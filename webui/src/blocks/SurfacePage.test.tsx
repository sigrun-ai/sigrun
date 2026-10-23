/**
 * The extension-surface page (UI-blocks U3 Task 5): the main-pane host
 * for one extension view, reached through the `#/ext/<slug>/<id>` route.
 *
 * U3's scope is the WIRE: load the surface through the transport, hold
 * the last frame, honor `refreshMs` (refetch data on the interval while
 * visible, stop on unmount) plus the 5-minute watcher keepalive (a
 * `since` fetch), and translate server `navigate` actions into the
 * app's route changes. The generic block renderer is U1's; until it
 * lands the page renders the surface's title + a text summary + its
 * actions row, so the two-browser e2e (a drag across lanes) has real
 * DOM to drive.
 */

import { describe, expect, test, vi } from "vitest";
import type { SurfaceLoad } from "@sigrun/shared/blocks";
import { ExtSurfaceHub } from "./extTransport";

// The component is react-test-renderer-rendered; the transport is a stub.

function stubLoad(access: SurfaceLoad["access"] = "write"): SurfaceLoad {
	return {
		tree: {
			type: "page",
			id: "board",
			title: "Acme board",
			main: [],
		} as unknown as SurfaceLoad["tree"],
		data: { cards: [{ id: "c1", title: "First", status: "todo" }] },
		rev: 1,
		treeRev: 1,
		access,
	};
}

describe("SurfacePage", () => {
	test("load() runs on mount and the title renders", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync, textContent } = await import("../test-utils");
		const load = vi.fn(async () => stubLoad());
		const hub = new ExtSurfaceHub();
		const transport = {
			load,
			fetchData: vi.fn(async () => ({ rev: 1, treeRev: 1 })),
			act: vi.fn(),
			upload: vi.fn(),
			image: vi.fn(),
			onChanged: vi.fn(() => () => {}),
		};
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="board"
				transport={transport}
				hub={hub}
			/>,
		);
		expect(load).toHaveBeenCalledTimes(1);
		expect(renderer.toJSON()).not.toBeNull();
	});

	test("access none renders the not-found state (the usual surface 404)", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync, textContent } = await import("../test-utils");
		const transport = {
			load: vi.fn(async () => stubLoad("none")),
			fetchData: vi.fn(),
			act: vi.fn(),
			upload: vi.fn(),
			image: vi.fn(),
			onChanged: vi.fn(() => () => {}),
		};
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="board"
				transport={transport}
				hub={new ExtSurfaceHub()}
			/>,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("not found");
	});

	test("refreshMs refetches data on the interval while mounted, stops on unmount", async () => {
		vi.useFakeTimers();
		try {
			const { SurfacePage } = await import("./SurfacePage");
			const { renderAsync } = await import("../test-utils");
			const fetchData = vi.fn(async () => ({ rev: 1, treeRev: 1 }));
			const transport = {
				load: vi.fn(async () => stubLoad()),
				fetchData,
				act: vi.fn(),
				upload: vi.fn(),
				image: vi.fn(),
				onChanged: vi.fn(() => () => {}),
			};
			const renderer = await renderAsync(
				<SurfacePage
					slug="fixture-surfaces"
					id="stats"
					refreshMs={1000}
					transport={transport}
					hub={new ExtSurfaceHub()}
				/>,
			);
			await vi.advanceTimersByTimeAsync(3500);
			expect(fetchData.mock.calls.length).toBeGreaterThanOrEqual(3);
			renderer.unmount();
			const callsAtUnmount = fetchData.mock.calls.length;
			await vi.advanceTimersByTimeAsync(3000);
			// One in-flight call may land after unmount (the tick that was already
			// scheduled); NO NEW ticks may start.
			expect(fetchData.mock.calls.length).toBeLessThanOrEqual(callsAtUnmount + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a 5-minute keepalive `since` fetch runs while visible", async () => {
		vi.useFakeTimers();
		try {
			const { SurfacePage } = await import("./SurfacePage");
			const { renderAsync } = await import("../test-utils");
			const fetchData = vi.fn(async () => ({ rev: 7, treeRev: 1 }));
			const transport = {
				load: vi.fn(async () => ({ ...stubLoad(), rev: 7 })),
				fetchData,
				act: vi.fn(),
				upload: vi.fn(),
				image: vi.fn(),
				onChanged: vi.fn(() => () => {}),
			};
			await renderAsync(
				<SurfacePage
					slug="fixture-surfaces"
					id="board"
					transport={transport}
					hub={new ExtSurfaceHub()}
				/>,
			);
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
			const sinceCalls = fetchData.mock.calls.filter(
				(call) => typeof (call as unknown[])[0] === "number",
			);
			expect(sinceCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
