/**
 * The meter block (UI-blocks U1 Task 2, spec §5.3): a labelled progress
 * bar over [min, max] whose tone is the highest threshold at or below
 * the value (accent below every threshold), plus the `bound` render
 * contract for its non-string Bindable value — a binding to a missing
 * path renders empty, never an error.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h, type ReactElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import type { Block, JsonObject } from "@sigrun/shared/blocks";
import { render, textContent } from "../test-utils";
import { BlockView } from "./BlockView";
import { MeterBlockView } from "./meter";
import { SurfaceActionsContext, SurfaceDataContext } from "./context";

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

/** Render `block` with surface data (write access). */
function renderBlock(block: Block, data?: JsonObject): ReturnType<typeof render> {
	const { provider } = makeActions();
	return render(
		h(SurfaceDataContext.Provider, {
			value: { data: data ?? {}, locale: "en-US" },
		}, provider(h(BlockView, { block }))),
	);
}

describe("meter: thresholds", () => {
	test("picks the tone of the highest threshold at or below the value", () => {
		const block = {
			type: "meter",
			value: { $: "/disk" },
			min: 0,
			max: 1,
			label: "Disk",
			thresholds: [
				{ at: 0.8, tone: "warn" },
				{ at: 0.95, tone: "bad" },
			],
		} as const;
		// 0.7: below every threshold → the base (accent) tone.
		expect(
			renderBlock(block, { disk: 0.7 }).root
				.findByProps({ "data-block": "meter" }).props["data-tone"],
		).toBe("accent");
		// 0.8: exactly the warn threshold → warn.
		expect(
			renderBlock(block, { disk: 0.8 }).root
				.findByProps({ "data-block": "meter" }).props["data-tone"],
		).toBe("warn");
		// 0.9: still warn (bad is at 0.95).
		expect(
			renderBlock(block, { disk: 0.9 }).root
				.findByProps({ "data-block": "meter" }).props["data-tone"],
		).toBe("warn");
		// 0.99: the bad threshold is the highest one reached → bad.
		expect(
			renderBlock(block, { disk: 0.99 }).root
				.findByProps({ "data-block": "meter" }).props["data-tone"],
		).toBe("bad");
	});

	test("without thresholds the tone stays accent", () => {
		const renderer = renderBlock(
			{ type: "meter", value: 0.4, label: "Load" },
		);
		expect(
			renderer.root.findByProps({ "data-block": "meter" }).props["data-tone"],
		).toBe("accent");
		renderer.unmount();
	});
});

describe("meter: rendering", () => {
	test("renders label, formatted value and a clamped fill", () => {
		const renderer = renderBlock(
			{ type: "meter", value: { $: "/used" }, min: 0, max: 100, label: "Quota", format: "percent" },
			{ used: 40 },
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Quota");
		expect(text).toContain("4,000%"); // percent format: 40 → 4,000%
		const fill = renderer.root.findByProps({ className: "blk-meter-fill" });
		expect(fill.props.style.width).toBe("40%");
		renderer.unmount();
	});

	test("a value beyond max clamps the fill to 100%", () => {
		const renderer = renderBlock(
			{ type: "meter", value: 140, min: 0, max: 100 },
		);
		expect(
			renderer.root.findByProps({ className: "blk-meter-fill" }).props.style
				.width,
		).toBe("100%");
		renderer.unmount();
	});

	test("a binding to a missing path renders empty, never an error", () => {
		const renderer = renderBlock(
			{ type: "meter", value: { $: "/missing" }, min: 0, max: 1, label: "Gone" },
		);
		const meter = renderer.root.findByProps({ "data-block": "meter" });
		expect(meter).toBeTruthy();
		expect(meter.props["data-tone"]).toBe("accent");
		expect(renderer.root.findByProps({ className: "blk-meter-fill" }).props.style.width).toBe("0%");
		renderer.unmount();
	});

	test("renders through MeterBlockView directly (the module export)", () => {
		const { provider } = makeActions();
		const renderer = render(
			h(SurfaceDataContext.Provider, { value: { data: {}, locale: "en-US" } },
				provider(h(MeterBlockView, { block: { type: "meter", value: 1 } }))),
		);
		expect(
			renderer.root.findByProps({ "data-block": "meter" }),
		).toBeTruthy();
		renderer.unmount();
	});
});
