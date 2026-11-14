/** Inline save feedback through SurfaceView + useSurface, over a fake
 * transport (the same transport-only seam SurfacePage tests use). */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SurfaceActResult, SurfaceTransport, Tree } from "@sigrun/shared/blocks";
import { findButton, instanceText, renderAsync } from "../test-utils";
import { SurfaceView } from "./SurfaceView";

const TREE: Tree = {
	v: 1,
	root: {
		type: "form",
		bind: "/settings",
		mode: "submit",
		onSubmit: "save",
		submitLabel: "Save",
		children: [{ type: "text", name: "batch", label: "Max batch" }],
	},
};

function makeTransport(result: SurfaceActResult): SurfaceTransport & {
	act: ReturnType<typeof vi.fn>;
} {
	return {
		load: vi.fn(async () => ({
			tree: TREE,
			data: { settings: { batch: 10 } },
			rev: 1,
			treeRev: 1,
			access: "write" as const,
		})),
		fetchData: vi.fn(async () => ({ rev: 2, treeRev: 1 })),
		act: vi.fn(async () => result),
		upload: vi.fn(),
		image: vi.fn(),
		onChanged: vi.fn(() => () => {}),
	};
}

async function submitForm(
	transport: SurfaceTransport & { act: ReturnType<typeof vi.fn> },
	inlineFeedback: boolean,
) {
	const renderer = await renderAsync(
		h(SurfaceView, { transport, inlineFeedback }),
	);
	await act(async () => {
		findButton(renderer, "Save").props.onClick();
	});
	expect(transport.act).toHaveBeenCalledTimes(1);
	return renderer;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SurfaceView inline save feedback", () => {
	test("inlineFeedback shows Saved after an accepted submit", async () => {
		const transport = makeTransport({ ok: true, rev: 2 });
		const renderer = await submitForm(transport, true);
		const saved = renderer.root.findByProps({
			role: "status",
			className: "blk-form-saved",
		});
		expect(instanceText(saved)).toBe("Saved");
		expect(renderer.root.findAllByProps({ className: "blk-surface-toast" })).toHaveLength(0);
	});

	test("inlineFeedback shows a rejected submit inline, not as a toast", async () => {
		const transport = makeTransport({
			ok: false,
			error: { field: "batch", message: "Max batch must be integer" },
		});
		const renderer = await submitForm(transport, true);
		const alert = renderer.root.findByProps({
			role: "alert",
			className: "blk-form-error",
		});
		expect(instanceText(alert)).toContain("Not saved: Max batch must be integer");
		expect(renderer.root.findAllByProps({ className: "blk-surface-toast" })).toHaveLength(0);
	});

	test("without inlineFeedback a rejected submit still toasts", async () => {
		const transport = makeTransport({
			ok: false,
			error: { field: "batch", message: "Max batch must be integer" },
		});
		const renderer = await submitForm(transport, false);
		const toasts = renderer.root.findAllByProps({ className: "blk-surface-toast" });
		expect(toasts).toHaveLength(1);
		expect(instanceText(toasts[0]!)).toBe("Max batch must be integer");
		expect(renderer.root.findAllByProps({ className: "blk-form-error" })).toHaveLength(0);
	});

	test("Saved clears after 4000 ms", async () => {
		vi.useFakeTimers();
		const transport = makeTransport({ ok: true, rev: 2 });
		const renderer = await renderAsync(
			h(SurfaceView, { transport, inlineFeedback: true }),
		);
		await act(async () => {
			findButton(renderer, "Save").props.onClick();
		});
		expect(renderer.root.findAllByProps({ className: "blk-form-saved" })).toHaveLength(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3999);
		});
		expect(renderer.root.findAllByProps({ className: "blk-form-saved" })).toHaveLength(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(renderer.root.findAllByProps({ className: "blk-form-saved" })).toHaveLength(0);
	});
});
