/**
 * The vim keymap (Task C4, UI refresh): real insert/normal/command modes
 * over the C3 action layer. Starts in INSERT with the composer focused —
 * every key types through except Esc (→ NORMAL, focus transcript),
 * Ctrl+C (abort a live run; otherwise consumed — quitting is ZZ or :q),
 * and Ctrl+O (answer an interaction). Every {@link RESERVED_KEYS} chord
 * passes in INSERT (the composer's readline chords and the tmux prefix
 * are never shadowed; ctrl+b is NEVER bound anywhere).
 *
 * NORMAL owns the transcript/list: j/k move, h/l focus list/transcript,
 * ctrl+d/ctrl+u half-page (bound here — RESERVED exists to protect the
 * composer's editing, and in NORMAL the composer is not focused),
 * gg/G edges, {/} prompt jumps, Enter/za fold, o open, y/yy copy,
 * f fork, e edit, v edit-in-vim, //?/n/N search, i/a back to INSERT,
 * `:` the command line, ctrl+p picker, ctrl+l redraw, ZZ quit. UNBOUND
 * PRINTABLE KEYS ARE CONSUMED — they must never leak into the composer.
 *
 * COMMAND accumulates a line after `:` (the app renders ":"+buffer in
 * the status bar via {@link VimKeymap.getCommandLine}); Enter dispatches
 * run-command, Esc cancels, Tab completes the command name.
 *
 * The two-key chords (gg, yy, za, ZZ) share one pending-key window of
 * 500 ms; a timed-out or mismatched prefix is consumed silently.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Action } from "../actions.js";
import { RESERVED_KEYS, type KeyContext, type Keymap, type KeyResult } from "./types.js";

export type VimMode = "insert" | "normal" | "command";

/** The keymap plus the mode/command-line seam the app polls after each key. */
export interface VimKeymap extends Keymap {
	readonly mode: VimMode;
	/** The ":" line while in command mode; undefined otherwise. */
	getCommandLine(): string | undefined;
	/**
	 * Drop to INSERT (the app calls this after an external edit-in-vim so
	 * the mode agrees with the restored composer focus).
	 */
	enterInsertMode(): void;
}

/** Options for {@link createVimKeymap}. */
export interface VimKeymapOptions {
	/**
	 * The slash-command catalog's names (C3's picker source); they join
	 * COMMAND_NAMES in the Tab completion table as `"/"`-prefixed
	 * entries. Defaults to none (the launcher fills a shared array once
	 * the catalog fetch lands).
	 */
	readonly catalogNames?: readonly string[];
}

/** The two-key chord window (gg, yy, za, ZZ). */
const CHORD_MS = 500;

/** The command-mode completion table (Tab completes the command name). */
const COMMAND_NAMES: readonly string[] = ["new", "fork", "model", "set", "b", "ls", "q", "quit"];

const BINDINGS: readonly { keys: string; action: string }[] = [
	{ keys: "esc (insert)", action: "normal mode" },
	{ keys: "i / a", action: "insert mode" },
	{ keys: "j / k", action: "move down / up" },
	{ keys: "h / l", action: "focus list / transcript" },
	{ keys: "ctrl+d / ctrl+u", action: "half page down / up" },
	{ keys: "gg / G", action: "top / bottom" },
	{ keys: "{ / }", action: "previous / next prompt" },
	{ keys: "enter / za", action: "toggle fold" },
	{ keys: "o", action: "open" },
	{ keys: "y / yy", action: "copy turn" },
	{ keys: "f", action: "fork here" },
	{ keys: "e", action: "edit here" },
	{ keys: "v", action: "edit in vim" },
	{ keys: "/ / ?", action: "search forward / backward" },
	{ keys: "n / N", action: "next / previous match" },
	{ keys: ":", action: "command line" },
	{ keys: "ctrl+p", action: "conversation picker" },
	{ keys: "ctrl+o", action: "answer interaction" },
	{ keys: "ctrl+l", action: "redraw" },
	{ keys: "ctrl+c", action: "abort run (busy)" },
	{ keys: "g?", action: "key reference" },
	{ keys: "ZZ / :q", action: "quit" },
	{ keys: "m", action: "pick up (block surface)" },
	{ keys: "enter", action: "drop (block surface)" },
	{ keys: "esc", action: "cancel move (block surface)" },
	{ keys: "space", action: "select (block surface)" },
	{ keys: ".", action: "action menu (block surface)" },
	{ keys: "x", action: "check (block surface)" },
	{ keys: "[ / ]", action: "previous / next range (calendar)" },
	{ keys: "t", action: "today (calendar)" },
];

function isReserved(data: string): boolean {
	return RESERVED_KEYS.some((id) => matchesKey(data, id as never));
}

/** A printable single character (space through ~, plus unicode text). */
function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " ";
}

export function createVimKeymap(options?: VimKeymapOptions): VimKeymap {
	const catalogNames = options?.catalogNames ?? [];
	/** Tab completion table: the vim-native commands plus `/`-catalog names. */
	const completionNames = (): readonly string[] => [
		...COMMAND_NAMES,
		...catalogNames.map((name) => `/${name}`),
	];
	let mode: VimMode = "insert";
	let commandLine = "";
	/** The pending chord prefix ("g" | "y" | "z" | "Z") and its timestamp. */
	let pending: { key: string; at: number } | undefined;

	/**
	 * Resolve the pending two-key chord (gg → top, ZZ → quit, za → fold)
	 * against `data`. Returns the chord's action, "consume" when `data`
	 * STARTS a chord, or undefined to process `data` fresh (a mismatched
	 * or timed-out follow-up).
	 */
	const chord = (data: string): Action | "consume" | undefined => {
		const now = Date.now();
		if (pending !== undefined) {
			const prefix = pending;
			pending = undefined;
			if (now - prefix.at <= CHORD_MS) {
				if (prefix.key === "g" && data === "g") return { type: "edge", to: "top" };
				// g? is vim normal's help key — "?" stays search-backward.
				if (prefix.key === "g" && data === "?") return { type: "help" };
				if (prefix.key === "Z" && data === "Z") return { type: "quit" };
				if (prefix.key === "z" && data === "a") return { type: "toggle-fold" };
			}
			// Mismatch/timeout: `data` is processed fresh below.
		}
		if (data === "g" || data === "Z" || data === "z") {
			pending = { key: data, at: now };
			return "consume";
		}
		return undefined;
	};

	const insert = (data: string, ctx: KeyContext): KeyResult => {
		// The composer's readline chords + the tmux prefix: NEVER bound.
		if (isReserved(data)) return "pass";
		if (matchesKey(data, Key.escape)) {
			if (ctx.autocompleteOpen) return "pass";
			mode = "normal";
			return { type: "focus", target: "transcript" };
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			return ctx.busy ? { type: "cancel-run" } : "consume";
		}
		if (matchesKey(data, Key.ctrl("o"))) return { type: "answer-interaction" };
		return "pass";
	};

	/** Block-surface keys (spec §12.4): NORMAL mode over a `surface`
	 *  focus. The surface wins over transcript/list bindings for the
	 *  shared keys (o/x/etc). */
	const surfaceNormal = (data: string): KeyResult | undefined => {
		if (data === "m") return { type: "blocks.pickUp" };
		if (matchesKey(data, Key.enter)) return { type: "blocks.drop" };
		if (matchesKey(data, Key.escape)) return { type: "blocks.cancelMove" };
		if (data === " ") return { type: "blocks.select" };
		if (data === ".") return { type: "blocks.actionMenu" };
		if (data === "x") return { type: "blocks.check" };
		if (data === "[") return { type: "blocks.rangePrev" };
		if (data === "]") return { type: "blocks.rangeNext" };
		if (data === "t") return { type: "blocks.today" };
		return undefined;
	};

	const normal = (data: string, ctx: KeyContext): KeyResult => {
		// ctrl+b / ctrl+f are NOT bound in vim normal — reserved chords pass.
		const chorded = chord(data);
		if (chorded !== undefined) return chorded;
		if (ctx.focus === "surface") {
			const surfaceResult = surfaceNormal(data);
			if (surfaceResult !== undefined) return surfaceResult;
		}
		if (data === "y") return { type: "copy" }; // yy is two copies — same action
		if (data === "j") return { type: "move", delta: 1 };
		if (data === "k") return { type: "move", delta: -1 };
		if (data === "h") return { type: "focus", target: "list" };
		if (data === "l") return { type: "focus", target: "transcript" };
		if (matchesKey(data, Key.ctrl("d"))) return { type: "page", direction: 1, half: true };
		if (matchesKey(data, Key.ctrl("u"))) return { type: "page", direction: -1, half: true };
		if (data === "G") return { type: "edge", to: "bottom" };
		if (data === "{") return { type: "prompt-jump", delta: -1 };
		if (data === "}") return { type: "prompt-jump", delta: 1 };
		if (matchesKey(data, Key.enter)) return { type: "toggle-fold" };
		if (data === "o") return { type: "open" };
		if (data === "f") return { type: "fork-here" };
		if (data === "e") return { type: "edit-here" };
		if (data === "v") return { type: "edit-in-vim" };
		if (data === "/") return { type: "search", direction: "forward" };
		if (data === "?") return { type: "search", direction: "backward" };
		if (data === "n") return { type: "search-next", reverse: false };
		if (data === "N") return { type: "search-next", reverse: true };
		if (data === "i" || data === "a") {
			mode = "insert";
			return { type: "focus", target: "composer" };
		}
		if (data === ":") {
			mode = "command";
			commandLine = "";
			return "consume";
		}
		if (matchesKey(data, Key.ctrl("p"))) return { type: "picker", kind: "conversation" };
		if (matchesKey(data, Key.ctrl("l"))) return { type: "redraw" };
		if (matchesKey(data, Key.ctrl("c"))) {
			return ctx.busy ? { type: "cancel-run" } : "consume";
		}
		// Reserved chords the composer owns pass even here (they are no-ops
		// in a non-composer focus, but the invariant is one rule).
		if (isReserved(data)) return "pass";
		// UNBOUND PRINTABLE KEYS ARE CONSUMED: never typed into the composer.
		if (isPrintable(data)) return "consume";
		return "consume";
	};

	const command = (data: string): KeyResult => {
		if (matchesKey(data, Key.escape)) {
			mode = "normal";
			commandLine = "";
			return "consume";
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			const line = commandLine;
			mode = "normal";
			commandLine = "";
			if (line.trim() === "") return "consume";
			return { type: "run-command", line };
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
			commandLine = commandLine.slice(0, -1);
			return "consume";
		}
		if (matchesKey(data, Key.tab) || data === "\t") {
			const match = completionNames().find(
				(name) => name.startsWith(commandLine) && name !== commandLine,
			);
			if (match !== undefined) commandLine = match;
			return "consume";
		}
		if (isPrintable(data)) {
			commandLine += data;
			return "consume";
		}
		return "consume";
	};

	return {
		name: "vim",
		get mode() {
			return mode;
		},
		getCommandLine: () => (mode === "command" ? `:${commandLine}` : undefined),
		enterInsertMode: () => {
			mode = "insert";
		},
		modeLabel: () => {
			if (mode === "insert") return "-- INSERT --";
			if (mode === "normal") return "-- NORMAL --";
			return undefined; // the status bar shows the ":" line instead
		},
		handle(data: string, ctx: KeyContext): KeyResult {
			// A modal overlay owns the keys; only its cancel key is held back.
			if (ctx.overlayOpen) {
				return matchesKey(data, Key.escape) ? "consume" : "pass";
			}
			if (mode === "insert") return insert(data, ctx);
			if (mode === "normal") return normal(data, ctx);
			return command(data);
		},
		hints(ctx: KeyContext): readonly string[] {
			if (mode === "command") return ["enter run", "esc cancel", "tab complete"];
			if (mode === "insert" || ctx.focus === "composer") return ["Esc normal"];
			return ["i insert", ": command", "g? keys"];
		},
		describe: () => BINDINGS,
	};
}
