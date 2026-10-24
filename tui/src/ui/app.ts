/**
 * The TUI shell (Task 6): sidebar left, conversation pane right, composer
 * footer — pi's idiom over the Task 4 client layers.
 *
 * File naming (the controller's pick-one ruling): plain `.ts` — pi-tui is
 * not React (components are `render(width): string[]` classes), so the
 * plan's `app.tsx` alternative does not apply.
 *
 * Layout: {@link TuiApp} is a `VStack`: the body row (`HStack`: sidebar
 * at a fixed basis, pane growing), then the interaction seam's prompt
 * strip (Task 8 — the pending stack, answerable via ctrl+o + digits), then
 * the ambient chrome (panel/footer/statusline zones by the record's
 * `place`). Both strips collapse to zero height when empty. The composer
 * is a pi-tui `Editor` the launcher mounts after the app on the TUI root —
 * pi's idiom is `TuiMainScreen` (the terminal owns scrollback; chat content
 * scrolls, the editor anchors the bottom as the last child). Viewport
 * `VStack`/`ScrollView` layouts are alt-screen-only (pi-tui 1.3.0), so the
 * footer composition lives in the launcher, not the app component.
 *
 * Wiring: the sidebar refreshes from `listConversations()`; selecting a
 * conversation swaps the pane's `watchConversation` subscription (the old
 * watch is closed before the new one opens); stream frames REPLACE the
 * pane (the SSE contract — a snapshot subsumes missed frames); the
 * composer submits fire-and-forget via `submit(id, text)` — the stream is
 * the source of truth for the reply (spec §10's composer rule). The fork
 * action (`forkActive`, driven by the `/fork` slash command; task C3's
 * action layer reintroduces a keybinding) calls
 * `forkConversation(id)` at the latest entry (the v1 default, spec §8),
 * refreshes the sidebar, and switches to the fork.
 *
 * Composer behaviors (Task 7): the composer tracks the wire's `steer.busy`
 * per frame; submitting while busy sends `whenBusy: "steer"`. Esc during a
 * live run aborts (the binding rides the launcher's pre-editor global
 * listener through {@link handleKeybinding} — pi-tui 1.3.0's `Editor` has
 * no escape hook of its own). A `/`-prefixed line routes through the
 * slash-command catalog (`getCommands()`, fetched once and cached by
 * {@link SlashCatalog}); unknown commands render a clear error. The POST's
 * immediate failure (4xx) and the abort outcomes render as pane
 * error/notice lines — the pane keeps rendering the reply off the stream.
 *
 * Sidebar focus (fix wave F2): the sidebar is the switcher (spec §2), so it
 * must be keyboard-reachable — ctrl+b toggles key routing between the
 * composer and the conversation list; a selection (or a second ctrl+b)
 * returns keys to the composer. Guarded actions (fix wave F1): every
 * fire-and-forget mutation path (`+ new`, conversation select, ctrl+f
 * fork) catches its rejection into a pane error line — a flaky remote must
 * never crash the process on an unhandled rejection.
 */

import {
	Editor,
	HStack,
	Key,
	matchesKey,
	VStack,
	type Component,
	type EditorTheme,
	type SelectListTheme,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ConversationViewWire, ModelEntry, SigrunClient, SlashCommand, WhenBusyMode } from "../api.js";
import { SigrunApiError } from "../api.js";
import type { JsonObject } from "@sigrun/shared/blocks";
import {
	ExtSurfaceHub,
	surfaceKeyHash,
	transportKey,
	type ExtSurfaceTransportHandle,
} from "../blocks/ext-transport.js";
import { watchConversation, type Unwatch, type WatchHandlers, type WatchOptions } from "../sse.js";
import { spawnSync } from "node:child_process";
import { plainTuiTheme, type TuiTheme } from "../theme.js";
import type { Action, ActionHost, Focus } from "../actions.js";
import { editInVim, resolveVimEditor } from "../editor-launch.js";
import { copyToTerminal } from "../clipboard.js";
import {
	commandInsertText,
	describeCommandError,
	isSkillCommandName,
	parseSlashInput,
	SlashCatalog,
} from "./composer.js";
import { AmbientChrome } from "./ambient.js";
import { ConversationPane } from "./conversation-pane.js";
import { InteractionPrompter } from "./interactions.js";
import { SettingsView } from "./settings.js";
import { openPicker, type PickerItem } from "./picker.js";
import { Sidebar } from "./sidebar.js";
import type { StatusBar } from "./status-bar.js";

/** The watch injection seam (tests stub it; the launcher uses the real one). */
export type WatchFn = (
	conversationId: number,
	handlers: WatchHandlers,
	options: WatchOptions,
) => Unwatch;

/**
 * How long the restart-recovery poll waits for /readyz before giving up
 * with a permanent error (U4 Task 2, spec §13.3). DUPLICATE of the
 * webui's `RESTART_READYZ_DEADLINE_MS` (webui/src/App.tsx) by design:
 * the tui package consumes only `@sigrun/shared` wire types (NodeNext,
 * no codegen), and a shared-module move for one number is not worth the
 * coupling — keep the two in sync by hand.
 */
export const RESTART_READYZ_DEADLINE_MS = 60_000;

export interface TuiAppOptions {
	/** The pi-tui instance (the Editor needs it for height-aware scrolling). */
	readonly tui: TUI;
	/** The stream watcher; defaults to Task 4's `watchConversation`. */
	readonly watch?: WatchFn;
	/** The watcher's transport options (baseUrl + user); defaults to none. */
	readonly watchOptions?: WatchOptions;
	/** The sidebar's fixed column basis (default 24). */
	readonly sidebarWidth?: number;
	/** The token theme (C1/C2); defaults to the plain identity fallback. */
	readonly theme?: TuiTheme;
	/** The tui.json `editor` field (C1; used when it names a vim binary). */
	readonly editor?: string;
	/** TEST SEAM: the vim resolution for edit-in-vim (C4). */
	readonly resolveVim?: () => string | undefined;
	/**
	 * The restart-recovery poll cadence (U4 Task 2, spec §13.3): the
	 * `/readyz` probe interval after `restart()` — default 500 ms; the
	 * tests shorten it.
	 */
	readonly restartPollMs?: number;
	/**
	 * TEST SEAM (U4 Task 2 round-2): the restart-recovery deadline —
	 * how long the poll waits for /readyz before surfacing the stalled
	 * restart as a permanent error notice. Default
	 * {@link RESTART_READYZ_DEADLINE_MS}; the deadline test shortens it.
	 */
	readonly restartDeadlineMs?: number;
}

/** PATH lookup for the vim fallback chain (nvim/vim/vi). */
function whichPath(name: string): string | undefined {
	const result = spawnSync("which", [name], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	return result.stdout.trim().split("\n")[0] || undefined;
}

/** No-color theme: the shell pins structure; styling is a later task. */
function plainEditorTheme(): EditorTheme {
	const identity = (text: string): string => text;
	const selectList: SelectListTheme = {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	};
	return { borderColor: identity, selectList };
}

/**
 * The `pi.agent` doc (pi-durable's AgentState), narrowed to the
 * configured surface the status bar and thinking cycle read — the same
 * source the webui's Composer uses.
 */
interface AgentDocWire {
	readonly model?: {
		readonly provider: string;
		readonly modelId: string;
	};
	readonly thinkingLevel?: string;
}

export class TuiApp implements Component, ActionHost {
	readonly #client: SigrunClient;
	/** The extension-surface transport hub (U3 Task 5): one per app —
	 *  `openExtView`'s transport subscribes through it; the launcher
	 *  dispatches `surface.changed` events into it. */
	readonly #extHub = new ExtSurfaceHub();
	/** The open extension view (the main pane's surface state). The
	 *  HANDLE (not the bare transport): a reconnect's new stream id
	 *  lands via setStreamId without re-creating the transport. */
	#extView: {
		readonly slug: string;
		readonly id: string;
		readonly handle: ExtSurfaceTransportHandle;
	} | undefined;
	/** The app's theme (the settings view's SurfaceView reuses it). */
	readonly #theme: TuiTheme;
	/** Unicode glyphs (the settings view's SurfaceView). Pinned true,
	 *  matching the blocks tests' default; a terminal-capability
	 *  downgrade is the theme system's call when it lands one. */
	readonly #unicode: boolean = true;
	/** The open settings view (U4 Task 4; `/settings` opens, Esc closes). */
	#settingsView: SettingsView | undefined;
	readonly #watch: WatchFn;
	readonly #watchOptions: WatchOptions;

	/** The sidebar (the app mounts it; tests drive it). */
	readonly sidebar: Sidebar;
	/** The conversation pane (the stream replaces its contents). */
	readonly pane: ConversationPane;
	/** The composer (the launcher mounts it after the app + focuses it). */
	readonly editor: Editor;
	/** The interaction seam's prompt strip (Task 8; zero height when empty). */
	readonly interactions: InteractionPrompter;
	/** The ambient seam's chrome zones (Task 8; zero height when empty). */
	readonly ambient: AmbientChrome;

	readonly #body = new HStack();
	readonly #layout = new VStack();
	#activeId: number | undefined;
	#unwatch: Unwatch | undefined;
	/** Monotonic watch generation: a stale watch's frames must never land. */
	#watchGen = 0;
	/** The last frame's `steer.busy` — the steer gate for the next submit. */
	#busy = false;
	/** The slash-command catalog (session-cached snapshot, live-rechecked
	 * on a miss — see SlashCatalog). */
	readonly #catalog: SlashCatalog;
	/** The repainting surface (pickers, copy flashes, redraw). */
	readonly #tui: TUI;
	/** The status bar sink the launcher mounts (notices, flashes, hints). */
	#statusBar: StatusBar | undefined;
	/** The focus region the action layer drives (C3). */
	#focus: Focus = "composer";
	/** A modal overlay (picker/search) owns the keys. */
	#overlayOpen = false;
	/** The quit sink: the launcher's exit resolution. */
	onQuit: (() => void) | undefined;
	/** The status-bar state the launcher last painted (flashes preserve it). */
	#statusSnapshot: { conversation: string; hints: readonly string[]; mode?: string } | undefined;
	/** The transcript search overlay state (query + direction). */
	#search: { query: string; direction: "forward" | "backward" } | undefined;
	/** The last frame's configured model id (status bar + pickers). */
	#modelId: string | undefined;
	/** The last frame's thinking level (the cycle order starts here). */
	#thinkingLevel: string = "off";
	/** The vim resolution for edit-in-vim (C4; configured → env → PATH). */
	readonly #resolveVim: () => string | undefined;
	/** The restart-recovery poll cadence (U4 Task 2). */
	readonly #restartPollMs: number;
	/** The restart-recovery deadline (U4 Task 2 round-2). */
	readonly #restartDeadlineMs: number;
	/** The in-flight restart poll's cancel flag (dispose fences it). */
	#restartGeneration = 0;

	constructor(client: SigrunClient, options: TuiAppOptions) {
		this.#client = client;
		this.#watch = options.watch ?? watchConversation;
		this.#watchOptions = options.watchOptions ?? { baseUrl: "" };
		this.#tui = options.tui;
		this.#catalog = new SlashCatalog(client);
		this.#resolveVim = options.resolveVim ?? (() =>
			resolveVimEditor({ configured: options.editor, env: process.env, which: whichPath }));
		this.#restartPollMs = options.restartPollMs ?? 500;
		this.#restartDeadlineMs =
			options.restartDeadlineMs ?? RESTART_READYZ_DEADLINE_MS;
		const theme = options.theme ?? plainTuiTheme();
		this.#theme = theme;
		this.sidebar = new Sidebar(client, theme === undefined ? undefined : { theme });
		this.pane = new ConversationPane(theme === undefined ? undefined : { theme });
		this.editor = new Editor(options.tui, plainEditorTheme());
		this.interactions = new InteractionPrompter(client);
		this.ambient = new AmbientChrome(client);

		this.#body.addChild(this.sidebar, {
			basis: options.sidebarWidth ?? 24,
			shrink: 1,
		});
		this.#body.addChild(this.pane, { basis: 0, grow: 1, minSize: 1 });
		// All entries are intrinsic-height (basis "auto"): the TUI mounts
		// the app on the MAIN screen, where render(width) is the production
		// path and the terminal owns scrollback — a numeric basis would be
		// clamped to its minSize and slice the body to one line (VStack
		// render path, no available height).
		this.#layout.addChild(this.#body, { basis: "auto" });
		this.#layout.addChild(this.interactions, { basis: "auto" });
		this.#layout.addChild(this.ambient, { basis: "auto" });

		// Seam state changes repaint; answer failures are user-initiated,
		// so they land as pane error lines (background polls fail quiet).
		const repaint = (): void => options.tui.requestRender();
		this.interactions.onChanged = repaint;
		this.ambient.onChanged = repaint;
		this.interactions.onError = (message) => this.pane.showError(message);

		this.sidebar.onSelect = (selection) => {
			if (selection === "new") {
				void this.createAndSelect();
			} else if (typeof selection === "object") {
				// An extension VIEW (U3 Task 5): open it in the main pane.
				void this.openExtView(selection.view.slug, selection.view.id).catch(
					(error: unknown) => {
						this.pane.showError(describeCommandError("open view", error));
					},
				);
			} else {
				// Caught at the call site (fix wave F1): selectConversation
				// keeps propagating for boot's fail-loud refresh, so the
				// interactive path guards here.
				void this.selectConversation(selection).catch((error: unknown) => {
					this.pane.showError(describeCommandError("select", error));
				});
			}
		};

		this.editor.onSubmit = (text) => {
			this.#submit(text);
		};
	}

	/** The active conversation id (undefined before the first refresh). */
	get activeConversationId(): number | undefined {
		return this.#activeId;
	}

	/** The current /v1/events stream id (the hello frame's payload);
	 *  the ext-view transports send it as X-Sigrun-Stream. */
	#eventsStreamId: string | undefined;

	/** The launcher's hello hook (U3 Task 5): the stream id feeds
	 *  future openExtView transports; an OPEN view's handle gets the
	 *  new id at once (its next fetch re-registers the watcher entry —
	 *  spec §7.3's reconnect rule; the webui twin remounts instead). */
	setEventsStreamId(streamId: string): void {
		this.#eventsStreamId = streamId;
		this.#extView?.handle.setStreamId(streamId);
	}

	/** The open extension view's identity (undefined = the conversation
	 *  pane is the main content). */
	get extView(): { readonly slug: string; readonly id: string } | undefined {
		return this.#extView === undefined
			? undefined
			: { slug: this.#extView.slug, id: this.#extView.id };
	}

	/**
	 * Open an extension VIEW in the main pane (U3 Task 5, spec §7.1):
	 * the sidebar's view selection swaps the pane's content to the
	 * surface's transport. The block renderer is U2's; the app holds
	 * the transport + identity here so U2's mount is one prop pass.
	 */
	async openExtView(slug: string, id: string, params?: JsonObject): Promise<void> {
		const key = transportKey({ slug, id, baseUrl: this.#watchOptions.baseUrl, ...(params === undefined ? {} : { params }) });
		const handle = this.#extHub.attach(
			{
				slug,
				id,
				...(params === undefined ? {} : { params }),
				baseUrl: this.#watchOptions.baseUrl,
				...(this.#watchOptions.user === undefined
					? {}
					: { user: this.#watchOptions.user }),
				...(this.#watchOptions.token === undefined
					? {}
					: { token: this.#watchOptions.token }),
				...(this.#eventsStreamId === undefined
					? {}
					: { streamId: this.#eventsStreamId }),
			},
			surfaceKeyHash(slug, id, key),
		);
		this.#extView = { slug, id, handle };
		this.#tui.requestRender();
	}

	/**
	 * Open the settings view (U4 Task 4, spec §13.4): `/settings` mounts
	 * the SettingsView (the sections list + the search picker over the
	 * index); Esc closes it back to the conversation.
	 */
	async openSettings(): Promise<void> {
		if (this.#settingsView !== undefined) return;
		const view = new SettingsView(this.#client, {
			tui: this.#tui,
			theme: this.#theme,
			unicode: this.#unicode,
			onRestart: async () => {
				await this.restart();
			},
			onClose: () => {
				this.#settingsView = undefined;
				this.#tui.requestRender();
			},
		});
		this.#settingsView = view;
		await view.load();
		this.#tui.requestRender();
	}

	/** The open settings view (tests drive it). */
	get settingsView(): SettingsView | undefined {
		return this.#settingsView;
	}

	/**
	 * Close the open settings view (Esc). Returns true when one was open.
	 */
	closeSettings(): boolean {
		if (this.#settingsView === undefined) return false;
		this.#settingsView.dispose();
		this.#settingsView = undefined;
		this.#tui.requestRender();
		return true;
	}

	/**
	 * Close the open extension view (the Esc/back idiom): the pane
	 * returns to the conversation AND the surface's fetches stop — no
	 * cadence, no keepalive for a surface nobody is looking at (spec
	 * §7.3's stop-when-hidden rule; U2's cadence timer consults this).
	 * Returns true when a view was open (the key was consumed).
	 */
	closeExtView(): boolean {
		if (this.#extView === undefined) return false;
		this.#extView = undefined;
		this.#tui.requestRender();
		return true;
	}

	/** The app-level surface.changed dispatch (the launcher's
	 *  `watchEvents` onEvent routes events here). */
	dispatchSurfaceChanged(event: {
		slug: string;
		id: string;
		k: string;
		rev: number;
		treeRev: number;
	}): void {
		this.#extHub.dispatch(event);
	}

	/** The focused region (the action layer's routing state). */
	get focus(): Focus {
		return this.#focus;
	}

	/** A modal overlay (picker/search) owns the keys. */
	get overlayOpen(): boolean {
		return this.#overlayOpen;
	}

	/** The last frame's `steer.busy` (the keymap's abort gate). */
	get busy(): boolean {
		return this.#busy;
	}

	/**
	 * The launcher's sink: the status bar it mounted (flashes, help, and
	 * the search overlay render through it). `set` also snapshots the
	 * launcher's steady state so a flash can restore it.
	 */
	setStatusBar(statusBar: StatusBar): void {
		this.#statusBar = statusBar;
		const originalSet = statusBar.set.bind(statusBar);
		statusBar.set = (state) => {
			if (state.message === undefined) this.#statusSnapshot = state;
			originalSet(state);
		};
		// The launcher paints the steady state BEFORE attaching (the
		// wrapper never saw it): seed the snapshot from the bar's current
		// state, or flashes/config paints stay dead until the next set.
		const current = statusBar.getState();
		if (current.message === undefined) this.#statusSnapshot = current;
		// The plan's status-bar mouse rule (C3): the MODEL segment opens
		// the model picker, the THINKING segment cycles the level — the
		// same actions as ctrl+p's picker and ctrl+t, through the one
		// dispatch seam.
		statusBar.onModelClick = () => void this.dispatch({ type: "picker", kind: "model" });
		statusBar.onThinkingClick = () => void this.dispatch({ type: "cycle-thinking" });
	}

	/** Flash a transient status-bar message, restoring the steady state. */
	#flashStatus(message: string): void {
		const base = this.#statusSnapshot;
		if (this.#statusBar === undefined || base === undefined) return;
		this.#statusBar.set({ ...base, message });
	}

	/**
	 * The configured model/thinking a frame carries (drives the cycle and
	 * the status bar's model/thinking segments). The source is the
	 * `pi.agent` doc (pi-durable's AgentState) — ConversationRecord is
	 * `{id, parent?}` and carries no model/thinking fields.
	 */
	#trackConfig(wire: ConversationViewWire): void {
		const doc = wire.docs["pi.agent"] as AgentDocWire | undefined;
		if (doc?.model !== undefined) {
			this.#modelId = `${doc.model.provider}/${doc.model.modelId}`;
		}
		if (doc?.thinkingLevel !== undefined) {
			this.#thinkingLevel = doc.thinkingLevel;
		}
		this.#paintConfig();
	}

	/**
	 * Feed the tracked model/thinking to the status bar's segments,
	 * merged into the launcher's steady state (no `message`) so a flash
	 * restores the segments too.
	 */
	#paintConfig(): void {
		const base = this.#statusSnapshot;
		if (this.#statusBar === undefined || base === undefined) return;
		this.#statusBar.set({
			...base,
			...(this.#modelId === undefined ? {} : { model: this.#modelId }),
			thinking: this.#thinkingLevel,
		});
	}

	/**
	 * Refresh the sidebar listing. Boot selects the first conversation;
	 * later refreshes keep the current selection.
	 */
	async refresh(): Promise<void> {
		await this.sidebar.refresh();
		if (this.#activeId === undefined) {
			const first = this.sidebar.rows[0];
			if (first !== undefined) {
				await this.selectConversation(first.id);
			}
		} else {
			this.sidebar.setActive(this.#activeId);
		}
	}

	/**
	 * Swap the pane to `id`: close the old watch, open the new one. The
	 * composer is disabled for the swap's duration (review finding): a
	 * submission must never split from the pane it was typed against, so
	 * Enter cannot fire `onSubmit` mid-swap (pi-tui's `disableSubmit`
	 * gates the submit path).
	 */
	async selectConversation(id: number): Promise<void> {
		if (id === this.#activeId) return;
		this.editor.disableSubmit = true;
		try {
			this.#unwatch?.();
			this.#unwatch = undefined;
			this.#activeId = id;
			// Busy state is per-frame: unknown for the new conversation until
			// its first frame arrives.
			this.#busy = false;
			this.sidebar.setActive(id);
			// Notices are per-conversation context (fix wave F4): an error
			// from the OLD conversation must never render in the new one.
			// The clear happens when the NEW watch installs (below): clearing
			// here — at selection time — would race the fork/create action
			// that LED to the swap (fix wave A1's /fork notice must survive
			// into the fork's pane).
			// Generation guard (review finding): a frame already in flight
			// from the JUST-closed watch can still deliver after the swap;
			// without a per-watch token it would land in the new
			// conversation's pane. The guard also fences error callbacks,
			// which carry no conversation id.
			const gen = ++this.#watchGen;
			// Fix wave A6: the swap repaints immediately — notice rows drop
			// and the pane swaps to the empty view (the stream's fresh
			// snapshot is the real first revision; a wholesale replacement
			// is the pane's own idiom, and the container is in entry order,
			// so dropping notice rows mid-list would leave a hole).
			this.pane.clearNotices();
			this.pane.showView(this.#emptyView(id));
			this.#unwatch = this.#watch(
				id,
				{
					onSnapshot: (wire) => {
						if (gen !== this.#watchGen) return;
						this.#busy = wire.steer.busy;
						this.#trackConfig(wire);
						// A revision may change the seam state: re-poll the
						// pending interactions; the ambient chrome tracks the
						// run state for its expires:"idle" surfaces.
						this.interactions.kick();
						this.ambient.setBusy(wire.steer.busy);
						this.pane.showView(wire);
					},
					onView: (wire) => {
						if (gen !== this.#watchGen) return;
						this.#busy = wire.steer.busy;
						this.#trackConfig(wire);
						this.interactions.kick();
						this.ambient.setBusy(wire.steer.busy);
						this.pane.showView(wire);
					},
					onError: (message) => {
						if (gen === this.#watchGen) this.onWatchError?.(message);
					},
					onOpen: () => {
						if (gen === this.#watchGen) this.onWatchOpen?.();
					},
				},
				this.#watchOptions,
			);
			this.interactions.setConversation(id);
			this.ambient.setConversation(id);
		} finally {
			this.editor.disableSubmit = false;
		}
	}

	/** The pre-snapshot pane state on a swap (fix wave A6): no entries,
	 * not busy — the stream's fresh snapshot is the real first revision. */
	#emptyView(id: number): ConversationViewWire {
		// SAFETY: a structural stub — ConversationViewWire's full shape is
		// server-built; the pane reads only conversation.id + entries.
		return {
			conversation: { id },
			entries: [],
			docs: {},
			steer: { busy: false, queued: 0 },
		} as unknown as ConversationViewWire;
	}

	/**
	 * Stream-error sink: the launcher wires this to the stream-health
	 * notices (fix wave F5 — "stream: disconnected" on the first failure,
	 * "stream: reconnected" on the next open). The generation guard above
	 * fences STALE watches' errors so they can't reach whatever is mounted
	 * here.
	 */
	onWatchError?: (message: string) => void;

	/**
	 * Stream-open sink (fix wave F5): fires on every (re)connect of the
	 * CURRENT watch — the recovery half of the launcher's stream-health
	 * notices. Generation-guarded like {@link onWatchError}.
	 */
	onWatchOpen?: () => void;

	/** Create a conversation (`+ new`), refresh the sidebar, select it. */
	async createAndSelect(): Promise<void> {
		// The submit guard spans the WHOLE async swap: the awaits below are
		// the window where an Enter would otherwise target the old id.
		this.editor.disableSubmit = true;
		try {
			const created = await this.#client.createConversation();
			await this.sidebar.refresh();
			await this.selectConversation(created.id);
		} catch (error: unknown) {
			// Fix wave F1: every fire-and-forget caller (`+ new`, `/new`) is
			// void-ed — a rejection must surface as a pane error, never an
			// unhandled rejection that kills the process.
			this.pane.showError(describeCommandError("new", error));
		} finally {
			this.editor.disableSubmit = false;
		}
	}

	/**
	 * Fork the active conversation at the latest entry (the v1 default,
	 * spec §8), refresh the sidebar, and switch to the fork. No-op with no
	 * active conversation.
	 */
	async forkActive(): Promise<void> {
		if (this.#activeId === undefined) return;
		this.editor.disableSubmit = true;
		try {
			const forked = await this.#client.forkConversation(this.#activeId);
			await this.sidebar.refresh();
			await this.selectConversation(forked.id);
		} catch (error: unknown) {
			// Fix wave F1 (see createAndSelect).
			this.pane.showError(describeCommandError("fork", error));
		} finally {
			this.editor.disableSubmit = false;
		}
	}

	/**
	 * The launcher's global keybinding seam: ctrl+o enters the interaction
	 * seam's answer mode; Esc during a live run aborts it (the composer
	 * idiom — the launcher routes input through here before the editor sees
	 * it, so Esc while busy never reaches the editor). Returns true when the
	 * key was consumed. Task C1b removed ctrl+b (sidebar focus) and ctrl+f
	 * (fork): task C3's action layer reintroduces navigation — until then
	 * the mouse drives the sidebar and `/fork` carries the fork.
	 */
	handleKeybinding(data: string): boolean {
		// The search overlay owns every key while open (C3).
		if (this.#search !== undefined) {
			return this.#handleSearchKey(data);
		}
		// A modal overlay (picker) owns the keys: the pre-keymap seams
		// below (answer mode, ctrl+o, busy Esc) must never fire behind it.
		// Returning false hands the key to the keymap, which passes
		// everything but ctrl+c through to the focused overlay.
		if (this.#overlayOpen) return false;
		// Answer mode captures the prompt's keys first (Task 8): esc here
		// exits answer mode — it must NOT reach the busy-abort below.
		if (this.interactions.answerMode) {
			if (this.interactions.handleKey(data)) return true;
		}
		// ctrl+o enters answer mode (ctrl+a is the editor's cursorLineStart).
		// Not consumed when nothing answerable is pending — the key falls
		// through to the editor.
		if (matchesKey(data, Key.ctrl("o"))) {
			return this.interactions.beginAnswer();
		}
		// The settings view owns its keys while open (U4 Task 4): Esc
		// closes an open section first, then the view; `/` opens the
		// search picker over the sections index.
		if (this.#settingsView !== undefined) {
			if (matchesKey(data, Key.escape)) {
				if (this.#settingsView.closeSection()) return true;
				return this.closeSettings();
			}
			if (data === "/" && this.#settingsView.openSectionId === undefined) {
				this.#settingsView.openSearch();
				return true;
			}
			this.#settingsView.handleInput(data);
			return true;
		}
		if (matchesKey(data, Key.escape) && this.#busy && this.#activeId !== undefined) {
			this.#abortActive();
			return true;
		}
		// Esc closes an open extension view — back to the
		// conversation pane; the surface's fetches stop (the keepalive
		// stops with the view, spec §7.3's stop-when-hidden).
		if (matchesKey(data, Key.escape) && this.#extView !== undefined) {
			return this.closeExtView();
		}
		return false;
	}

	/**
	 * Fire-and-forget submit (the stream carries the reply, spec §10). While
	 * the last frame reported a live run, the input goes as a steer
	 * (`whenBusy`, spec §7 item 3). The POST's own failure (an immediate 4xx
	 * — Review Focus 2) is the only thing awaited, and it lands as a pane
	 * error line; the composer never wedges on it.
	 */
	#submit(text: string): void {
		// Belt to the editor's own gate: pi-tui checks `disableSubmit` in
		// handleInput, not in the onSubmit callback — a programmatic
		// onSubmit during a swap must no-op too, and never destroy a draft.
		if (this.editor.disableSubmit) return;
		// Guard BEFORE clearing: a no-op submit must never destroy a draft.
		if (text.trim() === "") return;
		if (text.startsWith("/")) {
			// A command line is consumed by its dispatch (even when the
			// outcome is an error line).
			this.editor.setText("");
			void this.#runSlashCommand(text);
			return;
		}
		this.#submitLine(text);
	}

	/** Submit one line as a MESSAGE (the composer's plain path — also the
	 *  expand path, Task 2c: `/skill:name` and prompt-template lines go to
	 *  the server verbatim and are expanded AT ADMISSION, so the client
	 *  never calls an endpoint for them). */
	#submitLine(text: string): void {
		const id = this.#activeId;
		if (id === undefined) return;
		this.editor.setText("");
		const whenBusy: WhenBusyMode | undefined = this.#busy ? "steer" : undefined;
		this.#client.submit(id, text, whenBusy).catch((error: unknown) => {
			this.pane.showError(describeCommandError("submit", error));
		});
	}

	/**
	 * Abort the active conversation's live run (the Esc binding). The
	 * settled race (Review Focus 3) surfaces as a plain notice — the
	 * server's 200 `{result: "settled"}` and its 404 `no_active_submission`
	 * both mean "nothing left to abort"; a landed abort stays silent (the
	 * stream carries the outcome). Anything else is an error line.
	 */
	#abortActive(): void {
		const id = this.#activeId;
		if (id === undefined) return;
		void this.#client.abort(id).then(
			(response) => {
				if (response.result === "settled") {
					this.pane.showNotice("abort: the run had already settled");
				}
			},
			(error: unknown) => {
				if (error instanceof SigrunApiError && error.status === 404) {
					this.pane.showNotice("abort: no active run (already settled)");
					return;
				}
				this.pane.showError(describeCommandError("abort", error));
			},
		);
	}

	/**
	 * Route a `/`-prefixed line through the slash-command catalog. The
	 * catalog tells the composer what exists and where it goes (the server's
	 * thin-registry rule: no server-side execute indirection); the dispatch
	 * itself is the client's typed calls. Unknown commands and catalog
	 * commands the composer cannot drive both render clear errors.
	 */
	async #runSlashCommand(input: string): Promise<void> {
		const parsed = parseSlashInput(input);
		if (parsed === undefined || parsed.name === "") {
			this.pane.showError("empty slash command");
			return;
		}
		let command;
		try {
			command = await this.#catalog.get(parsed.name);
		} catch (error: unknown) {
			this.pane.showError(describeCommandError("getCommands", error));
			return;
		}
		// Live-catalog re-check (fix round): the cached snapshot is a session
		// snapshot — the server re-scans per request, and the command PICKER
		// fetches fresh, so a template the picker just offered must also
		// SUBMIT. One fresh fetch when the cache lacks the name, then the
		// honest unknown-command error if it is still absent.
		if (command === undefined) {
			try {
				command = await this.#catalog.getFresh(parsed.name);
			} catch (error: unknown) {
				this.pane.showError(describeCommandError("getCommands", error));
				return;
			}
		}
		// EXPAND inputs (Task 2c) are submissions, not dispatches: a
		// `kind: "expand"` catalog entry (prompt template, skill) — and ANY
		// `skill:`-prefixed name, known or not (unknown skills pass through
		// server-side) — goes to the server verbatim; expansion happens at
		// admission. Falling through BEFORE the unknown-command error keeps
		// `/skill:nope x` a submission, never a local error.
		if (command?.kind === "expand" || isSkillCommandName(parsed.name)) {
			this.#submitLine(input);
			return;
		}
		if (command === undefined) {
			this.pane.showError(`unknown command: /${parsed.name}`);
			return;
		}
		try {
			switch (parsed.name) {
				case "new":
					await this.createAndSelect();
					return;
				case "archive":
				case "unarchive": {
					const id = this.#activeId;
					if (id === undefined) {
						this.pane.showError(`/${parsed.name} needs an active conversation`);
						return;
					}
					await this.#client.patchMeta(id, { archived: parsed.name === "archive" });
					await this.sidebar.refresh();
					return;
				}
				case "model":
				case "thinking": {
					const id = this.#activeId;
					if (id === undefined) {
						this.pane.showError(`/${parsed.name} needs an active conversation`);
						return;
					}
					if (parsed.args === "") {
						this.pane.showError(`/${parsed.name} needs an argument (${command.argsHint ?? ""})`);
						return;
					}
					const response =
						parsed.name === "model"
							? await this.#client.configure(id, { model: parsed.args })
							: await this.#client.configure(id, { thinking: parsed.args });
					this.#thinkingLevel = response.thinkingLevel;
					if (response.model !== undefined) {
						this.#modelId = `${response.model.provider}/${response.model.modelId}`;
					}
					const model = this.#modelId ?? "no model";
					this.#flashStatus(`model ${model} · thinking ${response.thinkingLevel}`);
					return;
				}
				case "fork": {
					if (this.#activeId === undefined) {
						this.pane.showError("/fork needs an active conversation");
						return;
					}
					const droppedArgs = parsed.args;
					await this.forkActive();
					// The catalog advertises argsHint "[at]", but the composer
					// has no at-entry selection (notice, not support — the fix
					// wave's ruling): the argument is dropped WITH a notice, and
					// the fork still landed at the latest entry. The notice is
					// posted AFTER the fork: forkActive swaps conversations, and
					// the swap clears the pane (fix wave A6), so a notice posted
					// before would be discarded with the old conversation.
					if (droppedArgs !== "") {
						this.pane.showNotice(
							"fork at-entry selection is not supported by the TUI composer; forking at latest",
						);
					}
					return;
				}
				case "compact": {
					const id = this.#activeId;
					if (id === undefined) {
						this.pane.showError("/compact needs an active conversation");
						return;
					}
					await this.#client.compact(
						id,
						parsed.args === "" ? undefined : parsed.args,
					);
					this.pane.showNotice(
						"compaction admitted — the summary arrives on the stream",
					);
					return;
				}
				case "jobs": {
					// W4 Task 5: the job table into the pane's notice area — one
					// row per job (name, next run, last outcome), framed by a
					// header/footer so the list reads as a table, not stray lines.
					const { jobs } = await this.#client.listJobs();
					if (jobs.length === 0) {
						this.pane.showNotice("jobs: none");
						return;
					}
					this.pane.showNotice(
							`jobs: ${jobs.length} (name · next run · last outcome)`,
						);
					for (const job of jobs) {
						const next = job.nextRun ?? "no next run";
						const last = job.lastRun?.outcome ?? "never run";
						this.pane.showNotice(
								`  ${job.name} · ${next} · ${last}`,
						);
					}
					return;
				}
				case "settings": {
					// U4 Task 4: the settings view (sections + the search
					// picker over the index) mounts in the app's main column.
					await this.openSettings();
					return;
				}
				default:
					// An extension-contributed command (W5 Task 3): the catalog entry
					// carries its slug — POST the invoke endpoint and flash the
					// returned notice in the status bar (the client surface for
					// extension notices). A failure rejects through the surrounding
					// catch: the pane error line carries the server's words
					// (`command_failed` + the extension slug).
					if (command.extension !== undefined) {
						const id = this.#activeId;
						if (id === undefined) {
							this.pane.showError(`/${parsed.name} needs an active conversation`);
							return;
						}
						const result = await this.#client.runCommand(id, parsed.name, parsed.args);
						if (result.notice !== undefined) this.#flashStatus(result.notice);
						return;
					}
					this.pane.showError(
						`/${parsed.name} is not supported by the TUI composer`,
					);
			}
		} catch (error: unknown) {
			this.pane.showError(describeCommandError(`/${parsed.name}`, error));
		}
	}

	/** Close the stream subscription + seam pollers (the launcher calls this on exit). */
	dispose(): void {
		this.#unwatch?.();
		this.#unwatch = undefined;
		// Bump the watch generation too (fix wave A9): a handler still
		// held by an unwound delivery must fence after dispose exactly as
		// after a switch — nothing renders post-dispose.
		this.#watchGen += 1;
		this.#restartGeneration += 1;
		this.interactions.dispose();
		this.ambient.dispose();
	}

	/**
	 * The admin restart surface (U4 Task 2, spec §13.3): POST
	 * `/v1/admin/restart`, show the "Restarting…" notice, and poll
	 * `/readyz` — when it answers, the supervisor brought the server
	 * back, so refresh the sidebar (the durable listing) and clear the
	 * notice. A rejected POST (403/409 — no restart began) renders the
	 * error and returns without touching state. Resolves once the
	 * recovery poll ends (recovered or disposed).
	 */
	async restart(): Promise<void> {
		try {
			await this.#client.requestRestart();
		} catch (error: unknown) {
			this.pane.showError(
				describeCommandError("restart", error),
			);
			return;
		}
		this.pane.showNotice("Restarting… — waiting for the server");
		this.#tui.requestRender();
		const generation = this.#restartGeneration;
		const deadline = Date.now() + this.#restartDeadlineMs;
		for (;;) {
			await new Promise((resolve) =>
				setTimeout(resolve, this.#restartPollMs),
			);
			if (generation !== this.#restartGeneration) return;
			let ready = false;
			try {
				ready = await this.#client.checkReady();
			} catch {
				// Connection refused mid-restart: keep polling.
			}
			if (ready) break;
			// The deadline (the webui's RESTART_READYZ_DEADLINE_MS shape):
			// a stalled supervisor must SURFACE, never hang the poll
			// forever — clear the Restarting notice and leave a permanent
			// error naming the failure.
			if (Date.now() > deadline) {
				this.pane.clearNotices();
				this.pane.showError(
					`restart did not come back: /readyz never answered within ${Math.round(this.#restartDeadlineMs / 1000)}s — check the deployment's supervisor`,
				);
				this.#tui.requestRender();
				return;
			}
		}
		// Re-check the generation AFTER the probe: a dispose during the
		// sleep+check must not let the recovery render post-dispose.
		if (generation !== this.#restartGeneration) return;
		// Back: the listing is durable and the stream re-attach subsumes
		// whatever the restart dropped (the SSE reconnect contract).
		await this.sidebar.refresh().catch(() => {});
		this.pane.clearNotices();
		this.pane.showNotice("Restarted.");
		this.#tui.requestRender();
	}

	// ─── The action layer (Task C3) ────────────────────────────────────

	/**
	 * The keymap's context: focus, busy, autocomplete, overlay. The
	 * composer's autocomplete state is internal to pi-tui's Editor (no
	 * public getter), so the flag is a projection — the composer is the
	 * default focus and the editor cancels autocomplete before any
	 * focus-leaving key the keymap would act on.
	 */
	keyContext(): { focus: Focus; busy: boolean; autocompleteOpen: boolean; overlayOpen: boolean } {
		return {
			focus: this.#focus,
			busy: this.#busy,
			autocompleteOpen: false,
			overlayOpen: this.#overlayOpen,
		};
	}

	/** Run one action (the keymap's / pickers' / mouse's single seam). */
	async dispatch(action: Action): Promise<void> {
		switch (action.type) {
			case "focus":
				this.#focus = action.target;
				this.#applyFocusTarget();
				return;
			case "focus-cycle": {
				const order: readonly Focus[] = ["composer", "list", "transcript"];
				const index = order.indexOf(this.#focus);
				this.#focus = order[(index + action.direction + order.length) % order.length]!;
				this.#applyFocusTarget();
				return;
			}
			case "move":
				if (this.#focus === "list") {
					this.sidebar.moveCursor(action.delta);
				} else if (this.#focus === "transcript") {
					this.#moveTranscriptFocus(action.delta);
				}
				return;
			case "page":
				if (this.#focus === "list") {
					this.sidebar.moveCursor(action.direction * 10);
				} else if (this.#focus === "transcript") {
					this.#moveTranscriptFocus(action.direction * 10);
				}
				return;
			case "edge":
				if (this.#focus === "list") {
					this.sidebar.moveCursor(action.to === "top" ? -1_000_000 : 1_000_000);
				} else if (this.#focus === "transcript") {
					this.#moveTranscriptFocus(action.to === "top" ? -1_000_000 : 1_000_000);
				}
				return;
			case "prompt-jump":
				this.#promptJump(action.delta);
				return;
			case "toggle-fold":
				this.#foldFocused();
				return;
			case "open":
				if (this.#focus === "list") this.sidebar.confirm();
				else if (this.#focus === "transcript") this.#foldFocused();
				return;
			case "copy": {
				const index = this.pane.focusIndex;
				if (index === undefined) return;
				copyToTerminal(this.#tui.terminal as Terminal, this.pane.textOf(index));
				this.#flashStatus("Copied");
				return;
			}
			case "fork-here": {
				const id = this.#activeId;
				const index = this.pane.focusIndex;
				if (id === undefined || index === undefined) return;
				this.editor.disableSubmit = true;
				try {
					const forked = await this.#client.forkConversation(id, this.pane.entryIdOf(index));
					await this.sidebar.refresh();
					await this.selectConversation(forked.id);
				} catch (error: unknown) {
					this.pane.showError(describeCommandError("fork", error));
				} finally {
					this.editor.disableSubmit = false;
				}
				return;
			}
			case "edit-here":
				await this.#editHere();
				return;
			case "edit-in-vim":
				this.#editInVim();
				return;
			case "picker":
				this.#openPickerFor(action.kind);
				return;
			case "new-conversation":
				await this.createAndSelect();
				return;
			case "cycle-thinking":
				await this.#cycleThinking();
				return;
			case "search":
				this.#beginSearch(action.direction);
				return;
			case "search-next":
				this.#searchNext(action.reverse);
				return;
			case "answer-interaction":
				if (!this.interactions.answerMode) this.interactions.beginAnswer();
				return;
			case "cancel-run":
				this.#abortActive();
				return;
			case "redraw":
				this.invalidate();
				this.#tui.requestRender(true);
				return;
			case "quit":
				this.onQuit?.();
				return;
			case "help":
				this.#openHelp();
				return;
			case "command-line":
				this.editor.setText("/");
				return;
			case "run-command":
				await this.runCommand(action.line);
				return;
		}
	}

	/**
	 * The key reference overlay (C5): the launcher wires {@link helpOverlay}
	 * to `showHelp(tui, keymap)`. Without the seam the one-line hint flash
	 * is the fallback (the unit harness mounts no overlay).
	 */
	#openHelp(): void {
		if (this.#overlayOpen) return;
		if (this.helpOverlay === undefined) {
			this.#flashStatus(
				"tab focus · enter open · y copy · f fork · e edit · / search · ctrl+p conversations",
			);
			return;
		}
		this.#overlayOpen = true;
		this.helpOverlay(() => {
			this.#overlayOpen = false;
		});
	}

	/** pi-tui focus follows the action layer's region. */
	#applyFocusTarget(): void {
		if (this.#focus === "composer") this.#tui.setFocus(this.editor);
		else if (this.#focus === "list") this.#tui.setFocus(this.sidebar);
		else this.#tui.setFocus(this.pane);
		this.refreshHints();
	}

	/**
	 * The launcher's keymap seam (C5 fix): the active keymap's
	 * `hints(ctx)` for the current {@link keyContext}. Wired once at
	 * launch; {@link refreshHints} re-polls it on every focus change
	 * (and the launcher re-polls after each key for vim mode changes).
	 */
	public hintsProvider: (() => readonly string[]) | undefined;

	/**
	 * Re-poll the keymap's hints into the status bar's steady state.
	 * A transient flash or the search overlay owns the bar's right
	 * cluster until it restores the snapshot, so only the snapshot is
	 * updated while one is up (the restore paints the fresh hints).
	 */
	refreshHints(): void {
		if (this.#statusBar === undefined || this.hintsProvider === undefined) return;
		const hints = this.hintsProvider();
		const base = this.#statusSnapshot ?? { conversation: "", hints: [] };
		const next = { ...base, hints };
		this.#statusSnapshot = next;
		if (this.#search === undefined && this.#statusBar.getState().message === undefined) {
			this.#statusBar.set(next);
		}
	}

	/** Move the transcript's focused turn, clamped to the turn count. */
	#moveTranscriptFocus(delta: number): void {
		const count = this.pane.turns().length;
		if (count === 0) return;
		const current = this.pane.focusIndex;
		if (current === undefined) {
			this.pane.setFocus(delta < 0 ? count - 1 : 0);
			return;
		}
		this.pane.setFocus(Math.max(0, Math.min(current + delta, count - 1)));
	}

	/** Fold/unfold the focused assistant turn (no-op without one). */
	#foldFocused(): void {
		const index = this.pane.focusIndex;
		if (index !== undefined) this.pane.toggleFold(index);
	}

	/** Focus the previous/next user turn (delta -1 backward, 1 forward). */
	#promptJump(delta: 1 | -1): void {
		const turns = this.pane.turns();
		const current = this.pane.focusIndex ?? (delta < 0 ? turns.length : -1);
		for (let i = current + delta; i >= 0 && i < turns.length; i += delta) {
			if (turns[i]!.kind === "user") {
				this.pane.setFocus(i);
				return;
			}
		}
	}

	/** The transcript search overlay: a `/` query line in the status bar. */
	#beginSearch(direction: "forward" | "backward"): void {
		this.#search = { query: "", direction };
		this.#overlayOpen = true;
		this.#paintSearch();
	}

	/** The search line's status-bar rendering. */
	#paintSearch(): void {
		const search = this.#search;
		if (this.#statusBar === undefined || search === undefined) return;
		const base = this.#statusSnapshot ?? { conversation: "", hints: [] };
		this.#statusBar.set({
			...base,
			message: `/${search.query}`,
		});
	}

	/** End the search overlay (Enter keeps the match, Esc restores). */
	#endSearch(): void {
		this.#search = undefined;
		this.#overlayOpen = false;
		const base = this.#statusSnapshot;
		if (this.#statusBar !== undefined && base !== undefined) this.#statusBar.set(base);
	}

	/** Advance to the next match (reverse flips the remembered direction). */
	#searchNext(reverse: boolean): void {
		const search = this.#search;
		if (search === undefined || search.query === "") return;
		const forward = search.direction === "forward";
		this.#findMatch(search.query, reverse ? !forward : forward);
	}

	/** Focus the next turn whose text contains the query (case-insensitive). */
	#findMatch(query: string, forward: boolean): boolean {
		const turns = this.pane.turns();
		if (turns.length === 0) return false;
		const needle = query.toLowerCase();
		const delta = forward ? 1 : -1;
		const current = this.pane.focusIndex ?? (forward ? -1 : turns.length);
		for (let i = current + delta; i >= 0 && i < turns.length; i += delta) {
			if (this.pane.textOf(i).toLowerCase().includes(needle)) {
				this.pane.setFocus(i);
				return true;
			}
		}
		return false;
	}

	/** The search overlay's input seam (the launcher routes keys here). */
	#handleSearchKey(data: string): boolean {
		const search = this.#search;
		if (search === undefined) return false;
		if (matchesKey(data, Key.escape) || data === "\x07") {
			// Esc — and C-g, the emacs cancel — close the search.
			this.#endSearch();
			return true;
		}
		// C-s / C-r walk the matches while the overlay stays open (emacs).
		if (data === "\x13" || data === "\x12") {
			if (search.query !== "") this.#findMatch(search.query, data === "\x13");
			return true;
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			if (search.query !== "") {
				this.#findMatch(search.query, search.direction === "forward");
			}
			this.#endSearch();
			return true;
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
			search.query = search.query.slice(0, -1);
			this.#paintSearch();
			return true;
		}
		if (data.length === 1 && data >= " ") {
			search.query += data;
			this.#paintSearch();
			return true;
		}
		return true; // the overlay owns every key while open
	}

	/** Open the conversation/model/command picker for `kind`. */
	#openPickerFor(kind: "conversation" | "model" | "command"): void {
		if (this.#overlayOpen) return;
		this.#overlayOpen = true;
		const close = (): void => {
			this.#overlayOpen = false;
		};
		if (kind === "conversation") {
			const items: PickerItem<number>[] = this.sidebar.rows.map((row) => ({
				label: `${"  ".repeat(row.depth)}${row.depth > 0 ? "↳ " : ""}${row.name}`,
				detail: row.age,
				value: row.id,
			}));
			openPicker(this.#tui, items, {
				title: "Conversations",
				onPick: (id) => {
					void this.selectConversation(id).catch((error: unknown) => {
						this.pane.showError(describeCommandError("select", error));
					});
				},
				onClose: close,
			});
			return;
		}
		if (kind === "model") {
			this.#client
				.listModels()
				.then((response) => {
					openPicker(
						this.#tui,
						response.models.map((model: ModelEntry) => ({
							label: model.id,
							detail: model.name,
							value: model.id,
						})),
						{
							title: "Models",
							onPick: (modelId) => {
								void this.dispatch({ type: "run-command", line: `/model ${modelId}` });
							},
							onClose: close,
						},
					);
				})
				.catch((error: unknown) => {
					close();
					this.pane.showError(describeCommandError("listModels", error));
				});
			return;
		}
		this.#client
			.getCommands()
			.then((response) => {
				openPicker(
					this.#tui,
					response.commands.map((command: SlashCommand) => ({
						label: `/${command.name}`,
						// An EXPAND entry's detail carries its argument-hint too (Task
						// 2c — the hint IS the affordance: `/review <focus>`); endpoint
						// rows stay exactly as before.
						detail:
							command.kind === "expand" && command.argsHint !== undefined
								? `${command.description} ${command.argsHint}`
								: command.description,
						value: command,
					})),
					{
						title: "Commands",
						onPick: (command) => {
							this.#focus = "composer";
							this.#applyFocusTarget();
							this.editor.setText(commandInsertText(command));
						},
						onClose: close,
					},
				);
			})
			.catch((error: unknown) => {
				close();
				this.pane.showError(describeCommandError("getCommands", error));
			});
	}

	/** The thinking cycle (off → minimal → low → medium → high → xhigh → off). */
	async #cycleThinking(): Promise<void> {
		const id = this.#activeId;
		if (id === undefined) return;
		const order = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
		const index = order.indexOf(this.#thinkingLevel as (typeof order)[number]);
		const next = order[(index + 1) % order.length]!;
		try {
			const response = await this.#client.configure(id, { thinking: next });
			this.#thinkingLevel = response.thinkingLevel;
			this.#flashStatus(`thinking: ${response.thinkingLevel}`);
		} catch (error: unknown) {
			this.pane.showError(describeCommandError("configure", error));
		}
	}

	/**
	 * Edit-from-here (the web B4 Edit rule): fork at the PREVIOUS turn so
	 * the message is re-entered; on the first turn there is no fork point,
	 * so a fresh conversation is created. Either way the text prefills the
	 * durable draft (`patchMeta`) and the local composer. The fork point
	 * comes from the TURNS list (webui TurnList's rule): pi-durable mints
	 * ids from ONE global counter (entries, conversations, submissions,
	 * tasks), so entry-id arithmetic (`entryId - 1`) cannot locate the
	 * previous entry.
	 */
	async #editHere(): Promise<void> {
		const id = this.#activeId;
		const index = this.pane.focusIndex;
		if (id === undefined || index === undefined) return;
		const turn = this.pane.turns()[index];
		if (turn === undefined || turn.kind !== "user") {
			this.pane.showError("edit: focus a user turn");
			return;
		}
		const text = this.pane.textOf(index);
		this.editor.disableSubmit = true;
		try {
			const newId =
				index === 0
					? (await this.#client.createConversation()).id
					: (await this.#client.forkConversation(id, this.pane.entryIdOf(index - 1))).id;
			await this.#client.patchMeta(newId, { draft: { text } });
			await this.sidebar.refresh();
			await this.selectConversation(newId);
			this.editor.setText(text);
			this.#focus = "composer";
			this.#applyFocusTarget();
		} catch (error: unknown) {
			this.pane.showError(describeCommandError("edit", error));
		} finally {
			this.editor.disableSubmit = false;
		}
	}

	/**
	 * The vim command line's command table (Task C4). A `/`-prefixed line
	 * (or any name outside the table) routes through the existing slash
	 * catalog — the table holds only the vim-native commands.
	 */
	async runCommand(line: string): Promise<void> {
		if (line.startsWith("/")) {
			await this.#runSlashCommand(line);
			return;
		}
		const space = line.indexOf(" ");
		const name = space === -1 ? line : line.slice(0, space);
		const arg = space === -1 ? "" : line.slice(space + 1).trim();
		switch (name) {
			case "q":
			case "quit":
				this.onQuit?.();
				return;
			case "new":
				await this.createAndSelect();
				return;
			case "fork":
				await this.dispatch({ type: "fork-here" });
				return;
			case "ls":
				this.#openPickerFor("conversation");
				return;
			case "model":
				if (arg === "") {
					this.pane.showError("usage: model <provider/id>");
					return;
				}
				await this.#runSlashCommand(`/model ${arg}`);
				return;
			case "set": {
				const thinking = /^thinking=(\S+)$/.exec(arg);
				if (thinking === null) {
					this.pane.showError("usage: set thinking=<level>");
					return;
				}
				await this.#runSlashCommand(`/thinking ${thinking[1]}`);
				return;
			}
			case "b": {
				if (arg === "") {
					this.pane.showError("usage: b <id|name>");
					return;
				}
				const hit = /^\d+$/.test(arg)
					? this.sidebar.rows.find((row) => row.id === Number(arg))
					: this.sidebar.rows.find((row) =>
							row.name.toLowerCase().includes(arg.toLowerCase()),
					);
				if (hit === undefined) {
					this.#flashStatus("no match");
					return;
				}
				await this.selectConversation(hit.id);
				return;
			}
			default:
				await this.#runSlashCommand(`/${line}`);
		}
	}

	/**
	 * Edit the composer draft in a vim-family editor (Task C4): the TUI
	 * suspends while vim owns the terminal. No vim found → a status
	 * message and the draft stays untouched; nothing is spawned.
	 */
	#editInVim(): void {
		const editor = this.#resolveVim();
		if (editor === undefined) {
			this.#flashStatus("no vim found");
			return;
		}
		const tui = this.#tui as unknown as {
			stop(): void;
			start(): void;
			requestRender(force?: boolean): void;
		};
		const result = editInVim({ text: this.editor.getText(), editor, tui });
		if (!result.ok) {
			this.pane.showError(result.reason);
			return;
		}
		this.editor.setText(result.text);
		this.#focus = "composer";
		this.#applyFocusTarget();
		// Focus and mode must agree: the composer is focused, so the vim
		// keymap returns to INSERT (the launcher wires this seam).
		this.enterInsertMode?.();
	}

	/** The launcher's vim-keymap seam: re-enter INSERT after edit-in-vim. */
	public enterInsertMode: (() => void) | undefined;

	/**
	 * The launcher's help-overlay seam (C5): opens the key reference for
	 * the active keymap; the callback fires when the overlay closes.
	 */
	public helpOverlay: ((onClose: () => void) => void) | undefined;

	/**
	 * The slash catalog's command names (C3's picker source, cached) —
	 * the launcher feeds them to the vim `:` Tab completion.
	 */
	async slashCommandNames(): Promise<string[]> {
		return this.#catalog.names();
	}

	/**
	 * The vim keymap's status-bar seam (Task C4): the app polls the keymap
	 * after each key. `commandLine` set → the bar shows the `:` line;
	 * otherwise the steady state is restored with the keymap's mode chip
	 * in the `mode` segment.
	 */
	renderCommandLine(commandLine: string | undefined, modeLabel: string | undefined): void {
		const base = this.#statusSnapshot;
		if (this.#statusBar === undefined || base === undefined) return;
		if (commandLine !== undefined) {
			// A dedicated non-expiring segment — the `:` line must outlive the
			// flash TTL for the whole command mode.
			this.#statusBar.set({ ...base, commandLine });
			return;
		}
		this.#statusBar.set({ ...base, commandLine: undefined, mode: modeLabel ?? base.mode });
	}

	render(width: number): string[] {
		return this.#layout.render(width);
	}

	invalidate(): void {
		this.#layout.invalidate();
	}
}
