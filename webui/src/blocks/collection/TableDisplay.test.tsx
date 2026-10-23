/**
 * The table display (UI-blocks U1 Task 3, spec §5.5/§12.3): sortable
 * columns (numeric formats sort numerically), paged at 50 rows,
 * `cell: "meter"` bars and `cell: "badge"` badges with the item tone,
 * and the compact fallback — rows as cards with `priority: "low"`
 * columns behind an expandable part. Sort is view-only and survives a
 * data update.
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

function makeActions(): {
	dispatch: ReturnType<typeof vi.fn>;
	provider(children: ReactNode): ReactElement;
} {
	const dispatch = vi.fn();
	return {
		dispatch,
		provider: (children): ReactElement =>
			h(SurfaceActionsContext.Provider, {
				value: { dispatch, access: "write", viewState: {} as JsonObject },
			}, children),
	};
}

/** Render a collection inside a measuring ContainerWidth. */
function renderTable(
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
		widthPx === undefined
			? inner
			: h(ContainerWidth, null, inner),
	);
	if (widthPx !== undefined && fire !== undefined) {
		act(() => fire?.(widthPx));
	}
	return { renderer, dispatch };
}

const title = { $: "./title" } as const;

function tableBlock(extra?: Partial<CollectionBlock>): CollectionBlock {
	return {
		type: "collection",
		items: { $: "/rows" },
		item: { title },
		display: "table",
		columns: [
			{ field: "name", label: "Name", sortable: true },
			{ field: "points", label: "Points", format: "number", sortable: true },
			{ field: "note", label: "Note", priority: "low" },
		],
		...extra,
	};
}

/** All text of a found instance. */
function textOf(node: { readonly children: readonly unknown[] }): string {
	let text = "";
	for (const child of node.children) {
		text += typeof child === "string" ? child : textOf(child as typeof node);
	}
	return text;
}

/** A click event whose propagation a listener can observe. */
function clickEvent(): { stopPropagation: () => void } {
	return { stopPropagation: vi.fn() };
}
void textOf;
void clickEvent;

describe("table display (spec §5.5)", () => {
	test("renders rows from data; a sortable column click sorts numerically", () => {
		const block = tableBlock();
		const { renderer } = renderTable(block, {
			rows: [
				{ id: "a", name: "Alpha", points: 30, note: "x" },
				{ id: "b", name: "Beta", points: 100, note: "y" },
				{ id: "c", name: "Gamma", points: 5, note: "z" },
			],
		});
		const sort = renderer.root.find(
			(node) =>
				node.props.className === "blk-table-sort" && node.props["data-field"] === "points",
		);
		act(() => {
			sort.props.onClick();
		});
		// Numeric sort: 5, 30, 30 … (ascending) — Gamma, Alpha/Beta.
		let text = textContent(renderer.toJSON());
		expect(text.indexOf("Gamma")).toBeLessThan(text.indexOf("Beta"));
		// Second click: descending.
		act(() => {
			renderer.root
				.find(
					(node) =>
						node.props.className === "blk-table-sort" &&
						node.props["data-field"] === "points",
				)
				.props.onClick();
		});
		text = textContent(renderer.toJSON());
		expect(text.indexOf("Beta")).toBeLessThan(text.indexOf("Gamma"));
	});

	test("pages at 50 rows", () => {
		const rows = Array.from({ length: 120 }, (_, index) => ({
			id: `r${index}`,
			name: `Row ${index}`,
			points: index,
			note: "n",
		}));
		const { renderer } = renderTable(tableBlock(), { rows });
		// Page 1 shows the first 50; the pager reports 3 pages.
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Row 0");
		expect(text).not.toContain("Row 50");
		expect(text).toContain("Page 1 of 3");
		const next = renderer.root.find(
			(node) => node.type === "button" && textOf(node) === "Next",
		);
		act(() => {
			next.props.onClick();
		});
		const page2 = textContent(renderer.toJSON());
		expect(page2).toContain("Row 50");
		expect(page2).not.toContain("Row 0");
	});

	test("cell meter draws a bar; badge carries the item tone", () => {
		const block = tableBlock({
			columns: [
				{ field: "name", label: "Name" },
				{ field: "load", label: "Load", cell: "meter" },
				{ field: "state", label: "State", cell: "badge" },
			],
			item: { title, tone: { $: "./tone" } },
		});
		const { renderer } = renderTable(block, {
			rows: [{ id: "a", name: "Alpha", load: 0.4, state: "warn", tone: "warn" }],
		});
		const json = JSON.stringify(renderer.toJSON());
		expect(json).toContain('"data-cell":"meter"');
		expect(json).toContain('"data-cell":"badge"');
		expect(json).toContain('"data-tone":"warn"');
		expect(json).toContain('"inlineSize":"40%"');
	});

	test("compact width renders rows as cards with low-priority columns behind an expandable part", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const block = tableBlock();
		const { dispatch, provider } = makeActions();
		const inner = h(SurfaceDataContext.Provider, {
			value: {
				data: { rows: [{ id: "a", name: "Alpha", points: 3, note: "low-note" }] },
				locale: "en-US",
			},
		}, provider(h(CollectionBlockView, { block })));
		const renderer = render(h(ContainerWidth, null, inner));
		act(() => fire?.(20 * 16)); // compact (< 40rem)
		const json = JSON.stringify(renderer.toJSON());
		expect(json).toContain('"data-block":"table-compact"');
		let text = textContent(renderer.toJSON());
		expect(text).toContain("Alpha"); // the card
		expect(text).toContain("Points"); // high-priority column shows
		expect(text).not.toContain("low-note"); // low-priority hidden
		const more = renderer.root.find(
			(node) => node.type === "button" && node.props.className === "blk-table-expand",
		);
		act(() => {
			more.props.onClick(clickEvent());
		});
		text = textContent(renderer.toJSON());
		expect(text).toContain("low-note");
		void dispatch;
	});

	test("clicking the select checkbox does NOT fire onActivate", () => {
		const block = tableBlock({
			select: "multi",
			onActivate: { type: "navigate", params: { view: "item" } },
		});
		const { renderer, dispatch } = renderTable(block, {
			rows: [{ id: "a", name: "Alpha", points: 3, note: "x" }],
		});
		const box = renderer.root.find(
			(node) => node.type === "input" && node.props.className === "blk-select",
		);
		act(() => {
			box.props.onClick(clickEvent());
			box.props.onChange();
		});
		// Selection toggled; NO onActivate dispatched.
		expect(
			dispatch.mock.calls.some(
				(call) => (call[0] as { type: string }).type === "navigate",
			),
		).toBe(false);
	});

	test("clicking elsewhere in the row still activates", () => {
		const block = tableBlock({
			select: "multi",
			onActivate: { type: "navigate", params: { view: "item" } },
		});
		const { renderer, dispatch } = renderTable(block, {
			rows: [{ id: "a", name: "Alpha", points: 3, note: "x" }],
		});
		const row = renderer.root.find(
			(node) => node.type === "tr" && node.props["data-item-id"] === "a",
		);
		act(() => {
			row.props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "navigate", params: { view: "item" } },
			{ itemId: "a" },
		);
	});

	test("view-only sort survives a data update", () => {
		const block = tableBlock();
		const { dispatch, provider } = makeActions();
		const element = (data: JsonObject): ReactElement =>
			h(SurfaceDataContext.Provider, {
				value: { data, locale: "en-US" },
			}, provider(h(CollectionBlockView, { block })));
		const renderer = render(element({ rows: [
			{ id: "a", name: "Alpha", points: 30, note: "x" },
			{ id: "b", name: "Beta", points: 100, note: "y" },
		] }));
		const sort = renderer.root.find(
			(node) =>
				node.props.className === "blk-table-sort" && node.props["data-field"] === "points",
		);
		act(() => {
			sort.props.onClick(); // ascending by points
		});
		act(() => {
			renderer.update(element({ rows: [
				{ id: "a", name: "Alpha", points: 30, note: "x" },
				{ id: "b", name: "Beta", points: 100, note: "y" },
				{ id: "c", name: "Gamma", points: 5, note: "z" },
			] }));
		});
		const text = textContent(renderer.toJSON());
		// The sort (ascending) still holds: Gamma (5) before Beta (100).
		expect(text.indexOf("Gamma")).toBeLessThan(text.indexOf("Beta"));
		void dispatch;
	});
});
