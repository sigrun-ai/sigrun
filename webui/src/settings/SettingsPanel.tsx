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
 * Advanced (retry + raw per-model thinking JSON), Extensions (W3 Task 7),
 * and Providers (release 0.1 Task 2b — the per-provider readiness report
 * with the write-only credential field; hidden for a known non-admin).
 * The nav is deliberately HARDCODED: extension-registered sections are a
 * future spec (recorded 2026-10-15, deferred) — no seam yet, by design.
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
 *   localStorage via the app-owned {@link PrefsState}) — plus the theme
 *   controls (B7): Mode / Palette / Accent over App's {@link ThemeState}
 *   (the useTheme instance mounted in the shell — a pick applies
 *   immediately through it, never through Save). The palette swatches
 *   preview each palette's own bg + text + default accent; the accent
 *   swatches are round dots with their labels in `title`.
 *
 * Save semantics: only changed fields ride the PATCH. A save with every
 * control at its baseline sends an empty patch and reports "no changes
 * to save" — a correct no-op, not a failure.
 * - `perModelThinking`: a raw JSON textarea (keys "provider/modelId" → a
 *   pi-ai thinking level). Raw JSON is the documented v1 surface — an
 *   invalid document refuses to save locally (no 400 round-trip).
 */

import { useCallback, useEffect, useState } from "react";
import {
	ACCENTS,
	ACCENT_NAMES,
	PALETTES,
	PALETTE_NAMES,
} from "@sigrun/shared/themes";
import type {
	QueueModeWire,
	SettingsWire,
	SettingsPatchWire,
	SigrunClient,
	ExtensionInfoWire,
	ExtensionSecretWire,
	MetaResponse,
} from "../api";
import type { ThemeMode, ThemeState } from "../theme/useTheme";
import { ProvidersSection } from "./ProvidersSection";
import { type PrefKey, type PrefsState } from "./usePrefs";

/** The settings sections, in nav order. */
const SECTIONS = [
	"General",
	"Tools",
	"Interface",
	"Advanced",
	"Extensions",
	"Providers",
] as const;
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
		label: "Enter sends the prompt",
		note: "off: Ctrl+Enter submits (Enter inserts a newline); on: Enter submits and Shift+Enter inserts a newline. Ctrl+Enter submits either way.",
	},
	{
		key: "showThinking",
		label: "Show thinking blocks",
		note: "Show thinking text inside activity details",
	},
];

/** The mode segments (useTheme's ThemeMode values, labelled for the UI). */
const MODE_OPTIONS: readonly {
	readonly value: ThemeMode;
	readonly label: string;
}[] = [
	{ value: "system", label: "System" },
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];

// ─── Extensions (W3 Task 7, spec §7.7) ─────────────────────────────────────

/** One extension's editor state (the settings textarea + the secret rows). */
interface ExtensionDraft {
	/** The settings object as raw JSON text (the textarea's value). */
	settingsText: string;
	/** The last listed secret keys, sources included. */
	secrets: readonly ExtensionSecretWire[];
	/** Write-only values per listed key (never pre-filled — the API never
	 * returns values, so there is nothing to display). */
	secretValues: Record<string, string>;
	/** The add-a-new-secret row's key + write-only value. */
	newKey: string;
	newValue: string;
	/** Per-extension note (save outcome / a server error message). */
	note?: { readonly kind: "ok" | "error"; readonly message: string };
}

/** Serialize a settings object for the textarea (stable pretty-print). */
function settingsToText(value: Record<string, unknown>): string {
	const keys = Object.keys(value);
	if (keys.length === 0) return "";
	return JSON.stringify(value, null, 2);
}

/** Validate the raw settings JSON: empty ("{}") or a JSON object. */
function parseSettingsText(
	raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: true, value: {} };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, message: "settings must be a JSON object" };
		}
		return { ok: true, value: parsed as Record<string, unknown> };
	} catch (error) {
		return {
			ok: false,
			message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * The Extensions section (spec §7.7): the loaded-extension list with a
 * raw JSON settings editor and a write-only secret key list per
 * extension. Values an extension reads at factory time apply at restart
 * (the section's note says so); secrets are never displayed — the API
 * returns keys + sources only, and the inputs start empty by design.
 */
function ExtensionsSection(props: { readonly client: SigrunClient }) {
	const { client } = props;
	const [load, setLoad] = useState<
		| { readonly status: "loading" }
		| { readonly status: "error"; readonly message: string }
		| { readonly status: "ready"; readonly extensions: readonly ExtensionInfoWire[] }
	>({ status: "loading" });
	const [drafts, setDrafts] = useState<Record<string, ExtensionDraft>>({});

	useEffect(() => {
		let cancelled = false;
		client
			.listExtensions()
			.then(async (list) => {
				// Settings + secrets per extension load in parallel; a failure of
				// one extension's fetches fails the section (fail-loud client).
				const entries = await Promise.all(
					list.extensions.map(async (extension) => {
					const [settings, secrets] = await Promise.all([
						client.getExtensionSettings(extension.name),
						client.listExtensionSecrets(extension.name),
					]);
					const draft: ExtensionDraft = {
						settingsText: settingsToText(settings),
						secrets: secrets.secrets,
						secretValues: {},
						newKey: "",
						newValue: "",
					};
					return [extension.name, draft] as const;
				}),
			);
				if (cancelled) return;
				setLoad({ status: "ready", extensions: list.extensions });
				setDrafts(Object.fromEntries(entries));
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

	/** Patch one extension's draft (a shallow per-slug merge). */
	const patchDraft = (slug: string, patch: Partial<ExtensionDraft>): void => {
		setDrafts((prev) => ({ ...prev, [slug]: { ...prev[slug], ...patch } }));
	};

	/** Save one extension's settings (PUT the parsed object). */
	const saveSettings = async (slug: string): Promise<void> => {
		const draft = drafts[slug];
		if (draft === undefined) return;
		const parsed = parseSettingsText(draft.settingsText);
		if (!parsed.ok) {
			patchDraft(slug, { note: { kind: "error", message: parsed.message } });
			return;
		}
		try {
			await client.putExtensionSettings(slug, parsed.value);
			patchDraft(slug, { note: { kind: "ok", message: "saved" } });
		} catch (error: unknown) {
			patchDraft(slug, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	/** Set one secret (a listed key or the add-new row) and refresh the list. */
	const setSecret = async (slug: string, key: string, value: string): Promise<void> => {
		if (key === "" || value === "") return;
		try {
			const { secrets } = await client.putExtensionSecret(slug, key, value);
			patchDraft(slug, {
				secrets,
				secretValues: { ...drafts[slug].secretValues, [key]: "" },
				newKey: "",
				newValue: "",
				note: { kind: "ok", message: `secret ${key} set` },
			});
		} catch (error: unknown) {
			patchDraft(slug, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	/** Delete one secret and refresh the list. */
	const deleteSecret = async (slug: string, key: string): Promise<void> => {
		try {
			const { secrets } = await client.deleteExtensionSecret(slug, key);
			patchDraft(slug, { secrets, note: { kind: "ok", message: `secret ${key} deleted` } });
		} catch (error: unknown) {
			patchDraft(slug, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	if (load.status === "loading") {
		return <p className="settings-note">loading extensions…</p>;
	}
	if (load.status === "error") {
		return (
			<p className="settings-note" role="alert">
				{load.message}
			</p>
		);
	}
	if (load.extensions.length === 0) {
		return (
			<div className="settings-body">
				<p className="settings-note">no extensions are configured</p>
			</div>
		);
	}
	return (
		<div className="settings-body settings-ext-list">
			<p className="settings-note">
				settings are the extension's own JSON (read at factory time →
			applies at restart); secrets list keys only — values are write-only
			and never displayed
			</p>
			{load.extensions.map((extension) => {
			const draft = drafts[extension.name];
			if (draft === undefined) return null;
			return (
				<fieldset key={extension.name} className="settings-ext" data-ext={extension.name}>
					<legend className="settings-ext-name">
						{extension.name}
						<span className="settings-ext-meta">
							{extension.status}
							{extension.version === undefined
								? ""
								: ` · v${extension.version}`}
						</span>
					</legend>
					<label className="settings-field">
						<span className="settings-label">Settings (raw JSON)</span>
						<textarea
							className="settings-ext-settings"
							rows={4}
							spellCheck={false}
							placeholder="{}"
							value={draft.settingsText}
							onChange={(event) =>
								patchDraft(extension.name, {
									settingsText: event.target.value,
								})
							}
						/>
						<div className="settings-ext-row">
							<button
								type="button"
								className="settings-ext-save"
								onClick={() => void saveSettings(extension.name)}
							>
								Save settings
							</button>
							{draft.note !== undefined && (
								<span
									className="settings-note"
									role={draft.note.kind === "ok" ? "status" : "alert"}
								>
									{draft.note.message}
								</span>
							)}
						</div>
					</label>
					<div className="settings-field">
						<span className="settings-label">Secrets</span>
						{draft.secrets.length === 0 && (
							<p className="settings-note">no secrets set</p>
						)}
						{draft.secrets.map((secret) => (
							<div key={secret.key} className="settings-ext-row">
								<span className="settings-ext-key">
									{secret.key} <span className="settings-ext-source">({secret.source})</span>
								</span>
								<input
									type="password"
									className="settings-ext-secret-value"
									data-secret-key={secret.key}
									placeholder="new value"
									value={draft.secretValues[secret.key] ?? ""}
									onChange={(event) =>
									patchDraft(extension.name, {
										secretValues: {
											...draft.secretValues,
											[secret.key]: event.target.value,
										},
									})
									}
								/>
								<button
									type="button"
									className="settings-ext-secret-set"
									data-secret-key={secret.key}
									onClick={() =>
										void setSecret(
											extension.name,
											secret.key,
											draft.secretValues[secret.key] ?? "",
										)
									}
								>
									Set
								</button>
								<button
									type="button"
									className="settings-ext-secret-delete"
									data-secret-key={secret.key}
									onClick={() => void deleteSecret(extension.name, secret.key)}
								>
									Delete
								</button>
							</div>
						))}
						<div className="settings-ext-row">
							<input
								type="text"
								className="settings-ext-new-key"
								placeholder="new key"
								value={draft.newKey}
								onChange={(event) =>
									patchDraft(extension.name, { newKey: event.target.value })
							}
							/>
							<input
								type="password"
								className="settings-ext-new-value"
								placeholder="value"
								value={draft.newValue}
								onChange={(event) =>
									patchDraft(extension.name, { newValue: event.target.value })
							}
							/>
							<button
								type="button"
								className="settings-ext-secret-add"
								onClick={() =>
									void setSecret(extension.name, draft.newKey, draft.newValue)
								}
							>
								Set
								</button>
						</div>
					</div>
				</fieldset>
			);
		})}
		</div>
	);
}

export function SettingsPanel(props: {
	readonly client: SigrunClient;
	/** The app-owned client prefs (the Interface section edits them live). */
	readonly prefsState: PrefsState;
	/** The shell's useTheme state (the Interface section's theme controls). */
	readonly theme: ThemeState;
	/**
	 * The session's admin posture (release 0.1 Task 2b): `false` hides the
	 * admin-only Providers section. Undefined (no known identity — the
	 * naive posture, bare embeds) keeps it: the naive server makes every
	 * caller admin.
	 */
	readonly admin?: boolean;
	readonly onClose: () => void;
}) {
	const { client, onClose, prefsState, theme, admin } = props;
	const [load, setLoad] = useState<LoadState>({ status: "loading" });
	const [draft, setDraft] = useState<Draft | null>(null);
	// The /v1/meta snapshot (the version line in General): fetched once
	// per open; a failure leaves the line absent, never blocks settings.
	const [meta, setMeta] = useState<MetaResponse | null>(null);
	const [section, setSection] = useState<Section>("General");
	const [saveState, setSaveState] = useState<{
		readonly status: "idle" | "saving" | "saved";
		readonly message?: string;
	}>({ status: "idle" });

	useEffect(() => {
		let cancelled = false;
		client
			.getMeta()
			.then((snapshot) => {
				if (!cancelled) setMeta(snapshot);
			})
			.catch(() => {
				// The version line is cosmetic; a meta failure keeps the
				// settings surface fully usable without it.
			});
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
					<span className="settings-label">Steering mode</span>
					<span className="settings-select-wrap">
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
					</span>
				</label>
				<label className="settings-field">
					<span className="settings-label">Follow-up mode</span>
					<span className="settings-select-wrap">
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
					</span>
				</label>
				{/* The version line: what an operator quotes in a bug report — the
				   SERVER's version (from /v1/meta, which reads the package
				   manifest) plus the wire schema gate the boot already ran. */}
				<p className="settings-version">
					sigrun {meta?.version !== undefined ? `v${meta.version}` : ""}
					{meta?.harnessVersion !== undefined
						? ` · pi-durable v${meta.harnessVersion}`
						: ""}
				</p>
			</div>
		) : section === "Tools" ? (
			<div className="settings-body">
				<fieldset className="settings-field settings-tools">
					<legend className="settings-label">Default tools</legend>
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
				{/* The theme controls (B7): picks apply IMMEDIATELY through the
				    shell's useTheme state — no Save, never the server. */}
				<fieldset className="settings-field">
					<legend className="settings-label">Mode</legend>
					<div className="settings-mode-row" role="group" aria-label="mode">
						{MODE_OPTIONS.map((option) => (
							<button
								key={option.value}
								type="button"
								className="settings-mode"
								data-mode-option={option.value}
								aria-pressed={theme.mode === option.value}
								onClick={() => theme.setMode(option.value)}
							>
								{option.label}
							</button>
						))}
					</div>
				</fieldset>
				<fieldset className="settings-field">
					<legend className="settings-label">Palette</legend>
					<div className="settings-palettes" role="group" aria-label="palette">
						{PALETTE_NAMES.map((name) => {
							const palette = PALETTES[name];
							const tokens = palette[theme.resolved];
							return (
								<button
									key={name}
									type="button"
									className="settings-palette"
									data-palette-option={name}
									aria-pressed={theme.palette === name}
									title={palette.label}
									onClick={() => theme.setPalette(name)}
									style={{ background: tokens.bg }}
								>
									<span
										className="settings-swatch-dot"
										aria-hidden="true"
										style={{ background: tokens.text }}
									/>
									<span
										className="settings-swatch-dot"
										aria-hidden="true"
										style={{
											background: ACCENTS[palette.defaultAccent][theme.resolved],
										}}
									/>
								</button>
							);
						})}
					</div>
				</fieldset>
				<fieldset className="settings-field">
					<legend className="settings-label">Accent</legend>
					<div className="settings-accents" role="group" aria-label="accent">
						{ACCENT_NAMES.map((name) => (
							<button
								key={name}
								type="button"
								className="settings-accent"
								data-accent-option={name}
								aria-pressed={theme.accent === name}
								title={ACCENTS[name].label}
								onClick={() => theme.setAccent(name)}
								style={{ background: ACCENTS[name][theme.resolved] }}
							/>
						))}
					</div>
				</fieldset>
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
		) : section === "Extensions" ? (
			<ExtensionsSection client={client} />
		) : section === "Providers" ? (
			<ProvidersSection client={client} />
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
					<span className="settings-label">Retry enabled</span>
				</label>
				<label className="settings-field">
					<span className="settings-label">
						Per-model thinking (raw JSON, v1)
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
					<span className="settings-title">Settings</span>
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
							{/* A known non-admin session never sees the credential
							    section (hidden, not read-only — the server 403s the
							    writes anyway; the client must not pretend otherwise). */}
							{SECTIONS.filter(
								(name) => !(name === "Providers" && admin === false),
							).map((name) => (
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
						{saveState.status === "saving" ? "Saving…" : "Save"}
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
