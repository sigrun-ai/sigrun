/**
 * The TUI action layer (Task C3, UI refresh): a channel-neutral union of
 * everything the keymaps, pickers, mouse regions, and slash commands can
 * ask the shell to do. {@link TuiApp} implements {@link ActionHost} and
 * owns the focus state the focus/move/open actions drive.
 *
 * Focus targets: `composer` (the pi-tui Editor), `list` (the sidebar's
 * conversation tree), `transcript` (the pane's focusable turns). The
 * keymap decides WHICH action a key means per focus; the app decides
 * what the action DOES per focus.
 */

/** The three focusable regions. */
export type Focus = "composer" | "list" | "transcript";

/** Every dispatchable intent. */
export type Action =
	| { readonly type: "focus"; readonly target: Focus }
	| { readonly type: "focus-cycle"; readonly direction: 1 | -1 }
	| { readonly type: "move"; readonly delta: number }
	| { readonly type: "page"; readonly direction: 1 | -1; readonly half: boolean }
	| { readonly type: "edge"; readonly to: "top" | "bottom" }
	| { readonly type: "prompt-jump"; readonly delta: 1 | -1 }
	| { readonly type: "toggle-fold" }
	| { readonly type: "open" }
	| { readonly type: "copy" }
	| { readonly type: "fork-here" }
	| { readonly type: "edit-here" }
	| { readonly type: "edit-in-vim" }
	| { readonly type: "picker"; readonly kind: "conversation" | "model" | "command" }
	| { readonly type: "new-conversation" }
	| { readonly type: "cycle-thinking" }
	| { readonly type: "search"; readonly direction: "forward" | "backward" }
	| { readonly type: "search-next"; readonly reverse: boolean }
	| { readonly type: "answer-interaction" }
	| { readonly type: "cancel-run" }
	| { readonly type: "redraw" }
	| { readonly type: "quit" }
	| { readonly type: "help" }
	| { readonly type: "command-line" }
	| { readonly type: "run-command"; readonly line: string };

/** The dispatch surface {@link TuiApp} implements. */
export interface ActionHost {
	dispatch(action: Action): Promise<void>;
}
