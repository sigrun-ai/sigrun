/**
 * ExtPanelHost (UI-blocks U3 Task 5 fix round): the right-panel extension
 * surface host. The tests pin the lifecycle rule — the declared refreshMs
 * cadence runs while the panel is OPEN and STOPS when the host unmounts
 * (a closed panel keeps no cadence and registers no keepalive).
 */

import { describe, expect, test, vi } from "vitest";
import type { SurfaceLoad } from "@sigrun/shared/blocks";

function stubLoad(): SurfaceLoad {
	return {
		tree: {
			type: "page",
			id: "stats",
			title: "Acme stats",
			main: [],
		} as unknown as SurfaceLoad["tree"],
		data: { open: 2 },
		rev: 1,
		treeRev: 1,
		access: "read",
	};
}

describe("ExtPanelHost", () => {
	test("refreshMs refetches while mounted; unmount (the tab closing) stops it", async () => {
		vi.useFakeTimers();
		try {
			const { ExtPanelHost } = await import("./ExtPanelHost");
			const { renderAsync, textContent } = await import("../test-utils");
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
				<ExtPanelHost
					slug="fixture-surfaces"
					id="stats"
					transport={transport}
					refreshMs={1000}
				/>,
			);
			// The load ran; the cadence ticks.
			await vi.advanceTimersByTimeAsync(2500);
			expect(fetchData.mock.calls.length).toBeGreaterThanOrEqual(2);
			const text = textContent(renderer.toJSON());
			expect(text).toContain("Acme stats");

			// The tab closes → unmount → NO new fetches (the stop-when-
			// hidden rule for panels: there is no cadence for a panel
			// nobody is looking at).
			renderer.unmount();
			const atClose = fetchData.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(fetchData.mock.calls.length).toBeLessThanOrEqual(atClose + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an access-none panel renders the unavailable state (no cadence)", async () => {
		vi.useFakeTimers();
		try {
			const { ExtPanelHost } = await import("./ExtPanelHost");
			const { renderAsync, textContent } = await import("../test-utils");
			const fetchData = vi.fn(async () => ({ rev: 1, treeRev: 1 }));
			const transport = {
				load: vi.fn(async () => ({ ...stubLoad(), access: "none" as const })),
				fetchData,
				act: vi.fn(),
				upload: vi.fn(),
				image: vi.fn(),
				onChanged: vi.fn(() => () => {}),
			};
			const renderer = await renderAsync(
				<ExtPanelHost
					slug="fixture-surfaces"
					id="stats"
					transport={transport}
					refreshMs={1000}
				/>,
			);
			// The not-found render still carries NO cadence requirement —
			// the timer ticks only while a refreshMs is declared; the
			// access rule is the rail/panel registration's (the entry
			// disappears). Here we pin only the unavailable render.
			const text = textContent(renderer.toJSON());
			expect(text).toContain("isn't available");
		} finally {
			vi.useRealTimers();
		}
	});
});
