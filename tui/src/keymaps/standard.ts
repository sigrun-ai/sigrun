/**
 * The standard keymap (Task C3, UI refresh): readline-friendly globals
 * plus vi-flavoured navigation OUTSIDE the composer. The composer owns
 * every printable key and every {@link RESERVED_KEYS} chord — nothing
 * here shadows a line-editing key (ctrl+d/ctrl+u included), and ctrl+b
 * is never bound anywhere.
 *
 * Global (every focus): ctrl+p conversation picker, ctrl+n new
 * conversation, ctrl+t cycle thinking, ctrl+o answer interaction,
 * ctrl+l redraw, ctrl+c quit, tab/shift+tab focus cycle, Esc (abort a
 * live run, else focus the composer; passes through while the
 * composer's autocomplete is open). Outside the composer: arrows move,
 * PgUp/PgDn page, Home/End jump, Enter open, y copy, f fork, e edit,
 * / search, n/N next match, ? help.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Action } from "../actions.js";
import { RESERVED_KEYS, type KeyContext, type Keymap, type KeyResult } from "./types.js";

/** The help table (also the source of the status-bar hints). */
const BINDINGS: readonly { keys: string; action: string }[] = [
	{ keys: "ctrl+p", action: "conversation picker" },
	{ keys: "ctrl+n", action: "new conversation" },
	{ keys: "ctrl+t", action: "cycle thinking" },
	{ keys: "ctrl+o", action: "answer interaction" },
	{ keys: "ctrl+l", action: "redraw" },
	{ keys: "ctrl+c", action: "quit" },
	{ keys: "tab / shift+tab", action: "cycle focus" },
	{ keys: "esc", action: "abort run / focus composer" },
	{ keys: "↑ ↓", action: "move (list/transcript)" },
	{ keys: "pgup pgdn", action: "page (list/transcript)" },
	{ keys: "home end", action: "top / bottom" },
	{ keys: "enter", action: "open / select" },
	{ keys: "y", action: "copy turn" },
	{ keys: "f", action: "fork here" },
	{ keys: "e", action: "edit here" },
	{ keys: "/", action: "search transcript" },
	{ keys: "n / N", action: "next / previous match" },
	{ keys: "?", action: "help" },
	{ keys: "m", action: "pick up (block surface)" },
	{ keys: "enter", action: "drop (block surface)" },
	{ keys: "esc", action: "cancel move (block surface)" },
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

export function createStandardKeymap(): Keymap {
	const global = (data: string, ctx: KeyContext): KeyResult | undefined => {
		if (matchesKey(data, Key.ctrl("p"))) return { type: "picker", kind: "conversation" };
		if (matchesKey(data, Key.ctrl("n"))) return { type: "new-conversation" };
		if (matchesKey(data, Key.ctrl("t"))) return { type: "cycle-thinking" };
		if (matchesKey(data, Key.ctrl("o"))) return { type: "answer-interaction" };
		if (matchesKey(data, Key.ctrl("l"))) return { type: "redraw" };
		if (matchesKey(data, Key.ctrl("c"))) return { type: "quit" };
		if (matchesKey(data, Key.tab) || matchesKey(data, "tab")) {
			return ctx.autocompleteOpen ? "pass" : { type: "focus-cycle", direction: 1 };
		}
		if (matchesKey(data, "shift+tab")) return { type: "focus-cycle", direction: -1 };
		if (matchesKey(data, Key.escape)) {
			if (ctx.autocompleteOpen) return "pass";
			if (ctx.busy) return { type: "cancel-run" };
			return { type: "focus", target: "composer" };
		}
		return undefined;
	};

	const outsideComposer = (data: string): KeyResult | undefined => {
		if (matchesKey(data, Key.up) || matchesKey(data, "up")) return { type: "move", delta: -1 };
		if (matchesKey(data, Key.down) || matchesKey(data, "down")) return { type: "move", delta: 1 };
		if (matchesKey(data, Key.pageUp) || matchesKey(data, "pageUp"))
			return { type: "page", direction: -1, half: false };
		if (matchesKey(data, Key.pageDown) || matchesKey(data, "pageDown"))
			return { type: "page", direction: 1, half: false };
		if (matchesKey(data, Key.home) || matchesKey(data, "home")) return { type: "edge", to: "top" };
		if (matchesKey(data, Key.end) || matchesKey(data, "end")) return { type: "edge", to: "bottom" };
		if (matchesKey(data, Key.enter)) return { type: "open" };
		if (data === "y") return { type: "copy" };
		if (data === "f") return { type: "fork-here" };
		if (data === "e") return { type: "edit-here" };
		if (data === "/") return { type: "search", direction: "forward" };
		if (data === "n") return { type: "search-next", reverse: false };
		if (data === "N") return { type: "search-next", reverse: true };
		if (data === "?") return { type: "help" };
		return undefined;
	};

	const surface = (data: string): KeyResult | undefined => {
		// Block-surface keys (spec §12.4): routed ONLY here; the app
		// forwards the action to the focused block component.
		if (data === "m") return { type: "blocks.pickUp" };
		if (matchesKey(data, Key.enter)) return { type: "blocks.drop" };
		if (data === " ") return { type: "blocks.select" };
		if (data === ".") return { type: "blocks.actionMenu" };
		if (data === "x") return { type: "blocks.check" };
		if (data === "[") return { type: "blocks.rangePrev" };
		if (data === "]") return { type: "blocks.rangeNext" };
		if (data === "t") return { type: "blocks.today" };
		return undefined;
	};

	return {
		name: "standard",
		modeLabel: () => undefined,
		handle(data: string, ctx: KeyContext): KeyResult {
			// The composer's readline chords + the tmux prefix: NEVER bound.
			if (isReserved(data)) return "pass";
			// A modal overlay owns the keys; only quit still works.
			if (ctx.overlayOpen) {
				return matchesKey(data, Key.ctrl("c")) ? { type: "quit" } : "pass";
			}
			const globalResult = global(data, ctx);
			if (globalResult !== undefined) return globalResult;
			if (ctx.focus === "surface") {
				const surfaceResult = surface(data);
				if (surfaceResult !== undefined) return surfaceResult;
				// Esc on a surface: cancel a pick-up first, else the global
				// Esc (focus composer) already fired above.
				if (matchesKey(data, Key.escape)) return { type: "blocks.cancelMove" };
				return "pass";
			}
			if (ctx.focus !== "composer") {
				const navResult = outsideComposer(data);
				if (navResult !== undefined) return navResult;
			}
			return "pass";
		},
		hints(ctx: KeyContext): readonly string[] {
			if (ctx.focus === "composer") {
				return ["Tab focus", "^P chats", "? keys"];
			}
			return ["enter open", "y copy", "f fork", "e edit", "/ search", "? help"];
		},
		describe: () => BINDINGS,
	};
}
