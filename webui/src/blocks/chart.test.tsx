/**
 * The chart block (UI-blocks U1 Task 2, spec §5.4/§12.3): hand-written
 * SVG — line/area/bar series, `lttb` display downsampling to ≤2,000
 * points, stacking for area+bar, tone-classed threshold rules, tick
 * counts from the container width, the compact legend-below fallback,
 * and the below-16-rem sparkline-plus-latest fallback. The `bound`
 * regression pair (binding to a missing path renders empty; literal
 * data renders normally) pins the literal-branch fix in context.ts.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Block, ChartBlock, JsonObject } from "@sigrun/shared/blocks";
import { render, textContent } from "../test-utils";
import { SAMPLES } from "../../../test/fixtures/blocks/samples.js";
import { BlockView } from "./BlockView";
import { SurfaceActionsContext, SurfaceDataContext } from "./context";
import { ContainerWidth } from "./width";

/** The fake's latest observer callback (fired by the test). */
let fireWidth: ((widthPx: number) => void) | undefined;

/** A hand-fired ResizeObserver stand-in (see width.test.tsx). */
class FakeResizeObserver {
	constructor(
		callback: (entries: readonly { readonly contentRect: { readonly width: number } }[]) => void,
	) {
		fireWidth = (widthPx: number): void => {
			callback([{ contentRect: { width: widthPx } }]);
		};
	}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/** The dispatch spy + access the tests drive SurfaceActions with. */
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

/** Render `block` with surface data and a dispatch spy (write access). */
function renderBlock(
	block: Block,
	init?: { readonly data?: JsonObject },
): ReturnType<typeof render> {
	const { provider } = makeActions();
	return render(
		h(SurfaceDataContext.Provider, {
			value: { data: init?.data ?? {}, locale: "en-US" },
		}, provider(h(BlockView, { block }))),
	);
}

/** Render `block` inside a `ContainerWidth` measured at `rem` rem. */
function renderBlockInWidth(block: Block, rem: number): ReturnType<typeof render> {
	const { provider } = makeActions();
	const renderer = render(
		h(SurfaceDataContext.Provider, {
			value: { data: {}, locale: "en-US" },
		}, provider(h(ContainerWidth, null, h(BlockView, { block })))),
	);
	act(() => {
		fireWidth?.(rem * 16);
	});
	return renderer;
}

afterEach(() => {
	fireWidth = undefined;
	vi.unstubAllGlobals();
});

/** The gallery chart fixture's tree root (the real corpus, no copies). */
function chartFixture(): ChartBlock {
	const sample = SAMPLES.find(({ name }) => name === "chart");
	if (sample === undefined) throw new Error("chart fixture missing from corpus");
	return sample.tree.root as ChartBlock;
}

/** N points of a deterministic sine wave `[x, y]` pairs. */
function wave(count: number): [number, number][] {
	return Array.from({ length: count }, (_, i): [number, number] => [
		i,
		Math.round(Math.sin(i / 80) * 1000) / 10,
	]);
}

describe("chart: gallery fixture", () => {
	test("renders the chart fixture with title, threshold and y caption", () => {
		const renderer = renderBlock(chartFixture(), {
			data: { series: { acme: [[0, 5], [60, 7], [120, 6]] } },
		});
		expect(
			renderer.root.findByProps({ "data-block": "chart" }).props["data-chart-mode"],
		).toBe("full");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Throughput");
		expect(text).toContain("req/s"); // y caption carries the unit
		expect(
			renderer.root.findByProps({ "data-threshold-at": 20 }).props["data-tone"],
		).toBe("warn");
		renderer.unmount();
	});
});

describe("chart: downsampling (spec §5.4)", () => {
	test("a 10,000-point line series renders at most 2,000 points", () => {
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "number" },
			series: [{ name: "sine", kind: "line", data: wave(10_000) }],
		});
		const path = renderer.root.findByProps({ "data-kind": "line", "data-series": 0 });
		const coordinates = (String(path.props.d).match(/[ML]/g) ?? []).length;
		expect(coordinates).toBe(2000);
		renderer.unmount();
	});
});

describe("chart: series kinds (spec §5.4)", () => {
	test("a mixed line+bar chart renders one path and N rects", () => {
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "number" },
			series: [
				{ name: "trend", kind: "line", data: [[0, 4], [1, 5], [2, 3]] },
				{ name: "load", kind: "bar", data: [[0, 2], [1, 3], [2, 1], [3, 2]] },
			],
		});
		const lines = renderer.root
			.findAllByType("path")
			.filter((p) => p.props["data-kind"] === "line");
		expect(lines).toHaveLength(1);
		const bars = renderer.root.findAllByType("rect");
		expect(bars).toHaveLength(4);
		// Unstacked bars all stand on the shared zero baseline.
		const bottoms = bars.map((r) => r.props.y + r.props.height);
		for (const bottom of bottoms) {
			expect(bottom).toBeCloseTo(bottoms[0] as number, 1);
		}
		renderer.unmount();
	});
});

describe("chart: stacking (spec §5.4)", () => {
	test("stacked: true stacks bar heights on top of each other", () => {
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "number" },
			stacked: true,
			series: [
				{ name: "a", kind: "bar", data: [[0, 1], [1, 2]] },
				{ name: "b", kind: "bar", data: [[0, 3], [1, 4]] },
			],
		});
		const series0 = renderer.root
			.findAllByType("rect")
			.filter((r) => r.props["data-series"] === 0);
		const series1 = renderer.root
			.findAllByType("rect")
			.filter((r) => r.props["data-series"] === 1);
		expect(series0).toHaveLength(2);
		expect(series1).toHaveLength(2);
		// At each x, series 1 sits directly on top of series 0.
		for (let i = 0; i < 2; i += 1) {
			expect(series1[i]!.props.y + series1[i]!.props.height).toBeCloseTo(
				series0[i]!.props.y,
				1,
			);
		}
		// The stacked totals (1+3, 2+4) set the y domain: a "6" tick shows.
		expect(textContent(renderer.toJSON())).toContain("6");
		renderer.unmount();
	});
});

describe("chart: thresholds (spec §5.4)", () => {
	test("thresholds render as horizontal rules carrying their tone class", () => {
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "number" },
			series: [{ name: "s", kind: "line", data: [[0, 10], [1, 30]] }],
			thresholds: [
				{ at: 25, tone: "bad", label: "max" },
				{ at: 12, tone: "warn" },
			],
		});
		const bad = renderer.root.findByProps({ "data-threshold-at": 25 });
		expect(bad.props["data-tone"]).toBe("bad");
		const rule = bad.findByType("line");
		expect(String(rule.props.className)).toContain("blk-chart-threshold");
		expect(renderer.root.findByProps({ "data-threshold-at": 12 })).toBeTruthy();
		expect(textContent(renderer.toJSON())).toContain("max");
		renderer.unmount();
	});
});

describe("chart: width fallbacks (spec §12.3)", () => {
	test("full mode draws floor(width/80px) x-ticks and 5 y-ticks", () => {
		// No ContainerWidth: unmeasured, the 40 rem regular default → 640 px.
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "number" },
			series: [{ name: "s", kind: "line", data: [[0, 0], [100, 10]] }],
		});
		// floor(640/80)=8 requested; nice rounding yields 0..100 by 20.
		expect(renderer.root.findAllByProps({ "data-tick": "x" })).toHaveLength(6);
		// 5 requested over 0..10; nice rounding yields 0, 5, 10.
		expect(renderer.root.findAllByProps({ "data-tick": "y" })).toHaveLength(3);
		renderer.unmount();
	});

	test("compact width uses fewer ticks and the legend below", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = renderBlockInWidth({
			type: "chart",
			x: { kind: "number" },
			series: [
				{ name: "s", kind: "line", data: [[0, 0], [100, 10]] },
				{ name: "t", kind: "line", data: [[0, 5], [100, 5]] },
			],
		}, 30);
		const chart = renderer.root.findByProps({ "data-block": "chart" });
		expect(chart.props["data-chart-mode"]).toBe("compact");
		// floor(480/80)=6 requested over 0..100; nice → 0..100 by 20.
		expect(renderer.root.findAllByProps({ "data-tick": "x" })).toHaveLength(6);
		const legend = renderer.root.findByProps({ "data-legend": "below" });
		expect(textContent(renderer.toJSON())).toContain("s");
		expect(textContent(renderer.toJSON())).toContain("t");
		renderer.unmount();
	});

	test("below 16 rem the sparkline fallback draws one path and latest value per series", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = renderBlockInWidth({
			type: "chart",
			x: { kind: "number" },
			series: [
				{ name: "alpha", kind: "line", data: [[0, 1], [1, 2], [2, 42]] },
				{ name: "beta", kind: "line", data: [[0, 9], [1, 8], [2, 7.5]] },
			],
		}, 15);
		expect(
			renderer.root.findByProps({ "data-block": "chart" }).props["data-chart-mode"],
		).toBe("spark");
		expect(renderer.root.findAllByType("path")).toHaveLength(2);
		expect(renderer.root.findAllByType("rect")).toHaveLength(0);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
		expect(text).toContain("42"); // alpha's latest value
		expect(text).toContain("7.5"); // beta's latest value
		renderer.unmount();
	});
});

describe("chart: axis formats", () => {
	test("a time x-axis formats its ticks as datetimes, not raw numbers", () => {
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "time" },
			series: [{ name: "s", kind: "line", data: [[0, 1], [86_400_000, 2]] }],
		});
		const labels = renderer.root
			.findAllByProps({ "data-tick": "x" })
			.map((t) => textContentOf(t));
		expect(labels.length).toBeGreaterThan(0);
		for (const label of labels) {
			expect(label).toMatch(/[^0-9.,]/); // 1/1/1970-style, not "0"
		}
		renderer.unmount();
	});
});

describe("chart: bound series data (the literal-branch regression)", () => {
	test("a binding to a missing path renders empty, never an error", () => {
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "number" },
			series: [{ name: "gone", kind: "line", data: { $: "/missing/series" } }],
		});
		expect(renderer.toJSON()).not.toBeNull();
		expect(renderer.root.findAllByType("path")).toHaveLength(0);
		renderer.unmount();
	});

	test("literal series data renders normally", () => {
		const renderer = renderBlock({
			type: "chart",
			x: { kind: "number" },
			series: [{ name: "here", kind: "line", data: [[0, 1], [1, 2], [2, 1]] }],
		});
		expect(renderer.root.findAllByType("path")).toHaveLength(1);
		renderer.unmount();
	});
});

// ─── helpers ──────────────────────────────────────────────────────────────

/** The visible text under a rendered test instance (recursive). */
function textContentOf(node: { children?: readonly unknown[] }): string {
	return (node.children ?? [])
		.map((child) => {
			if (typeof child === "string") return child;
			if (child !== null && typeof child === "object" && "children" in child) {
				return textContentOf(child as { children?: readonly unknown[] });
			}
			return "";
		})
		.join("");
}
