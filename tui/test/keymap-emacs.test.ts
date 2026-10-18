/**
 * The emacs keymap (Task C5): modeless, C-x chord prefix (1 000 ms),
 * M-x command picker, C-s/C-r search, C-g cancel/close/composer, M-w/M-f/
 * M-e copy/fork/edit outside the composer, and the RESERVED_KEYS
 * pass-through invariant (ctrl+b is NEVER bound).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createEmacsKeymap } from "../src/keymaps/emacs.js";
import { RESERVED_KEYS, type KeyContext } from "../src/keymaps/types.js";

function ctx(init?: Partial<KeyContext>): KeyContext {
	return {
		focus: "composer",
		busy: false,
		autocompleteOpen: false,
		overlayOpen: false,
		...init,
	};
}

describe("emacs keymap — C-x chord", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("C-x then b → conversation picker", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x18", ctx())).toBe("consume");
		expect(keymap.handle("b", ctx())).toEqual({
			type: "picker",
			kind: "conversation",
		});
	});

	test("C-x then o → focus cycle forward; C-x C-c → quit; C-x k consumed", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x18", ctx())).toBe("consume");
		expect(keymap.handle("o", ctx())).toEqual({
			type: "focus-cycle",
			direction: 1,
		});
		expect(keymap.handle("\x18", ctx())).toBe("consume");
		expect(keymap.handle("\x03", ctx())).toEqual({ type: "quit" });
		expect(keymap.handle("\x18", ctx())).toBe("consume");
		expect(keymap.handle("k", ctx())).toBe("consume");
	});

	test("C-x then 1 100 ms then b → the prefix expired, b passes", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x18", ctx())).toBe("consume");
		vi.setSystemTime(Date.now() + 1_100);
		expect(keymap.handle("b", ctx())).toBe("pass");
	});

	test("a reserved pass-through disarms the chord (C-x C-b b does not pick)", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x18", ctx())).toBe("consume");
		expect(keymap.handle("\x02", ctx())).toBe("pass"); // C-b is reserved
		expect(keymap.handle("b", ctx())).toBe("pass"); // the user's "b", not a chord
	});

	test("a mismatched chord follow-up is consumed (emacs undefined-key beep)", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x18", ctx())).toBe("consume");
		expect(keymap.handle("z", ctx())).toBe("consume");
	});
});

describe("emacs keymap — globals", () => {
	test("M-x opens the command picker", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x1bx", ctx())).toEqual({
			type: "picker",
			kind: "command",
		});
	});

	test("C-s / C-r search forward / backward in any focus", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x13", ctx())).toEqual({
			type: "search",
			direction: "forward",
		});
		expect(keymap.handle("\x12", ctx({ focus: "transcript" }))).toEqual({
			type: "search",
			direction: "backward",
		});
	});

	test("C-g busy → cancel-run; idle → focus composer", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x07", ctx({ busy: true }))).toEqual({
			type: "cancel-run",
		});
		expect(keymap.handle("\x07", ctx({ focus: "transcript" }))).toEqual({
			type: "focus",
			target: "composer",
		});
	});

	test("C-g with an overlay open passes (the overlay closes itself)", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x07", ctx({ overlayOpen: true }))).toBe("pass");
	});

	test("M-p / M-n jump between prompts; C-o answers; C-l redraws; C-h helps", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x1bp", ctx())).toEqual({
			type: "prompt-jump",
			delta: -1,
		});
		expect(keymap.handle("\x1bn", ctx())).toEqual({
			type: "prompt-jump",
			delta: 1,
		});
		expect(keymap.handle("\x0f", ctx())).toEqual({ type: "answer-interaction" });
		expect(keymap.handle("\x0c", ctx())).toEqual({ type: "redraw" });
		expect(keymap.handle("\x08", ctx())).toEqual({ type: "help" });
	});
});

describe("emacs keymap — focus-dependent bindings", () => {
	test("M-f in the composer passes (the editor's word-forward)", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x1bf", ctx())).toBe("pass");
	});

	test("M-f in the transcript forks here; M-w copies; M-e edits", () => {
		const keymap = createEmacsKeymap();
		const transcript = ctx({ focus: "transcript" });
		expect(keymap.handle("\x1bf", transcript)).toEqual({ type: "fork-here" });
		expect(keymap.handle("\x1bw", transcript)).toEqual({ type: "copy" });
		expect(keymap.handle("\x1be", transcript)).toEqual({ type: "edit-here" });
	});

	test("M-w / M-e in the composer pass (outside-composer actions)", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x1bw", ctx())).toBe("pass");
		expect(keymap.handle("\x1be", ctx())).toBe("pass");
	});

	test("C-n / C-p move outside the composer, pass inside it", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\x0e", ctx({ focus: "list" }))).toEqual({
			type: "move",
			delta: 1,
		});
		expect(keymap.handle("\x10", ctx({ focus: "transcript" }))).toEqual({
			type: "move",
			delta: -1,
		});
		expect(keymap.handle("\x0e", ctx())).toBe("pass");
		expect(keymap.handle("\x10", ctx())).toBe("pass");
	});

	test("enter opens/folds outside the composer, passes inside it", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.handle("\r", ctx({ focus: "transcript" }))).toEqual({
			type: "open",
		});
		expect(keymap.handle("\r", ctx())).toBe("pass");
	});
});

describe("emacs keymap — invariants", () => {
	test("every RESERVED_KEYS chord passes in every focus (ctrl+b never bound)", () => {
		const keymap = createEmacsKeymap();
		for (const id of RESERVED_KEYS) {
			const letter = id.replace("ctrl+", "");
			const data = String.fromCharCode(letter.charCodeAt(0) - 96);
			for (const focus of ["composer", "list", "transcript"] as const) {
				expect(keymap.handle(data, ctx({ focus }))).toBe("pass");
			}
		}
	});

	test("while an overlay is open everything passes (the overlay owns keys)", () => {
		const keymap = createEmacsKeymap();
		const open = ctx({ overlayOpen: true });
		expect(keymap.handle("b", open)).toBe("pass");
		expect(keymap.handle("\x1bw", open)).toBe("pass");
		expect(keymap.handle("\x0e", open)).toBe("pass");
	});

	test("modeless: no mode label; hints name the chord keys", () => {
		const keymap = createEmacsKeymap();
		expect(keymap.name).toBe("emacs");
		expect(keymap.modeLabel()).toBeUndefined();
		expect(keymap.hints(ctx())).toEqual([
			"C-x b chats",
			"M-x commands",
			"C-h keys",
		]);
	});

	test("describe() lists every binding group", () => {
		const keymap = createEmacsKeymap();
		const keys = keymap.describe().map((row) => row.keys);
		for (const expected of ["C-x b", "M-x", "C-s / C-r", "C-g", "M-w", "C-h"]) {
			expect(keys).toContain(expected);
		}
		expect(keymap.describe().some((row) => row.keys.includes("C-b"))).toBe(false);
	});
});
