/**
 * SettingsPanel (Task 8c, pi parity): the settings editor opened from the
 * TopBar gear. GETs `/v1/settings` on open, edits the store fields, PATCHes
 * the edits on Save (the server persists them; the harness picks a patched
 * `steeringMode` up on the NEXT submission's admission — the spec's binding
 * testable).
 *
 * Field shapes v1:
 * - `steeringMode` / `followUpMode`: selects over pi-durable's QueueMode,
 *   plus a "(server default)" option that PATCHes `null` (clears the file
 *   key, restoring the pi-durable default `one-at-a-time`).
 * - `retry.enabled`: a checkbox (the only simply-shaped retry/stream
 *   field; the retry/stream TIMING knobs stay file-only in v1).
 * - `defaultTools`: checkboxes over the 7 core tool names (read, bash,
 *   edit, write, find, grep, ls). All-checked clears the filter (absent
 *   key = every installed tool).
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

/** The 7 core tool names the `defaultTools` filter selects over. */
export const CORE_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
] as const;

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
	for (const name of CORE_TOOLS) {
		// Absent defaultTools = no filter = every core tool on.
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
	const allOn = CORE_TOOLS.every((name) => draft.tools[name]);
	const noneOn = CORE_TOOLS.every((name) => !draft.tools[name]);
	if (allOn || noneOn) {
		// All-on clears the filter (the no-filter default). None-on clears
		// it too: an empty `tools` array would drop every tool — an
		// unusable conversation; the store's resolveAgent behavior for an
		// empty stored array keeps every tool anyway.
		if (baseline.defaultTools !== undefined) patch.defaultTools = null;
	} else {
		const selected = CORE_TOOLS.filter((name) => draft.tools[name]);
		const baselineTools = baseline.defaultTools ?? [...CORE_TOOLS];
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
			patch.perModelThinking = JSON.parse(trimmed) as Record<string, string>;
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

export function SettingsPanel(props: {
	readonly client: SigrunClient;
	readonly onClose: () => void;
}) {
	const { client, onClose } = props;
	const [load, setLoad] = useState<LoadState>({ status: "loading" });
	const [draft, setDraft] = useState<Draft | null>(null);
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
				setSaveState({ status: "saved", message: "no changes" });
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
				{load.status === "loading" && (
					<p className="settings-note">loading settings…</p>
				)}
				{load.status === "error" && (
					<p className="settings-note" role="alert">
						{load.message}
					</p>
				)}
				{load.status === "ready" && draft !== null && (
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
						<fieldset className="settings-field settings-tools">
							<legend className="settings-label">default tools</legend>
							{CORE_TOOLS.map((name) => (
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
								all checked = no filter (every installed tool)
							</p>
						</fieldset>
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
						<footer className="settings-actions">
							<button
								type="button"
								className="settings-save"
								disabled={saveState.status === "saving" || !thinkingValid}
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
				)}
			</div>
		</div>
	);
}
