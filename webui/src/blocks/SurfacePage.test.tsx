/**
 * The extension-surface page (UI-blocks U3 Task 5): the main-pane host
 * for one extension view, reached through the `#/ext/<slug>/<id>` route.
 *
 * The page renders the surface's tree through the generic block
 * renderer (SurfaceView/useSurface/BlockView) and keeps its transport/
 * lifecycle layer: `load` on mount, `refreshMs` refetch cadence, the
 * 5-minute watcher keepalive, `surface.changed` subscription, and the
 * shell's `onNavigate` seam for `navigate` actions and accepted act
 * results.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import type { SurfaceLoad, SurfaceTransport, Tree } from "@sigrun/shared/blocks";
import { ExtSurfaceHub } from "./extTransport";

/** The test surface tree: a page with markdown, a list collection, and
 *  a submit-mode form (one choice field, `onSubmit: "answer"`). */
const TREE: Tree = {
	v: 1,
	root: {
		type: "page",
		id: "inbox",
		title: "Acme inbox",
		main: [
			{ type: "markdown", text: "Hello **inbox**" },
			{
				type: "collection",
				id: "items",
				items: { $: "/items" },
				item: { title: { $: "./title" } },
				display: "list",
			},
			{
				type: "form",
				id: "answer-form",
				bind: "/answer",
				mode: "submit",
				onSubmit: "answer",
				children: [
					{
						type: "choice",
						name: "option",
						label: "Option",
						options: [
							{ id: "a", label: "Option A" },
							{ id: "b", label: "Option B" },
						],
					},
				],
			},
		],
	},
};

function stubLoad(access: SurfaceLoad["access"] = "write"): SurfaceLoad {
	return {
		tree: TREE,
		data: {
			items: [
				{ id: "i1", title: "First item" },
				{ id: "i2", title: "Second item" },
			],
		},
		rev: 1,
		treeRev: 1,
		access,
	};
}

function makeTransport(
	load: () => Promise<SurfaceLoad> = async () => stubLoad(),
): SurfaceTransport & {
	load: ReturnType<typeof vi.fn>;
	fetchData: ReturnType<typeof vi.fn>;
	act: ReturnType<typeof vi.fn>;
} {
	return {
		load: vi.fn(load),
		fetchData: vi.fn(async () => ({ rev: 1, treeRev: 1 })),
		act: vi.fn(async () => ({ ok: true as const, rev: 2 })),
		upload: vi.fn(),
		image: vi.fn(),
		onChanged: vi.fn(() => () => {}),
	};
}

/** The board tree fixture: a lanes collection with three lanes. */
const BOARD_TREE: Tree = {
	v: 1,
	root: {
		type: "page",
		id: "board",
		title: "Acme board",
		main: [
			{
				type: "collection",
				id: "cards",
				items: { $: "/cards" },
				item: { title: { $: "./title" } },
				display: "lanes",
				groupBy: "status",
				groups: [
					{ id: "todo", title: "To do" },
					{ id: "doing", title: "In progress" },
					{ id: "done", title: "Done" },
				],
				onMove: "move",
			},
		],
	},
};

describe("SurfacePage", () => {
	test("renders the page tree through the block renderer (markdown, collection, form)", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync, textContent } = await import("../test-utils");
		const transport = makeTransport();
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="inbox"
				transport={transport}
				hub={new ExtSurfaceHub()}
			/>,
		);
		expect(transport.load).toHaveBeenCalledTimes(1);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Hello");
		expect(text).toContain("inbox");
		expect(text).toContain("First item");
		expect(text).toContain("Second item");
		expect(text).toContain("Option A");
		expect(text).toContain("Option B");
		// No interim JSON dump.
		expect(
			renderer.root.findAllByProps({ className: "ext-surface-data" }),
		).toHaveLength(0);
		// The markdown block renders through the generic renderer.
		expect(
			renderer.root.findAllByProps({ className: "blk blk-markdown" }).length,
		).toBeGreaterThan(0);
	});

	test("access none renders the not-found state", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync, textContent } = await import("../test-utils");
		const transport = makeTransport(async () => stubLoad("none"));
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="inbox"
				transport={transport}
				hub={new ExtSurfaceHub()}
			/>,
		);
		expect(textContent(renderer.toJSON())).toContain("not found");
	});

	test("submitting the form calls transport.act with the values + rev payload", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync } = await import("../test-utils");
		const transport = makeTransport();
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="inbox"
				transport={transport}
				hub={new ExtSurfaceHub()}
			/>,
		);
		// Pick option "a" and submit.
		const radio = renderer.root.find(
			(node) => node.type === "input" && node.props.value === "a",
		);
		await act(async () => {
			(radio.props as { onChange: () => void }).onChange();
		});
		const submit = renderer.root.findByProps({ className: "blk-form-submit" });
		await act(async () => {
			(submit.props as { onClick: () => void }).onClick();
		});
		expect(transport.act).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "answer",
				payload: { values: { option: "a" }, rev: 1 },
			}),
		);
	});

	test("a page navigate action calls onNavigate and never calls transport.act", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync } = await import("../test-utils");
		const transport = makeTransport();
		const onNavigate = vi.fn();
		// Add a header action button carrying a navigate action.
		const treeWithAction: Tree = {
			v: 1,
			root: {
				...TREE.root,
				actions: [
					{
						id: "dismissed",
						label: "Dismissed",
						action: { type: "navigate", params: { tab: "dismissed" } },
					},
				],
			} as Tree["root"],
		};
		transport.load = vi.fn(async () => ({ ...stubLoad(), tree: treeWithAction }));
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="inbox"
				transport={transport}
				hub={new ExtSurfaceHub()}
				onNavigate={onNavigate}
			/>,
		);
		const button = renderer.root.findByProps({ "data-page-action": "dismissed" });
		await act(async () => {
			(button.props as { onClick: () => void }).onClick();
		});
		expect(onNavigate).toHaveBeenCalledWith({ params: { tab: "dismissed" } });
		expect(transport.act).not.toHaveBeenCalled();
	});

	test("an accepted act result carrying navigate + toast routes and shows the toast", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync, textContent } = await import("../test-utils");
		const transport = makeTransport();
		transport.act = vi.fn(async () => ({
			ok: true as const,
			rev: 2,
			navigate: { type: "navigate" as const, params: { id: "x" } },
			toast: "Done",
		}));
		const onNavigate = vi.fn();
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="inbox"
				transport={transport}
				hub={new ExtSurfaceHub()}
				onNavigate={onNavigate}
			/>,
		);
		const radio = renderer.root.find(
			(node) => node.type === "input" && node.props.value === "a",
		);
		await act(async () => {
			(radio.props as { onChange: () => void }).onChange();
		});
		const submit = renderer.root.findByProps({ className: "blk-form-submit" });
		await act(async () => {
			(submit.props as { onClick: () => void }).onClick();
		});
		await vi.waitFor(() => {
			expect(onNavigate).toHaveBeenCalledWith({ params: { id: "x" } });
		});
		await vi.waitFor(() => {
			expect(textContent(renderer.toJSON())).toContain("Done");
		});
	});

	test("the lanes collection renders through the generic lanes display (three lanes, cards in their lanes)", async () => {
		const { SurfacePage } = await import("./SurfacePage");
		const { renderAsync, textContent } = await import("../test-utils");
		const transport = makeTransport(async () => ({
			tree: BOARD_TREE,
			data: {
				cards: [
					{ id: "c1", title: "First card", status: "todo" },
					{ id: "c2", title: "Second card", status: "doing" },
					{ id: "c3", title: "Third card", status: "done" },
				],
			},
			rev: 1,
			treeRev: 1,
			access: "write",
		}));
		const renderer = await renderAsync(
			<SurfacePage
				slug="fixture-surfaces"
				id="board"
				transport={transport}
				hub={new ExtSurfaceHub()}
			/>,
		);
		// The generic lanes display root.
		const lanes = renderer.root.findByProps({ "data-display": "lanes" });
		expect(lanes).toBeDefined();
		// Three lane headings.
		for (const title of ["To do", "In progress", "Done"]) {
			expect(textContent(renderer.toJSON())).toContain(title);
		}
		// Cards render inside their lanes.
		for (const [lane, card] of [
			["todo", "First card"],
			["doing", "Second card"],
			["done", "Third card"],
		] as const) {
			const laneEl = renderer.root.findByProps({ "data-lane": lane });
			const titles = laneEl.findAllByProps({ className: "blk-card-title" });
			const laneText = titles
				.map((el) => el.children.join(""))
				.join(" ");
			expect(laneText).toContain(card);
		}
	});

	test("refreshMs refetches data on the interval while mounted, stops on unmount", async () => {
		vi.useFakeTimers();
		try {
			const { SurfacePage } = await import("./SurfacePage");
			const { renderAsync } = await import("../test-utils");
			const transport = makeTransport();
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
			expect(transport.fetchData.mock.calls.length).toBeGreaterThanOrEqual(3);
			renderer.unmount();
			const callsAtUnmount = transport.fetchData.mock.calls.length;
			await vi.advanceTimersByTimeAsync(3000);
			expect(transport.fetchData.mock.calls.length).toBeLessThanOrEqual(
				callsAtUnmount + 1,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a since answer with ops and no data falls back to one full refetch and renders fresh data", async () => {
		vi.useFakeTimers();
		try {
			const { SurfacePage } = await import("./SurfacePage");
			const { renderAsync, textContent } = await import("../test-utils");
			const fresh = {
				items: [{ id: "i2", title: "Second item" }],
			};
			const transport = makeTransport();
			transport.fetchData = vi.fn(async (since?: number) =>
				since === undefined
					? { rev: 2, treeRev: 1, data: fresh }
					: {
							rev: 2,
							treeRev: 1,
							ops: [{ op: "set" as const, path: "/items/0/title", value: "Second item" }],
						},
			);
			const renderer = await renderAsync(
				<SurfacePage
					slug="fixture-surfaces"
					id="inbox"
					refreshMs={1000}
					transport={transport}
					hub={new ExtSurfaceHub()}
				/>,
			);
			expect(textContent(renderer.toJSON())).toContain("First item");
			// A missed change event does not matter: the next cadence tick
			// heals the data, with the ops-only answer triggering ONE full fetch.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(textContent(renderer.toJSON())).toContain("Second item");
			expect(textContent(renderer.toJSON())).not.toContain("First item");
			const sinceCalls = transport.fetchData.mock.calls.filter(
				(call) => typeof (call as unknown[])[0] === "number",
			);
			const fullCalls = transport.fetchData.mock.calls.filter(
				(call) => (call as unknown[])[0] === undefined,
			);
			expect(sinceCalls).toEqual([[1]]);
			expect(fullCalls).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a data update does NOT re-arm the keepalive interval (refresh identity is stable)", async () => {
		vi.useFakeTimers();
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearSpy = vi.spyOn(globalThis, "clearInterval");
		try {
			const { SurfacePage } = await import("./SurfacePage");
			const { renderAsync } = await import("../test-utils");
			const transport = makeTransport();
			const changeListeners: ((event: { rev: number; treeRev: number }) => void)[] = [];
			transport.onChanged = vi.fn((listener) => {
				changeListeners.push(listener);
				return () => undefined;
			});
			transport.fetchData = vi.fn(async () => ({
				rev: 2,
				treeRev: 1,
				data: { items: [{ id: "i1", title: "Updated item" }] },
			}));
			await renderAsync(
				<SurfacePage
					slug="fixture-surfaces"
					id="inbox"
					transport={transport}
					hub={new ExtSurfaceHub()}
				/>,
			);
			const intervalsAfterMount = intervalSpy.mock.calls.length;
			expect(intervalsAfterMount).toBeGreaterThanOrEqual(1);
			// A surface.changed → since-fetch → data apply re-renders the
			// page. The keepalive interval must SURVIVE the churn — a
			// re-arm (clearInterval + fresh setInterval) restarts the
			// 5-minute clock and never lets a tick land under activity.
			await act(async () => {
				for (const listener of changeListeners) {
					listener({ rev: 2, treeRev: 1 });
				}
				await vi.advanceTimersByTimeAsync(10);
			});
			expect(clearSpy).not.toHaveBeenCalled();
			expect(intervalSpy.mock.calls.length).toBe(intervalsAfterMount);
		} finally {
			clearSpy.mockRestore();
			intervalSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	test("a 5-minute keepalive `since` fetch runs while visible", async () => {
		vi.useFakeTimers();
		try {
			const { SurfacePage } = await import("./SurfacePage");
			const { renderAsync } = await import("../test-utils");
			const transport = makeTransport(async () => ({ ...stubLoad(), rev: 7 }));
			transport.fetchData = vi.fn(async () => ({ rev: 7, treeRev: 1 }));
			await renderAsync(
				<SurfacePage
					slug="fixture-surfaces"
					id="inbox"
					transport={transport}
					hub={new ExtSurfaceHub()}
				/>,
			);
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
			// The keepalive is a full fetch; its result also feeds the render.
			expect(transport.fetchData.mock.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a hidden tab pauses the cadence; visible resumes with an immediate refetch", async () => {
		vi.useFakeTimers();
		const listeners: (() => void)[] = [];
		const doc = {
			visibilityState: "visible" as string,
			addEventListener: (_t: string, l: () => void) => listeners.push(l),
			removeEventListener: (_t: string, l: () => void) => {
				const i = listeners.indexOf(l);
				if (i >= 0) listeners.splice(i, 1);
			},
		};
		(globalThis as { document?: unknown }).document = doc;
		try {
			const { SurfacePage } = await import("./SurfacePage");
			const { renderAsync } = await import("../test-utils");
			const transport = makeTransport();
			await renderAsync(
				<SurfacePage
					slug="fixture-surfaces"
					id="stats"
					refreshMs={1000}
					transport={transport}
					hub={new ExtSurfaceHub()}
				/>,
			);
			await vi.advanceTimersByTimeAsync(2500);
			expect(transport.fetchData.mock.calls.length).toBeGreaterThanOrEqual(2);

			doc.visibilityState = "hidden";
			for (const listener of [...listeners]) listener();
			const atHide = transport.fetchData.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			// No NEW ticks start while hidden (an already in-flight tick may
			// finish its request).
			expect(transport.fetchData.mock.calls.length).toBeLessThanOrEqual(atHide + 1);

			doc.visibilityState = "visible";
			for (const listener of [...listeners]) listener();
			// Resuming performs an immediate full keepalive fetch.
			expect(transport.fetchData.mock.calls.length).toBeGreaterThan(atHide);
			const atResume = transport.fetchData.mock.calls.length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(transport.fetchData.mock.calls.length).toBeGreaterThan(atResume);
		} finally {
			delete (globalThis as { document?: unknown }).document;
			vi.useRealTimers();
		}
	});
});
