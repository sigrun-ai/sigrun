/**
 * The page shell (UI-blocks U1 Task 6, spec §5.1/§12.3): header
 * title/subtitle/switcher/actions, the sidebar/main/detail columns, the
 * `empty` state (main ONLY, when main's first collection binds to
 * missing/null/[]), and the compact fallbacks (sidebar → drawer, detail
 * → pushed page with back). Also pins the SurfaceView host and the
 * Task-5 sibling-render case: a live `/view/` form and a markdown block
 * bound to `/view/...` under ONE SurfaceView provider.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h, act, type ReactElement } from "react";
import { describe, expect, test } from "vitest";
import type {
	JsonObject,
	PageBlock,
	SurfaceActResult,
	SurfaceLoad,
	SurfaceTransport,
	Tree,
} from "@sigrun/shared/blocks";
import { renderAsync, textContent } from "../test-utils";
import { PageBlockView } from "./Page";
import { SurfaceView } from "./SurfaceView";
import { SurfaceActionsContext, SurfaceDataContext } from "./context";
import { WidthContext } from "./width";

/** Render the page at a fixed width class (the container's ResizeObserver
 *  does not run under react-test-renderer). */
async function renderPage(
	block: PageBlock,
	data: JsonObject = {},
	widthClass: "compact" | "regular" | "wide" = "regular",
): ReturnType<typeof renderAsync> {
	return renderAsync(
		h(
			WidthContext.Provider,
			{ value: { widthClass, rem: widthClass === "compact" ? 30 : 60 } },
			h(
				SurfaceDataContext.Provider,
				{ value: { data, locale: "en-US" } },
				h(
					SurfaceActionsContext.Provider,
					{ value: { dispatch: (): void => {}, access: "write" as const, viewState: {} } },
					h(PageBlockView, { block }),
				),
			),
		),
	);
}

/** Find host nodes by a data attribute. */
function find(
	renderer: Awaited<ReturnType<typeof renderPage>>,
	key: string,
	value?: string,
): unknown[] {
	return renderer.root.findAll(
		(node) =>
			typeof node.props[key] === "string" &&
			(value === undefined || node.props[key] === value),
	);
}

/** The jobs fixture's shape (test/fixtures/blocks/page.json), inline so the
 *  tests own their literals. */
function pageBlock(over: Partial<PageBlock> = {}): PageBlock {
	return {
		type: "page",
		id: "page",
		title: "Jobs",
		subtitle: "acme queue",
		actions: [
			{
				id: "refresh",
				label: "Refresh",
				icon: "refresh",
				action: { type: "edit", name: "refresh" },
			},
		],
		main: [{ type: "markdown", text: "acme jobs run **here**" }],
		...over,
	};
}

describe("page shell (spec §5.1)", () => {
	test("header renders title, subtitle, and action buttons", async () => {
		const r = await renderPage(pageBlock());
		expect(textContent(r.toJSON())).toContain("Jobs");
		expect(textContent(r.toJSON())).toContain("acme queue");
		expect(find(r, "data-page-action")).toHaveLength(1);
		expect(textContent(r.toJSON())).toContain("Refresh");
	});

	test("bindable title/subtitle resolve against surface data", async () => {
		const r = await renderPage(
			pageBlock({ title: { $: "/title" }, subtitle: { $: "/sub" } }),
			{ title: "acme board", sub: "live" },
		);
		expect(textContent(r.toJSON())).toContain("acme board");
		expect(textContent(r.toJSON())).toContain("live");
	});

	test("action button dispatches its Action", async () => {
		let dispatched: string | null = null;
		const r = await renderAsync(
			h(
				SurfaceActionsContext.Provider,
				{
					value: {
						dispatch: (action): void => {
							dispatched = "name" in action ? action.name : action.type;
						},
						access: "write" as const,
						viewState: {},
					},
				},
				h(PageBlockView, { block: pageBlock() }),
			),
		);
		const [button] = r.root.findAll(
			(node) => node.props["data-page-action"] === "refresh",
		);
		act(() => {
			(button as unknown as { props: { onClick(): void } }).props.onClick();
		});
		expect(dispatched).toBe("refresh");
	});

	test("header switcher renders a choice whose selection dispatches a navigate", async () => {
		let dispatched: { type?: string } | null = null;
		const block = pageBlock({
			switcher: {
				type: "choice",
				name: "board",
				label: "Board",
				options: [
					{ id: "one", label: "One" },
					{ id: "two", label: "Two" },
				],
			},
		});
		const r = await renderAsync(
			h(
				SurfaceActionsContext.Provider,
				{
					value: {
						dispatch: (action): void => {
							dispatched = action;
						},
						access: "write" as const,
						viewState: {},
					},
				},
				h(PageBlockView, { block }),
			),
		);
		expect(find(r, "data-page-switcher")).toHaveLength(1);
		// Pick "two" through the select (radio rows at ≤5 options).
		const radios = r.root.findAllByProps({ name: "board" });
		const radio = radios.find(
			(node) => (node.props as { value?: string }).value === "two",
		);
		act(() => {
			(
				radio as unknown as { props: { onChange(): void } }
			).props.onChange();
		});
		expect(dispatched).toEqual({
			type: "navigate",
			params: { board: "two" },
		});
	});

	test("sidebar and detail render alongside main at regular width", async () => {
		const r = await renderPage(
			pageBlock({
				sidebar: [{ type: "markdown", text: "the sidebar" }],
				detail: [{ type: "markdown", text: "the detail" }],
			}),
		);
		expect(textContent(r.toJSON())).toContain("the sidebar");
		expect(textContent(r.toJSON())).toContain("the detail");
		expect(find(r, "data-page-region", "sidebar")).toHaveLength(1);
		expect(find(r, "data-page-region", "detail")).toHaveLength(1);
		expect(find(r, "data-page-region", "main")).toHaveLength(1);
	});

	test("detail is omitted when the slot is absent or empty", async () => {
		const without = await renderPage(pageBlock());
		expect(find(without, "data-page-region", "detail")).toHaveLength(0);
		const empty = await renderPage(pageBlock({ detail: [] }));
		expect(find(empty, "data-page-region", "detail")).toHaveLength(0);
	});

	test("empty state replaces MAIN ONLY when the first collection binds missing/null/[]; sidebar and detail keep rendering", async () => {
		const block = pageBlock({
			sidebar: [{ type: "markdown", text: "side survives" }],
			main: [
				{
					type: "collection",
					items: { $: "/jobs" },
					item: { title: "x" },
					display: "list",
				},
			],
			detail: [{ type: "markdown", text: "detail survives" }],
			empty: { icon: "check", title: "All done", hint: "no pending jobs" },
		});
		for (const data of [{}, { jobs: null }, { jobs: [] }] as JsonObject[]) {
			const r = await renderPage(block, data);
			const text = textContent(r.toJSON());
			expect(text).toContain("All done");
			expect(text).toContain("no pending jobs");
			expect(text).toContain("side survives");
			expect(text).toContain("detail survives");
			expect(find(r, "data-page-empty")).toHaveLength(1);
		}
	});

	test("empty state does NOT show when the collection has items", async () => {
		const block = pageBlock({
			main: [
				{
					type: "collection",
					items: { $: "/jobs" },
					item: { title: "x" },
					display: "list",
				},
			],
			empty: { icon: "check", title: "All done" },
		});
		const r = await renderPage(block, { jobs: [{ id: "a" }] });
		expect(find(r, "data-page-empty")).toHaveLength(0);
	});

	test("empty state does not apply without a first collection in main", async () => {
		const r = await renderPage(
			pageBlock({ empty: { icon: "check", title: "All done" } }),
		);
		expect(find(r, "data-page-empty")).toHaveLength(0);
		expect(textContent(r.toJSON())).toContain("acme jobs run");
	});

	test("compact: the sidebar becomes a drawer (hidden until opened)", async () => {
		const r = await renderPage(
			pageBlock({ sidebar: [{ type: "markdown", text: "side" }] }),
			{},
			"compact",
		);
		const drawers = find(r, "data-page-region", "sidebar");
		expect(drawers).toHaveLength(1);
		expect(
			(drawers[0] as { props: Record<string, unknown> }).props["data-open"],
		).toBeUndefined();
		// The drawer toggle opens it.
		const [toggle] = r.root.findAllByProps({ "data-page-drawer-toggle": "" });
		act(() => {
			(toggle as unknown as { props: { onClick(): void } }).props.onClick();
		});
		const [opened] = find(r, "data-page-region", "sidebar");
		expect(
			(opened as { props: Record<string, unknown> }).props["data-open"],
		).toBe("");
	});

	test("compact: the detail is a pushed page with a back button", async () => {
		const r = await renderPage(
			pageBlock({ detail: [{ type: "markdown", text: "pushed" }] }),
			{},
			"compact",
		);
		// Detail hidden until pushed; the toggle is in the header.
		const [detailBefore] = find(r, "data-page-region", "detail");
		expect(
			(detailBefore as { props: Record<string, unknown> }).props["data-open"],
		).toBeUndefined();
		const [detailToggle] = r.root.findAllByProps({
			"data-page-detail-toggle": "",
		});
		act(() => {
			(detailToggle as unknown as { props: { onClick(): void } }).props.onClick();
		});
		const [detailAfter] = find(r, "data-page-region", "detail");
		expect(
			(detailAfter as { props: Record<string, unknown> }).props["data-open"],
		).toBe("");
		// Back pops the pushed page.
		const [back] = r.root.findAllByProps({ "data-page-detail-back": "" });
		act(() => {
			(back as unknown as { props: { onClick(): void } }).props.onClick();
		});
		const [detailClosed] = find(r, "data-page-region", "detail");
		expect(
			(detailClosed as { props: Record<string, unknown> }).props["data-open"],
		).toBeUndefined();
	});
});

// ─── SurfaceView ──────────────────────────────────────────────────────────

/** An in-memory transport whose act always accepts (the gallery's shape). */
function memoryTransport(
	load: SurfaceLoad,
	actResult: SurfaceActResult = { ok: true, rev: load.rev + 1 },
): SurfaceTransport {
	return {
		load: async () => load,
		fetchData: async () => ({ rev: load.rev, treeRev: load.treeRev }),
		act: async () => actResult,
		upload: async () => actResult,
		image: async () => new Uint8Array(),
		onChanged: () => () => {},
	};
}

function surfaceLoad(tree: Tree, data: JsonObject): SurfaceLoad {
	return { tree, data, rev: 1, treeRev: 1, access: "write" };
}

describe("SurfaceView", () => {
	test("loading → ready: renders the tree's blocks", async () => {
		const r = await renderAsync(
			h(SurfaceView, {
				transport: memoryTransport(
					surfaceLoad(
						{ v: 1, root: { type: "markdown", text: "surface body" } },
						{},
					),
				),
			}),
		);
		expect(textContent(r.toJSON())).toContain("surface body");
	});

	test("access none renders not-found; a failing load renders error with retry", async () => {
		const notFound = await renderAsync(
			h(SurfaceView, {
				transport: memoryTransport(
					surfaceLoad({ v: 1, root: { type: "markdown", text: "x" } }, {}),
				),
			}),
		);
		void notFound;
		const none: SurfaceTransport = {
			load: async () => ({
				tree: { v: 1, root: { type: "markdown", text: "x" } },
				data: {},
				rev: 1,
				treeRev: 1,
				access: "none",
			}),
			fetchData: async () => ({ rev: 1, treeRev: 1 }),
			act: async () => ({ ok: true, rev: 2 }),
			upload: async () => ({ ok: true, rev: 2 }),
			image: async () => new Uint8Array(),
			onChanged: () => () => {},
		};
		const nf = await renderAsync(h(SurfaceView, { transport: none }));
		expect(textContent(nf.toJSON())).toContain("not found");

		let attempts = 0;
		const failing: SurfaceTransport = {
			...none,
			load: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("boom");
				return {
					tree: { v: 1, root: { type: "markdown", text: "recovered" } },
					data: {},
					rev: 1,
					treeRev: 1,
					access: "write" as const,
				};
			},
		};
		const err = await renderAsync(h(SurfaceView, { transport: failing }));
		expect(textContent(err.toJSON())).toContain("went wrong");
		const [retry] = err.root.findAllByProps({ "data-surface-retry": "" });
		await act(async () => {
			(retry as unknown as { props: { onClick(): void } }).props.onClick();
		});
		expect(textContent(err.toJSON())).toContain("recovered");
	});

	test("sibling render: a live /view/ form publishes through ONE provider to a sibling markdown bound to /view/...", async () => {
		// The Task-5 fix-round seam, made testable by this host: the form's
		// /view/ debounce writes setView; the sibling markdown reads /view/.
		const tree: Tree = {
			v: 1,
			root: {
				type: "stack",
				children: [
					{
						type: "form",
						id: "f",
						bind: "/view/filter",
						mode: "live",
						children: [{ type: "text", name: "q", label: "Q" }],
					},
					{ type: "markdown", text: { $: "/view/filter/q" } },
				],
			},
		};
		const r = await renderAsync(
			h(SurfaceView, { transport: memoryTransport(surfaceLoad(tree, {})) }),
		);
		const input = r.root.find(
			(node) => node.type === "input" && node.props["aria-label"] === "Q",
		);
		await act(async () => {
			(input.props as { onChange(e: unknown): void }).onChange({
				target: { value: "acme" },
			});
			// The live debounce is 300 ms (LIVE_DEBOUNCE_MS).
			await new Promise((resolve) => setTimeout(resolve, 400));
		});
		expect(textContent(r.toJSON())).toContain("acme");
	});

	test("server field error: a rejected act with {field} renders the message under that field (spec §5.6)", async () => {
		const tree: Tree = {
			v: 1,
			root: {
				type: "form",
				bind: "/registration",
				mode: "submit",
				onSubmit: "register",
				submitLabel: "Register",
				children: [
					{ type: "text", name: "name", label: "Name" },
					{ type: "text", name: "handle", label: "Handle" },
				],
			},
		};
		const transport = memoryTransport(
			surfaceLoad(tree, { registration: { name: "Acme", handle: "acme" } }),
			{
				ok: false,
				error: { message: "Handle is taken", field: "handle" },
			},
		);
		const r = await renderAsync(h(SurfaceView, { transport }));
		const [submit] = r.root.findAll(
			(node) =>
				node.type === "button" && node.props.className === "blk-form-submit",
		);
		await act(async () => {
			(submit.props as { onClick(): void }).onClick();
			await Promise.resolve();
		});
		const handleRow = r.root.find(
			(node) =>
				node.type === "input" && node.props["aria-label"] === "Handle",
		);
		// Find the enclosing field row (label + input + error chrome) and
		// assert the server message renders INSIDE it.
		let row: typeof handleRow = handleRow;
		while (
			row.parent !== null &&
			!((row.parent.props as { className?: string }).className ?? "").includes(
				"blk-field",
			)
		) {
			row = row.parent;
		}
		const fieldRow = row.parent;
		expect(fieldRow !== null).toBe(true);
		expect(
			fieldRow !== null &&
				fieldRow.findAllByProps({ className: "blk-field-error" }).some(
					(node) => node.children.join("").includes("Handle is taken"),
				),
		).toBe(true);
		// The rejection also lands the global toast.
		expect(textContent(r.toJSON())).toContain("Handle is taken");
	});
});
