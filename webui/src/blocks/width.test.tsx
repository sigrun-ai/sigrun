/**
 * Width (UI-blocks U1 Task 1, spec §12): the `ContainerWidth` provider
 * measures its container with a `ResizeObserver` and publishes the width
 * class (`compact` < 40 rem, `regular` 40–75, `wide` > 75) plus the rem
 * width structural fallbacks key off. Tests drive a fake ResizeObserver
 * (react-test-renderer host refs are null, so the observer is constructed
 * without a target and fired by hand; 1 rem = 16 px in the node env).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, textContent } from "../test-utils";
import type { Block } from "@sigrun/shared/blocks";
import { BlockView } from "./BlockView";
import { ContainerWidth, useWidthClass } from "./width";

/** The fake's latest observer callback (fired by the test). */
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

/** Report the current width class from inside a container. */
function WidthProbe(): ReactElement {
	return h("span", { "data-width-class": useWidthClass() });
}

/** Render `children` inside a measuring ContainerWidth. */
function inContainer(children: ReactNode): ReturnType<typeof render> {
	return render(h(ContainerWidth, null, children));
}

afterEach(() => {
	fire = undefined;
	vi.unstubAllGlobals();
});

describe("ContainerWidth: width classes", () => {
	test("30 rem reports compact", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = inContainer(h(WidthProbe));
		act(() => fire?.(30 * 16));
		expect(
			renderer.root.findByProps({ "data-width-class": "compact" }),
		).toBeTruthy();
		renderer.unmount();
	});

	test("50 rem reports regular", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = inContainer(h(WidthProbe));
		act(() => fire?.(50 * 16));
		expect(
			renderer.root.findByProps({ "data-width-class": "regular" }),
		).toBeTruthy();
		renderer.unmount();
	});

	test("80 rem reports wide", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = inContainer(h(WidthProbe));
		act(() => fire?.(80 * 16));
		expect(
			renderer.root.findByProps({ "data-width-class": "wide" }),
		).toBeTruthy();
		renderer.unmount();
	});

	test("the 40 rem boundary is regular and the 75 rem boundary is regular", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = inContainer(h(WidthProbe));
		act(() => fire?.(40 * 16));
		expect(
			renderer.root.findByProps({ "data-width-class": "regular" }),
		).toBeTruthy();
		act(() => fire?.(75 * 16));
		expect(
			renderer.root.findByProps({ "data-width-class": "regular" }),
		).toBeTruthy();
		act(() => fire?.(75.01 * 16));
		expect(
			renderer.root.findByProps({ "data-width-class": "wide" }),
		).toBeTruthy();
		renderer.unmount();
	});

	test("without a ResizeObserver the class defaults to regular", () => {
		const renderer = inContainer(h(WidthProbe));
		expect(
			renderer.root.findByProps({ "data-width-class": "regular" }),
		).toBeTruthy();
		renderer.unmount();
	});
});

describe("visibleAt (spec §12.2)", () => {
	const block: Block = {
		type: "markdown",
		text: "only when regular",
		visibleAt: "atLeast:regular",
	};

	test("hidden at 30 rem (compact)", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = inContainer(h(BlockView, { block }));
		act(() => fire?.(30 * 16));
		expect(textContent(renderer.toJSON())).not.toContain("only when regular");
		renderer.unmount();
	});

	test("shown at 50 rem (regular)", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = inContainer(h(BlockView, { block }));
		act(() => fire?.(50 * 16));
		expect(textContent(renderer.toJSON())).toContain("only when regular");
		renderer.unmount();
	});
});
