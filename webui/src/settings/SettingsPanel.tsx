/**
 * SettingsPanel (UI-blocks U4 Task 4, spec §13.4 → 0.4.0 Task 4): the
 * settings editor, rebuilt over the ONE settings renderer — now a
 * main-pane PAGE (no overlay/dialog chrome): the route owns the open
 * section (`section` prop + `onSection` back into the host's router),
 * so browser back/forward and deep links walk the section ids. The
 * nav + search build from `GET /v1/settings/sections` (core's sections
 * first — General, Tools, Interface, Advanced, Providers, Extensions —
 * then every loaded extension's declared sections). Each section
 * renders as a {@link SurfaceView} over its surface mount (`/v1/ext/
 * <slug>/surfaces/<id>`); the settings forms' submits carry the
 * surface's `rev` (the optimistic-concurrency token — the U4
 * form-submit payload).
 *
 * The core coves keep their channels-native components:
 * - **Interface** binds client prefs ({@link PrefsState}) + the theme
 *   controls ({@link ThemeState}) — client state, never the server.
 * - **Providers** is a compact readiness list linking to extension pages.
 * - Every loaded extension has one page; declared shared/personal sections
 *   stack there instead of colliding on their repeated section ids.
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
	MetaResponse,
	SettingsSectionEntryWire,
	SettingsSectionIndexEntryWire,
	SigrunClient,
} from "../api";
import { createExtTransport } from "../blocks/extTransport";
import { SurfaceView } from "../blocks/SurfaceView";
import type { ThemeMode, ThemeState } from "../theme/useTheme";
import { AccountLinksSection } from "./AccountLinksSection";
import { ExtensionPage } from "./ExtensionPage";
import { ProvidersSection } from "./ProvidersSection";
import { TokensSection } from "./TokensSection";
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

import { filterSettingsIndex as filterSettingsIndexShared } from "@sigrun/shared/views";

/** Filter the index by the query (case-insensitive over label + help +
 *  key) — `@sigrun/shared`'s ONE implementation (U4 Task 4 round-2);
 *  the re-export keeps the panel's import surface. */
export function filterSettingsIndex(
	index: readonly SettingsSectionIndexEntryWire[],
	query: string,
): readonly SettingsSectionIndexEntryWire[] {
	return filterSettingsIndexShared(index, query);
}

// ─── The panel ────────────────────────────────────────────────────────────

/** The ONE section-visibility rule used by both deep links and navigation.
 *  A known non-admin never sees the Providers cove; the naive/unknown
 *  posture keeps it because that server makes every caller admin. */
export function visibleSettingsSections(
	sections: readonly SettingsSectionEntryWire[],
	admin: boolean | undefined,
): readonly SettingsSectionEntryWire[] {
	return sections.filter((section) => {
		if (section.id === "providers" && admin === false) return false;
		if (section.slug !== "core" && admin === false) return section.scope === "user" && section.admin !== true;
		if (section.scope === "user" && section.admin === true && admin === false) return false;
		return true;
	});
}

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
	/** The route's section id (0.4.0 Task 4): the page is CONTROLLED — the
	 * host's hash route owns the open section; absent → the panel's own
	 * default (General). Deep links obey exactly the nav's visibility
	 * rule (a non-admin cannot open the admin-only coves). */
	readonly section?: string;
	/** A nav click hands the section id to the host's router (the hash
	 * route write lives there — back/forward walks the section ids). */
	readonly onSection: (id: string) => void;
	/** The App's restart action (§13.3) — the callout's Restart button. */
	readonly onRestart?: () => Promise<void>;
}): React.ReactElement {
	const {
		client,
		onSection,
		prefsState,
		theme,
		admin,
		onRestart,
		section,
	} = props;
	const [load, setLoad] = useState<SectionsLoad>({ status: "loading" });
	// The /v1/meta snapshot (the version line in General): fetched once
	// per open; a failure leaves the line absent, never blocks settings.
	const [meta, setMeta] = useState<MetaResponse | null>(null);
	// The open section. The ROUTE is the source of truth (the resolve
	// effect below maps `section` into this state — deep links,
	// back/forward, and bookmarks all resolve identically).
	const [open, setOpen] = useState<OpenSection | null>(null);
	// The loaded-extension list (the cove's nav rows + the resolve
	// effect's uncovered-slug arm — the route alone decides the cove,
	// so back/forward and deep links into it land correctly).
	const [extensions, setExtensions] = useState<readonly ExtensionInfoWire[] | null>(null);
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
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setLoad({
					status: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
		// The loaded-extension list feeds the cove's nav rows AND the
		// resolve effect's uncovered-slug arm (the route alone decides).
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

	// The CONTROLLED section (0.4.0 Task 4): the route owns the open
	// section — resolved here, never set directly. Resolution mirrors the
	// old deep-link rule: a CORE section by id first, then any declared
	// section by id, then the COVE's uncovered-extension slug (derived
	// from the fetched extension list — back/forward and deep links into
	// the cove resolve identically to an in-app click); the absent id
	// (bare #/settings) and any unresolvable/hidden id (a non-admin's
	// Providers, a stale rename) degrade to the General default — the
	// section a principal cannot see never opens.
	useEffect(() => {
		if (load.status !== "ready") return;
		const visible = visibleSettingsSections(load.sections, admin);
		if (section !== undefined) {
			const core = visible.find(
				(entry) => entry.slug === "core" && entry.id === section,
			);
			if (core !== undefined) {
				setOpen({ kind: "section", entry: core });
				return;
			}
			const page = extensions?.find((entry) => entry.name === section);
			if (page?.settingsPage === true && (admin !== false || visible.some((entry) => entry.page === page.name && entry.scope === "user"))) {
				setOpen({ kind: "extension", slug: page.name });
				return;
			}
		}
		const general = visible.find(
			(entry) => entry.slug === "core" && entry.id === "general",
		);
		if (general !== undefined) {
			setOpen({ kind: "section", entry: general });
		}
	}, [load, section, admin, extensions]);

	const results = useMemo(
		() => (load.status === "ready" ? filterSettingsIndex(load.index, query) : []),
		[load, query],
	);

	/** Jump to a search hit: open its section (routing the id through the
	 *  host's hash), then focus the field whose name matches the hit's
	 *  key (the webui focus half of the search's resolve contract). */
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
			onSection(entry.page ?? entry.id);
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
		[load, onSection],
	);

	const pendingRestart = coreMeta?.pendingRestart ?? [];
	const supervised = coreMeta?.supervised === true;
	const showRestartButton = supervised && admin !== false && onRestart !== undefined;

	const navSections = useMemo(() => {
		if (load.status !== "ready") return [];
		// The server 403s non-admin writes regardless — the client must
		// not pretend those controls are available.
		return visibleSettingsSections(load.sections, admin);
	}, [load, admin]);
	const pageOwners = useMemo(
		() => new Set((extensions ?? []).map((extension) => extension.name)),
		[extensions],
	);
	const pageTitles = useMemo(
		() => new Map((extensions ?? []).map((extension) => [extension.name, extension.title])),
		[extensions],
	);
	const openExtension = open?.kind === "extension"
		? extensions?.find((entry) => entry.name === open.slug)
		: undefined;

	return (
		<div className="settings-page">
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
							{navSections.filter((section) => section.slug === "core" && section.scope !== "user").map((section) => (
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
									onClick={() => onSection(section.id)}
								>
									{section.title}
								</button>
							))}
							<ExtensionPagesNav
								extensions={extensions}
								sections={navSections}
								open={open}
								admin={admin !== false}
								onOpen={onSection}
							/>
						</nav>
						<div className="settings-section" ref={bodyRef}>
							{open === null ? (
								<p className="settings-note">select a section</p>
							) : open.kind === "extension" && openExtension !== undefined ? (
								<ExtensionPage
									key={openExtension.name}
									client={client}
									extension={openExtension}
									sections={navSections.filter((entry) => entry.page === openExtension.name)}
									admin={admin !== false}
								/>
							) : open.kind === "section" ? (
								<SettingsSectionBody
									key={`${open.entry.slug}/${open.entry.id}`}
									client={client}
									entry={open.entry}
									prefsState={prefsState}
									theme={theme}
									meta={meta}
									onCoreMeta={setCoreMeta}
									valuesRef={sectionDataRef}
									pageOwners={pageOwners}
									titles={pageTitles}
									onOpenPage={onSection}
								/>
							) : null}
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

function ExtensionPagesNav(props: {
	readonly extensions: readonly ExtensionInfoWire[] | null;
	readonly sections: readonly SettingsSectionEntryWire[];
	readonly open: OpenSection | null;
	readonly admin: boolean;
	readonly onOpen: (page: string) => void;
}): React.ReactElement | null {
	const { extensions, sections, open, admin, onOpen } = props;
	if (extensions === null) return null;
	const pages = new Set(sections.map((section) => section.page).filter((page): page is string => page !== undefined));
	const listed = extensions
		.filter((extension) => extension.settingsPage === true && (admin || pages.has(extension.name)))
		.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name, undefined, { sensitivity: "base" }));
	if (listed.length === 0) return null;
	return (
		<div className="settings-nav-group" role="group" aria-label="Extensions">
			<div className="settings-nav-heading">Extensions</div>
			{listed.map((extension) => (
				<button
					key={extension.name}
					type="button"
					className="settings-nav-item settings-nav-extension"
					data-ext={extension.name}
					data-active={open?.kind === "extension" && open.slug === extension.name ? "" : undefined}
					onClick={() => onOpen(extension.name)}
				>
					{extension.title ?? extension.name}
				</button>
			))}
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
	readonly pageOwners: ReadonlySet<string>;
	readonly titles: ReadonlyMap<string, string | undefined>;
	readonly onOpenPage: (owner: string) => void;
}): React.ReactElement {
	const { entry, client, prefsState, theme, meta, onCoreMeta, titles } = props;
	// The Interface + Providers + Extensions coves never mount a surface.
	if (entry.slug === "core" && entry.id === "interface") {
		return <InterfaceCove prefsState={prefsState} theme={theme} />;
	}
	if (entry.slug === "core" && entry.id === "providers") {
		return <ProvidersSection client={client} pageOwners={props.pageOwners} titles={titles} onOpenPage={props.onOpenPage} />;
	}
	if (entry.slug === "core" && entry.id === "accounts") {
		return <AccountLinksSection client={client} />;
	}
	if (entry.slug === "core" && entry.id === "tokens") {
		return <TokensSection client={client} />;
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
	// The probe's onData: a stable callback per section (a fresh closure
	// per render would re-arm the probe's poll every frame).
	const { onCoreMeta, valuesRef } = props;
	const handleProbeData = useCallback(
		(data: JsonObject) => {
			valuesRef.current[`${entry.slug}/${entry.id}`] =
				(typeof data.settings === "object" &&
				data.settings !== null &&
				!Array.isArray(data.settings)
					? data.settings
					: {}) as JsonObject;
			if (onCoreMeta !== undefined) {
				const metaBlock = data.meta;
				if (
					typeof metaBlock === "object" &&
					metaBlock !== null &&
					!Array.isArray(metaBlock) &&
					Array.isArray((metaBlock as JsonObject).pendingRestart)
				) {
					const block = metaBlock as JsonObject;
					onCoreMeta({
						pendingRestart: (block.pendingRestart as unknown[]).filter(
							(k): k is string => typeof k === "string",
						),
						supervised: block.supervised === true,
					});
				}
			}
		},
		[entry.slug, entry.id, onCoreMeta, valuesRef],
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
			<SurfaceMetaProbe transport={transport} onData={handleProbeData} />
			<SurfaceView transport={transport} />
		</div>
	);
}

/**
 * The data probe beside the SurfaceView: a fetch of the same surface's
 * data the panel reads the `meta` block + the search's value resolution
 * from (the SurfaceView consumes the transport; the panel needs the
 * raw data object). The probe REFETCHES every 1.5 s (the pendingRestart
 * callout must catch keys a save in ANOTHER section lands; the probe is
 * cheap — the surface's data is small and the poll only runs while the
 * section is open).
 */
function SurfaceMetaProbe(props: {
	readonly transport: ReturnType<typeof createExtTransport>;
	readonly onData: (data: JsonObject) => void;
}): null {
	const { transport, onData } = props;
	useEffect(() => {
		let cancelled = false;
		const poll = (): void => {
			transport
				.fetchData()
				.then((result) => {
					if (!cancelled && result.data !== undefined) onData(result.data);
				})
				.catch(() => {
					// The SurfaceView surfaces the load failure; the probe is
					// best-effort (the callout hides when the read fails).
				});
		};
		poll();
		const timer = setInterval(poll, 1500);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [transport, onData]);
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
