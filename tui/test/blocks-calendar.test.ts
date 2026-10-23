/**
 * The `calendar` display (UI-blocks U2 Task 4, spec §5.5 + §12.3 +
 * §12.4): a month grid at regular/wide (day-rows, the same v1 shape as
 * U1's grid); the agenda at compact and for `range: "agenda"`. `m` on
 * an event picks it up, arrows move it by DAY, Enter drops with
 * `{itemId, to: {start, end}}` keeping the duration; `[`/`]`/`t`
 * change the range (view-only, never dispatched).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CollectionBlock, JsonObject, JsonValue } from "@sigrun/shared/blocks";
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
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

const CALENDAR: CollectionBlock = {
	type: "collection",
	items: { $: "/events" },
	display: "calendar",
	item: { title: { $: "./title" } },
	time: { start: "start", end: "end", range: "month" },
	onMove: "move-event",
};

const EVENTS: JsonValue = [
	{ id: "e-1", title: "Planning", start: "2026-10-05T09:00:00Z", end: "2026-10-05T10:30:00Z" },
	{ id: "e-2", title: "Review", start: "2026-10-12T14:00:00Z", end: "2026-10-12T15:00:00Z" },
];

function data(items: JsonValue): Record<string, JsonValue> {
	return { events: items };
}

beforeEach(() => {
	// Pin "today" into October 2026 so the default range is the fixture month.
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("calendar — layout (§5.5, §12.3)", () => {
	test("regular/wide renders the month grid with events under their day", () => {
		const { ctx } = makeCtx(data(EVENTS));
		const text = renderBlock(CALENDAR, ctx).render(160).join("\n");
		expect(text).toContain("2026-10");
		expect(text).toContain("Planning");
		expect(text).toContain("Review");
		// Day rows: the 5th and the 12th appear as day numbers.
		expect(text).toContain("05");
		expect(text).toContain("12");
	});

	test("compact renders the agenda (a start-sorted row per event)", () => {
		const { ctx } = makeCtx(data(EVENTS));
		const text = renderBlock(CALENDAR, ctx).render(72).join("\n");
		expect(text).toContain("2026-10-05");
		expect(text).toContain("Planning");
		expect(text).toContain("Review");
		// Start order: Planning before Review.
		expect(text.indexOf("Planning")).toBeLessThan(text.indexOf("Review"));
	});

	test("range agenda renders the agenda at ANY width", () => {
		const block: CollectionBlock = {
			...CALENDAR,
			time: { start: "start", end: "end", range: "agenda" },
		};
		const { ctx } = makeCtx(data(EVENTS));
		const text = renderBlock(block, ctx).render(160).join("\n");
		expect(text).toContain("2026-10-05");
		expect(text).toContain("Planning");
	});
});

describe("calendar — range keys (§12.4, view-only)", () => {
	test("[ / ] shift the visible month, t returns to today", () => {
		const { ctx, captured } = makeCtx(data(EVENTS));
		const comp = renderBlock(CALENDAR, ctx);
		expect(comp.render(160).join("\n")).toContain("2026-10");
		comp.handleInput?.("]");
		expect(comp.render(160).join("\n")).toContain("2026-11");
		comp.handleInput?.("[");
		comp.handleInput?.("[");
		expect(comp.render(160).join("\n")).toContain("2026-09");
		comp.handleInput?.("t");
		expect(comp.render(160).join("\n")).toContain("2026-10");
		expect(captured).toHaveLength(0);
	});
});

describe("calendar — keyboard moves (§12.4)", () => {
	test("m → → → Enter dispatches {start, end} shifted by one day, duration kept", () => {
		const { ctx, captured } = makeCtx(data(EVENTS));
		const comp = renderBlock(CALENDAR, ctx);
		comp.render(160);
		// Cursor on the first event (e-1, Oct 5, 90 minutes).
		comp.handleInput?.("m");
		expect(comp.render(160).join("\n")).toContain("✋");
		comp.handleInput?.(RIGHT); // +1 day
		comp.handleInput?.(ENTER);
		expect(captured).toEqual([
			{
				action: { type: "move", name: "move-event" },
				payload: {
					itemId: "e-1",
					to: { start: "2026-10-06T09:00:00Z", end: "2026-10-06T10:30:00Z" },
				},
			},
		]);
	});

	test("the down arrow also moves by day; left moves back", () => {
		const { ctx, captured } = makeCtx(data(EVENTS));
		const comp = renderBlock(CALENDAR, ctx);
		comp.render(160);
		comp.handleInput?.("m");
		comp.handleInput?.(DOWN); // +1 day
		comp.handleInput?.(LEFT); // back to the start day → the drop is a no-op
		comp.handleInput?.(ENTER);
		expect(captured).toHaveLength(0);
	});

	test("Esc cancels without dispatching", () => {
		const { ctx, captured } = makeCtx(data(EVENTS));
		const comp = renderBlock(CALENDAR, ctx);
		comp.render(160);
		comp.handleInput?.("m");
		comp.handleInput?.(RIGHT);
		comp.handleInput?.(ESC);
		expect(captured).toHaveLength(0);
		expect(comp.render(160).join("\n")).not.toContain("✋");
	});
});
