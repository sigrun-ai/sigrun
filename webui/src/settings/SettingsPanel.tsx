/**
 * SettingsPanel (UI-blocks U4 Task 4, spec §13.4): the settings editor,
 * rebuilt over the ONE settings renderer. The nav + search build from
 * `GET /v1/settings/sections` (core's sections first — General, Tools,
 * Interface, Advanced, Providers, Extensions — then every loaded
 * extension's declared sections). Each section renders as a
 * {@link SurfaceView} over its surface mount (`/v1/ext/<slug>/surfaces/
 * <id>`); the settings forms' submits carry the surface's `rev` (the
 * optimistic-concurrency token — the U4 form-submit payload).
 *
 * The core coves keep their channels-native components:
 * - **Interface** binds client prefs ({@link PrefsState}) + the theme
 *   controls ({@link ThemeState}) — client state, never the server.
 * - **Providers** keeps the §7.6 credential flows
 *   ({@link ProvidersSection}).
 * - **Extensions** keeps the extension-list editor (raw JSON settings
 *   + write-only secrets per loaded extension) — an extension WITHOUT
 *   a declared section keeps its raw JSON editor here (the spec's
 *   Extensions → <name> → Advanced carry-over).
 *
 * The pending-restart callout (§13.2/§13.3) reads the General section's
 * `meta` block (`pendingRestart`, `supervised`): when the list is
 * non-empty the panel shows the callout — with a Restart button when
 * the server is supervised AND the session is an admin (the App's
 * restart action runs the §13.3 flow), otherwise the text "Restart
 * sigrun to apply".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ACCENTS,
	ACCENT_NAMES,
	PALETTES,
	PALETTE_NAMES,
} from "@sigrun/shared/themes";
import type { JsonObject } from "@sigrun/shared/blocks";
import type {
	ExtensionInfoWire,
	ExtensionSecretWire,
	MetaResponse,
	SettingsSectionEntryWire,
	SettingsSectionIndexEntryWire,
	SigrunClient,
} from "../api";
import { createExtTransport } from "../blocks/extTransport";
import { SurfaceView } from "../blocks/SurfaceView";
import type { ThemeMode, ThemeState } from "../theme/useTheme";
import { ProvidersSection } from "./ProvidersSection";
import { type PrefKey, type PrefsState } from "./usePrefs";

// ─── The load state ───────────────────────────────────────────────────────

type SectionsLoad =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| {
			readonly status: "ready";
			readonly sections: readonly SettingsSectionEntryWire[];
			readonly index: readonly SettingsSectionIndexEntryWire[];
	  };

/** The section the body shows (the nav selection). */
type OpenSection =
	| { readonly kind: "section"; readonly entry: SettingsSectionEntryWire }
	| { readonly kind: "extension"; readonly slug: string };

/** The per-section field values cache (the search hit's resolve target). */
type SectionValues = Record<string, JsonObject>;

// ─── The search ───────────────────────────────────────────────────────────

/** Filter the index by the query (case-insensitive over label + help). */
export function filterSettingsIndex(
	index: readonly SettingsSectionIndexEntryWire[],
	query: string,
): readonly SettingsSectionIndexEntryWire[] {
	const q = query.trim().toLowerCase();
	if (q === "") return [];
	return index.filter(
		(entry) =>
			entry.label.toLowerCase().includes(q) ||
			(entry.help ?? "").toLowerCase().includes(q) ||
			(entry.key ?? "").toLowerCase().includes(q),
	);
}

// ─── The panel ────────────────────────────────────────────────────────────

export function SettingsPanel(props: {
	readonly client: SigrunClient;
	/** The app-owned client prefs (the Interface section edits them live). */
	readonly prefsState: PrefsState;
	/** The shell's useTheme state (the Interface section's theme controls). */
	readonly theme: ThemeState;
	/**
	 * The session's admin posture (release 0.1 Task 2b): `false` hides the
	 * admin-only Providers section + the restart button. Undefined (no
	 * known identity — the naive posture) keeps them: the naive server
	 * makes every caller admin.
	 */
	readonly admin?: boolean;
	/** The App's restart action (§13.3) — the callout's Restart button. */
	readonly onRestart?: () => Promise<void>;
	readonly onClose: () => void;
}): React.ReactElement {
	const { client, onClose, prefsState, theme, admin, onRestart } = props;
	const [load, setLoad] = useState<SectionsLoad>({ status: "loading" });
	// The /v1/meta snapshot (the version line in General): fetched once
	// per open; a failure leaves the line absent, never blocks settings.
	const [meta, setMeta] = useState<MetaResponse | null>(null);
	const [open, setOpen] = useState<OpenSection | null>(null);
	const [query, setQuery] = useState("");
	// The General section's `meta` block (the pending-restart callout +
	// the supervised flag): the surface's data lands here on render.
	const [coreMeta, setCoreMeta] = useState<{
		readonly pendingRestart: readonly string[];
		readonly supervised: boolean;
	} | null>(null);
	// The search's focus hand-off: a hit resolves its section's data,
	// finds the field element, and focuses it.
	const sectionDataRef = useRef<SectionValues>({});
	const bodyRef = useRef<HTMLDivElement | null>(null);

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
			.listSettingsSections()
			.then((response) => {
				if (cancelled) return;
				setLoad({
					status: "ready",
					sections: response.sections,
					index: response.index,
				});
				const general = response.sections.find(
					(section) => section.slug === "core" && section.id === "general",
				);
				if (general !== undefined) {
					setOpen({ kind: "section", entry: general });
				}
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

	const results = useMemo(
		() => (load.status === "ready" ? filterSettingsIndex(load.index, query) : []),
		[load, query],
	);

	/** Jump to a search hit: open its section, then focus the field
	 *  whose name matches the hit's key (the webui focus half of the
	 *  search's resolve contract). */
	const jumpTo = useCallback(
		async (hit: SettingsSectionIndexEntryWire) => {
			const entry =
				load.status === "ready"
					? load.sections.find(
							(section) =>
								section.slug === hit.slug && section.id === hit.sectionId,
						)
					: undefined;
			if (entry === undefined) return;
			setQuery("");
			setOpen({ kind: "section", entry });
			// The surface loads async; the focus pass polls the body for
			// the field element (a `[name="<key>"]` control) briefly.
			if (hit.key !== undefined) {
				const key = hit.key;
				for (let attempt = 0; attempt < 20; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					// The form's fields render `data-name` on their row (the
					// fields.tsx contract); the row's focusable child takes
					// the focus.
					const row = bodyRef.current?.querySelector<HTMLElement>(
						`[data-name=${JSON.stringify(key)}]`,
					);
					const element =
						row?.querySelector<HTMLElement>(
							"input, textarea, select, button, [tabindex]",
						) ?? row;
					if (element !== null && element !== undefined) {
						element.focus();
						return;
					}
				}
			}
		},
		[load],
	);

	const pendingRestart = coreMeta?.pendingRestart ?? [];
	const supervised = coreMeta?.supervised === true;
	const showRestartButton = supervised && admin !== false && onRestart !== undefined;

	const navSections = useMemo(() => {
		if (load.status !== "ready") return [];
		// A known non-admin never sees the Providers nav row (the server
		// 403s the writes regardless — the client must not pretend).
		return load.sections.filter(
			(section) => !(section.id === "providers" && admin === false),
		);
	}, [load, admin]);

	return (
		<div className="settings-overlay" role="dialog" aria-label="settings">
			<div className="settings-panel">
				<header className="settings-head">
					<span className="settings-title">Settings</span>
					<input
						type="search"
						className="settings-search"
						placeholder="Search settings"
						aria-label="search settings"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
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
				{pendingRestart.length > 0 && (
					<div className="settings-restart-callout" role="status">
						<p className="settings-restart-text">
							Restart sigrun to apply: {pendingRestart.join(", ")}
						</p>
						{showRestartButton && (
							<button
								type="button"
								className="settings-restart"
								onClick={() => void onRestart()}
							>
								Restart
							</button>
						)}
					</div>
				)}
				{load.status === "loading" && (
					<p className="settings-note">loading settings…</p>
				)}
				{load.status === "error" && (
					<p className="settings-note" role="alert">
						{load.message}
					</p>
				)}
				{load.status === "ready" && (
					<div className="settings-layout">
						<nav className="settings-nav" aria-label="settings sections">
							{navSections.map((section) => (
								<button
									key={`${section.slug}/${section.id}`}
									type="button"
									className="settings-nav-item"
									data-active={
										open?.kind === "section" &&
										open.entry.slug === section.slug &&
										open.entry.id === section.id
											? ""
											: undefined
									}
									onClick={() => setOpen({ kind: "section", entry: section })}
								>
									{section.title}
								</button>
							))}
							{/* The extension-list cove (the raw-JSON editor): one row
							    per loaded extension whose declared sections don't
							    already cover it — the spec's "an extension without a
							    section keeps its raw JSON editor". */}
							<ExtensionCoveNav
								client={client}
								open={open}
								coveredSlugs={
									new Set(
										load.sections
											.filter((s) => s.slug !== "core")
											.map((s) => s.slug),
									)
								}
								onOpen={(slug) => setOpen({ kind: "extension", slug })}
							/>
						</nav>
						<div className="settings-section" ref={bodyRef}>
							{open === null ? (
								<p className="settings-note">select a section</p>
							) : open.kind === "extension" ? (
								<ExtensionCove client={client} slug={open.slug} />
							) : (
								<SettingsSectionBody
									key={`${open.entry.slug}/${open.entry.id}`}
									client={client}
									entry={open.entry}
									prefsState={prefsState}
									theme={theme}
									meta={meta}
									onCoreMeta={setCoreMeta}
									valuesRef={sectionDataRef}
								/>
							)}
						</div>
					</div>
				)}
				{query.trim() !== "" && results.length > 0 && (
					<div className="settings-search-results" role="listbox">
						{results.slice(0, 20).map((hit, index) => (
							<button
								key={`${hit.slug}/${hit.sectionId}/${hit.key ?? hit.label}/${index}`}
								type="button"
								className="settings-search-hit"
								role="option"
								aria-selected="false"
								onClick={() => void jumpTo(hit)}
							>
								<span className="settings-search-hit-label">{hit.label}</span>
								<span className="settings-search-hit-path">
									{hit.slug === "core" ? "" : `${hit.slug} · `}
									{hit.sectionId}
								</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/** One section's body: the coves (Interface / Providers / Extensions)
 *  keep their channels-native components; every other section renders
 *  its surface. */
function SettingsSectionBody(props: {
	readonly client: SigrunClient;
	readonly entry: SettingsSectionEntryWire;
	readonly prefsState: PrefsState;
	readonly theme: ThemeState;
	readonly meta: MetaResponse | null;
	readonly onCoreMeta: (meta: {
		readonly pendingRestart: readonly string[];
		readonly supervised: boolean;
	}) => void;
	readonly valuesRef: React.MutableRefObject<SectionValues>;
}): React.ReactElement {
	const { entry, client, prefsState, theme, meta, onCoreMeta } = props;
	// The Interface + Providers + Extensions coves never mount a surface.
	if (entry.slug === "core" && entry.id === "interface") {
		return <InterfaceCove prefsState={prefsState} theme={theme} />;
	}
	if (entry.slug === "core" && entry.id === "providers") {
		return <ProvidersSection client={client} />;
	}
	if (entry.slug === "core" && entry.id === "extensions") {
		return <ExtensionsCove client={client} />;
	}
	return (
		<SettingsSurfaceBody
			client={client}
			entry={entry}
			meta={entry.slug === "core" && entry.id === "general" ? meta : null}
			onCoreMeta={entry.slug === "core" ? onCoreMeta : undefined}
			valuesRef={props.valuesRef}
		/>
	);
}

/** The surface-backed section body (every non-cove section). */
function SettingsSurfaceBody(props: {
	readonly client: SigrunClient;
	readonly entry: SettingsSectionEntryWire;
	readonly meta: MetaResponse | null;
	readonly onCoreMeta?:
		| ((meta: {
				readonly pendingRestart: readonly string[];
				readonly supervised: boolean;
		  }) => void)
		| undefined;
	readonly valuesRef: React.MutableRefObject<SectionValues>;
}): React.ReactElement {
	const { entry, meta, client } = props;
	// One transport per section mount (the key on the parent re-creates
	// it on a section switch).
	const transport = useMemo(
		() =>
			createExtTransport({
				slug: entry.slug,
				id: entry.id,
				fetch: client.rawFetch,
			}),
		[entry.slug, entry.id, client],
	);
	return (
		<div className="settings-body" data-settings-section={entry.id}>
			{entry.slug === "core" && entry.id === "general" && (
				<p className="settings-version">
					sigrun {meta?.version !== undefined ? `v${meta.version}` : ""}
					{meta?.harnessVersion !== undefined
						? ` · pi-durable v${meta.harnessVersion}`
						: ""}
				</p>
			)}
			<SurfaceMetaProbe
				transport={transport}
				onData={(data) => {
					props.valuesRef.current[`${entry.slug}/${entry.id}`] =
						(typeof data.settings === "object" &&
						data.settings !== null &&
						!Array.isArray(data.settings)
							? data.settings
							: {}) as JsonObject;
					if (props.onCoreMeta !== undefined) {
						const metaBlock = data.meta;
						if (
							typeof metaBlock === "object" &&
							metaBlock !== null &&
							!Array.isArray(metaBlock) &&
							Array.isArray((metaBlock as JsonObject).pendingRestart)
						) {
							const block = metaBlock as JsonObject;
							props.onCoreMeta({
								pendingRestart: (block.pendingRestart as unknown[]).filter(
									(k): k is string => typeof k === "string",
								),
								supervised: block.supervised === true,
							});
						}
					}
				}}
			/>
			<SurfaceView transport={transport} />
		</div>
	);
}

/**
 * The data probe beside the SurfaceView: a fetch of the same surface's
 * data the panel reads the `meta` block + the search's value resolution
 * from (the SurfaceView consumes the transport; the panel needs the
 * raw data object — one extra fetch per section mount, cached).
 */
function SurfaceMetaProbe(props: {
	readonly transport: ReturnType<typeof createExtTransport>;
	readonly onData: (data: JsonObject) => void;
}): null {
	useEffect(() => {
		let cancelled = false;
		props.transport
			.load()
			.then((result) => {
				if (!cancelled) props.onData(result.data);
			})
			.catch(() => {
				// The SurfaceView surfaces the load failure; the probe is
				// best-effort (the callout hides when the read fails).
			});
		return () => {
			cancelled = true;
		};
	}, [props.transport]);
	return null;
}

// ─── The Interface cove (client prefs + theme — never the server) ─────────

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

/** The Interface cove (B7): theme controls apply immediately through the
 *  shell's useTheme; the prefs flip live — nothing rides the server. */
function InterfaceCove(props: {
	readonly prefsState: PrefsState;
	readonly theme: ThemeState;
}): React.ReactElement {
	const { prefsState, theme } = props;
	return (
		<div className="settings-body">
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
				interface preferences are per-browser (stored locally — never sent
				to the server)
			</p>
		</div>
	);
}

// ─── The Extensions cove (W3 Task 7, spec §7.7 — the raw-JSON editor) ─────

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
	} catch (error: unknown) {
		return {
			ok: false,
			message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** The Extensions cove's nav rows: one per loaded extension whose
 *  declared sections don't already cover it (the raw-JSON editor's
 *  reachability — the spec's keep-reachable rule). */
function ExtensionCoveNav(props: {
	readonly client: SigrunClient;
	readonly open: OpenSection | null;
	readonly coveredSlugs: ReadonlySet<string>;
	readonly onOpen: (slug: string) => void;
}): React.ReactElement | null {
	const { client, coveredSlugs, onOpen, open } = props;
	const [extensions, setExtensions] = useState<readonly ExtensionInfoWire[] | null>(
		null,
	);
	useEffect(() => {
		let cancelled = false;
		client
			.listExtensions()
			.then((list) => {
				if (!cancelled) setExtensions(list.extensions);
			})
			.catch(() => {
				if (!cancelled) setExtensions([]);
			});
		return () => {
			cancelled = true;
		};
	}, [client]);
	if (extensions === null) return null;
	// An extension WITH a declared section renders under its own nav
	// rows; the cove covers the rest (the raw-JSON editor).
	const uncovered = extensions.filter((entry) => !coveredSlugs.has(entry.name));
	if (uncovered.length === 0) return null;
	return (
		<>
			{uncovered.map((extension) => (
				<button
					key={extension.name}
					type="button"
					className="settings-nav-item settings-nav-extension"
					data-ext={extension.name}
					data-active={
						open?.kind === "extension" && open.slug === extension.name
							? ""
							: undefined
					}
					onClick={() => onOpen(extension.name)}
				>
					{extension.name} (advanced)
				</button>
			))}
		</>
	);
}

/** One extension's raw-JSON editor (the spec §7.7 carry-over). */
function ExtensionCove(props: {
	readonly client: SigrunClient;
	readonly slug: string;
}): React.ReactElement {
	const { client, slug } = props;
	const [draft, setDraft] = useState<ExtensionDraft | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		setDraft(null);
		setError(null);
		Promise.all([
			client.getExtensionSettings(slug),
			client.listExtensionSecrets(slug),
		])
			.then(([settingsResponse, secrets]) => {
				if (cancelled) return;
				setDraft({
					settingsText: settingsToText(settingsResponse.settings),
					secrets: secrets.secrets,
					secretValues: {},
					newKey: "",
					newValue: "",
				});
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [client, slug]);

	const patchDraft = (patch: Partial<ExtensionDraft>): void => {
		setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }));
	};

	const saveSettings = async (): Promise<void> => {
		if (draft === null) return;
		const parsed = parseSettingsText(draft.settingsText);
		if (!parsed.ok) {
			patchDraft({ note: { kind: "error", message: parsed.message } });
			return;
		}
		try {
			await client.putExtensionSettings(slug, parsed.value);
			patchDraft({ note: { kind: "ok", message: "saved" } });
		} catch (cause: unknown) {
			patchDraft({
				note: {
					kind: "error",
					message: cause instanceof Error ? cause.message : String(cause),
				},
			});
		}
	};

	const setSecret = async (key: string, value: string): Promise<void> => {
		if (key === "" || value === "" || draft === null) return;
		try {
			const { secrets } = await client.putExtensionSecret(slug, key, value);
			setDraft({
				...draft,
				secrets,
				secretValues: { ...draft.secretValues, [key]: "" },
				newKey: "",
				newValue: "",
				note: { kind: "ok", message: `secret ${key} set` },
			});
		} catch (cause: unknown) {
			patchDraft({
				note: {
					kind: "error",
					message: cause instanceof Error ? cause.message : String(cause),
				},
			});
		}
	};

	const deleteSecret = async (key: string): Promise<void> => {
		try {
			const { secrets } = await client.deleteExtensionSecret(slug, key);
			patchDraft({ secrets, note: { kind: "ok", message: `secret ${key} deleted` } });
		} catch (cause: unknown) {
			patchDraft({
				note: {
					kind: "error",
					message: cause instanceof Error ? cause.message : String(cause),
				},
			});
		}
	};

	if (error !== null) {
		return (
			<p className="settings-note" role="alert">
				{error}
			</p>
		);
	}
	if (draft === null) {
		return <p className="settings-note">loading…</p>;
	}
	return (
		<div className="settings-body settings-ext-list">
			<p className="settings-note">
				settings are the extension's own JSON (read at factory time → applies
				at restart); secrets list keys only — values are write-only and never
				displayed
			</p>
			<fieldset className="settings-ext" data-ext={slug}>
				<legend className="settings-ext-name">{slug}</legend>
				<label className="settings-field">
					<span className="settings-label">Settings (raw JSON)</span>
					<textarea
						className="settings-ext-settings"
						rows={4}
						spellCheck={false}
						placeholder="{}"
						value={draft.settingsText}
						onChange={(event) =>
							patchDraft({ settingsText: event.target.value })
						}
					/>
					<div className="settings-ext-row">
						<button
							type="button"
							className="settings-ext-save"
							onClick={() => void saveSettings()}
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
								{secret.key}{" "}
								<span className="settings-ext-source">({secret.source})</span>
							</span>
							<input
								type="password"
								className="settings-ext-secret-value"
								data-secret-key={secret.key}
								placeholder="new value"
								value={draft.secretValues[secret.key] ?? ""}
								onChange={(event) =>
									patchDraft({
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
									void setSecret(secret.key, draft.secretValues[secret.key] ?? "")
								}
							>
								Set
							</button>
							<button
								type="button"
								className="settings-ext-secret-delete"
								data-secret-key={secret.key}
								onClick={() => void deleteSecret(secret.key)}
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
							onChange={(event) => patchDraft({ newKey: event.target.value })}
						/>
						<input
							type="password"
							className="settings-ext-new-value"
							placeholder="value"
							value={draft.newValue}
							onChange={(event) => patchDraft({ newValue: event.target.value })}
						/>
						<button
							type="button"
							className="settings-ext-secret-add"
							onClick={() => void setSecret(draft.newKey, draft.newValue)}
						>
							Set
						</button>
					</div>
				</div>
			</fieldset>
		</div>
	);
}

/** The Extensions cove list (every loaded extension's editor — the
 *  section's own body; the nav's per-extension rows open the same
 *  editor scoped to one slug). */
function ExtensionsCove(props: { readonly client: SigrunClient }): React.ReactElement {
	const { client } = props;
	const [extensions, setExtensions] = useState<readonly ExtensionInfoWire[] | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		client
			.listExtensions()
			.then((list) => {
				if (!cancelled) setExtensions(list.extensions);
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [client]);
	if (error !== null) {
		return (
			<p className="settings-note" role="alert">
				{error}
			</p>
		);
	}
	if (extensions === null) {
		return <p className="settings-note">loading extensions…</p>;
	}
	if (extensions.length === 0) {
		return (
			<div className="settings-body">
				<p className="settings-note">no extensions are configured</p>
			</div>
		);
	}
	return (
		<div className="settings-body">
			{extensions.map((extension) => (
				<ExtensionCove key={extension.name} client={client} slug={extension.name} />
			))}
		</div>
	);
}
