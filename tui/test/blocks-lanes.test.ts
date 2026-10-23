/**
 * The `lanes` display (UI-blocks U2 Task 4, spec §5.5 + §12.3 + §12.4):
 * lanes side by side at regular/wide, one lane plus a Tab/Shift+Tab
 * switcher at compact; "Move to…" in the `.` menu at compact; keyboard
 * moves (`m` pick up, arrows place, Enter drop, Esc cancel) dispatch
 * the U1 pointer-drop payload `{itemId, from: {group, index}, to:
 * {group, index}}`. Review Focus 1: a resize while picked up keeps the
 * pick-up and recomputes the drop target in the new layout.
 */

import { describe, expect, test } from "vitest";
import type { Action, CollectionBlock, JsonObject, JsonValue } from "@sigrun/shared/blocks";
import { plainTuiTheme } from "../src/theme.js";
import { renderBlock } from "../src/blocks/render.js";
import type { BlockCtx } from "../src/blocks/render.js";

interface Captured {
	action: { type: string; name?: string };
	payload: JsonValue;
}

function makeCtx(data: Record<string, JsonValue>): { ctx: BlockCtx; captured: Captured[] } {
	const captured: Captured[] = [];
	const ctx: BlockCtx = {
		data,
		theme: plainTuiTheme(),
		locale: "en-CA",
		timeZone: "UTC",
		access: "write",
		unicode: true,
		dispatch: (action, payload) => {
			captured.push({ action: action as Captured["action"], payload });
		},
		view: { values: {} },
	};
	return { ctx, captured };
}

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const STAB = "\x1b[Z";

const BOARD: CollectionBlock = {
	type: "collection",
	items: { $: "/items" },
	display: "lanes",
	groupBy: "status",
	groups: [
		{ id: "todo", title: "To do" },
		{ id: "doing", title: "Doing" },
		{ id: "done", title: "Done" },
	],
	item: { title: { $: "./title" } },
	onMove: "move-task",
};

const ITEMS: JsonValue = [
	{ id: "t-1", title: "Alpha", status: "todo" },
	{ id: "t-2", title: "Beta", status: "todo" },
	{ id: "t-3", title: "Gamma", status: "doing" },
];

function data(items: JsonValue): Record<string, JsonValue> {
	return { items };
}

describe("lanes — layout (§5.5, §12.3)", () => {
	test("regular/wide renders every lane side by side with its cards", () => {
		const { ctx } = makeCtx(data(ITEMS));
		const lines = renderBlock(BOARD, ctx).render(160).join("\n");
		expect(lines).toContain("## To do");
		expect(lines).toContain("## Doing");
		expect(lines).toContain("## Done");
		expect(lines).toContain("Alpha");
		expect(lines).toContain("Gamma");
		// Side by side: the headings share one row.
		const headingRow = lines.split("\n").find((line) => line.includes("## To do"));
		expect(headingRow).toContain("## Doing");
	});

	test("compact renders ONE lane plus a switcher; Tab/Shift+Tab cycle", () => {
		const { ctx } = makeCtx(data(ITEMS));
		const comp = renderBlock(BOARD, ctx);
		let text = comp.render(72).join("\n");
		// Only the first lane's cards render.
		expect(text).toContain("Alpha");
		expect(text).not.toContain("Gamma");
		// The switcher lists every lane.
		expect(text).toContain("To do");
		expect(text).toContain("Doing");
		comp.handleInput?.(TAB);
		text = comp.render(72).join("\n");
		expect(text).toContain("Gamma");
		expect(text).not.toContain("Alpha");
		comp.handleInput?.(STAB);
		text = comp.render(72).join("\n");
		expect(text).toContain("Alpha");
	});
});

describe("lanes — keyboard moves (§12.4)", () => {
	test("m → → → ↓ → Enter dispatches the U1 move payload", () => {
		const { ctx, captured } = makeCtx(data(ITEMS));
		const comp = renderBlock(BOARD, ctx);
		comp.render(160);
		// Cursor starts on todo's first item (t-1).
		comp.handleInput?.("m");
		// The pick-up marker renders.
		expect(comp.render(160).join("\n")).toContain("✋");
		comp.handleInput?.(RIGHT); // across to "doing"
		comp.handleInput?.(DOWN); // index 1 within "doing"
		comp.handleInput?.(ENTER);
		expect(captured).toEqual([
			{
				action: { type: "move", name: "move-task" },
				payload: {
					itemId: "t-1",
					from: { group: "todo", index: 0 },
					to: { group: "doing", index: 1 },
				},
			},
		]);
	});

	test("Esc cancels the pick-up without dispatching", () => {
		const { ctx, captured } = makeCtx(data(ITEMS));
		const comp = renderBlock(BOARD, ctx);
		comp.render(160);
		comp.handleInput?.("m");
		comp.handleInput?.(RIGHT);
		comp.handleInput?.(ESC);
		comp.handleInput?.(ENTER);
		expect(captured.filter((c) => c.action.type === "move")).toHaveLength(0);
		// The marker is gone.
		expect(comp.render(160).join("\n")).not.toContain("✋");
	});

	test("a drop at the item's own placement dispatches nothing", () => {
		const { ctx, captured } = makeCtx(data(ITEMS));
		const comp = renderBlock(BOARD, ctx);
		comp.render(160);
		comp.handleInput?.("m");
		comp.handleInput?.(ENTER);
		expect(captured).toHaveLength(0);
	});

	test("Review Focus 1: a resize while picked up keeps the pick-up and the drop recomputes", () => {
		const { ctx, captured } = makeCtx(data(ITEMS));
		const comp = renderBlock(BOARD, ctx);
		comp.render(160);
		comp.handleInput?.("m");
		expect(comp.render(160).join("\n")).toContain("✋");
		// Resize across the compact boundary: the pick-up survives.
		const compact = comp.render(72).join("\n");
		expect(compact).toContain("✋");
		comp.render(160);
		comp.handleInput?.(RIGHT);
		comp.handleInput?.(ENTER);
		expect(captured).toEqual([
			{
				action: { type: "move", name: "move-task" },
				payload: {
					itemId: "t-1",
					from: { group: "todo", index: 0 },
					to: { group: "doing", index: 0 },
				},
			},
		]);
	});
});

describe("lanes — the compact 'Move to…' menu (§12.3)", () => {
	test(". at compact lists the OTHER groups and dispatches the move to the lane's end", () => {
		const { ctx, captured } = makeCtx(data(ITEMS));
		const comp = renderBlock(BOARD, ctx);
		comp.render(72);
		comp.handleInput?.(".");
		const menu = comp.render(72).join("\n");
		expect(menu).toContain("Move to…");
		expect(menu).toContain("Doing");
		expect(menu).toContain("Done");
		expect(menu).not.toContain("> To do"); // the current lane is not a target
		comp.handleInput?.(ENTER); // the first target: "doing"
		expect(captured).toEqual([
			{
				action: { type: "move", name: "move-task" },
				payload: {
					itemId: "t-1",
					from: { group: "todo", index: 0 },
					// The doing lane holds t-3: the target index is its end.
					to: { group: "doing", index: 1 },
				},
			},
		]);
	});
});
