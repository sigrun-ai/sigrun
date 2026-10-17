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
 * refreshes the approvals strip.
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { displayName } from "../../src/shared/conversations.js";
import {
	createClient,
	type ConversationSummary,
	type ConversationViewWire,
	type MetaResponse,
	type SigrunClient,
} from "./api";
import { Composer } from "./composer/Composer";
import { TurnList } from "./entries/TurnList";
import {
	liveCompactionFailure,
	liveCompactions,
} from "./entries/liveDoc";
import { ChatHeader, type PanelMode } from "./layout/ChatHeader";
import { Rail } from "./layout/Rail";
import { RightPanel } from "./layout/RightPanel";
import { PINNED_SCHEMA_VERSION } from "./schema-version";
import { SessionList } from "./sessions/SessionList";
import { useConversationList } from "./sessions/useConversationList";
import { SettingsPanel } from "./settings/SettingsPanel";
import { usePrefs, type PrefsState } from "./settings/usePrefs";
import type { EventSourceFactory } from "./stream";
import { useTheme } from "./theme/useTheme";
import { useConversationView } from "./useConversationView";
import { WorkspaceBrowser } from "./workspace/WorkspaceBrowser";

/** The boot state machine: meta fetch → schema gate → shell. */
type Boot =
	| { readonly status: "loading" }
	| { readonly status: "refused"; readonly message: string }
	| { readonly status: "ready"; readonly meta: MetaResponse };
/** The default client (same-origin); tests inject a stub-backed one. */
const defaultClient = createClient();

const PANEL_STORAGE_KEY = "sigrun.panel";

/** Load the persisted panel mode; garbage/absent → null (closed). */
function loadPanel(): PanelMode | null {
	const stored = (
		globalThis as { localStorage?: { getItem(key: string): string | null } }
	).localStorage;
	try {
		const value = stored?.getItem(PANEL_STORAGE_KEY) ?? null;
		return value === "outline" || value === "workspace" ? value : null;
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
}

function ChatCenter(props: {
	activeId: number | null;
	view: ConversationViewWire | null;
	status: string;
	error: string | null;
	readonly showThinking: boolean;
	readonly client: SigrunClient;
	readonly onNavigate: (id: number) => void;
	readonly parent?: { id: number; name: string };
}) {
	const { activeId, view, status, error, showThinking } = props;
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
		>
			{error !== null && <p role="alert">{error}</p>}
			{view === null ? (
				<p className="chat-loading">loading…</p>
			) : (
				<>
					<TurnList
						view={view}
						showThinking={showThinking}
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

export function App(options: AppOptions = {}) {
	const client = options.client ?? defaultClient;
	useTheme();
	const prefsState: PrefsState = usePrefs();
	const [boot, setBoot] = useState<Boot>({ status: "loading" });
	const [activeId, setActiveId] = useState<number | null>(null);
	const [panel, setPanel] = useState<PanelMode | null>(loadPanel);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [shellError, setShellError] = useState<string | null>(null);
	const { view, status, error } = useConversationView(activeId, {
		createEventSource: options.createEventSource,
	});
	// The LIFTED conversation list (B3): one hook owns the rows for the
	// sidebar, the header title, and the transcript's fork parents. `busy`
	// (the view's steer state) drives the post-run reloads — a name the
	// auto-namer writes at settlement appears without a manual reload.
	const list = useConversationList(client, {
		busy: view?.steer.busy ?? false,
	});
	// The transcript's fork lineage (B4): the active conversation's fork
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

	// Boot-time default: select the root conversation (the §5 default session)
	// once the schema gate passes and the lifted list has rows, so the
	// composer is live without a click.
	useEffect(() => {
		if (boot.status !== "ready" || activeId !== null) return;
		if (list.rows.length === 0) return;
		const root = list.rows.find((c) => c.root);
		const first = root ?? list.rows[0];
		// Re-check activeId inside the callback: a user click that landed while
		// the list was in flight wins over the boot default (the T26b review's
		// clobber race).
		setActiveId((current) => current ?? first?.id ?? null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [boot.status, list.rows]);

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

	// Conversation writes. Each action lands its write, then reloads the
	// lifted list so the sidebar (and the header title) reflect it at once —
	// the 10 s poll would also catch up, but the user just acted.

	const renameConversation = useCallback(
		async (id: number, name: string): Promise<void> => {
			try {
				await client.patchConversationMeta(id, { name });
				await list.reload();
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
			.then((jsonl) => downloadText(`sigrun-conversation-${activeId}.jsonl`, jsonl))
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
				/>
			</div>
			<main className="main-column">
				<ChatHeader
					title={titleOf(list.rows, activeId)}
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
					<div className="chat-column">
						<ChatCenter
							activeId={activeId}
							view={view}
							status={status}
							error={error}
							showThinking={prefsState.prefs.showThinking}
							client={client}
							onNavigate={onSelect}
							parent={parent}
						/>
						<footer className="composer-slot">
							<Composer
								client={client}
								conversationId={activeId}
								view={view}
								onNavigate={onSelect}
								enterToSend={prefsState.prefs.enterToSend}
							/>
						</footer>
					</div>
					<RightPanel
						mode={panel}
						outline={
							<div className="right-panel-body">
								<h4 className="right-panel-title">Outline</h4>
							</div>
						}
						workspace={
							<WorkspaceBrowser
								client={client}
								conversationId={activeId}
								onClose={closePanel}
							/>
						}
					/>
				</div>
			</main>
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
					onClose={() => setSettingsOpen(false)}
				/>
			)}
		</div>
	);
}
