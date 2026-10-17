/**
 * SettingsPanel (Task 8c, pi parity): the settings editor opened from the
 * rail's Settings button. GETs `/v1/settings` on open, edits the store fields, PATCHes
 * the edits on Save (the server persists them; the harness picks a patched
 * `steeringMode` up on the NEXT submission's admission — the spec's binding
 * testable).
 *
 * Sections (2026-10-15 quick wins): the fields are grouped into a
 * left-hand nav — General (queue modes), Tools (default tools),
 * Interface (client-only prefs, localStorage — never the server file),
 * Advanced (retry + raw per-model thinking JSON). The nav is deliberately
 * HARDCODED: extension-registered sections are a future spec (recorded
 * 2026-10-15, deferred) — no seam yet, by design.
 *
 * Field shapes v1:
 * - `steeringMode` / `followUpMode`: selects over pi-durable's QueueMode,
 *   plus a "(server default)" option that PATCHes `null` (clears the file
 *   key, restoring the pi-durable default `one-at-a-time`).
 * - `retry.enabled`: a checkbox (the only simply-shaped retry/stream
 *   field; the retry/stream TIMING knobs stay file-only in v1).
 * - `defaultTools`: checkboxes over the server's `toolRoster` (the live
 *   registry's tool names — extension tools like codemode's appear
 *   automatically; mapped to pi-durable's model-offered filter
 *   `AgentChange.modelTools`, NOT the enabled filter). All-checked clears
 *   the filter (absent key = every installed tool); NONE-checked also
 *   clears it — the filter hides listed tools and can never disable them
 *   all, so the fieldset carries a note saying so. `toolRoster` is a
 *   required contract field; the bundled CORE_TOOLS fallback below is
 *   defensive only (a mid-deploy shape drift renders the core list
 *   instead of an empty fieldset).
 * - Interface (client prefs): `enterToSend` and `showThinking` — applied
 *   the moment their checkbox flips (no save step; they live in
 *   localStorage via the app-owned {@link PrefsState}).
 *
 * Save semantics: only changed fields ride the PATCH. A save with every
 * control at its baseline sends an empty patch and reports "no changes
 * to save" — a correct no-op, not a failure.
 * - `perModelThinking`: a raw JSON textarea (keys "provider/modelId" → a
 *   pi-ai thinking level). Raw JSON is the documented v1 surface — an
 *   invalid document refuses to save locally (no 400 round-trip).
 */

import { useCallback, useEffect, useState } from "react";
import type {
	QueueModeWire,
	SettingsWire,
	SettingsPatchWire,
	SigrunClient,
} from "../api";
import { type PrefKey, type PrefsState } from "./usePrefs";

/** The settings sections, in nav order. */
const SECTIONS = ["General", "Tools", "Interface", "Advanced"] as const;
type Section = (typeof SECTIONS)[number];

/**
 * The fallback `defaultTools` roster: the core tool names, used only when
 * a response omits `toolRoster` (defensive — the contract declares it
 * required) — the panel stays usable instead of rendering an empty
 * fieldset.
 */
export const CORE_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
] as const;

/** The roster the checkboxes render over: the server's when present, the fallback otherwise. */
function rosterOf(settings: SettingsWire): readonly string[] {
	return settings.toolRoster ?? CORE_TOOLS;
}

type LoadState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly settings: SettingsWire };

interface Draft {
	/** Empty string = the "(server default)" option (PATCHes null). */
	steeringMode: QueueModeWire | "";
	followUpMode: QueueModeWire | "";
	/** Absent `retry.enabled` renders checked (pi-durable's retry default is on). */
	retryEnabled: boolean;
	tools: Record<string, boolean>;
	perModelThinking: string;
}

function draftFrom(settings: SettingsWire): Draft {
	const tools: Record<string, boolean> = {};
	for (const name of rosterOf(settings)) {
		// Absent defaultTools = no filter = every roster tool on.
		tools[name] =
			settings.defaultTools === undefined ||
			settings.defaultTools.includes(name);
	}
	return {
		steeringMode: settings.steeringMode ?? "",
		followUpMode: settings.followUpMode ?? "",
		retryEnabled: settings.retry?.enabled ?? true,
		tools,
		perModelThinking:
			settings.perModelThinking === undefined
				? ""
				: JSON.stringify(settings.perModelThinking, null, 2),
	};
}

/**
 * Draft → PATCH body: only CHANGED fields ride the patch (the server merges;
 * an unchanged field left out is never rewritten). The cleared/default
 * affordance PATCHes `null`.
 */
function patchFrom(draft: Draft, baseline: SettingsWire): SettingsPatchWire {
	const patch: Record<string, unknown> = {};
	const queueMode = (
		key: "steeringMode" | "followUpMode",
		value: QueueModeWire | "",
	): void => {
		const current = baseline[key];
		if (value === "") {
			if (current !== undefined) patch[key] = null;
		} else if (value !== current) {
			patch[key] = value;
		}
	};
	queueMode("steeringMode", draft.steeringMode);
	queueMode("followUpMode", draft.followUpMode);
	const retryEnabled = baseline.retry?.enabled ?? true;
	if (draft.retryEnabled !== retryEnabled) {
		patch.retry = { enabled: draft.retryEnabled };
	}
	const roster = rosterOf(baseline);
	const allOn = roster.every((name) => draft.tools[name]);
	const noneOn = roster.every((name) => !draft.tools[name]);
	if (allOn || noneOn) {
		// All-on clears the filter (the no-filter default). None-on clears
		// it too: an empty `tools` array would drop every tool — an
		// unusable conversation; the store's resolveAgent behavior for an
		// empty stored array keeps every tool anyway.
		if (baseline.defaultTools !== undefined) patch.defaultTools = null;
	} else {
		const selected = roster.filter((name) => draft.tools[name]);
		const baselineTools = baseline.defaultTools ?? [...roster];
		if (
			selected.length !== baselineTools.length ||
			selected.some((name) => !baselineTools.includes(name))
		) {
			patch.defaultTools = selected;
		}
	}
	const baselineThinking =
		baseline.perModelThinking === undefined
			? ""
			: JSON.stringify(baseline.perModelThinking, null, 2);
	const trimmed = draft.perModelThinking.trim();
	if (trimmed !== baselineThinking.trim()) {
		if (trimmed === "") patch.perModelThinking = null;
		else {
			// parsePerModelThinking validated this before save was enabled.
			const parsed: unknown = JSON.parse(trimmed);
			patch.perModelThinking = parsed as Record<string, string>;
		}
	}
	return patch as SettingsPatchWire;
}

/** Validate the raw JSON: absent (empty) or a `{model: level}` object. */
function parsePerModelThinking(
	raw: string,
): { ok: true } | { ok: false; message: string } {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: true };
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { ok: false, message: "must be a JSON object" };
		}
		for (const [model, level] of Object.entries(parsed)) {
			if (typeof level !== "string") {
				return { ok: false, message: `${model}: level must be a string` };
			}
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

const QUEUE_MODE_OPTIONS: readonly (QueueModeWire | "")[] = [
	"",
	"one-at-a-time",
	"all",
];

/** The Interface section's client prefs, in render order. */
const CLIENT_PREF_FIELDS: readonly {
	readonly key: PrefKey;
	readonly label: string;
	readonly note: string;
}[] = [
	{
		key: "enterToSend",
		label: "enter sends the prompt",
		note: "off: Ctrl+Enter submits (Enter inserts a newline); on: Enter submits and Shift+Enter inserts a newline. Ctrl+Enter submits either way.",
	},
	{
		key: "showThinking",
		label: "show thinking blocks",
		note: "reasoning text arrives with assistant messages; off hides it completely.",
	},
];

export function SettingsPanel(props: {
	readonly client: SigrunClient;
	/** The app-owned client prefs (the Interface section edits them live). */
	readonly prefsState: PrefsState;
	readonly onClose: () => void;
}) {
	const { client, onClose, prefsState } = props;
	const [load, setLoad] = useState<LoadState>({ status: "loading" });
	const [draft, setDraft] = useState<Draft | null>(null);
	const [section, setSection] = useState<Section>("General");
	const [saveState, setSaveState] = useState<{
		readonly status: "idle" | "saving" | "saved";
		readonly message?: string;
	}>({ status: "idle" });

	useEffect(() => {
		let cancelled = false;
		client
			.getSettings()
			.then((settings) => {
				if (cancelled) return;
				setLoad({ status: "ready", settings });
				setDraft(draftFrom(settings));
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setLoad({
					status: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	const save = useCallback(async () => {
		if (draft === null || load.status !== "ready") return;
		const parsed = parsePerModelThinking(draft.perModelThinking);
		if (!parsed.ok) {
			setSaveState({ status: "idle", message: parsed.message });
			return;
		}
		const patch = patchFrom(draft, load.settings);
		setSaveState({ status: "saving" });
		try {
			const saved = await client.patchSettings(patch);
			setLoad({ status: "ready", settings: saved });
			if (Object.keys(patch).length === 0) {
				// An empty patch means every control matched the baseline —
				// nothing was sent, and that's a correct outcome, not a
				// failure. Say so honestly instead of "saved".
				setSaveState({ status: "saved", message: "no changes to save" });
			} else {
				setSaveState({ status: "saved", message: "saved" });
			}
		} catch (error: unknown) {
			setSaveState({
				status: "idle",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}, [client, draft, load]);

	const thinkingValid =
		draft === null ? true : parsePerModelThinking(draft.perModelThinking).ok;

	const body =
		load.status === "loading" ? (
			<p className="settings-note">loading settings…</p>
		) : load.status === "error" ? (
			<p className="settings-note" role="alert">
				{load.message}
			</p>
		) : draft === null ? null : section === "General" ? (
			<div className="settings-body">
				<label className="settings-field">
					<span className="settings-label">steering mode</span>
					<select
						className="settings-steering"
						value={draft.steeringMode}
						onChange={(event) =>
							setDraft({
								...draft,
								steeringMode: event.target.value as QueueModeWire | "",
							})
						}
					>
						{QUEUE_MODE_OPTIONS.map((mode) => (
							<option key={mode || "default"} value={mode}>
								{mode === "" ? "(server default)" : mode}
							</option>
						))}
					</select>
				</label>
				<label className="settings-field">
					<span className="settings-label">follow-up mode</span>
					<select
						className="settings-followup"
						value={draft.followUpMode}
						onChange={(event) =>
							setDraft({
								...draft,
								followUpMode: event.target.value as QueueModeWire | "",
							})
						}
					>
						{QUEUE_MODE_OPTIONS.map((mode) => (
							<option key={mode || "default"} value={mode}>
								{mode === "" ? "(server default)" : mode}
							</option>
						))}
					</select>
				</label>
			</div>
		) : section === "Tools" ? (
			<div className="settings-body">
				<fieldset className="settings-field settings-tools">
					<legend className="settings-label">default tools</legend>
					{rosterOf(load.settings).map((name) => (
						<label key={name} className="settings-checkbox">
							<input
								type="checkbox"
								checked={draft.tools[name]}
								onChange={(event) =>
									setDraft({
										...draft,
										tools: {
											...draft.tools,
											[name]: event.target.checked,
										},
									})
								}
							/>
							{name}
						</label>
					))}
					<p className="settings-note">
						all checked = no filter (every installed tool); unchecking
						every box also leaves every tool enabled — the filter only
						hides listed tools, it can never disable them all
					</p>
				</fieldset>
			</div>
		) : section === "Interface" ? (
			<div className="settings-body">
				{CLIENT_PREF_FIELDS.map((field) => (
					<label
						key={field.key}
						className="settings-field settings-checkbox"
					>
						<input
							type="checkbox"
							className={`settings-pref-${field.key}`}
							checked={prefsState.prefs[field.key]}
							onChange={(event) =>
								prefsState.setPref(field.key, event.target.checked)
							}
						/>
						<span className="settings-label">{field.label}</span>
						<p className="settings-note">{field.note}</p>
					</label>
				))}
				<p className="settings-note">
					interface preferences are per-browser (stored locally — never
					sent to the server)
				</p>
			</div>
		) : (
			<div className="settings-body">
				<label className="settings-field settings-checkbox">
					<input
						type="checkbox"
						className="settings-retry-enabled"
						checked={draft.retryEnabled}
						onChange={(event) =>
							setDraft({ ...draft, retryEnabled: event.target.checked })
						}
					/>
					<span className="settings-label">retry enabled</span>
				</label>
				<label className="settings-field">
					<span className="settings-label">
						per-model thinking (raw JSON, v1)
					</span>
					<textarea
						className="settings-thinking"
						rows={4}
						spellCheck={false}
						placeholder='{"provider/modelId": "high"}'
						value={draft.perModelThinking}
						onChange={(event) =>
							setDraft({ ...draft, perModelThinking: event.target.value })
						}
					/>
					<p className="settings-note">
						{`a raw JSON object — "provider/modelId": thinking level (off, minimal, low, medium, high, xhigh, max); empty clears`}
					</p>
				</label>
			</div>
		);

	return (
		<div className="settings-overlay" role="dialog" aria-label="settings">
			<div className="settings-panel">
				<header className="settings-head">
					<span className="settings-title">settings</span>
					<span className="spacer" />
					<button
						type="button"
						className="settings-close"
						title="close settings"
						onClick={onClose}
					>
						✕
					</button>
				</header>
				{load.status === "ready" && (
					<div className="settings-layout">
						<nav className="settings-nav" aria-label="settings sections">
							{SECTIONS.map((name) => (
								<button
									key={name}
									type="button"
									className="settings-nav-item"
									data-active={name === section || undefined}
									onClick={() => setSection(name)}
								>
									{name}
								</button>
							))}
						</nav>
						<div className="settings-section">{body}</div>
					</div>
				)}
				{load.status !== "ready" && body}
				<footer className="settings-actions">
					<button
						type="button"
						className="settings-save"
						disabled={
							saveState.status === "saving" ||
							!thinkingValid ||
							load.status !== "ready"
						}
						onClick={() => void save()}
					>
						{saveState.status === "saving" ? "saving…" : "save"}
					</button>
					{saveState.message !== undefined && (
						<span
							className="settings-note"
							role={saveState.status === "saved" ? "status" : "alert"}
						>
							{saveState.message}
						</span>
					)}
				</footer>
			</div>
		</div>
	);
}
