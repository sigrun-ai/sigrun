/**
 * The TUI shell (Task 6): sidebar left, conversation pane right, composer
 * footer — pi's idiom over the Task 4 client layers.
 *
 * File naming (the controller's pick-one ruling): plain `.ts` — pi-tui is
 * not React (components are `render(width): string[]` classes), so the
 * plan's `app.tsx` alternative does not apply.
 *
 * Layout: {@link TuiApp} IS the body row (`HStack`: sidebar at a fixed
 * basis, pane growing). The composer is a pi-tui `Editor` the launcher
 * mounts after the app on the TUI root — pi's idiom is `TuiMainScreen`
 * (the terminal owns scrollback; chat content scrolls, the editor anchors
 * the bottom as the last child). Viewport `VStack`/`ScrollView` layouts
 * are alt-screen-only (pi-tui 1.3.0), so the footer composition lives in
 * the launcher, not the app component.
 *
 * Wiring: the sidebar refreshes from `listConversations()`; selecting a
 * conversation swaps the pane's `watchConversation` subscription (the old
 * watch is closed before the new one opens); stream frames REPLACE the
 * pane (the SSE contract — a snapshot subsumes missed frames); the
 * composer submits fire-and-forget via `submit(id, text)` — the stream is
 * the source of truth for the reply (spec §10's composer rule). The fork
 * action (`forkActive`, bound to ctrl+f by the launcher) calls
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
 */

import {
	Editor,
	HStack,
	Key,
	matchesKey,
	type Component,
	type EditorTheme,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import type { SigrunClient, WhenBusyMode } from "../api.js";
import { SigrunApiError } from "../api.js";
import { watchConversation, type Unwatch, type WatchHandlers, type WatchOptions } from "../sse.js";
import { describeCommandError, parseSlashInput, SlashCatalog } from "./composer.js";
import { ConversationPane } from "./conversation-pane.js";
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

	readonly #layout = new HStack();
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
		this.sidebar = new Sidebar(client);
		this.pane = new ConversationPane();
		this.editor = new Editor(options.tui, plainEditorTheme());

		this.#layout.addChild(this.sidebar, {
			basis: options.sidebarWidth ?? 24,
			shrink: 1,
		});
		this.#layout.addChild(this.pane, { basis: 0, grow: 1, minSize: 1 });

		this.sidebar.onSelect = (selection) => {
			if (selection === "new") {
				void this.createAndSelect();
			} else {
				void this.selectConversation(selection);
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
			// Generation guard (review finding): a frame already in flight
			// from the JUST-closed watch can still deliver after the swap;
			// without a per-watch token it would land in the new
			// conversation's pane. The guard also fences error callbacks,
			// which carry no conversation id.
			const gen = ++this.#watchGen;
			this.#unwatch = this.#watch(
				id,
				{
					onSnapshot: (wire) => {
						if (gen !== this.#watchGen) return;
						this.#busy = wire.steer.busy;
						this.pane.showView(wire);
					},
					onView: (wire) => {
						if (gen !== this.#watchGen) return;
						this.#busy = wire.steer.busy;
						this.pane.showView(wire);
					},
					onError: (message) => {
						if (gen === this.#watchGen) this.onWatchError?.(message);
					},
				},
				this.#watchOptions,
			);
		} finally {
			this.editor.disableSubmit = false;
		}
	}

	/**
	 * Stream-error sink. Task 7 owns rendering these in the pane; v1's
	 * default is a no-op — the generation guard above exists so a STALE
	 * watch's errors can't reach whatever a later task mounts here.
	 */
	onWatchError?: (message: string) => void;

	/** Create a conversation (`+ new`), refresh the sidebar, select it. */
	async createAndSelect(): Promise<void> {
		// The submit guard spans the WHOLE async swap: the awaits below are
		// the window where an Enter would otherwise target the old id.
		this.editor.disableSubmit = true;
		try {
			const created = await this.#client.createConversation();
			await this.sidebar.refresh();
			await this.selectConversation(created.id);
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
		} finally {
			this.editor.disableSubmit = false;
		}
	}

	/**
	 * The launcher's global keybinding seam: ctrl+f forks the active
	 * conversation (spec §8's v1 fork-at-latest default); Esc during a live
	 * run aborts it (the composer idiom — the launcher routes input through
	 * here before the editor sees it, so Esc while busy never reaches the
	 * editor). Returns true when the key was consumed.
	 */
	handleKeybinding(data: string): boolean {
		if (matchesKey(data, Key.ctrl("f"))) {
			void this.forkActive();
			return true;
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
					await this.forkActive();
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

	/** Close the stream subscription (the launcher calls this on exit). */
	dispose(): void {
		this.#unwatch?.();
		this.#unwatch = undefined;
	}

	render(width: number): string[] {
		return this.#layout.render(width);
	}

	invalidate(): void {
		this.#layout.invalidate();
	}
}
