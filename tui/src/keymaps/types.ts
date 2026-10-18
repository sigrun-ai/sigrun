/**
 * The keymap contract (Task C3, UI refresh): a keymap maps raw terminal
 * input to an {@link Action}, `"pass"` (the focused component — usually
 * the composer — gets the key), or `"consume"` (swallow silently). The
 * launcher's single input listener asks the keymap first, then dispatches
 * / consumes / passes.
 *
 * RESERVED_KEYS are the composer's line-editing chords (readline-style)
 * and the tmux prefix: a keymap must NEVER bind them — it returns "pass"
 * for every one in every focus so the editor (or tmux) always sees them.
 * Ctrl+B in particular is the user's hard rule.
 */

import type { Action, Focus } from "../actions.js";

/** The state a keymap decision depends on. */
export interface KeyContext {
	readonly focus: Focus;
	/** A live run is in flight (Esc aborts it). */
	readonly busy: boolean;
	/** The composer's autocomplete dropdown is open (Esc/Tab pass to it). */
	readonly autocompleteOpen: boolean;
	/** A modal overlay (picker/search/answer) owns the keys. */
	readonly overlayOpen: boolean;
}

/** What the launcher does with the key: run the action, swallow, or pass. */
export type KeyResult = Action | "pass" | "consume";

export interface Keymap {
	readonly name: "standard" | "vim" | "emacs";
	/** The status-bar mode chip text; undefined = no chip (standard). */
	modeLabel(): string | undefined;
	handle(data: string, ctx: KeyContext): KeyResult;
	/** The one-line hint cluster for the status bar. */
	hints(ctx: KeyContext): readonly string[];
	/** The help listing: every binding with a human description. */
	describe(): readonly { keys: string; action: string }[];
}

/**
 * Keys no keymap may bind: the composer's readline chords plus the tmux
 * prefix (ctrl+b). Keymaps return "pass" for all of them in every focus.
 */
export const RESERVED_KEYS: readonly string[] = [
	"ctrl+b",
	"ctrl+a",
	"ctrl+e",
	"ctrl+f",
	"ctrl+k",
	"ctrl+u",
	"ctrl+w",
	"ctrl+y",
	"ctrl+d",
	"ctrl+j",
];
