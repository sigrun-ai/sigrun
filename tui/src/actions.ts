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

/** The three focusable regions. `surface` (Task 4, UI-blocks U2) is a
 *  block surface pane (lanes/calendar/collection) — the blocks.* keys
 *  route ONLY while it has focus. While a surface is focused the
 *  transcript/list nav keys (y/f/e//?) are inert (the keymaps pass
 *  them); Task 6's surface host decides any surface-side meaning for
 *  them. */
export type Focus = "composer" | "list" | "transcript" | "surface";

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
	| { readonly type: "run-command"; readonly line: string }
	// UI-blocks U2 Task 4 (spec §12.4): block-surface keys. Routed ONLY
	// while the `surface` focus is active; the app forwards them to the
	// focused block component.
	/** Pick up the item under the cursor (m / M-m). */
	| { readonly type: "blocks.pickUp" }
	/** Drop the picked-up item at its placement (Enter). */
	| { readonly type: "blocks.drop" }
	/** Cancel the pick-up (Esc). */
	| { readonly type: "blocks.cancelMove" }
	/** Toggle the selection of the item under the cursor (Space). */
	| { readonly type: "blocks.select" }
	/** Open the action menu (`.` — bulk actions, "Move to…"). */
	| { readonly type: "blocks.actionMenu" }
	/** Toggle the checkable field of the item under the cursor (x). */
	| { readonly type: "blocks.check" }
	/** Previous calendar range ([). */
	| { readonly type: "blocks.rangePrev" }
	/** Next calendar range (]). */
	| { readonly type: "blocks.rangeNext" }
	/** Return the calendar range to today (t). */
	| { readonly type: "blocks.today" };

/** The dispatch surface {@link TuiApp} implements. */
export interface ActionHost {
	dispatch(action: Action): Promise<void>;
}
