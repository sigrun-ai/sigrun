/**
 * ExtPanelHost (UI-blocks U3 Task 5 fix round): the right-panel extension
 * surface host. The panel renders the surface's tree through the generic
 * block renderer and keeps its lifecycle: the declared refreshMs cadence
 * runs while the panel is OPEN and STOPS when the host unmounts.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, test, vi } from "vitest";
import type { SurfaceLoad, Tree } from "@sigrun/shared/blocks";

const TREE: Tree = {
	v: 1,
	root: {
		type: "page",
		id: "stats",
		title: "Acme stats",
		main: [{ type: "markdown", text: "Hello **inbox**" }],
	},
};

function stubLoad(): SurfaceLoad {
	return {
		tree: TREE,
		data: { open: 2 },
		rev: 1,
		treeRev: 1,
		access: "read",
	};
}

describe("ExtPanelHost", () => {
	test("renders the tree's markdown through the block renderer", async () => {
		const { ExtPanelHost } = await import("./ExtPanelHost");
		const { renderAsync, textContent } = await import("../test-utils");
		const transport = {
			load: vi.fn(async () => stubLoad()),
			fetchData: vi.fn(async () => ({ rev: 1, treeRev: 1 })),
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
			/>,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Hello");
		expect(text).toContain("inbox");
		expect(
			renderer.root.findAllByProps({ className: "blk blk-markdown" }).length,
		).toBeGreaterThan(0);
	});

	test("refreshMs refetches while mounted; unmount (the tab closing) stops it", async () => {
		vi.useFakeTimers();
		try {
			const { ExtPanelHost } = await import("./ExtPanelHost");
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
				<ExtPanelHost
					slug="fixture-surfaces"
					id="stats"
					transport={transport}
					refreshMs={1000}
				/>,
			);
			await vi.advanceTimersByTimeAsync(2500);
			expect(fetchData.mock.calls.length).toBeGreaterThanOrEqual(2);

			renderer.unmount();
			const atClose = fetchData.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(fetchData.mock.calls.length).toBeLessThanOrEqual(atClose + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an access-none panel renders the unavailable state", async () => {
		const { ExtPanelHost } = await import("./ExtPanelHost");
		const { renderAsync, textContent } = await import("../test-utils");
		const transport = {
			load: vi.fn(async () => ({ ...stubLoad(), access: "none" as const })),
			fetchData: vi.fn(async () => ({ rev: 1, treeRev: 1 })),
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
			/>,
		);
		expect(textContent(renderer.toJSON())).toContain("not found");
	});
});
