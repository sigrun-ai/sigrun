/**
 * The `collection` block (UI-blocks U2 Task 3, spec §5.5 + §5.5.1 +
 * §12.3): the fixed card slots, and the list/table/grid displays.
 *
 * - Card slot order is FIXED (§5.5.1): eyebrow line, title (icon + tone
 *   marker), subtitle, body clamped to 4 lines, badges + meta on one
 *   line, metrics, status with a spinner frame, deps as "after: …".
 * - List: groups render in `groups` order, nesting indents 2 cells per
 *   level, `numbered`, checkable toggles via `x` dispatching `onCheck`
 *   with `{itemId, value}`, quiet items fold behind "N more".
 * - Table: `s` picks a sortable column and cycles asc → desc, alignment
 *   is by DISPLAY width (CJK titles pin this), 50 rows per page with
 *   PgUp/PgDn; at compact width rows become cards with the
 *   `priority: "low"` columns behind Enter-expand.
 * - Grid: `floor(width / token)` columns (`s`=30 without image, `m`=45
 *   with), `overflow: "scroll"` stays one row.
 * - `Space` selects, `.` opens the bulk action menu; an action with a
 *   `form` opens the seam form and dispatches `{ids, values}` (the real
 *   form renderer is Task 5's — this is the seam note only).
 */

import { describe, expect, test, vi } from "vitest";
import type { Action, Block, CollectionBlock, JsonObject, JsonValue } from "@sigrun/shared/blocks";
import { plainTuiTheme } from "../src/theme.js";
import { renderBlock } from "../src/blocks/render.js";
import type { BlockCtx } from "../src/blocks/render.js";

interface Captured {
	action: Action;
	payload: JsonValue;
}

function makeCtx(
	data: Record<string, JsonValue>,
	opts: { unicode?: boolean } = {},
): { ctx: BlockCtx; captured: Captured[] } {
	const captured: Captured[] = [];
	const ctx: BlockCtx = {
		data,
		theme: plainTuiTheme(),
		locale: "en-CA",
		timeZone: "UTC",
		access: "write",
		unicode: opts.unicode ?? true,
		dispatch: (action, payload) => {
			captured.push({ action, payload });
		},
		view: { values: {} },
	};
	return { ctx, captured };
}

const ENTER = "\r";
const DOWN = "\x1b[B";
const PGDN = "\x1b[6~";
const PGUP = "\x1b[5~";

// ─── card slots (§5.5.1) ────────────────────────────────────────────────────

const FULL_CARD_ITEM: JsonObject = {
	id: "t-1",
	eyebrow: "acme/queue · 2026-10-20",
	title: "Drain the queue",
	subtitle: "billing lane",
	body: "line one\nline two\nline three\nline four\nline five\nline six",
	icon: "clock",
	b0: "urgent",
	b1: "customer",
	owner: "A. Lovelace",
	eta: "2026-10-21T12:00:00Z",
	p40: 40,
	p95: 190,
	tone: "warn",
	status: "running",
	spin: true,
	deps: ["t-0", "t-pre"],
};

const FULL_CARD: CollectionBlock = {
	type: "collection",
	items: { $: "/items" },
	display: "list",
	item: {
		eyebrow: { $: "./eyebrow" },
		title: { $: "./title" },
		subtitle: { $: "./subtitle" },
		body: { $: "./body" },
		icon: { $: "./icon" },
		badges: [{ text: { $: "./b0" } }, { text: { $: "./b1" }, tone: "bad" }],
		meta: [
			{ person: { user: "ada", name: { $: "./owner" } } },
			{ time: { $: "./eta" }, format: "date" },
		],
		metrics: [
			{ label: "p40", value: { $: "./p40" } },
			{ label: "p95", value: { $: "./p95" } },
		],
		tone: { $: "./tone" },
		status: { label: { $: "./status" }, tone: "good", spinner: { $: "./spin" } },
		deps: { $: "./deps" },
	},
};

describe("card slots (§5.5.1)", () => {
	test("every slot renders in the fixed line order", () => {
		const { ctx } = makeCtx({ items: [FULL_CARD_ITEM] });
		const lines = renderBlock(FULL_CARD, ctx).render(100).filter((l) => l.trim() !== "");
		const idx = (needle: string): number => {
			const at = lines.findIndex((l) => l.includes(needle));
			expect(at, `missing slot text: ${needle}`).toBeGreaterThanOrEqual(0);
			return at;
		};
		// eyebrow → title → subtitle → body → badges+meta → metrics → status → after.
		const order = [
			idx("acme/queue · 2026-10-20"),
			idx("Drain the queue"),
			idx("billing lane"),
			idx("line one"),
			idx("A. Lovelace"),
			idx("p40: 40"),
			idx("p95: 190"),
			idx("running"),
			idx("after: t-0, t-pre"),
		];
		for (let i = 1; i < order.length; i++) {
			expect(order[i]).toBeGreaterThan(order[i - 1] ?? -1);
		}
	});

	test("the title line carries the icon glyph and the tone marker", () => {
		const { ctx } = makeCtx({ items: [FULL_CARD_ITEM] });
		const lines = renderBlock(FULL_CARD, ctx).render(100);
		const titleLine = lines.find((l) => l.includes("Drain the queue"));
		expect(titleLine).toBeDefined();
		// warn tone marker (▲) and the clock icon (◷) ride the title line.
		expect(titleLine).toContain("▲");
		expect(titleLine).toContain("◷");
	});

	test("badges and meta share one line", () => {
		const { ctx } = makeCtx({ items: [FULL_CARD_ITEM] });
		const lines = renderBlock(FULL_CARD, ctx).render(100);
		const line = lines.find((l) => l.includes("A. Lovelace"));
		expect(line).toBeDefined();
		expect(line).toContain("urgent");
		expect(line).toContain("customer");
		expect(line).toContain("Oct 21, 2026");
	});

	test("the body clamps to 4 lines", () => {
		// Narrow enough that each body line wraps to its own row (>4 rows).
		const { ctx } = makeCtx({ items: [FULL_CARD_ITEM] });
		const lines = renderBlock(FULL_CARD, ctx).render(12).filter((l) => l.includes("line "));
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("line one");
		expect(lines[3]).toContain("line four");
	});

	test("status shows a spinner frame; the frame ticks per render", () => {
		const { ctx } = makeCtx({ items: [FULL_CARD_ITEM] });
		const comp = renderBlock(FULL_CARD, ctx);
		const first = comp.render(100).find((l) => l.includes("running")) ?? "";
		const second = comp.render(100).find((l) => l.includes("running")) ?? "";
		expect(first).toContain("⠋");
		expect(second).toContain("⠙");
	});

	test("ASCII ctx: tone marker, spinner frame and icon fall back to ASCII", () => {
		const { ctx } = makeCtx({ items: [FULL_CARD_ITEM] }, { unicode: false });
		const lines = renderBlock(FULL_CARD, ctx).render(100);
		const titleLine = lines.find((l) => l.includes("Drain the queue")) ?? "";
		expect(titleLine).toContain("^"); // warn ASCII marker
		expect(titleLine).not.toContain("▲");
		const statusLine = lines.find((l) => l.includes("running")) ?? "";
		expect(statusLine).toContain("*"); // ASCII spinner frame
	});

	test("optional slots omit cleanly", () => {
		const minimal: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" } },
		};
		const { ctx } = makeCtx({ items: [{ id: "a", title: "Just a title" }] });
		const lines = renderBlock(minimal, ctx).render(80);
		expect(lines.some((l) => l.includes("Just a title"))).toBe(true);
		expect(lines.some((l) => l.includes("after:"))).toBe(false);
	});

	test("card tone tints the title through the theme", () => {
		const marking = {
			...plainTuiTheme(),
			fg: (token: string) => (s: string) => `<${token}>${s}</>`,
		};
		const ctx: BlockCtx = {
			data: { items: [{ id: "a", title: "Toned", tone: "good" }] },
			theme: marking,
			locale: "en-CA",
			timeZone: "UTC",
			access: "write",
			unicode: true,
			dispatch: () => {},
			view: { values: {} },
		};
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" }, tone: { $: "./tone" } },
		};
		const lines = renderBlock(block, ctx).render(80);
		expect(lines.some((l) => l.includes("<ok>") && l.includes("Toned"))).toBe(true);
	});
});

// ─── list display ───────────────────────────────────────────────────────────

const GROUPED: CollectionBlock = {
	type: "collection",
	items: { $: "/items" },
	display: "list",
	item: { title: { $: "./title" } },
	groupBy: "lane",
	groups: [
		{ id: "doing", title: "Doing" },
		{ id: "todo", title: "To do" },
	],
};

describe("list display", () => {
	test("groups render in `groups` order, not data order", () => {
		const { ctx } = makeCtx({
			items: [
				{ id: "a", title: "Alpha", lane: "todo" },
				{ id: "b", title: "Beta", lane: "doing" },
			],
		});
		const lines = renderBlock(GROUPED, ctx).render(80);
		const doingAt = lines.findIndex((l) => l.includes("Doing"));
		const betaAt = lines.findIndex((l) => l.includes("Beta"));
		const todoAt = lines.findIndex((l) => l.includes("To do"));
		const alphaAt = lines.findIndex((l) => l.includes("Alpha"));
		expect(doingAt).toBeGreaterThanOrEqual(0);
		expect(doingAt).toBeLessThan(betaAt);
		expect(betaAt).toBeLessThan(todoAt);
		expect(todoAt).toBeLessThan(alphaAt);
	});

	test("a collapsed group hides its rows behind the heading", () => {
		const block: CollectionBlock = {
			...GROUPED,
			groups: [
				{ id: "doing", title: "Doing", collapsed: true },
				{ id: "todo", title: "To do" },
			],
		};
		const { ctx } = makeCtx({
			items: [
				{ id: "a", title: "Alpha", lane: "todo" },
				{ id: "b", title: "Beta", lane: "doing" },
			],
		});
		const lines = renderBlock(block, ctx).render(80);
		expect(lines.some((l) => l.includes("Doing"))).toBe(true);
		expect(lines.some((l) => l.includes("Beta"))).toBe(false);
		expect(lines.some((l) => l.includes("Alpha"))).toBe(true);
	});

	test("nesting indents 2 cells per level", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" } },
			children: "subs",
		};
		const { ctx } = makeCtx({
			items: [{ id: "a", title: "Parent", subs: [{ id: "b", title: "Child" }] }],
		});
		const lines = renderBlock(block, ctx).render(80);
		const parent = lines.find((l) => l.includes("Parent")) ?? "";
		const child = lines.find((l) => l.includes("Child")) ?? "";
		// After the 2-cell cursor column, the child sits 2 cells deeper
		// than the parent (one nesting level = 2 cells).
		expect(parent.slice(2)).toBe("• Parent");
		expect(child.slice(2)).toBe("  • Child");
	});

	test("numbered prefixes rows", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			numbered: true,
			item: { title: { $: "./title" } },
		};
		const { ctx } = makeCtx({
			items: [
				{ id: "a", title: "First" },
				{ id: "b", title: "Second" },
			],
		});
		const lines = renderBlock(block, ctx).render(80);
		expect(lines.some((l) => l.includes("1. ") && l.includes("First"))).toBe(true);
		expect(lines.some((l) => l.includes("2. ") && l.includes("Second"))).toBe(true);
	});

	test("x toggles a checkable item and dispatches onCheck {itemId, value}", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" } },
			checkable: "done",
			onCheck: "setDone",
		};
		const { ctx, captured } = makeCtx({
			items: [
				{ id: "a", title: "Checked row", done: false },
				{ id: "b", title: "Other", done: true },
			],
		});
		const comp = renderBlock(block, ctx);
		let lines = comp.render(80);
		expect(lines.some((l) => l.includes("[ ]") && l.includes("Checked row"))).toBe(true);
		expect(lines.some((l) => l.includes("[x]") && l.includes("Other"))).toBe(true);
		comp.handleInput?.("x"); // cursor starts on the first row
		expect(captured).toEqual([
			{ action: { type: "edit", name: "setDone" }, payload: { itemId: "a", value: true } },
		]);
		// the toggle is optimistic: the box flips locally
		lines = comp.render(80);
		expect(lines.some((l) => l.includes("[x]") && l.includes("Checked row"))).toBe(true);
	});

	test("x on the second row toggles that row only", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" } },
			checkable: "done",
			onCheck: "setDone",
		};
		const { ctx, captured } = makeCtx({
			items: [
				{ id: "a", title: "One", done: false },
				{ id: "b", title: "Two", done: true },
			],
		});
		const comp = renderBlock(block, ctx);
		comp.render(80);
		comp.handleInput?.(DOWN);
		comp.handleInput?.("x");
		expect(captured).toEqual([
			{ action: { type: "edit", name: "setDone" }, payload: { itemId: "b", value: false } },
		]);
	});

	test("quiet items fold behind an \"N more\" line", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" }, quiet: { $: "./quiet" } },
		};
		const { ctx } = makeCtx({
			items: [
				{ id: "a", title: "Loud", quiet: false },
				{ id: "b", title: "Hushed one", quiet: true },
				{ id: "c", title: "Hushed two", quiet: true },
			],
		});
		const comp = renderBlock(block, ctx);
		let lines = comp.render(80);
		expect(lines.some((l) => l.includes("Loud"))).toBe(true);
		expect(lines.some((l) => l.includes("Hushed"))).toBe(false);
		expect(lines.some((l) => l.includes("2 more"))).toBe(true);
		// Enter on the "N more" row unfolds.
		comp.handleInput?.(DOWN); // cursor past "Loud" onto "2 more"
		comp.handleInput?.(ENTER);
		lines = comp.render(80);
		expect(lines.some((l) => l.includes("Hushed one"))).toBe(true);
		expect(lines.some((l) => l.includes("Hushed two"))).toBe(true);
		expect(lines.some((l) => l.includes("Show less"))).toBe(true);
	});

	test("Space selects, . opens the bulk action menu, choosing dispatches", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" } },
			select: "multi",
			bulkActions: [
				{ id: "archive", label: "Archive", onSubmit: "archiveItems" },
				{
					id: "tag",
					label: "Tag",
					onSubmit: "tagItems",
					form: { v: 1, root: { type: "stack", children: [] } },
				},
			],
		};
		const { ctx, captured } = makeCtx({
			items: [
				{ id: "a", title: "Row A" },
				{ id: "b", title: "Row B" },
			],
		});
		const comp = renderBlock(block, ctx);
		let lines = comp.render(80);
		comp.handleInput?.(" "); // select Row A (cursor at 0)
		lines = comp.render(80);
		expect(lines.some((l) => l.includes("(•)") || l.includes("(*)"))).toBe(true);
		comp.handleInput?.("."); // open the bulk menu
		lines = comp.render(80);
		expect(lines.some((l) => l.includes("Bulk actions (1 selected)"))).toBe(true);
		expect(lines.some((l) => l.includes("Archive"))).toBe(true);
		expect(lines.some((l) => l.includes("Tag"))).toBe(true);
		// choose "archive" (no form): dispatches {ids}
		comp.handleInput?.(ENTER);
		expect(captured).toEqual([
			{ action: { type: "submit", name: "archiveItems" }, payload: { ids: ["a"] } },
		]);
		// selection cleared after the action; menu closed
		lines = comp.render(80);
		expect(lines.some((l) => l.includes("Bulk actions"))).toBe(false);
	});

	test("a bulk action with a form opens the seam form and rides {ids, values}", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" } },
			select: "multi",
			bulkActions: [
				{
					id: "tag",
					label: "Tag",
					onSubmit: "tagItems",
					form: {
						v: 1,
						root: {
							type: "form",
							bind: "/view/form",
							mode: "submit",
							onSubmit: "tagItems",
							children: [{ type: "text", name: "label", label: "Label" }],
						},
					},
				},
			],
		};
		const { ctx, captured } = makeCtx({
			items: [
				{ id: "a", title: "Row A" },
				{ id: "b", title: "Row B" },
			],
		});
		const comp = renderBlock(block, ctx);
		comp.render(80);
		comp.handleInput?.(" "); // select Row A
		comp.handleInput?.("."); // menu (one entry)
		comp.handleInput?.(ENTER); // choose "tag" → form opens (Task 5 seam)
		let lines = comp.render(80);
		expect(lines.some((l) => l.includes("Label:"))).toBe(true);
		// type into the seam form and submit
		comp.handleInput?.("hello");
		comp.handleInput?.(ENTER);
		expect(captured).toEqual([
			{
				action: { type: "submit", name: "tagItems" },
				payload: { ids: ["a"], values: { label: "hello" } },
			},
		]);
		lines = comp.render(80);
		expect(lines.some((l) => l.includes("Bulk actions"))).toBe(false);
	});

	test("selection marker is ASCII on an ASCII terminal", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./title" } },
			select: "multi",
		};
		const { ctx } = makeCtx({ items: [{ id: "a", title: "Row A" }] }, { unicode: false });
		const comp = renderBlock(block, ctx);
		comp.render(80);
		comp.handleInput?.(" ");
		const lines = comp.render(80);
		expect(lines.some((l) => l.includes("(*)") && l.includes("Row A"))).toBe(true);
	});

	test("lanes render in this client (Task 4 landed them; the §4.4 notice belongs to unknown types)", () => {
		const lanes: Block = {
			type: "collection",
			items: { $: "/items" },
			display: "lanes",
			item: { title: { $: "./title" } },
		};
		const { ctx } = makeCtx({ items: [{ id: "a", title: "Row A" }] });
		const lines = renderBlock(lanes, ctx).render(80);
		expect(lines.some((l) => l.includes("Not supported in this client"))).toBe(false);
		expect(lines.some((l) => l.includes("Row A"))).toBe(true);
	});
});

// ─── table display ──────────────────────────────────────────────────────────

const TABLE: CollectionBlock = {
	type: "collection",
	items: { $: "/rows" },
	display: "table",
	item: { title: { $: "./title" } },
	columns: [
		{ field: "title", label: "Title", sortable: true },
		{ field: "count", label: "Count", format: "number", sortable: true },
		{ field: "state", label: "State", cell: "badge" },
		{ field: "load", label: "Load", cell: "meter" },
		{ field: "note", label: "Note", priority: "low" },
	],
};

describe("table display", () => {
	test("header labels and cell values render aligned by display width", () => {
		const { ctx } = makeCtx({
			rows: [
				{ id: "a", title: "Alpha", count: 12, state: "ok", load: 0.5, note: "first" },
				{ id: "b", title: "Beta", count: 3, state: "warn", load: 0.25, note: "second" },
			],
		});
		const lines = renderBlock(TABLE, ctx).render(100);
		const header = lines.findIndex((l) => l.includes("Title") && l.includes("Count"));
		expect(header).toBeGreaterThanOrEqual(0);
		expect(lines.some((l) => l.includes("Alpha") && l.includes("12") && l.includes("first"))).toBe(
			true,
		);
	});

	test("CJK titles align by display width, not string length", () => {
		const { ctx } = makeCtx({
			rows: [
				{ id: "a", title: "表題", count: 12, state: "ok", load: 0, note: "wide" },
				{ id: "b", title: "AB", count: 3, state: "ok", load: 0, note: "narrow" },
			],
		});
		const lines = renderBlock(TABLE, ctx).render(100);
		const wide = lines.find((l) => l.includes("表題")) ?? "";
		const narrow = lines.find((l) => l.includes("AB")) ?? "";
		// A display-width-aware pad puts the Count column at the same
		// DISPLAY cell on both rows: "表題" is 4 cells wide, "AB" is 2,
		// so the CJK row's count byte index sits exactly 2 cells earlier
		// (wide chars cost 2 display cells but 1 string index each).
		// The COUNT column is 4 cells wide ("Count" header); the numeric
		// cells right-align, so "12" (2 digits) ends at the column edge and
		// "3" sits one pad later in byte index. Against that, the CJK
		// title's two wide chars pull the count 2 cells EARLIER — the
		// display-width pad, not the byte count, is what aligns.
		const countAt = (line: string, value: string): number => line.indexOf(value);
		expect(countAt(wide, "12")).toBe(countAt(narrow, "3") - 3);
	});

	test("s opens a column choice; picking a column sorts asc then desc", () => {
		const { ctx } = makeCtx({
			rows: [
				{ id: "a", title: "Charlie", count: 9, state: "ok", load: 0, note: "" },
				{ id: "b", title: "Alpha", count: 42, state: "ok", load: 0, note: "" },
				{ id: "c", title: "Bravo", count: 7, state: "ok", load: 0, note: "" },
			],
		});
		const comp = renderBlock(TABLE, ctx);
		comp.render(100);
		comp.handleInput?.("s");
		let lines = comp.render(100);
		// the sort menu lists the sortable columns only
		expect(lines.some((l) => l.includes("Sort by"))).toBe(true);
		expect(lines.some((l) => l.includes("Title"))).toBe(true);
		expect(lines.some((l) => l.includes("Count"))).toBe(true);
		comp.handleInput?.(ENTER); // choose "Title" → asc
		lines = comp.render(100);
		const order = (out: string[]): string[] =>
			["Alpha", "Bravo", "Charlie"].map((t) => out.find((l) => l.includes(t)) ?? "");
		let titles = order(lines);
		expect(titles[0]).toContain("Alpha");
		expect(lines.indexOf(titles[0])).toBeLessThan(lines.indexOf(titles[1]));
		expect(lines.indexOf(titles[1])).toBeLessThan(lines.indexOf(titles[2]));
		// sorting the same column again flips to desc
		comp.handleInput?.("s");
		comp.handleInput?.(ENTER);
		lines = comp.render(100);
		titles = order(lines);
		expect(lines.indexOf(titles[2])).toBeLessThan(lines.indexOf(titles[1]));
		expect(lines.indexOf(titles[1])).toBeLessThan(lines.indexOf(titles[0]));
		// never dispatched: sort is view-only (§6.2)
	});

	test("sort never dispatches (view-only)", () => {
		const { ctx, captured } = makeCtx({
			rows: [
				{ id: "a", title: "B", count: 1, state: "ok", load: 0, note: "" },
				{ id: "b", title: "A", count: 2, state: "ok", load: 0, note: "" },
			],
		});
		const comp = renderBlock(TABLE, ctx);
		comp.render(100);
		comp.handleInput?.("s");
		comp.handleInput?.(ENTER);
		expect(captured).toEqual([]);
	});

	test("pages at 50 rows with PgUp/PgDn", () => {
		const rows = Array.from({ length: 120 }, (_, i) => ({
			id: `r${i}`,
			title: `row-${String(i).padStart(3, "0")}`,
			count: i,
			state: "ok",
			load: 0,
			note: "",
		}));
		const { ctx } = makeCtx({ rows });
		const comp = renderBlock(TABLE, ctx);
		let lines = comp.render(100);
		expect(lines.some((l) => l.includes("row-000"))).toBe(true);
		expect(lines.some((l) => l.includes("row-049"))).toBe(true);
		expect(lines.some((l) => l.includes("row-050"))).toBe(false);
		expect(lines.some((l) => l.includes("1–50 of 120"))).toBe(true);
		comp.handleInput?.(PGDN);
		lines = comp.render(100);
		expect(lines.some((l) => l.includes("row-050"))).toBe(true);
		expect(lines.some((l) => l.includes("row-099"))).toBe(true);
		expect(lines.some((l) => l.includes("51–100 of 120"))).toBe(true);
		comp.handleInput?.(PGDN);
		lines = comp.render(100);
		expect(lines.some((l) => l.includes("row-119"))).toBe(true);
		expect(lines.some((l) => l.includes("101–120 of 120"))).toBe(true);
		comp.handleInput?.(PGUP);
		lines = comp.render(100);
		expect(lines.some((l) => l.includes("row-099"))).toBe(true);
	});

	test("a declared initial sort orders before render", () => {
		const block: CollectionBlock = {
			...TABLE,
			sort: { field: "count", dir: "desc" },
		};
		const { ctx } = makeCtx({
			rows: [
				{ id: "a", title: "low", count: 1, state: "ok", load: 0, note: "" },
				{ id: "b", title: "high", count: 99, state: "ok", load: 0, note: "" },
			],
		});
		const lines = renderBlock(block, ctx).render(100);
		const highAt = lines.findIndex((l) => l.includes("high"));
		const lowAt = lines.findIndex((l) => l.includes("low"));
		expect(highAt).toBeGreaterThanOrEqual(0);
		expect(highAt).toBeLessThan(lowAt);
	});

	test("compact width renders rows as cards; low-priority columns hide behind Enter", () => {
		const { ctx } = makeCtx({
			rows: [
				{
					id: "a",
					title: "Card row",
					count: 12,
					state: "ok",
					load: 0.5,
					note: "hidden note",
				},
			],
		});
		const comp = renderBlock(TABLE, ctx);
		let lines = comp.render(60); // compact
		expect(lines.some((l) => l.includes("Card row"))).toBe(true);
		// the high-priority columns ride the card; the low one is folded
		expect(lines.some((l) => l.includes("12"))).toBe(true);
		expect(lines.some((l) => l.includes("hidden note"))).toBe(false);
		comp.handleInput?.(ENTER); // expand the row
		lines = comp.render(60);
		expect(lines.some((l) => l.includes("Note:") && l.includes("hidden note"))).toBe(true);
	});
});

// ─── grid display ───────────────────────────────────────────────────────────

describe("grid display", () => {
	test("columns = floor(width / token) — s without an image", () => {
		const grid: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "grid",
			item: { title: { $: "./title" } },
		};
		const items = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, title: `G${i}` }));
		const { ctx } = makeCtx({ items });
		// 100 cells / 30 = 3 columns: row 0 = G0 G1 G2, row 1 = G3 G4.
		const lines = renderBlock(grid, ctx).render(100).filter((l) => l.trim() !== "");
		const row0 = lines.find((l) => l.includes("G0")) ?? "";
		expect(row0).toContain("G1");
		expect(row0).toContain("G2");
		expect(row0).not.toContain("G3");
		const row1 = lines.find((l) => l.includes("G3")) ?? "";
		expect(row1).toContain("G4");
	});

	test("the m token (45 cells) applies when the card has an image", () => {
		const grid: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "grid",
			item: { title: { $: "./title" }, image: { $: "./img" } },
		};
		const items = Array.from({ length: 3 }, (_, i) => ({
			id: `g${i}`,
			title: `G${i}`,
			img: "https://images.example.invalid/x.png",
		}));
		const { ctx } = makeCtx({ items });
		// 100 / 45 = 2 columns: row 0 = G0 G1, row 1 = G2.
		const lines = renderBlock(grid, ctx).render(100).filter((l) => l.trim() !== "");
		const row0 = lines.find((l) => l.includes("G0")) ?? "";
		expect(row0).toContain("G1");
		expect(row0).not.toContain("G2");
	});

	test("overflow: scroll stays one row", () => {
		const grid: CollectionBlock = {
			type: "collection",
			items: { $: "/items" },
			display: "grid",
			overflow: "scroll",
			item: { title: { $: "./title" } },
		};
		const items = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, title: `G${i}` }));
		const { ctx } = makeCtx({ items });
		const lines = renderBlock(grid, ctx).render(100).filter((l) => l.trim() !== "");
		// one row holds as many cells as fit; the rest stay in the row
		// (truncated at the pane edge) — never a second row.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("G0");
		expect(lines[0]).toContain("G1");
	});
});
