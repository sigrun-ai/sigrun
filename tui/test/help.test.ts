/**
 * The key reference overlay (Task C5): showHelp(tui, keymap) lists the
 * keymap's describe() table in two columns; Esc, q, or the keymap's own
 * help key closes it.
 */

import { describe, expect, test } from "vitest";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { showHelp } from "../src/ui/help.js";
import { createStandardKeymap } from "../src/keymaps/standard.js";
import { createEmacsKeymap } from "../src/keymaps/emacs.js";
import { createVimKeymap } from "../src/keymaps/vim.js";
import type { Keymap } from "../src/keymaps/types.js";

/** A TUI stub that captures the overlay component and its hide. */
function stubTui(): {
	tui: TUI;
	shown: { component: Component | undefined };
	hides: number;
} {
	const shown: { component: Component | undefined } = { component: undefined };
	const record = { hides: 0 };
	const tui = {
		showOverlay(component: Component): OverlayHandle {
			shown.component = component;
			return {
				hide: () => {
					record.hides += 1;
					shown.component = undefined;
				},
			} as unknown as OverlayHandle;
		},
	} as unknown as TUI;
	return { tui, shown, hides: record.hides };
}

describe("help overlay", () => {
	test("renders every describe() row of the standard keymap", () => {
		const { tui, shown } = stubTui();
		const keymap = createStandardKeymap();
		showHelp(tui, keymap);
		expect(shown.component).toBeDefined();
		const text = shown.component!.render(100).join("\n");
		for (const row of keymap.describe()) {
			expect(text).toContain(row.keys);
			expect(text).toContain(row.action);
		}
	});

	test("renders the emacs and vim tables too", () => {
		for (const keymap of [createEmacsKeymap(), createVimKeymap()]) {
			const { tui, shown } = stubTui();
			showHelp(tui, keymap);
			const text = shown.component!.render(100).join("\n");
			for (const row of keymap.describe()) {
				expect(text).toContain(row.action);
			}
		}
	});

	test("lays the rows out in two columns (both halves share a line)", () => {
		const { tui, shown } = stubTui();
		const keymap = createStandardKeymap();
		showHelp(tui, keymap);
		const lines = shown.component!.render(120);
		const rows = keymap.describe();
		// Two columns: a header plus ceil(n/2) body lines, not n body lines.
		expect(lines).toHaveLength(Math.ceil(rows.length / 2) + 1);
		// Both halves share a line: row i and row i+half render together.
		const left = rows[1]!;
		const right = rows[1 + Math.ceil(rows.length / 2)]!;
		expect(lines.some((line) => line.includes(left.action) && line.includes(right.action))).toBe(true);
	});

	test("Esc closes; q closes; the keymap's help key closes", () => {
		// Esc
		let env = stubTui();
		showHelp(env.tui, createStandardKeymap());
		env.shown.component!.handleInput!("\x1b");
		expect(env.shown.component).toBeUndefined();
		// q
		env = stubTui();
		showHelp(env.tui, createVimKeymap());
		env.shown.component!.handleInput!("q");
		expect(env.shown.component).toBeUndefined();
		// The standard keymap's help key is "?".
		env = stubTui();
		showHelp(env.tui, createStandardKeymap());
		env.shown.component!.handleInput!("?");
		expect(env.shown.component).toBeUndefined();
		// The emacs keymap's help key is C-h ("\x08").
		env = stubTui();
		showHelp(env.tui, createEmacsKeymap());
		env.shown.component!.handleInput!("\x08");
		expect(env.shown.component).toBeUndefined();
	});

	test("the vim overlay closes on g? but not on bare g or ?", () => {
		const { tui, shown } = stubTui();
		showHelp(tui, createVimKeymap());
		shown.component!.handleInput!("?"); // bare ? is not vim's help key
		expect(shown.component).toBeDefined();
		shown.component!.handleInput!("g");
		expect(shown.component).toBeDefined(); // g alone arms, never closes
		shown.component!.handleInput!("?");
		expect(shown.component).toBeUndefined(); // g? closes
	});

	test("onClose fires when the overlay closes", () => {
		const { tui, shown } = stubTui();
		let closed = 0;
		showHelp(tui, createStandardKeymap(), { onClose: () => (closed += 1) });
		shown.component!.handleInput!("q");
		expect(closed).toBe(1);
	});

	test("unrelated keys are consumed, not closers", () => {
		const { tui, shown } = stubTui();
		showHelp(tui, createStandardKeymap());
		shown.component!.handleInput!("x");
		expect(shown.component).toBeDefined();
	});

	test("the emacs overlay does NOT close on '?' (not its help key)", () => {
		const { tui, shown } = stubTui();
		showHelp(tui, createEmacsKeymap());
		shown.component!.handleInput!("?");
		expect(shown.component).toBeDefined();
	});

	test("accepts any Keymap-typed value (the declared signature)", () => {
		const { tui, shown } = stubTui();
		const keymap: Keymap = createEmacsKeymap();
		showHelp(tui, keymap);
		expect(shown.component).toBeDefined();
	});
});
