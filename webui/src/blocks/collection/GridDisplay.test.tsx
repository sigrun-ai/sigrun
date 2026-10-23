/**
 * The grid display (UI-blocks U1 Task 3, spec §5.5/§12.3): cards in as
 * many columns as fit — `minItemWidth` from the item template's image
 * presence (`m` with images, `s` without); `overflow: "scroll"` stays
 * one horizontal row even in compact width, while `wrap` collapses to
 * one column (§12.3).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CollectionBlock, JsonObject } from "@sigrun/shared/blocks";
import { render } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { ContainerWidth, useWidthRem } from "../width";

/** A probe publishing the measured rem (diagnoses width flow). */
function WidthProbe(): ReactNode {
	return h("span", { "data-width-probe": String(useWidthRem()) });
}
import { CollectionBlockView } from "./Collection";

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

function renderGrid(
	block: CollectionBlock,
	data: JsonObject,
	widthPx?: number,
): { renderer: ReturnType<typeof render>; fire(widthPx: number): void } {
	vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	const { provider } = makeActions();
	const inner = h(SurfaceDataContext.Provider, {
		value: { data, locale: "en-US" },
	}, provider(h(CollectionBlockView, { block })));
	const renderer = render(
		widthPx === undefined ? inner : h(ContainerWidth, null, inner, h(WidthProbe)),
	);
	const fireWidth = (px: number): void => {
		expect(fire).toBeDefined();
		act(() => fire?.(px));
	};
	if (widthPx !== undefined) fireWidth(widthPx);
	return { renderer, fire: fireWidth };
}

const title = { $: "./title" } as const;
const items = {
	rows: [
		{ id: "a", title: "Alpha" },
		{ id: "b", title: "Beta" },
	],
};

describe("grid display (spec §5.5)", () => {
	test("minItemWidth: m with an image template, s without", () => {
		const withImage: CollectionBlock = {
			type: "collection",
			items: { $: "/rows" },
			item: { title, image: { $: "./image" } },
			display: "grid",
		};
		const { renderer: wide } = renderGrid(withImage, items, 80 * 16);
		expect(JSON.stringify(wide.toJSON())).toContain("minmax(24rem, 1fr)");

		const without: CollectionBlock = {
			type: "collection",
			items: { $: "/rows" },
			item: { title },
			display: "grid",
		};
		const { renderer: s } = renderGrid(without, items, 80 * 16);
		expect(JSON.stringify(s.toJSON())).toContain("minmax(16rem, 1fr)");
	});

	test("overflow scroll stays one row even in compact", () => {
		const scrollBlock: CollectionBlock = {
			type: "collection",
			items: { $: "/rows" },
			item: { title },
			display: "grid",
			overflow: "scroll",
		};
		const { renderer: scroll } = renderGrid(scrollBlock, items, 20 * 16); // compact
		const scrollJson = JSON.stringify(scroll.toJSON());
		expect(scrollJson).toContain('"data-overflow":"scroll"');
		expect(scrollJson).toContain('"gridTemplateColumns":"1fr"'); // one track
		expect(scrollJson).toContain('"overflowX":"auto"'); // a scroll row
	});

	test("wrap collapses to one column in compact (§12.3)", () => {
		const wrapBlock: CollectionBlock = {
			type: "collection",
			items: { $: "/rows" },
			item: { title },
			display: "grid",
		};
		const { renderer: wrap } = renderGrid(wrapBlock, items, 10 * 16);
		const wrapJson = JSON.stringify(wrap.toJSON());
		expect(wrapJson).toContain('"data-width-probe":"10"');
		expect(wrapJson).toContain('"data-overflow":"wrap"');
		expect(wrapJson).toContain('"gridTemplateColumns":"1fr"'); // one column
		expect(wrapJson).not.toContain('"overflowX":"auto"');
	});

	test("activating a card dispatches onActivate with the item id", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/rows" },
			item: { title },
			display: "grid",
			onActivate: { type: "navigate", params: { view: "item" } },
		};
		const dispatch = vi.fn();
		const renderer = render(
			h(SurfaceDataContext.Provider, {
				value: { data: items, locale: "en-US" },
			}, h(SurfaceActionsContext.Provider, {
				value: { dispatch, access: "write", viewState: {} as JsonObject },
			}, h(CollectionBlockView, { block }))),
		);
		const card = renderer.root.find(
			(node) => node.props["data-item-id"] === "b",
		);
		act(() => {
			card.props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "navigate", params: { view: "item" } },
			{ itemId: "b" },
		);
	});
});
