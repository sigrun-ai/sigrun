/**
 * The app shell (B2, UI refresh): the section rail + conversation sidebar
 * (one drawer below 900px), the chat pane under ChatHeader, and the
 * mode-switchable RightPanel — over the composer footer.
 *
 * The active conversation id is App state: `SessionList.onSelect` flips
 * it, and the view hook re-drives (a fresh stream opens; the stale one
 * closes — the hook's cleanup owns that). The Composer receives the
 * latest view frame: `steer.busy` flips its send→steer toggle,
 * `docs["pi.usage"]` feeds the ring, and each new frame reference
 * refreshes the pending-interaction strip.
 *
 * Boot gate (spec §5 fail-loud): the app fetches `GET /v1/meta` and
 * REFUSES to render the shell when the served `schemaVersion` differs
 * from the bundle's pinned copy. A matching meta feeds the rail (health
 * dot) and the shell; the ChatHeader's title comes from the lifted
 * conversation list (B3's `useConversationList` — one hook owns the rows
 * the sidebar, the header, and the transcript all read).
 *
 * Shell state: `panel` (Outline/Workspace, persisted under
 * `sigrun.panel`; clicking the active mode closes it), `drawerOpen` (the
 * ≤900px rail+sidebar drawer), `settingsOpen` (the rail's Settings button
 * — the dialog itself is B7's restyle). The theme hook (mode/palette/
 * accent) runs here for its root-application side effect.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { displayName } from "@sigrun/shared/conversations";
import type { JsonObject } from "@sigrun/shared/blocks";
import { canonicalJson, eventKeyWeb } from "@sigrun/shared/blocks";
import { groupTurns } from "@sigrun/shared/turns";
import {
	createClient,
	type ConversationSummary,
	type ConversationViewWire,
	type MetaResponse,
	type SigrunClient,
	type WhoamiResponse,
} from "./api";
import { Composer } from "./composer/Composer";
import { TurnList } from "./entries/TurnList";
import { userText } from "./entries/UserEntry";
import {
	liveCompactionFailure,
	liveCompactions,
} from "./entries/liveDoc";
import { GalleryView } from "./gallery/GalleryView";
import { SurfacePage } from "./blocks/SurfacePage";
import { ExtPanelHost } from "./blocks/ExtPanelHost";
import { ExtSurfaceHub } from "./blocks/extTransport";
import { ChatHeader, type PanelMode } from "./layout/ChatHeader";
import { Rail } from "./layout/Rail";
import { RightPanel } from "./layout/RightPanel";
import { extPanelEntries, extViewEntries, loadRailOrder, moveExtView, orderExtViews } from "./layout/extViews";
import { JobsPanel } from "./jobs/JobsPanel";
import { OutlinePanel } from "./outline/OutlinePanel";
import { PINNED_SCHEMA_VERSION } from "./schema-version";
import { SessionList } from "./sessions/SessionList";
import { ShareMenu } from "./sessions/ShareMenu";
import { useConversationList } from "./sessions/useConversationList";
import { SettingsPanel } from "./settings/SettingsPanel";
import { usePrefs, type PrefsState } from "./settings/usePrefs";
import type { EventSourceFactory } from "./stream";
import { useTheme } from "./theme/useTheme";
import { useConversationView } from "./useConversationView";
import { useStickToBottom } from "./useStickToBottom";
import { WorkspaceBrowser } from "./workspace/WorkspaceBrowser";

/** The boot state machine: meta fetch → schema gate → shell. The
 *  `"restarting"` state (U4 Task 2, spec §13.3) replaces the shell
 *  after an admin restart call: the app polls `/readyz` and re-boots
 *  (a keyed remount re-runs the schema gate) when it answers. */
type Boot =
	| { readonly status: "loading" }
	| { readonly status: "refused"; readonly message: string }
	| { readonly status: "ready"; readonly meta: MetaResponse }
	| { readonly status: "restarting" };
/** The default client (same-origin); tests inject a stub-backed one. */
const defaultClient = createClient();

const PANEL_STORAGE_KEY = "sigrun.panel";

/** §13.3: how long the restart-recovery poll waits for /readyz before
 *  surfacing a stalled restart as a refusal (never a silent hang). */
const RESTART_READYZ_DEADLINE_MS = 60_000;

/** Load the persisted panel mode; garbage/absent → null (closed). */
function loadPanel(): PanelMode | null {
	const stored = (
		globalThis as { localStorage?: { getItem(key: string): string | null } }
	).localStorage;
	try {
		const value = stored?.getItem(PANEL_STORAGE_KEY) ?? null;
		return value === "outline" || value === "workspace" || value === "jobs"
			? value
			: null;
	} catch {
		return null;
	}
}

function persistPanel(mode: PanelMode | null): void {
	try {
		(globalThis as { localStorage?: Storage }).localStorage?.setItem(
			PANEL_STORAGE_KEY,
			mode ?? "none",
		);
	} catch {
		// A failing store (private browsing) keeps the panel session-only.
	}
}

/** The chronological-transcript pref (the tool-visibility fix): persisted
 * like the panel mode; absent/garbage → the grouped default. */
const TIMELINE_STORAGE_KEY = "sigrun.timeline";

function loadTimeline(): boolean {
	// Default ON (round 2): in-place interleaving is the preferred reading
	// shape; an explicit "0" (the user toggled grouped) wins over the default.
	try {
		return (
			(globalThis as { localStorage?: { getItem(k: string): string | null } })
				.localStorage?.getItem(TIMELINE_STORAGE_KEY) !== "0"
		);
	} catch {
		return true;
	}
}

function persistTimeline(on: boolean): void {
	try {
		(globalThis as { localStorage?: Storage }).localStorage?.setItem(
			TIMELINE_STORAGE_KEY,
			on ? "1" : "0",
		);
	} catch {
		// A failing store keeps the view session-only.
	}
}

/** Save text as a browser download (the Export menu action; test-safe). */
function downloadText(filename: string, text: string): void {
	const doc = (globalThis as { document?: Document }).document;
	if (doc === undefined) return;
	const url = URL.createObjectURL(
		new Blob([text], { type: "application/json" }),
	);
	const anchor = doc.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	doc.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/** The conversation's display title: B1's `displayName` — the ONE name
 *  spelling (sidebar rows and the header agree; unnamed → "New conversation"). */
function titleOf(summaries: readonly ConversationSummary[], id: number | null): string {
	if (id === null) return "sigrun";
	return displayName(summaries.find((item) => item.id === id) ?? { id, archived: false, pinned: false });
}

export interface AppOptions {
	/** Injected for tests; defaults to the same-origin §5 client. */
	readonly client?: SigrunClient;
	/** Injected for tests; defaults to the browser's native EventSource. */
	readonly createEventSource?: EventSourceFactory;
	/** The resolved principal (W1 Task 8, fed by the AuthGate): the rail's
	 *  identity and the sidebar's owner gate. Absent in bare embeds. */
	readonly identity?: WhoamiResponse;
	/** The AuthGate's logout flip: App performs the logout call, then hands
	 *  the session-end back. */
	readonly onLogout?: () => void;
	/**
	 * Test/Task-4 seam (U4 Task 2, spec §13.3): the app hands its
	 * restart action out once the shell mounts — Task 4's pendingRestart
	 * callout wires its Restart button to it; the tests drive it
	 * directly (no shell surface exposes it before Task 4).
	 */
	readonly onExposeActions?: (actions: AppActions) => void;
	/** INTERNAL (the wrapper's remount signal): the shell calls this when
	 *  the restart reply lands; the wrapper bumps the shell's key so the
	 *  recovery remounts the whole tree. Never passed by callers. */
	readonly onRestarting?: () => void;
}

/** The app-level actions the §13.3 restart surface exposes. */
export interface AppActions {
	/**
	 * Admin restart: POST /v1/admin/restart, flip the shell to
	 * "Restarting…", poll `/readyz`, and re-boot the app when it
	 * answers. Failures (403/409) surface as the shell error, never
	 * silently.
	 */
	restart(): Promise<void>;
}

function ChatCenter(props: {
	activeId: number | null;
	view: ConversationViewWire | null;
	status: string;
	error: string | null;
	readonly showThinking: boolean;
	readonly timeline: boolean;
	readonly client: SigrunClient;
	readonly onNavigate: (id: number) => void;
	readonly parent?: { id: number; name: string };
	/** Receives the transcript's scroll root (the outline jumps inside it). */
	readonly onScrollRoot: (element: HTMLElement | null) => void;
	/** The dock height as bottom padding, so the last message clears the
	 *  composer dock that overlays the scroll area (the scroll fade, B5). */
	readonly dockPadding: number;
}) {
	const { activeId, view, status, error, showThinking, timeline } = props;
	if (activeId === null) {
		return (
			<section className="chat-center">
				<p className="chat-empty">Select or create a conversation</p>
			</section>
		);
	}
	const busy = view?.steer.busy ?? false;
	// A live compaction task renders its own line; a FAILURE persists on the
	// doc after the task ends (cleared by the next successful summary).
	const compacting = view !== null && liveCompactions(view) > 0;
	const compactionError =
		view === null || compacting ? undefined : liveCompactionFailure(view);
	return (
		<section
			className="chat-center"
			data-view-status={status}
			aria-label="chat transcript"
			ref={props.onScrollRoot}
			style={
				props.dockPadding > 0
					? { paddingBottom: `${props.dockPadding}px` }
					: undefined
			}
		>
			{error !== null && <p role="alert">{error}</p>}
			{view === null ? (
				<p className="chat-loading">loading…</p>
			) : (
				<>
					<TurnList
						view={view}
						showThinking={showThinking}
						timeline={timeline}
						parent={props.parent}
						client={props.client}
						onNavigate={props.onNavigate}
					/>
					{busy && (
						<div className="chat-working" role="status">
							<span className="chat-working-dot" />
							<span className="chat-working-dot" />
							<span className="chat-working-dot" />
							<span className="chat-working-label">
								{compacting ? "compacting…" : "working…"}
							</span>
						</div>
					)}
					{compactionError !== undefined && (
						<p className="chat-compaction-failure" role="alert">
							compaction failed: {compactionError}
						</p>
					)}
				</>
			)}
		</section>
	);
}

/** The app shell's hash route (UI-blocks U3 Task 5): `#/c/<id>` (a
 *  conversation — the SessionList's select also lands here) and
 *  `#/ext/<slug>/<id>?params=<json>` (an extension surface view). The
 *  hash is the browser history entry; `navigate({params})` re-renders
 *  the surface with new params (a new hash entry, so back/forward
 *  walks them). */
type Route =
	| { readonly kind: "chat" }
	| {
			readonly kind: "ext";
			readonly slug: string;
			readonly id: string;
			readonly params: JsonObject;
		};

/** Parse `location.hash` into a route; garbage → the chat default. */
function parseHash(hash: string): Route {
	const path = hash.startsWith("#") ? hash.slice(1) : hash;
	const match = /^\/ext\/([^/]+)\/([^/?]+)(?:\?(.*))?$/.exec(path);
	if (match === null) return { kind: "chat" };
	const paramsRaw = match[3];
	let params: JsonObject = {};
	if (paramsRaw !== undefined) {
		// The route's query is a single `params=<json>` pair (spec §7.2);
		// anything else is ignored (the shell stays conservative).
		const paramsParam = new URLSearchParams(paramsRaw).get("params");
		if (paramsParam !== null) {
			try {
				const decoded: unknown = JSON.parse(paramsParam);
				if (
					typeof decoded === "object" &&
					decoded !== null &&
					!Array.isArray(decoded)
				) {
					params = decoded as JsonObject;
				}
			} catch {
				// Malformed params → the empty object (the surface renders
				// its default instance; the shell never refuses the route).
			}
		}
	}
	return {
		kind: "ext",
		slug: decodeURIComponent(match[1] ?? ""),
		id: decodeURIComponent(match[2] ?? ""),
		params,
	};
}

/** Serialize a route to the hash (the back/forward history entry). */
function routeHash(route: Route): string {
	if (route.kind === "chat") return "#/c";
	const base = `#/ext/${encodeURIComponent(route.slug)}/${encodeURIComponent(route.id)}`;
	if (Object.keys(route.params).length === 0) return base;
	return `${base}?params=${encodeURIComponent(JSON.stringify(route.params))}`;
}

/**
 * The hash seam: the URL fragment is the route's persistence (browser
 * back/forward ride it). In hosts without `location` (the
 * react-test-renderer harness), a module-level fallback holds the
 * current hash so the app's own navigation is self-consistent — tests
 * assert against `locationHash()` and the popstate path re-parses it.
 */
let fallbackHash = "";
function readHash(): string {
	const location_ = (globalThis as { location?: { hash?: string } }).location;
	if (location_ !== undefined && typeof location_.hash === "string") {
		return location_.hash;
	}
	return fallbackHash;
}
function writeHash(hash: string, replace = false): void {
	const historyApi = (
		globalThis as {
			history?: {
				pushState(d: unknown, t: string, u: string): void;
				replaceState(d: unknown, t: string, u: string): void;
			};
		}
	).history;
	fallbackHash = hash;
	if (historyApi === undefined) return;
	if (replace) historyApi.replaceState(null, "", hash);
	else historyApi.pushState(null, "", hash);
}

/** The current route hash (tests + the popstate handler read it). */
export function locationHash(): string {
	return readHash();
}

function AppShell(options: AppOptions = {}) {
	const client = options.client ?? defaultClient;
	const identity = options.identity;
	const onLogout = options.onLogout;
	const onRestarting = options.onRestarting;
	// The theme hook runs here for its root-application side effect; the
	// STATE feeds the settings panel's Interface section (B7) — its picks
	// apply immediately through this instance.
	const theme = useTheme();
	const prefsState: PrefsState = usePrefs();
	const [boot, setBoot] = useState<Boot>({ status: "loading" });

	// §13.3 (U4 Task 2): the admin restart action. POST the restart, flip
	// the shell to "Restarting…", and poll /readyz — when it answers the
	// supervisor has brought the process back, so the shell re-boots by
	// REMOUNT: effects with [client]-shaped deps (the schema gate's meta
	// fetch among them) never refire on a status flip inside the same
	// component instance — the restart is the one place a fresh boot MUST
	// re-run them, so this instance signals the App wrapper
	// (`onRestarting`), whose key bump remounts the whole tree.
	const restart = useCallback(async (): Promise<void> => {
		try {
			await client.requestRestart();
		} catch (cause) {
			setShellError(
				`restart failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
			return;
		}
		setShellError(null);
		setBoot({ status: "restarting" });
		// The wrapper bumps the shell's key at recovery (the poll below
		// flips the wrapper's state via this signal; this component
		// instance never leaves "restarting" — the REMOUNT is the boot).
		const deadline = Date.now() + RESTART_READYZ_DEADLINE_MS;
		// Free-running poll (never an effect: it must outlive the boot
		// state it drives, and a stalled recovery must surface, not hang).
		for (;;) {
			let ready = false;
			try {
				ready = await client.checkReady();
			} catch {
				// Connection refused mid-restart: keep polling.
			}
			if (ready) {
				// Remount the shell (the wrapper's key bump) — the fresh
				// instance re-runs the whole boot chain. The fallback
				// setBoot covers a bare embed with no wrapper (tests
				// mounting AppShell-shaped App directly).
				if (onRestarting !== undefined) onRestarting();
				else setBoot({ status: "loading" });
				return;
			}
			if (Date.now() > deadline) {
				setBoot({
					status: "refused",
					message:
						"restart did not come back: /readyz never answered within " +
						`${RESTART_READYZ_DEADLINE_MS / 1000}s — check the deployment's supervisor`,
				});
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}, [client, onRestarting]);
	// Expose the action surface (Task 4's callout button; the tests).
	// The window handle lets a browser drive the REAL action path (the
	// e2e's restart-surface check); it is overwritten per remount, never
	// accumulated.
	useEffect(() => {
		options.onExposeActions?.({ restart });
		(
			globalThis as { __sigrunAppActions?: AppActions }
		).__sigrunAppActions = { restart };
	}, [options, restart]);
	const [activeId, setActiveId] = useState<number | null>(null);
	const [panel, setPanel] = useState<PanelMode | null>(loadPanel);
	const [timeline, setTimeline] = useState<boolean>(loadTimeline);
	const [drawerOpen, setDrawerOpen] = useState(false);
	// Re-render token for hash-driven section switches (the section itself
	// derives from the hash each render).
	const [, setSectionTick] = useState(0);
	// The section the shell shows (U1 Task 6): the dev Blocks gallery rides
	// a hash route so a refresh keeps the page; the entry renders only when
	// `/v1/meta` reports dev (Rail gates it). NOT state — the hash is the
	// source of truth (the boot gate remounts the shell after meta lands,
	// so state would reset to the pre-gate hash; the hash listener keeps
	// back/forward and the rail button in sync).
	const win = globalThis as { location?: { hash: string } };
	const section: "chats" | "blocks" =
		boot.status === "ready" && win.location?.hash.startsWith("#/blocks")
			? "blocks"
			: "chats";
	const [settingsOpen, setSettingsOpen] = useState(false);
	// The hash route (U3 Task 5): the main pane renders either the chat
	// column or one extension surface page. `navigate({params})` pushes a
	// new hash entry; popstate walks back/forward through them.
	const [route, setRoute] = useState<Route>(() => parseHash(readHash()));
	// The ONE change-event hub per app (the transports subscribe; the
	// shared events source dispatches surface.changed into it).
	const [extHub] = useState(() => new ExtSurfaceHub());
	// The extension surfaces the principal cannot see (access none):
	// `slug/id` keys — discovered at render time (a load's 404), the rail
	// entry disappears at once (§6.5's "no rail entry").
	const [hiddenExtSurfaces] = useState<readonly string[]>([]);
	// The open extension PANEL tab's `slug/id` key (RightPanel state).
	const [extPanel, setExtPanel] = useState<string | null>(null);
	// The share editor's target conversation (W1 Task 8, spec §5.9): set by
	// the sidebar's owner-only Share… action, rendered as an overlay.
	const [shareFor, setShareFor] = useState<number | null>(null);
	// The action-failure strip (rename/fork/new/export/compact). A SUCCESS
	// of any later action clears it — a stale failure must not outlive the
	// next thing that worked.
	const [shellError, setShellError] = useState<string | null>(null);
	// The scroll fade (B5): the composer dock overlays the transcript's
	// bottom, so the transcript's bottom padding must equal the dock height
	// (the last message stays scrollable clear of the dock). A ResizeObserver
	// follows the dock — the composer's height moves with its tray/strip.
	const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
	const [dockPadding, setDockPadding] = useState(0);
	// Callback ref (React 19 ref cleanup): measure once, then follow resizes.
	const dockRef = useCallback(
		(dock: HTMLElement | null): (() => void) | undefined => {
			if (dock === null) return undefined;
			const measure = (): void => setDockPadding(dock.offsetHeight);
			measure();
			const Observer = (
				globalThis as {
					ResizeObserver?: new (callback: () => void) => ResizeObserver;
				}
			).ResizeObserver;
			if (Observer === undefined) return undefined;
			const observer = new Observer(measure);
			observer.observe(dock);
			return () => observer.disconnect();
		},
		[],
	);
	const { view, status, error, frames } = useConversationView(activeId, {
		createEventSource: options.createEventSource,
	});
	// Auto-scroll (round 2): stick to the bottom on new frames unless the
	// user scrolled up; `frames` is the stream's revision counter.
	const stuck = useStickToBottom(scrollRoot, frames);
	void stuck;
	// The LIFTED conversation list (B3): one hook owns the rows for the
	// sidebar, the header title, and the transcript's fork parents. `busy`
	// (the view's steer state) drives the post-run reloads — a name the
	// auto-namer writes at settlement appears without a manual reload.
	const [jobChanged, setJobChanged] = useState(0);
	const list = useConversationList(client, {
		busy: view?.steer.busy ?? false,
		createEventSource: options.createEventSource,
		// W4 Task 5: `job.changed` rides the hook's ONE shared
		// `/v1/events` source — the bump is the JobsPanel's refetch token
		// (never a second EventSource per app).
		onJobChanged: useCallback(() => {
			setJobChanged((token) => token + 1);
		}, []),
		// U3 Task 5: `surface.changed` rides the SAME source into the ext
		// hub (the open surface page's transport fires its onChanged).
		onSurfaceChanged: useCallback(
			(event: { slug: string; id: string; k: string; rev: number; treeRev: number }) => {
				extHub.dispatch(event);
			},
			[extHub],
		),
	});
	// The open surface page's transport: the hub attach (its onChanged
	// subscription is the routing registry entry) keyed on the wire `k`
	// (sha256 of slug\0id\0canonical params). The async eventKeyWeb
	// resolves per ext-route instance; the page renders only once the
	// hash resolves (a render-time createExtTransport would leave its
	// onChanged subscription outside the hub — the first Task-5 pass's
	// bob-context bug). `streamId` joins the deps: a reconnect's new
	// stream rebuilds the transport (X-Sigrun-Stream watcher identity).
	const extRoute = route.kind === "ext" ? route : null;
	const extKey = extRoute === null ? "" : canonicalJson(extRoute.params ?? {});
	const [extKeyHash, setExtKeyHash] = useState<{ key: string; hash: string } | null>(null);
	useEffect(() => {
		if (extRoute === null) {
			setExtKeyHash(null);
			return;
		}
		let alive = true;
		void eventKeyWeb(extRoute.slug, extRoute.id, extKey).then((hash) => {
			if (alive) setExtKeyHash({ key: extKey, hash });
		});
		return () => {
			alive = false;
		};
	}, [extRoute, extKey]);
	const extTransport = useMemo(() => {
		if (extRoute === null || extKeyHash === null || extKeyHash.key !== extKey) {
			return undefined;
		}
		return extHub.attach(
			{
				slug: extRoute.slug,
				id: extRoute.id,
				params: extRoute.params,
				...(list.streamId === undefined ? {} : { streamId: list.streamId }),
			},
			extKeyHash.hash,
		);
	}, [extRoute, extKey, extKeyHash, extHub, list.streamId]);

	// The open extension PANEL's transport (spec §7.1/§7.3): created ONLY
	// while a panel tab is active — closing the panel drops the transport
	// (no cadence, no watcher keepalive for a hidden panel).
	const extPanelParts = useMemo(() => {
		if (extPanel === null) return null;
		const [slug, id] = extPanel.split("/");
		if (slug === undefined || id === undefined || slug === "" || id === "") {
			return null;
		}
		return { slug, id };
	}, [extPanel]);
	const [extPanelKeyHash, setExtPanelKeyHash] = useState<{
		readonly forKey: string;
		readonly hash: string;
	} | null>(null);
	useEffect(() => {
		if (extPanelParts === null) {
			setExtPanelKeyHash(null);
			return;
		}
		let alive = true;
		const forKey = extPanel ?? "";
		void eventKeyWeb(extPanelParts.slug, extPanelParts.id, canonicalJson({})).then(
			(hash) => {
				if (alive) setExtPanelKeyHash({ forKey, hash });
			},
		);
		return () => {
			alive = false;
		};
	}, [extPanelParts, extPanel]);
	const extPanelTransport = useMemo(() => {
		if (
			extPanelParts === null ||
			extPanelKeyHash === null ||
			extPanelKeyHash.forKey !== extPanel
		) {
			return undefined;
		}
		return extHub.attach(
			{
				slug: extPanelParts.slug,
				id: extPanelParts.id,
				...(list.streamId === undefined ? {} : { streamId: list.streamId }),
			},
			extPanelKeyHash.hash,
		);
	}, [extPanelParts, extPanel, extPanelKeyHash, extHub, list.streamId]);

	// Visible-surface registration (spec §7.3's re-registration rule):
	// the open ext page remounts on a stream change (its key joins
	// streamId), but the open PANEL and rail-side watcher entries need
	// the hook's registry — noting them here (also once the pre-hello
	// stream resolves) makes the hello handler's reconnect refetch cover
	// every visible surface.
	useEffect(() => {
		if (extRoute !== null) {
			list.noteSurfaceVisible(extRoute.slug, extRoute.id, extRoute.params);
		}
		if (extPanelParts !== null) {
			list.noteSurfaceVisible(extPanelParts.slug, extPanelParts.id);
		}
		// extKey re-runs the effect when the route's params change
		// identity (extRoute is memoized by the router).
	}, [extRoute, extKey, extPanelParts, list.streamId, list.noteSurfaceVisible]);
	// The active panel's declared refresh cadence (§7.1): read from the
	// meta projection's panel rows (never a second fetch).
	const panelRefreshMs = useMemo(() => {
		if (extPanelParts === null || boot.status !== "ready") return undefined;
		return extPanelEntries(boot.meta.extensions).find(
			(entry) => entry.slug === extPanelParts.slug && entry.id === extPanelParts.id,
		)?.refreshMs;
	}, [extPanelParts, boot]);
	// parent, named from the lifted rows — one hook owns every name the UI
	// shows. A parent missing from the rows falls back to the display name.
	const parent = useMemo(() => {
		const ref = list.rows.find((row) => row.id === activeId)?.parent;
		if (ref === undefined) return undefined;
		const row = list.rows.find((candidate) => candidate.id === ref.id);
		return {
			id: ref.id,
			name:
				row === undefined
					? displayName({ id: ref.id, archived: false, pinned: false })
					: displayName(row),
		};
	}, [list.rows, activeId]);
	// The outline's rows (B5): one per USER turn, from the same grouped
	// turns the transcript renders — data-entry-id joins the panel to the
	// turn roots TurnList emits.
	const outlineTurns = useMemo(() => {
		const items: { entryId: number; text: string }[] = [];
		for (const turn of groupTurns(view?.entries ?? [])) {
			if (turn.kind === "user") {
				items.push({ entryId: turn.entry.id, text: userText(turn.entry) });
			}
		}
		return items;
	}, [view]);

	const onSelect = useCallback((id: number) => {
		setActiveId(id);
		setDrawerOpen(false);
	}, []);

	// Panel toggling: clicking the ACTIVE mode closes the panel (null).
	const onPanel = useCallback((mode: PanelMode) => {
		setPanel((current) => {
			const next = current === mode ? null : mode;
			persistPanel(next);
			return next;
		});
	}, []);
	const closePanel = useCallback(() => {
		setPanel(null);
		persistPanel(null);
	}, []);

	// The popstate listener: browser back/forward re-parses the hash
	// into route state (the rail's ext entries and the surface pages'
	// navigate(params) both land here).
	useEffect(() => {
		const onPop = (): void => setRoute(parseHash(readHash()));
		(globalThis as { addEventListener?: (t: string, l: () => void) => void }).addEventListener?.("popstate", onPop);
		return () => {
			(globalThis as { removeEventListener?: (t: string, l: () => void) => void }).removeEventListener?.("popstate", onPop);
		};
	}, []);

	// The rail's extension-view click: navigate to the surface's route.
	const onOpenExtView = useCallback((slug: string, id: string): void => {
		const next: Route = { kind: "ext", slug, id, params: {} };
		writeHash(routeHash(next));
		setRoute(next);
		setDrawerOpen(false);
	}, []);

	// The rail's extension-view ordering state (a client preference):
	// App owns it so the rail's keyboard reorder (Alt+Arrow) re-renders
	// and persists (`sigrun.railOrder`, surviving a reload).
	const [railOrder, setRailOrder] = useState<readonly string[]>(() =>
		loadRailOrder(),
	);
	const onMoveExtView = useCallback(
		(key: string, delta: -1 | 1): void => {
			setRailOrder((current) => {
				if (boot.status !== "ready") return current;
				const ordered = orderExtViews(
					extViewEntries(boot.meta.extensions),
					current,
				);
				return moveExtView(ordered, key, delta);
			});
		},
		[boot],
	);
	const railExtEntries = useMemo(
		() =>
			boot.status === "ready"
				? orderExtViews(extViewEntries(boot.meta.extensions), railOrder)
				: [],
		[boot, railOrder],
	);

	// The open ext view's declared refresh cadence (§7.1): read from the
	// meta projection (never a second fetch); absent → no cadence.
	const extRefreshMs = useMemo(() => {
		if (extRoute === null) return undefined;
		return railExtEntries.find(
			(entry) => entry.slug === extRoute.slug && entry.id === extRoute.id,
		)?.refreshMs;
	}, [extRoute, railExtEntries]);

	// The conversation select ALSO writes the hash (the browser's back
	// returns to the surface the user came from).
	const onSelectWithRoute = useCallback(
		(id: number): void => {
			writeHash(`#/c/${id}`);
			setRoute({ kind: "chat" });
			onSelect(id);
		},
		[onSelect],
	);
	// The conversation sidebar's select routes through the hash writer
	// (browser back returns to a surface the user came from); the
	// SessionList + transcript navigate callbacks use the SAME seam.
	void onSelectWithRoute;

	// Boot-time default: select the root conversation (the §5 default session)
	// once the schema gate passes and the lifted list has rows, so the
	// composer is live without a click. An /ext hash route SUPPRESSES the
	// default (the user asked for a surface, not a conversation).
	useEffect(() => {
		if (boot.status !== "ready" || activeId !== null) return;
		if (route.kind === "ext") return;
		if (list.rows.length === 0) return;
		const root = list.rows.find((c) => c.root);
		const first = root ?? list.rows[0];
		// Re-check activeId inside the callback: a user click that landed while
		// the list was in flight wins over the boot default (the T26b review's
		// clobber race).
		setActiveId((current) => current ?? first?.id ?? null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [boot.status, list.rows, route.kind]);

	// The schema-version gate (spec §5): no shell renders until /v1/meta
	// answers with the pinned schema. A mismatch — or an unverifiable fetch —
	// is an explicit refusal, never a half-rendered wrong-contract UI.
	useEffect(() => {
		let cancelled = false;
		client
			.getMeta()
			.then((meta) => {
				if (cancelled) return;
				if (meta.schemaVersion !== PINNED_SCHEMA_VERSION) {
					setBoot({
						status: "refused",
						message:
							`schema mismatch: the server speaks schema ${meta.schemaVersion} ` +
							`but this webui bundle is pinned to ${PINNED_SCHEMA_VERSION}. ` +
							"Rebuild and redeploy the bundle against this server (spec §5).",
					});
				} else {
					setBoot({ status: "ready", meta });
				}
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				const detail =
					cause instanceof Error ? cause.message : String(cause);
				setBoot({
					status: "refused",
					message:
						`schema check failed: ${detail}. ` +
						"The wire schema is unverifiable, so the webui refuses to render (spec §5).",
				});
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	// Keep the section in sync with the hash (back/forward navigation).
	useEffect(() => {
		const win = globalThis as {
			addEventListener?: (t: string, l: () => void) => void;
			removeEventListener?: (t: string, l: () => void) => void;
			location?: { hash: string };
		};
		const onHashChange = (): void => {
			// The hash IS the section — force a re-render on change.
			setSectionTick((tick) => tick + 1);
		};
		win.addEventListener?.("hashchange", onHashChange);
		return () => win.removeEventListener?.("hashchange", onHashChange);
	}, []);

	// Conversation writes. Each action lands its write, then reloads the
	// lifted list so the sidebar (and the header title) reflect it at once —
	// the 10 s poll would also catch up, but the user just acted.

	const renameConversation = useCallback(
		async (id: number, name: string): Promise<void> => {
			try {
				await client.patchConversationMeta(id, { name });
				await list.reload();
				setShellError(null);
			} catch (cause) {
				setShellError(
					`rename failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			}
		},
		[client, list.reload],
	);

	// The header's inline rename targets the active conversation.
	const onRename = useCallback(
		async (name: string): Promise<void> => {
			if (activeId === null) return;
			await renameConversation(activeId, name);
		},
		[activeId, renameConversation],
	);

	const archiveConversation = useCallback(
		async (id: number, archived: boolean): Promise<void> => {
			try {
				await client.patchConversationMeta(id, { archived });
				await list.reload();
				setShellError(null);
			} catch (cause) {
				setShellError(
					`archive failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			}
		},
		[client, list.reload],
	);

	const onFork = useCallback(
		(id: number): void => {
			client
				.fork(id)
				.then(async (created) => {
					await list.reload(); // the fork row (nested under its parent)
					onSelect(created.id); // navigate to the new conversation
					setShellError(null);
				})
				.catch((cause: unknown) =>
					setShellError(
						`fork failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
			);
		},
		[client, list.reload, onSelect],
	);

	const onNew = useCallback((): void => {
		client
			.createConversation()
			.then(async (created) => {
				await list.reload();
				onSelect(created.id);
				setShellError(null);
			})
			.catch((cause: unknown) =>
				setShellError(
					`new conversation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			),
		);
	}, [client, list.reload, onSelect]);

	const onExport = useCallback((): void => {
		if (activeId === null) return;
		client
			.exportConversation(activeId)
			.then((jsonl) => {
				downloadText(`sigrun-conversation-${activeId}.jsonl`, jsonl);
				setShellError(null);
			})
			.catch((cause: unknown) =>
				setShellError(
					`export failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
			);
	}, [activeId, client]);

	const onCompact = useCallback((): void => {
		if (activeId === null) return;
		client
			.compact(activeId)
			.then(() => setShellError(null))
			.catch((cause: unknown) =>
				setShellError(
					`compact failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
			);
	}, [activeId, client]);

	// The header's archive action targets the active conversation.
	const onArchive = useCallback((): void => {
		if (activeId === null) return;
		void archiveConversation(activeId, true);
	}, [activeId, archiveConversation]);

	if (boot.status === "loading") {
		return (
			<div className="app-boot">
				<p>sigrun — checking the wire schema…</p>
			</div>
		);
	}
	if (boot.status === "restarting") {
		return (
			<div className="app-boot" role="status">
				<p>sigrun — Restarting…</p>
			</div>
		);
	}
	if (boot.status === "refused") {
		return (
			<div className="app-refused" role="alert">
				<h1>sigrun — refusing to render</h1>
				<p>{boot.message}</p>
			</div>
		);
	}

	return (
		<div className="app-root">
			<div
				className="side-drawer"
				data-open={drawerOpen ? "" : undefined}
			>
				<Rail
					meta={boot.meta}
					onOpenSettings={() => setSettingsOpen(true)}
					onOpenGallery={
						boot.meta.dev
							? () => {
								(
									globalThis as {
										history?: { pushState(a: null, b: string, c: string): void };
									}
								).history?.pushState(null, "", "#/blocks");
								setSectionTick((tick) => tick + 1);
							}
							: undefined
					}
					identity={identity}
					hiddenExtSurfaces={hiddenExtSurfaces}
					onOpenExtView={onOpenExtView}
					extViewEntries={railExtEntries}
					onMoveExtView={onMoveExtView}
					onLogout={
						onLogout === undefined
							? undefined
							: () => {
								// End the server session, then hand the flip back — a
								// failed logout call still signs the UI out (the cookie
								// is best-effort dead either way).
								void client
									.logout()
									.catch(() => undefined)
									.finally(() => onLogout());
							}
					}
				/>
				{list.error !== null && (
					<p className="side-error" role="alert">
						conversations unavailable: {list.error}
					</p>
				)}
				<SessionList
					rows={list.rows}
					activeId={activeId}
					onSelect={onSelect}
					onNew={onNew}
					onRename={renameConversation}
					onArchive={archiveConversation}
					onFork={onFork}
					currentUser={identity?.user}
					onShare={setShareFor}
				/>
			</div>
			{section === "blocks" ? (
				<main className="main-column">
					<GalleryView />
				</main>
			) : (
			<main className="main-column">
				<ChatHeader
					title={titleOf(list.rows, activeId)}
					timeline={timeline}
					onTimeline={() =>
						setTimeline((on) => {
							persistTimeline(!on);
							return !on;
						})
					}
					panel={panel}
					onPanel={onPanel}
					onRename={onRename}
					onExport={onExport}
					onCompact={onCompact}
					onArchive={onArchive}
					drawerOpen={drawerOpen}
					onToggleDrawer={() => setDrawerOpen((open) => !open)}
				/>
				{shellError !== null && (
					<p className="shell-error" role="alert">
						{shellError}
					</p>
				)}
				<div className="main-body">
					{extRoute !== null && extTransport !== undefined ? (
						<SurfacePage
							// The key joins the instance identity + the watcher
							// stream id: a NEW hello (a reconnect) remounts the
							// page, whose load re-registers the new stream's
							// watcher entry (spec §7.3's reconnect rule).
							key={`${extRoute.slug}/${extRoute.id}/${list.streamId ?? "pre-hello"}`}
							slug={extRoute.slug}
							id={extRoute.id}
							hub={extHub}
							transport={extTransport}
							onNavigate={(action) => {
								const target = action.target;
								// The params-only form re-renders THIS surface
								// with new params (a new hash entry).
								if (action.params !== undefined) {
									const next: Route = {
										kind: "ext",
										slug: extRoute.slug,
										id: extRoute.id,
										params: action.params,
									};
									writeHash(routeHash(next));
									setRoute(next);
									return;
								}
								// A core target (spec §6.1): conversation opens the
								// chat route + selects; job opens the jobs panel;
								// settings opens the dialog; view re-routes to that
								// extension view. An inaccessible target renders the
								// usual not-found (the surface page's own access
								// resolution — the shell never pre-checks).
								if (target !== undefined && target !== null && typeof target === "object") {
									if ("conversation" in target && typeof target.conversation === "number") {
										writeHash("#/c");
										setRoute({ kind: "chat" });
										onSelect(target.conversation);
										return;
									}
									if ("job" in target) {
										writeHash("#/c");
										setRoute({ kind: "chat" });
										setPanel("jobs");
										persistPanel("jobs");
										return;
									}
									if ("settings" in target) {
										setSettingsOpen(true);
										return;
									}
									if ("view" in target && target.view !== null && typeof target.view === "object") {
										const view = target.view as { extension: string; id: string; params?: JsonObject };
										const next: Route = {
											kind: "ext",
											slug: view.extension,
											id: view.id,
											params: view.params ?? {},
										};
										writeHash(routeHash(next));
										setRoute(next);
									}
								}
							}}
							{...(extRefreshMs === undefined ? {} : { refreshMs: extRefreshMs })}
						/>
					) : (
					<div className="chat-column">
						<ChatCenter
							activeId={activeId}
							view={view}
							status={status}
							error={error}
							showThinking={prefsState.prefs.showThinking}
							timeline={timeline}
							client={client}
							onNavigate={onSelect}
							parent={parent}
							onScrollRoot={setScrollRoot}
							dockPadding={dockPadding}
						/>
						{/* The scroll fade (B5): the pointer-events-none gradient +
						    mask + 1.5px blur band over the transcript bottom, under the
						    composer dock that overlays the scroll area. */}
						<div className="chat-fade" aria-hidden="true" />
						<footer className="composer-slot" ref={dockRef}>
							<Composer
								client={client}
								conversationId={activeId}
								view={view}
								onNavigate={onSelect}
								enterToSend={prefsState.prefs.enterToSend}
								readOnly={
									list.rows.find((row) => row.id === activeId)?.access ===
									"read"
								}
							/>
						</footer>
					</div>
					)}
			<RightPanel
				mode={panel}
				extPanels={extPanelEntries(boot.meta.extensions)}
				activeExtPanel={extPanel}
				onOpenExtPanel={(slug, id) => {
					setExtPanel(`${slug}/${id}`);
				}}
				{...(extPanelParts !== null && extPanelTransport !== undefined
					? {
							extContent: (
								<ExtPanelHost
									key={extPanel}
									slug={extPanelParts.slug}
									id={extPanelParts.id}
									transport={extPanelTransport}
									{...(panelRefreshMs === undefined
										? {}
										: { refreshMs: panelRefreshMs })}
								/>
							),
						}
					: {})}
				outline={
					<OutlinePanel scrollRoot={scrollRoot} turns={outlineTurns} />
				}
				workspace={
					<WorkspaceBrowser
						client={client}
						conversationId={activeId}
							onClose={closePanel}
					/>
				}
				jobs={
					<JobsPanel
						client={client}
						onNavigate={onSelect}
						refreshToken={jobChanged}
					/>
				}
			/>
				</div>
			</main>
			)}
			{/* The ≤900px overlays' backdrops (CSS: hidden at desktop widths).
			    The drawer covers the header toggle while open; the panel is a
			    fixed overlay — click-outside closes both. */}
			{drawerOpen && (
				<div
					className="drawer-backdrop"
					onClick={() => setDrawerOpen(false)}
					aria-hidden="true"
				/>
			)}
			{panel !== null && (
				<div
					className="panel-backdrop"
					onClick={closePanel}
					aria-hidden="true"
				/>
			)}
			{settingsOpen && (
				<SettingsPanel
					client={client}
					prefsState={prefsState}
					theme={theme}
					admin={identity?.admin}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{/* The share editor overlay (spec §5.9): the sidebar's owner-only
			    Share… action targets a row; the backdrop click closes. */}
			{shareFor !== null &&
				(() => {
					const row = list.rows.find((item) => item.id === shareFor);
					return row === undefined ? null : (
						<div
							className="share-overlay"
							onClick={(event) => {
								if (event.target === event.currentTarget) setShareFor(null);
							}}
						>
							<ShareMenu
								client={client}
								conversation={row}
								onClose={() => setShareFor(null)}
								onSaved={() => {
									void list.reload();
								}}
							/>
						</div>
					);
				})()}
		</div>
	);
}

/**
 * The restart-remount wrapper (U4 Task 2, spec §13.3): AppShell's
 * `onRestarting` flips this wrapper's state, which swaps AppShell's
 * React `key` — the recovery (or a repeated restart) remounts the whole
 * shell, so every boot effect (the schema gate's meta fetch among them)
 * re-runs by construction rather than by dep-array gymnastics.
 */
export function App(options: AppOptions = {}): ReactElement {
	const [generation, setGeneration] = useState(0);
	return (
		<AppShell
			key={generation}
			{...options}
			onRestarting={() => setGeneration((g) => g + 1)}
		/>
	);
}
