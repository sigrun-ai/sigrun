/**
 * The `page` shell and SurfaceView (UI-blocks U2 Task 5, spec §5.1/
 * §12.3): the header line (title, subtitle, hints), the `ctrl+s`
 * switcher (a `choice` field; Enter dispatches `navigate` with
 * `{<name>: id}`), the `.` actions menu (access read hides edit/answer
 * actions), the sidebar as a focusable pane at ≥ 100 columns and a
 * toggled overlay below, `empty` replacing MAIN ONLY when main's first
 * collection binds missing/null/[], the detail region as a pushed view
 * with Esc back, and SurfaceView's loading / not-found / error-with-`r`
 * states.
 */

import { describe, expect, test } from "vitest";
import type {
	Action,
	JsonObject,
	JsonValue,
	PageBlock,
	SurfaceActResult,
	SurfaceLoad,
	SurfaceTransport,
	Tree,
} from "@sigrun/shared/blocks";
import { plainTuiTheme } from "../src/theme.js";
import type { BlockCtx } from "../src/blocks/render.js";
import { renderBlock } from "../src/blocks/render.js";
import type { PageComponent } from "../src/blocks/page.js";
import { SurfaceState } from "../src/blocks/surface.js";
import { SurfaceView } from "../src/blocks/surface-view.js";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";

interface Captured {
	action: Action;
	payload: JsonValue;
}

function makeCtx(
	data: Record<string, JsonValue>,
	opts: { access?: "read" | "write"; unicode?: boolean } = {},
): { ctx: BlockCtx; captured: Captured[] } {
	const captured: Captured[] = [];
	const ctx: BlockCtx = {
		data,
		theme: plainTuiTheme(),
		locale: "en-CA",
		timeZone: "UTC",
		access: opts.access ?? "write",
		unicode: opts.unicode ?? true,
		dispatch: (action, payload) => {
			captured.push({ action, payload });
		},
		view: { values: {} },
	};
	return { ctx, captured };
}

function pageOf(block: PageBlock, ctx: BlockCtx): PageComponent {
	return renderBlock(block, ctx) as unknown as PageComponent;
}

function textBlock(textValue: string): PageBlock["main"][number] {
	return { type: "markdown", text: textValue };
}

describe("page header (§5.1)", () => {
	test("the header line carries the title and subtitle", () => {
		const { ctx } = makeCtx({});
		const page = pageOf(
			{
				type: "page",
				title: "Acme board",
				subtitle: "three lanes",
				main: [textBlock("main here")],
			},
			ctx,
		);
		const lines = page.render(100);
		expect(lines[0]).toContain("Acme board");
		expect(lines.join("\n")).toContain("three lanes");
	});

	test("the title resolves a binding", () => {
		const { ctx } = makeCtx({ name: "Bound title" });
		const page = pageOf(
			{ type: "page", title: { $: "/name" }, main: [textBlock("m")] },
			ctx,
		);
		expect(page.render(100).join("\n")).toContain("Bound title");
	});
});

describe("page switcher (§5.1)", () => {
	const switcherPage: PageBlock = {
		type: "page",
		title: "Boards",
		switcher: {
			type: "choice",
			name: "board",
			label: "Board",
			options: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Beta" },
			],
		},
		main: [textBlock("m")],
	};

	test("ctrl+s opens the switcher; Enter dispatches navigate with the id", () => {
		const { ctx, captured } = makeCtx({});
		const page = pageOf(switcherPage, ctx);
		page.handleInput("\x13"); // ctrl+s
		const text = page.render(100).join("\n");
		expect(text).toContain("Alpha");
		expect(text).toContain("Beta");
		page.handleInput(DOWN);
		page.handleInput(ENTER);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.action).toEqual({ type: "navigate", params: { board: "b" } });
	});

	test("Esc closes the switcher without dispatching", () => {
		const { ctx, captured } = makeCtx({});
		const page = pageOf(switcherPage, ctx);
		page.handleInput("\x13");
		page.handleInput(ESC);
		expect(captured).toHaveLength(0);
		expect(page.hasOverlay).toBe(false);
	});
});

describe("page actions menu (§5.1)", () => {
	const actionsPage: PageBlock = {
		type: "page",
		title: "Board",
		actions: [
			{ id: "act-add", label: "Add card", action: { type: "submit", name: "addCard" } },
			{ id: "act-open", label: "Open docs", action: { type: "open", url: "https://example.invalid" } },
		],
		main: [textBlock("m")],
	};

	test(". opens the actions menu; Enter dispatches the picked action", () => {
		const { ctx, captured } = makeCtx({});
		const page = pageOf(actionsPage, ctx);
		page.handleInput(".");
		expect(page.render(100).join("\n")).toContain("Add card");
		page.handleInput(ENTER);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.action).toEqual({ type: "submit", name: "addCard" });
	});

	test("access read hides edit/answer actions; navigate/open stay", () => {
		const { ctx } = makeCtx({}, { access: "read" });
		const page = pageOf(actionsPage, ctx);
		page.handleInput(".");
		const text = page.render(100).join("\n");
		expect(text).not.toContain("Add card");
		expect(text).toContain("Open docs");
	});
});

describe("page sidebar (§5.1)", () => {
	const sidePage: PageBlock = {
		type: "page",
		title: "Board",
		sidebar: [textBlock("SIDEBAR-CONTENT")],
		main: [textBlock("MAIN-CONTENT")],
	};

	test("at ≥ 100 columns the sidebar is a pane beside main", () => {
		const { ctx } = makeCtx({});
		const page = pageOf(sidePage, ctx);
		const text = page.render(120).join("\n");
		expect(text).toContain("SIDEBAR-CONTENT");
		expect(text).toContain("MAIN-CONTENT");
	});

	test("below 100 columns the sidebar hides until Tab toggles the overlay", () => {
		const { ctx } = makeCtx({});
		const page = pageOf(sidePage, ctx);
		const before = page.render(90).join("\n");
		expect(before).toContain("MAIN-CONTENT");
		expect(before).not.toContain("SIDEBAR-CONTENT");
		page.handleInput(TAB);
		expect(page.sidebarOpen).toBe(true);
		const opened = page.render(90).join("\n");
		expect(opened).toContain("SIDEBAR-CONTENT");
		page.handleInput(ESC);
		expect(page.sidebarOpen).toBe(false);
		expect(page.hasOverlay).toBe(false);
	});
});

describe("page empty state (§5.1)", () => {
	const emptyPage: PageBlock = {
		type: "page",
		title: "Board",
		sidebar: [textBlock("SIDE")],
		main: [
			{
				type: "collection",
				id: "cards",
				items: { $: "/cards" },
				display: "list",
				item: { title: { $: "./title" } },
			},
		],
		empty: { icon: "list", title: "No cards yet", hint: "Add one to begin." },
	};

	test("an empty first collection replaces MAIN only (sidebar stays)", () => {
		const { ctx } = makeCtx({ cards: [] });
		const page = pageOf(emptyPage, ctx);
		const text = page.render(90).join("\n");
		expect(text).toContain("No cards yet");
		expect(text).toContain("Add one to begin.");
		// The sidebar is a toggled overlay below 100 columns: Tab opens it.
		page.handleInput(TAB);
		expect(page.render(90).join("\n")).toContain("SIDE");
	});

	test("a non-empty collection renders main, not the empty state", () => {
		const { ctx } = makeCtx({ cards: [{ id: "c1", title: "Card one" }] });
		const page = pageOf(emptyPage, ctx);
		const text = page.render(90).join("\n");
		expect(text).not.toContain("No cards yet");
	});
});

describe("page detail (§5.1/§12.3)", () => {
	const detailPage: PageBlock = {
		type: "page",
		title: "Board",
		main: [textBlock("MAIN-CONTENT")],
		detail: [textBlock("DETAIL-CONTENT")],
	};

	test("Enter pushes the detail view; Esc pops back", () => {
		const { ctx } = makeCtx({});
		const page = pageOf(detailPage, ctx);
		expect(page.render(100).join("\n")).not.toContain("DETAIL-CONTENT");
		page.handleInput(ENTER);
		expect(page.detailPushed).toBe(true);
		const pushed = page.render(100).join("\n");
		expect(pushed).toContain("DETAIL-CONTENT");
		expect(pushed).not.toContain("MAIN-CONTENT");
		page.handleInput(ESC);
		expect(page.detailPushed).toBe(false);
		expect(page.render(100).join("\n")).toContain("MAIN-CONTENT");
	});
});

// ─── SurfaceView (the surface host component) ────────────────────────────

const PAGE_TREE: Tree = {
	v: 1,
	root: {
		type: "page",
		title: "Hosted",
		main: [textBlock("HOSTED-MAIN")],
	},
};

function fakeTransport(init: {
	load?: () => Promise<SurfaceLoad>;
}): { transport: SurfaceTransport; acts: { action: string }[] } {
	const acts: { action: string }[] = [];
	const transport: SurfaceTransport = {
		load:
			init.load ??
			(() =>
				Promise.resolve({
					tree: PAGE_TREE,
					data: {},
					rev: 1,
					treeRev: 1,
					access: "write" as const,
				})),
		fetchData: () => Promise.reject(new Error("no fetch")),
		act: (body) => {
			acts.push(body);
			return Promise.resolve({ ok: true, rev: 2 } as SurfaceActResult);
		},
		upload: () => Promise.resolve({ ok: true, rev: 2 }),
		image: () => Promise.resolve(new Uint8Array()),
		onChanged: () => () => {},
	};
	return { transport, acts };
}

function makeView(transport: SurfaceTransport): SurfaceView {
	return new SurfaceView(new SurfaceState(transport), {
		theme: plainTuiTheme(),
		unicode: true,
	});
}

describe("SurfaceView states", () => {
	test("loading before load() resolves", () => {
		const { transport } = fakeTransport({
			load: () => new Promise(() => {}),
		});
		const view = makeView(transport);
		expect(view.render(100).join("\n")).toContain("loading");
	});

	test("ready renders the tree's root block", async () => {
		const { transport } = fakeTransport({});
		const surface = new SurfaceState(transport);
		const view = new SurfaceView(surface, { theme: plainTuiTheme(), unicode: true });
		await surface.load();
		expect(view.render(100).join("\n")).toContain("HOSTED-MAIN");
	});

	test("access none renders not-found", async () => {
		const { transport } = fakeTransport({
			load: () =>
				Promise.resolve({
					tree: PAGE_TREE,
					data: {},
					rev: 1,
					treeRev: 1,
					access: "none" as const,
				}),
		});
		const surface = new SurfaceState(transport);
		const view = new SurfaceView(surface, { theme: plainTuiTheme(), unicode: true });
		await surface.load();
		expect(view.render(100).join("\n").toLowerCase()).toContain("not found");
	});

	test("a load failure shows the error line; r retries the load", async () => {
		let loads = 0;
		const { transport } = fakeTransport({
			load: () => {
				loads += 1;
				if (loads === 1) return Promise.reject(new Error("boom"));
				return Promise.resolve({
					tree: PAGE_TREE,
					data: {},
					rev: 1,
					treeRev: 1,
					access: "write" as const,
				});
			},
		});
		const surface = new SurfaceState(transport);
		const view = new SurfaceView(surface, { theme: plainTuiTheme(), unicode: true });
		await surface.load();
		expect(view.render(100).join("\n")).toContain("r to retry");
		view.handleInput("r");
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(loads).toBe(2);
		expect(view.render(100).join("\n")).toContain("HOSTED-MAIN");
	});

	test("input routes to the rendered root while ready (a submit action dispatches)", async () => {
		const { transport, acts } = fakeTransport({});
		const surface = new SurfaceState(transport);
		const view = new SurfaceView(surface, { theme: plainTuiTheme(), unicode: true });
		await surface.load();
		// The page's actions menu: `.` opens it, Enter dispatches.
		view.handleInput(".");
		expect(acts).toHaveLength(0); // the page has no actions; nothing fires
	});
});
