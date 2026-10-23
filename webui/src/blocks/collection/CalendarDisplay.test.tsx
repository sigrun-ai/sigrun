/**
 * The calendar display (UI-blocks U1 Task 4, spec §5.5/§12.3/§12.4):
 * month view places items by `time.start`; drag to another day
 * dispatches a move with `to: {start, end}` preserving duration;
 * `onResize` drags the end; `onCreate` drags an empty slot; compact
 * shows the agenda; `[`/`]`/`t` change the visible range (view-only).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CollectionBlock, JsonObject } from "@sigrun/shared/blocks";
import { render, textContent } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { ContainerWidth } from "../width";
import { CollectionBlockView } from "./Collection";

// A fake ResizeObserver drives the width class (width.test.tsx's pattern).
let fire: ((widthPx: number) => void) | undefined;
class FakeResizeObserver {
	constructor(
		callback: (entries: readonly { readonly contentRect: { readonly width: number } }[]) => void,
	) {
		fire = (widthPx: number): void => {
			callback([{ contentRect: { width: widthPx } }]);
		};
	}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

afterEach(() => {
	fire = undefined;
	vi.unstubAllGlobals();
});

function makeActions(access: "read" | "write" = "write"): {
	dispatch: ReturnType<typeof vi.fn>;
	provider(children: ReactNode): ReactElement;
} {
	const dispatch = vi.fn();
	return {
		dispatch,
		provider: (children): ReactElement =>
			h(SurfaceActionsContext.Provider, {
				value: { dispatch, access, viewState: {} as JsonObject },
			}, children),
	};
}

function renderCalendar(
	block: CollectionBlock,
	data: JsonObject,
	widthPx?: number,
): { renderer: ReturnType<typeof render>; dispatch: ReturnType<typeof vi.fn> } {
	vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	const { dispatch, provider } = makeActions();
	const inner = h(SurfaceDataContext.Provider, {
		value: { data, locale: "en-US" },
	}, provider(h(CollectionBlockView, { block })));
	const renderer = render(
		widthPx === undefined ? inner : h(ContainerWidth, null, inner),
	);
	if (widthPx !== undefined && fire !== undefined) {
		act(() => fire?.(widthPx));
	}
	return { renderer, dispatch };
}

const title = { $: "./title" } as const;

function calendarBlock(extra?: Partial<CollectionBlock>): CollectionBlock {
	return {
		type: "collection",
		items: { $: "/events" },
		item: { title },
		display: "calendar",
		onMove: "onMove",
		time: {
			start: "start",
			end: "end",
			range: "month",
			onResize: "onResize",
			onCreate: "onCreate",
		},
		...extra,
	};
}

function events(...rows: readonly [string, string, string][]): JsonObject {
	return {
		events: rows.map(([id, start, end]) => ({ id, start, end, title: `Event ${id}` })),
	};
}

/** 2026-10 is the fixture month (Oct 1 is a Thursday). */
const OCT = "2026-10";

describe("calendar display (spec §5.5/§12.3/§12.4)", () => {
	test("month view places items by time.start on their day cell", () => {
		const { renderer } = renderCalendar(
			calendarBlock(),
			events(["a", `${OCT}-05T09:00:00Z`, `${OCT}-05T10:00:00Z`]),
			60 * 16,
		);
		const json = JSON.stringify(renderer.toJSON());
		expect(json).toContain('"data-display":"calendar"');
		expect(json).toContain('"data-layout":"month"');
		// The day cell for the 5th carries the item.
		const day = renderer.root.find(
			(node) => node.props["data-day"] === `${OCT}-05`,
		);
		expect(textContent([day] as never)).toContain("Event a");
	});

	test("dragging an item to another day dispatches move with to {start, end} preserving duration", () => {
		vi.stubGlobal("document", {
			elementFromPoint: () => ({
				closest: (selector: string) =>
					selector === "[data-drop-day]"
						? {
								getAttribute: (name: string) =>
									name === "data-drop-day" ? `${OCT}-10` : null,
							}
						: null,
			}),
		});
		const { renderer, dispatch } = renderCalendar(
			calendarBlock(),
			events(["a", `${OCT}-05T09:00:00Z`, `${OCT}-05T11:30:00Z`]),
			60 * 16,
		);
		const card = renderer.root.find(
			(node) =>
				node.props["data-drag-item"] === "a" &&
				typeof node.props.onPointerDown === "function",
		);
		act(() => {
			card.props.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0 });
			card.props.onPointerUp({ pointerId: 1, clientX: 10, clientY: 10 });
		});
		// 2h30m duration preserved; day shifts to the 10th.
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "move", name: "onMove" },
			{
				itemId: "a",
				to: { start: `${OCT}-10T09:00:00Z`, end: `${OCT}-10T11:30:00Z` },
			},
		);
	});

	test("onResize drag dispatches {itemId, end}", () => {
		vi.stubGlobal("document", {
			elementFromPoint: () => ({
				closest: (selector: string) =>
					selector === "[data-drop-day]"
						? {
								getAttribute: (name: string) =>
									name === "data-drop-day" ? `${OCT}-07` : null,
							}
						: null,
			}),
		});
		const { renderer, dispatch } = renderCalendar(
			calendarBlock(),
			events(["a", `${OCT}-05T09:00:00Z`, `${OCT}-05T10:00:00Z`]),
			60 * 16,
		);
		const handle = renderer.root.find(
			(node) =>
				node.props["data-resize-item"] === "a" &&
				typeof node.props.onPointerDown === "function",
		);
		act(() => {
			handle.props.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0 });
			handle.props.onPointerUp({ pointerId: 1, clientX: 10, clientY: 10 });
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "edit", name: "onResize" },
			{ itemId: "a", end: `${OCT}-07T10:00:00Z` },
		);
	});

	test("onCreate drag on an empty slot dispatches {start, end}", () => {
		vi.stubGlobal("document", {
			elementFromPoint: () => ({
				closest: (selector: string) =>
					selector === "[data-drop-day]"
						? {
								getAttribute: (name: string) =>
									name === "data-drop-day" ? `${OCT}-12` : null,
							}
						: null,
			}),
		});
		const { renderer, dispatch } = renderCalendar(
			calendarBlock(),
			events(),
			60 * 16,
		);
		const slot = renderer.root.find(
			(node) =>
				node.props["data-create-day"] === `${OCT}-12` &&
				typeof node.props.onPointerDown === "function",
		);
		act(() => {
			slot.props.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0 });
			slot.props.onPointerUp({ pointerId: 1, clientX: 10, clientY: 10 });
		});
		// The created slot spans the dropped day (all-day default).
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "onCreate", turn: false },
			{ start: `${OCT}-12T00:00:00Z`, end: `${OCT}-13T00:00:00Z` },
		);
	});

	test("compact width shows the agenda (items sorted by start)", () => {
		const { renderer } = renderCalendar(
			calendarBlock(),
			events(
				["b", `${OCT}-09T09:00:00Z`, `${OCT}-09T10:00:00Z`],
				["a", `${OCT}-05T09:00:00Z`, `${OCT}-05T10:00:00Z`],
			),
			20 * 16,
		);
		const json = JSON.stringify(renderer.toJSON());
		expect(json).toContain('"data-layout":"agenda"');
		const text = textContent(renderer.toJSON());
		expect(text.indexOf("Event a")).toBeLessThan(text.indexOf("Event b"));
	});

	test("[ / ] shift the visible range; t returns to today (view-only, no dispatch)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(`${OCT}-15T12:00:00Z`));
		const { renderer, dispatch } = renderCalendar(
			calendarBlock(),
			events(),
			60 * 16,
		);
		const surface = renderer.root.find(
			(node) => node.props["data-display"] === "calendar",
		);
		const heading = (): string =>
			renderer.root.find(
				(node) => typeof node.props["data-range-label"] === "string",
			).props["data-range-label"];
		expect(heading()).toBe(OCT);
		act(() => {
			surface.props.onKeyDown({ key: "]" });
		});
		expect(heading()).toBe("2026-11");
		act(() => {
			surface.props.onKeyDown({ key: "[" });
		});
		expect(heading()).toBe(OCT);
		act(() => {
			surface.props.onKeyDown({ key: "]" });
		});
		act(() => {
			surface.props.onKeyDown({ key: "t" });
		});
		expect(heading()).toBe(OCT);
		// Range changes are view-only.
		expect(dispatch).not.toHaveBeenCalled();
	});

	test("read access hides the create and resize affordances", () => {
		const readDispatch = vi.fn();
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = render(
			h(ContainerWidth, null, h(SurfaceDataContext.Provider, {
				value: {
					data: events(["a", `${OCT}-05T09:00:00Z`, `${OCT}-05T10:00:00Z`]),
					locale: "en-US",
				},
			}, h(SurfaceActionsContext.Provider, {
				value: { dispatch: readDispatch, access: "read", viewState: {} as JsonObject },
			}, h(CollectionBlockView, { block: calendarBlock() })))),
		);
		act(() => fire?.(60 * 16));
		const json = JSON.stringify(renderer.toJSON());
		expect(json).not.toContain("data-create-day");
		expect(json).not.toContain("data-resize-item");
	});

	test("a pointercancel clears the pending calendar drag with no dispatch", () => {
		vi.stubGlobal("document", {
			elementFromPoint: () => ({
				closest: () => ({
					getAttribute: () => `${OCT}-10`,
				}),
			}),
		});
		const { renderer, dispatch } = renderCalendar(
			calendarBlock(),
			events(["a", `${OCT}-05T09:00:00Z`, `${OCT}-05T10:00:00Z`]),
			60 * 16,
		);
		const card = renderer.root.find(
			(node) =>
				node.props["data-drag-item"] === "a" &&
				typeof node.props.onPointerDown === "function",
		);
		act(() => {
			card.props.onPointerDown({
				pointerId: 3,
				clientX: 0,
				clientY: 0,
				currentTarget: { setPointerCapture: () => undefined },
			});
		});
		// Cancel mid-drag: no dispatch even though a drop day resolves.
		act(() => {
			card.props.onPointerCancel({ pointerId: 3 });
		});
		expect(dispatch).not.toHaveBeenCalled();
		// A later pointerup finds no pending drag.
		act(() => {
			card.props.onPointerUp({ clientX: 5, clientY: 5 });
		});
		expect(dispatch).not.toHaveBeenCalled();
	});
});
