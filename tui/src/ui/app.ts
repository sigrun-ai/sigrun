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
import type { SigrunClient } from "../api.js";
import { watchConversation, type Unwatch, type WatchHandlers, type WatchOptions } from "../sse.js";
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

	constructor(client: SigrunClient, options: TuiAppOptions) {
		this.#client = client;
		this.#watch = options.watch ?? watchConversation;
		this.#watchOptions = options.watchOptions ?? { baseUrl: "" };
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
						if (gen === this.#watchGen) this.pane.showView(wire);
					},
					onView: (wire) => {
						if (gen === this.#watchGen) this.pane.showView(wire);
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
	 * conversation (spec §8's v1 fork-at-latest default). Returns true
	 * when the key was consumed.
	 */
	handleKeybinding(data: string): boolean {
		if (matchesKey(data, Key.ctrl("f"))) {
			void this.forkActive();
			return true;
		}
		return false;
	}

	/** Fire-and-forget submit (the stream carries the reply, spec §10). */
	#submit(text: string): void {
		// Belt to the editor's own gate: pi-tui checks `disableSubmit` in
		// handleInput, not in the onSubmit callback — a programmatic
		// onSubmit during a swap must no-op too, and never destroy a draft.
		if (this.editor.disableSubmit) return;
		const id = this.#activeId;
		// Guard BEFORE clearing: a no-op submit must never destroy a draft.
		if (id === undefined || text.trim() === "") return;
		this.editor.setText("");
		this.#client.submit(id, text).catch(() => {
			// Task 7 owns error surfacing in the pane; the shell's contract
			// is that a failed submit never wedges the composer.
		});
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
