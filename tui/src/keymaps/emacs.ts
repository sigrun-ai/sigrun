/**
 * The emacs keymap (Task C5, UI refresh): modeless, chord-driven. `C-x`
 * ("\x18") arms a 1 000 ms chord: `C-x b` conversation picker, `C-x o`
 * focus cycle, `C-x C-c` quit, `C-x k` a consumed no-op (a mismatched
 * follow-up is the emacs undefined-key beep — consumed, never typed).
 * `M-x` opens the command picker; `C-s` / `C-r` search forward / backward
 * (the app's search overlay turns them into next / previous while open);
 * `C-g` cancels a live run, closes the search/picker (it passes through
 * to the open overlay), or focuses the composer. `M-p` / `M-n` jump
 * between prompts; `M-w` copy, `M-f` fork, `M-e` edit are outside-
 * composer actions (in the composer `M-f` is the editor's word-forward —
 * all three pass). `C-n` / `C-p` move outside the composer; `C-o`
 * answers an interaction, `C-l` redraws, `C-h` opens the key reference.
 * Every {@link RESERVED_KEYS} chord passes in every focus — ctrl+b is
 * NEVER bound (no `C-x C-b` either).
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Action } from "../actions.js";
import { RESERVED_KEYS, type KeyContext, type Keymap, type KeyResult } from "./types.js";

/** The C-x chord window. */
const CHORD_MS = 1_000;

const BINDINGS: readonly { keys: string; action: string }[] = [
	{ keys: "C-x b", action: "conversation picker" },
	{ keys: "C-x o", action: "cycle focus" },
	{ keys: "C-x C-c", action: "quit" },
	{ keys: "M-x", action: "command picker" },
	{ keys: "C-s / C-r", action: "search forward / backward" },
	{ keys: "C-g", action: "cancel run / close / focus composer" },
	{ keys: "M-p / M-n", action: "previous / next prompt" },
	{ keys: "M-w", action: "copy turn" },
	{ keys: "M-f", action: "fork here" },
	{ keys: "M-e", action: "edit here" },
	{ keys: "C-n / C-p", action: "move down / up" },
	{ keys: "enter", action: "open / fold" },
	{ keys: "C-o", action: "answer interaction" },
	{ keys: "C-l", action: "redraw" },
	{ keys: "C-h", action: "key reference" },
	{ keys: "M-m", action: "pick up (block surface)" },
	{ keys: "enter", action: "drop (block surface)" },
	{ keys: "C-g", action: "cancel move (block surface)" },
	{ keys: "space", action: "select (block surface)" },
	{ keys: ".", action: "action menu (block surface)" },
	{ keys: "x", action: "check (block surface)" },
	{ keys: "[ / ]", action: "previous / next range (calendar)" },
	{ keys: "t", action: "today (calendar)" },
];

/** Match `data` against any reserved chord (they always pass). */
function isReserved(data: string): boolean {
	return RESERVED_KEYS.some((id) => matchesKey(data, id as never));
}

export function createEmacsKeymap(): Keymap {
	/** The armed C-x prefix timestamp (undefined = no chord pending). */
	let chordAt: number | undefined;

	/**
	 * Resolve the C-x chord against `data`. Returns the chord's result,
	 * "consume" when `data` ARMS the prefix, or undefined to process
	 * `data` fresh (no prefix pending, or the window expired).
	 */
	const chord = (data: string): Action | "consume" | undefined => {
		const now = Date.now();
		if (chordAt !== undefined) {
			const armed = chordAt;
			chordAt = undefined;
			if (now - armed <= CHORD_MS) {
				if (data === "b") return { type: "picker", kind: "conversation" };
				if (data === "o") return { type: "focus-cycle", direction: 1 };
				if (data === "\x03") return { type: "quit" }; // C-x C-c
				if (data === "k") return "consume"; // C-x k: a no-op, consumed
				return "consume"; // undefined chord: the emacs beep
			}
			// Expired: `data` is processed fresh below.
		}
		if (data === "\x18") {
			chordAt = now;
			return "consume";
		}
		return undefined;
	};

	/** Block-surface keys (spec §12.4; emacs picks up with M-m). C-g is
	 *  the cancel key — it cancels a move on a surface BEFORE the global
	 *  C-g (cancel-run / focus composer) below sees it. */
	const surface = (data: string): KeyResult | undefined => {
		if (data === "\x1bm") return { type: "blocks.pickUp" }; // M-m
		if (matchesKey(data, Key.enter) || data === "\r") return { type: "blocks.drop" };
		if (data === "\x07") return { type: "blocks.cancelMove" }; // C-g
		if (data === " ") return { type: "blocks.select" };
		if (data === ".") return { type: "blocks.actionMenu" };
		if (data === "x") return { type: "blocks.check" };
		if (data === "[") return { type: "blocks.rangePrev" };
		if (data === "]") return { type: "blocks.rangeNext" };
		if (data === "t") return { type: "blocks.today" };
		return undefined;
	};

	return {
		name: "emacs",
		modeLabel: () => undefined,
		handle(data: string, ctx: KeyContext): KeyResult {
			// The composer's readline chords + the tmux prefix: NEVER bound.
			// A reserved pass-through disarms a pending C-x — otherwise
			// `C-x C-b b` would fire the picker with the user's "b".
			if (isReserved(data)) {
				chordAt = undefined;
				return "pass";
			}
			// A modal overlay owns the keys; C-g passes too — the picker and
			// the search overlay close themselves on it.
			if (ctx.overlayOpen) return "pass";
			const chorded = chord(data);
			if (chorded !== undefined) return chorded;
			// A block surface owns the §12.4 keys (its C-g is cancel-move,
			// which must win over the global C-g cancel-run).
			if (ctx.focus === "surface") {
				const surfaceResult = surface(data);
				if (surfaceResult !== undefined) return surfaceResult;
			}
			if (data === "\x1bx") return { type: "picker", kind: "command" };
			if (data === "\x13") return { type: "search", direction: "forward" };
			if (data === "\x12") return { type: "search", direction: "backward" };
			if (data === "\x07") {
				return ctx.busy
					? { type: "cancel-run" }
					: { type: "focus", target: "composer" };
			}
			if (data === "\x1bp") return { type: "prompt-jump", delta: -1 };
			if (data === "\x1bn") return { type: "prompt-jump", delta: 1 };
			if (data === "\x0f") return { type: "answer-interaction" };
			if (data === "\x0c") return { type: "redraw" };
			if (data === "\x08") return { type: "help" };
			if (ctx.focus === "composer") return "pass";
			// Outside the composer: the transcript/list actions.
			if (data === "\x1bw") return { type: "copy" };
			if (data === "\x1bf") return { type: "fork-here" };
			if (data === "\x1be") return { type: "edit-here" };
			if (data === "\x0e") return { type: "move", delta: 1 };
			if (data === "\x10") return { type: "move", delta: -1 };
			if (matchesKey(data, Key.enter) || data === "\r") return { type: "open" };
			return "pass";
		},
		hints: () => ["C-x b chats", "M-x commands", "C-h keys"],
		describe: () => BINDINGS,
	};
}
