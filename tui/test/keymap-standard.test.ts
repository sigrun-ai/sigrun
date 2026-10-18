/**
 * The standard keymap (Task C3): globals fire in every focus, navigation
 * keys only act outside the composer, and every RESERVED_KEYS chord
 * passes through in every focus (ctrl+b is NEVER bound — the hard rule,
 * loop-tested over Key.ctrl encodings).
 */

import { describe, expect, test } from "vitest";
import { Key } from "@earendil-works/pi-tui";
import type { Focus } from "../src/actions.js";
import { createStandardKeymap } from "../src/keymaps/standard.js";
import { RESERVED_KEYS, type KeyContext } from "../src/keymaps/types.js";

const FOCUSES: readonly Focus[] = ["composer", "list", "transcript"];

function ctx(init?: Partial<KeyContext>): KeyContext {
	return {
		focus: "composer",
		busy: false,
		autocompleteOpen: false,
		overlayOpen: false,
		...init,
	};
}

describe("standard keymap — globals", () => {
	test("ctrl+p opens the conversation picker from the composer", () => {
		const keymap = createStandardKeymap();
		expect(keymap.handle("\x10", ctx())).toEqual({
			type: "picker",
			kind: "conversation",
		});
	});

	test("ctrl+n / ctrl+t / ctrl+o / ctrl+l / ctrl+c fire in every focus", () => {
		const keymap = createStandardKeymap();
		for (const focus of FOCUSES) {
			expect(keymap.handle("\x0e", ctx({ focus }))).toEqual({ type: "new-conversation" });
			expect(keymap.handle("\x14", ctx({ focus }))).toEqual({ type: "cycle-thinking" });
			expect(keymap.handle("\x0f", ctx({ focus }))).toEqual({ type: "answer-interaction" });
			expect(keymap.handle("\x0c", ctx({ focus }))).toEqual({ type: "redraw" });
			expect(keymap.handle("\x03", ctx({ focus }))).toEqual({ type: "quit" });
		}
	});

	test("tab cycles focus forward, shift+tab backward", () => {
		const keymap = createStandardKeymap();
		expect(keymap.handle("\t", ctx())).toEqual({ type: "focus-cycle", direction: 1 });
		expect(keymap.handle("\x1b[Z", ctx())).toEqual({ type: "focus-cycle", direction: -1 });
	});

	test("esc: busy aborts the run, idle focuses the composer, autocomplete passes", () => {
		const keymap = createStandardKeymap();
		expect(keymap.handle("\x1b", ctx({ busy: true }))).toEqual({ type: "cancel-run" });
		expect(keymap.handle("\x1b", ctx({ focus: "transcript" }))).toEqual({
			type: "focus",
			target: "composer",
		});
		expect(keymap.handle("\x1b", ctx({ autocompleteOpen: true, busy: true }))).toBe("pass");
	});
});

describe("standard keymap — focus-dependent keys", () => {
	test("y passes in the composer, copies in the transcript and list", () => {
		const keymap = createStandardKeymap();
		expect(keymap.handle("y", ctx())).toBe("pass");
		expect(keymap.handle("y", ctx({ focus: "transcript" }))).toEqual({ type: "copy" });
		expect(keymap.handle("y", ctx({ focus: "list" }))).toEqual({ type: "copy" });
	});

	test("arrows/page/home/end pass in the composer and navigate outside it", () => {
		const keymap = createStandardKeymap();
		expect(keymap.handle("\x1b[A", ctx())).toBe("pass");
		expect(keymap.handle("\x1b[A", ctx({ focus: "transcript" }))).toEqual({
			type: "move",
			delta: -1,
		});
		expect(keymap.handle("\x1b[B", ctx({ focus: "list" }))).toEqual({ type: "move", delta: 1 });
		expect(keymap.handle("\x1b[5~", ctx({ focus: "transcript" }))).toEqual({
			type: "page",
			direction: -1,
			half: false,
		});
		expect(keymap.handle("\x1b[6~", ctx({ focus: "list" }))).toEqual({
			type: "page",
			direction: 1,
			half: false,
		});
		expect(keymap.handle("\x1b[H", ctx({ focus: "transcript" }))).toEqual({
			type: "edge",
			to: "top",
		});
		expect(keymap.handle("\x1b[F", ctx({ focus: "list" }))).toEqual({
			type: "edge",
			to: "bottom",
		});
	});

	test("enter/f/e// /n/N/? pass in the composer and act outside it", () => {
		const keymap = createStandardKeymap();
		expect(keymap.handle("\r", ctx())).toBe("pass");
		expect(keymap.handle("\r", ctx({ focus: "list" }))).toEqual({ type: "open" });
		expect(keymap.handle("f", ctx({ focus: "transcript" }))).toEqual({ type: "fork-here" });
		expect(keymap.handle("e", ctx({ focus: "transcript" }))).toEqual({ type: "edit-here" });
		expect(keymap.handle("/", ctx({ focus: "transcript" }))).toEqual({
			type: "search",
			direction: "forward",
		});
		expect(keymap.handle("n", ctx({ focus: "transcript" }))).toEqual({
			type: "search-next",
			reverse: false,
		});
		expect(keymap.handle("N", ctx({ focus: "list" }))).toEqual({
			type: "search-next",
			reverse: true,
		});
		expect(keymap.handle("?", ctx({ focus: "transcript" }))).toEqual({ type: "help" });
		// None of these fire in the composer (typed text must reach it).
		for (const data of ["f", "e", "/", "n", "N", "?"]) {
			expect(keymap.handle(data, ctx())).toBe("pass");
		}
	});

	test("ctrl+d and ctrl+u are NOT bound (composer chords)", () => {
		const keymap = createStandardKeymap();
		for (const focus of FOCUSES) {
			expect(keymap.handle("\x04", ctx({ focus }))).toBe("pass");
			expect(keymap.handle("\x15", ctx({ focus }))).toBe("pass");
		}
	});
});

describe("standard keymap — reserved keys (the hard rule)", () => {
	test("every RESERVED_KEYS chord passes in every focus, busy or not", () => {
		const keymap = createStandardKeymap();
		for (const id of RESERVED_KEYS) {
			// Key.ctrl("b") etc. — the encodings terminals actually send.
			const data = keyDataFor(id);
			for (const focus of FOCUSES) {
				for (const busy of [false, true]) {
					expect(keymap.handle(data, ctx({ focus, busy }))).toBe("pass");
				}
			}
		}
	});

	test("ctrl+b is never bound even with an overlay open", () => {
		const keymap = createStandardKeymap();
		expect(keymap.handle(keyDataFor("ctrl+b"), ctx({ overlayOpen: true }))).toBe("pass");
	});
});

/** The terminal byte for a `ctrl+x` id (the legacy control-code mapping). */
function keyDataFor(id: string): string {
	const letter = id.slice("ctrl+".length);
	return String.fromCharCode(letter.charCodeAt(0) - 96);
}

describe("standard keymap — overlay", () => {
	test("everything passes while an overlay is open except ctrl+c quit", () => {
		const keymap = createStandardKeymap();
		const open = ctx({ overlayOpen: true });
		expect(keymap.handle("\x10", open)).toBe("pass"); // ctrl+p
		expect(keymap.handle("y", open)).toBe("pass");
		expect(keymap.handle("\x1b", open)).toBe("pass");
		expect(keymap.handle("\x03", open)).toEqual({ type: "quit" });
	});
});
