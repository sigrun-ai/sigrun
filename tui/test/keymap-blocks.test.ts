/**
 * The block-surface keys (UI-blocks U2 Task 4, spec §12.4): the
 * `blocks.*` actions exist in all three keymaps, route ONLY while the
 * `surface` focus is active, and appear in every keymap's describe()
 * table (the help overlay renders it verbatim).
 *
 * - standard + vim: `m` picks up, Enter drops, Esc cancels;
 * - emacs: `M-m` picks up, Enter drops, `C-g` cancels;
 * - all three: Space selects, `.` the action menu, `x` checks,
 *   `[`/`]` range prev/next, `t` today.
 */

import { describe, expect, test } from "vitest";
import { createStandardKeymap } from "../src/keymaps/standard.js";
import { createVimKeymap, type VimKeymap } from "../src/keymaps/vim.js";
import { createEmacsKeymap } from "../src/keymaps/emacs.js";
import type { Keymap } from "../src/keymaps/types.js";
import type { KeyContext } from "../src/keymaps/types.js";

function ctx(init?: Partial<KeyContext>): KeyContext {
	return {
		focus: "surface",
		busy: false,
		autocompleteOpen: false,
		overlayOpen: false,
		...init,
	};
}

/** A vim keymap in NORMAL mode (its insert mode types everything). */
function normalVim(): VimKeymap {
	const keymap = createVimKeymap();
	// Esc from insert lands in normal.
	keymap.handle("\x1b", ctx({ focus: "composer" }));
	return keymap;
}

describe("block-surface keys — standard", () => {
	const keymap = createStandardKeymap();

	test("m / enter / esc / space / . / x / [ ] t map to the blocks actions", () => {
		expect(keymap.handle("m", ctx())).toEqual({ type: "blocks.pickUp" });
		expect(keymap.handle("\r", ctx())).toEqual({ type: "blocks.drop" });
		expect(keymap.handle("\x1b", ctx())).toEqual({ type: "blocks.cancelMove" });
		expect(keymap.handle(" ", ctx())).toEqual({ type: "blocks.select" });
		expect(keymap.handle(".", ctx())).toEqual({ type: "blocks.actionMenu" });
		expect(keymap.handle("x", ctx())).toEqual({ type: "blocks.check" });
		expect(keymap.handle("[", ctx())).toEqual({ type: "blocks.rangePrev" });
		expect(keymap.handle("]", ctx())).toEqual({ type: "blocks.rangeNext" });
		expect(keymap.handle("t", ctx())).toEqual({ type: "blocks.today" });
	});

	test("esc stays global while busy (cancel-run wins over cancel-move)", () => {
		expect(keymap.handle("\x1b", ctx({ busy: true }))).toEqual({ type: "cancel-run" });
	});

	test("esc outside a surface still focuses the composer", () => {
		expect(keymap.handle("\x1b", ctx({ focus: "transcript" }))).toEqual({
			type: "focus",
			target: "composer",
		});
	});

	test("the same keys pass in other focuses", () => {
		for (const focus of ["composer", "list", "transcript"] as const) {
			expect(keymap.handle("m", ctx({ focus }))).toBe("pass");
			expect(keymap.handle("x", ctx({ focus }))).toBe("pass");
			expect(keymap.handle("[", ctx({ focus }))).toBe("pass");
		}
	});
});

describe("block-surface keys — vim (normal mode)", () => {
	test("m / enter / esc / space / . / x / [ ] t map to the blocks actions", () => {
		const keymap = normalVim();
		expect(keymap.handle("m", ctx())).toEqual({ type: "blocks.pickUp" });
		expect(keymap.handle("\r", ctx())).toEqual({ type: "blocks.drop" });
		expect(keymap.handle("\x1b", ctx())).toEqual({ type: "blocks.cancelMove" });
		expect(keymap.handle(" ", ctx())).toEqual({ type: "blocks.select" });
		expect(keymap.handle(".", ctx())).toEqual({ type: "blocks.actionMenu" });
		expect(keymap.handle("x", ctx())).toEqual({ type: "blocks.check" });
		expect(keymap.handle("[", ctx())).toEqual({ type: "blocks.rangePrev" });
		expect(keymap.handle("]", ctx())).toEqual({ type: "blocks.rangeNext" });
		expect(keymap.handle("t", ctx())).toEqual({ type: "blocks.today" });
	});

	test("in other focuses m types/consumes as before (never a blocks action)", () => {
		const keymap = normalVim();
		// list focus: m is unbound → consumed (vim normal never leaks printables).
		expect(keymap.handle("m", ctx({ focus: "list" }))).toBe("consume");
		// insert mode in the composer: m types.
		const insert = createVimKeymap();
		expect(insert.handle("m", ctx({ focus: "composer" }))).toBe("pass");
	});
});

describe("block-surface keys — emacs", () => {
	const keymap = createEmacsKeymap();

	test("M-m / enter / C-g / space / . / x / [ ] t map to the blocks actions", () => {
		expect(keymap.handle("\x1bm", ctx())).toEqual({ type: "blocks.pickUp" });
		expect(keymap.handle("\r", ctx())).toEqual({ type: "blocks.drop" });
		expect(keymap.handle("\x07", ctx())).toEqual({ type: "blocks.cancelMove" });
		expect(keymap.handle(" ", ctx())).toEqual({ type: "blocks.select" });
		expect(keymap.handle(".", ctx())).toEqual({ type: "blocks.actionMenu" });
		expect(keymap.handle("x", ctx())).toEqual({ type: "blocks.check" });
		expect(keymap.handle("[", ctx())).toEqual({ type: "blocks.rangePrev" });
		expect(keymap.handle("]", ctx())).toEqual({ type: "blocks.rangeNext" });
		expect(keymap.handle("t", ctx())).toEqual({ type: "blocks.today" });
	});

	test("M-m passes outside the surface focus", () => {
		expect(keymap.handle("\x1bm", ctx({ focus: "composer" }))).toBe("pass");
	});
});

describe("block-surface keys — the help overlay lists them (§12.4)", () => {
	test("every keymap's describe() table names the blocks actions", () => {
		const keymaps: Keymap[] = [createStandardKeymap(), createVimKeymap(), createEmacsKeymap()];
		for (const keymap of keymaps) {
			const text = keymap
				.describe()
				.map((row) => `${row.keys} ${row.action}`)
				.join("\n");
			expect(text).toContain("pick up (block surface)");
			expect(text).toContain("drop (block surface)");
			expect(text).toContain("cancel move (block surface)");
			expect(text).toContain("select (block surface)");
			expect(text).toContain("action menu (block surface)");
			expect(text).toContain("check (block surface)");
			expect(text).toContain("range (calendar)");
			expect(text).toContain("today (calendar)");
		}
	});

	test("emacs uses M-m for pick up", () => {
		const text = createEmacsKeymap()
			.describe()
			.map((row) => `${row.keys} ${row.action}`)
			.join("\n");
		expect(text).toContain("M-m");
	});
});
