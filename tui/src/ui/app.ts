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
	type TUI,
} from "@earendil-works/pi-tui";
import type { ConversationViewWire, SigrunClient, WhenBusyMode } from "../api.js";
import { SigrunApiError } from "../api.js";
import { watchConversation, type Unwatch, type WatchHandlers, type WatchOptions } from "../sse.js";
import type { TuiTheme } from "../theme.js";
import { describeCommandError, parseSlashInput, SlashCatalog } from "./composer.js";
import { AmbientChrome } from "./ambient.js";
import { ConversationPane } from "./conversation-pane.js";
import { InteractionPrompter } from "./interactions.js";
import { Sidebar } from "./sidebar.js";

/** The watch injection seam (tests stub it; the launcher uses the real one). */
export type WatchFn = (
	conversationId: number,
	handlers: WatchHandlers,
	options: WatchOptions,
) => Unwatch;

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

export class TuiApp implements Component {
	readonly #client: SigrunClient;
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
	/** The slash-command catalog (fetched once, cached — a boot constant). */
	readonly #catalog: SlashCatalog;

	constructor(client: SigrunClient, options: TuiAppOptions) {
		this.#client = client;
		this.#watch = options.watch ?? watchConversation;
		this.#watchOptions = options.watchOptions ?? { baseUrl: "" };
		this.#catalog = new SlashCatalog(client);
		const theme = options.theme;
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
		if (matchesKey(data, Key.escape) && this.#busy && this.#activeId !== undefined) {
			this.#abortActive();
			return true;
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
		if (command === undefined) {
			this.pane.showError(`unknown command: /${parsed.name}`);
			return;
		}
		try {
			switch (parsed.name) {
				case "new":
					await this.createAndSelect();
					return;
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
				default:
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
		this.interactions.dispose();
		this.ambient.dispose();
	}

	render(width: number): string[] {
		return this.#layout.render(width);
	}

	invalidate(): void {
		this.#layout.invalidate();
	}
}
