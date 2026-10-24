/**
 * BlockView (UI-blocks U1 Task 1): the block-set renderer core — one
 * component per block dispatched on `block.type`, bindings resolved
 * through the `SurfaceData` context, actions dispatched through
 * `SurfaceActions`. This suite pins the renderer's core behaviours:
 * every Task-1 gallery fixture renders; bindings resolve (missing paths
 * render empty); `formatValue` shapes stat values; unknown blocks render
 * the fallback + "Not supported in this client"; columns stack when the
 * minimums don't fit; action buttons hide under `access: "read"`; a
 * `confirm` action opens a dialog and cancelling dispatches nothing;
 * `copy` writes the clipboard with no dispatch; `open` opens only
 * allowed schemes; and RTL text slots carry `dir="auto"`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Block, JsonObject, JsonValue } from "@sigrun/shared/blocks";
import { render, stubClipboard, textContent } from "../test-utils";
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
function makeActions(
	access: "read" | "write",
): {
	dispatch: ReturnType<typeof vi.fn>;
	provider(children: ReactNode): ReactElement;
} {
	const dispatch = vi.fn();
	return {
		dispatch,
		provider: (children): ReactElement =>
			h(SurfaceActionsContext.Provider, {
				value: { dispatch, access, viewState: {} as JsonObject },
			}, children),
	};
}

/** Render `block` with surface data and a dispatch spy (write access). */
function renderBlock(
	block: Block,
	init?: { readonly data?: JsonObject; readonly item?: JsonValue },
): {
	renderer: ReturnType<typeof render>;
	dispatch: ReturnType<typeof vi.fn>;
} {
	const { dispatch, provider } = makeActions("write");
	const renderer = render(
		h(SurfaceDataContext.Provider, {
			value: {
				data: init?.data ?? {},
				...(init?.item === undefined ? {} : { item: init.item }),
				locale: "en-US",
			},
		}, provider(h(BlockView, { block }))),
	);
	return { renderer, dispatch };
}

/** Render `block` inside a `ContainerWidth` measured at `rem` rem. */
function renderBlockInWidth(
	block: Block,
	rem: number,
	init?: { readonly data?: JsonObject; readonly item?: JsonValue },
): {
	renderer: ReturnType<typeof render>;
	dispatch: ReturnType<typeof vi.fn>;
} {
	const { dispatch, provider } = makeActions("write");
	const renderer = render(
		h(SurfaceDataContext.Provider, {
			value: {
				data: init?.data ?? {},
				...(init?.item === undefined ? {} : { item: init.item }),
				locale: "en-US",
			},
		}, provider(h(ContainerWidth, null, h(BlockView, { block })))),
	);
	act(() => {
		fireWidth?.(rem * 16);
	});
	return { renderer, dispatch };
}

afterEach(() => {
	fireWidth = undefined;
	vi.unstubAllGlobals();
});

// ─── the gallery fixtures render (test/fixtures/blocks, U0 Task 2) ────────

/** The Task-1 block types (Tasks 2–5 own the rest of the corpus). */
const TASK1_TYPES: ReadonlySet<string> = new Set([
	"stack", "columns", "grid", "section",
	"markdown", "fields", "stat", "callout", "image", "diff", "details",
]);

/** The Task-1 fixtures from the U0 gallery corpus itself (the single
 *  source — the webui never carries drifting copies). */
const FIXTURES: readonly [name: string, block: Block][] = SAMPLES
	.filter(({ tree }) => TASK1_TYPES.has(tree.root.type))
	.map(({ name, tree }) => [name, tree.root]);

describe("BlockView: gallery fixtures render", () => {
	for (const [name, block] of FIXTURES) {
		test(`fixture ${name} renders without error`, () => {
			const { renderer } = renderBlock(block, {
				data: { latency: 42, disk: 0.7 },
			});
			// Renders a non-empty tree without throwing.
			expect(renderer.toJSON()).not.toBeNull();
			renderer.unmount();
		});
	}
});

// ─── bindings and formats ─────────────────────────────────────────────────

describe("BlockView: bindings", () => {
	test("a stat binding resolves against surface data", () => {
		const { renderer } = renderBlock(
			{ type: "stat", label: "Latency", value: { $: "/latency" }, unit: "ms" },
			{ data: { latency: 42 } },
		);
		expect(textContent(renderer.toJSON())).toContain("42");
		renderer.unmount();
	});

	test("a binding to a missing path renders empty, never an error", () => {
		const { renderer } = renderBlock(
			{ type: "stat", label: "Latency", value: { $: "/missing" } },
		);
		const json = renderer.toJSON();
		expect(json).not.toBeNull();
		expect(textContent(json)).toContain("Latency");
		renderer.unmount();
	});
});

describe("BlockView: stat formats", () => {
	test("format bytes shows 1.5 KB", () => {
		const { renderer } = renderBlock(
			{ type: "stat", label: "Size", value: 1536, format: "bytes" },
		);
		expect(textContent(renderer.toJSON())).toContain("1.5 KB");
		renderer.unmount();
	});
});

// ─── unknown blocks (spec §4.4) ───────────────────────────────────────────

describe("BlockView: unknown block types", () => {
	test("an unknown type renders fallback text plus the notice", () => {
		const { renderer } = renderBlock({
			type: "hologram",
			fallback: "a 3d projection of acme",
		} as unknown as Block);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("a 3d projection of acme");
		expect(text).toContain("Not supported in this client");
		renderer.unmount();
	});

	test("an unknown type without fallback still shows the notice", () => {
		const { renderer } = renderBlock({
			type: "hologram",
		} as unknown as Block);
		expect(textContent(renderer.toJSON())).toContain("Not supported in this client");
		renderer.unmount();
	});
});

// ─── columns stacking (spec §12.3) ────────────────────────────────────────

describe("BlockView: columns", () => {
	test("stacks when the sum of minWidths exceeds the container", () => {
		// s+m = 16+24 = 40 rem minimum vs a 30 rem container: stacked.
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const { renderer } = renderBlockInWidth(
			{ type: "columns", children: [
				{ minWidth: "s", block: { type: "markdown", text: "left" } },
				{ minWidth: "m", block: { type: "markdown", text: "right" } },
			] },
			30,
		);
		const columns = renderer.root.findByProps({ "data-block": "columns" });
		expect(columns.props["data-stacked"]).toBe(true);
		renderer.unmount();
	});

	test("side by side when the minimums fit", () => {
		// s+m = 40 rem minimum vs a 50 rem container: columns.
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const { renderer } = renderBlockInWidth(
			{ type: "columns", children: [
				{ minWidth: "s", block: { type: "markdown", text: "left" } },
				{ minWidth: "m", block: { type: "markdown", text: "right" } },
			] },
			50,
		);
		const columns = renderer.root.findByProps({ "data-block": "columns" });
		expect(columns.props["data-stacked"]).toBe(false);
		renderer.unmount();
	});

	test("weights ride the flex style when side by side", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const { renderer } = renderBlockInWidth({ type: "columns", children: [
			{ weight: 2, block: { type: "markdown", text: "left" } },
			{ weight: 1, block: { type: "markdown", text: "right" } },
		] }, 50);
		const grow = renderer.root
			.findByProps({ "data-block": "columns" })
			.findAllByType("div")
			.map((div) => (div.props.style as { flexGrow?: number } | undefined)?.flexGrow);
		expect(grow).toContain(2);
		expect(grow).toContain(1);
		renderer.unmount();
	});
});

// ─── section ──────────────────────────────────────────────────────────────

describe("BlockView: section", () => {
	test("renders title, subtitle and children", () => {
		const { renderer } = renderBlock({ type: "section", title: "Group", subtitle: "sub", children: [
			{ type: "markdown", text: "inside" },
		] });
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Group");
		expect(text).toContain("sub");
		expect(text).toContain("inside");
		renderer.unmount();
	});

	test("collapsible toggles the children", () => {
		const { renderer } = renderBlock({ type: "section", title: "Group", collapsible: true, collapsed: false, children: [
			{ type: "markdown", text: "inside" },
		] });
		expect(textContent(renderer.toJSON())).toContain("inside");
		const toggle = renderer.root.findByProps({ "aria-expanded": true });
		act(() => {
			toggle.props.onClick();
		});
		expect(textContent(renderer.toJSON())).not.toContain("inside");
		expect(renderer.root.findByProps({ "aria-expanded": false })).toBeTruthy();
		renderer.unmount();
	});

	test("collapsed by default when collapsed: true", () => {
		const { renderer } = renderBlock({ type: "section", title: "Group", collapsible: true, collapsed: true, children: [
			{ type: "markdown", text: "inside" },
		] });
		expect(textContent(renderer.toJSON())).not.toContain("inside");
		renderer.unmount();
	});
});

// ─── content blocks ───────────────────────────────────────────────────────

describe("BlockView: markdown", () => {
	test("renders markdown text through the chat renderer", () => {
		const { renderer } = renderBlock(
			{ type: "markdown", text: "acme **bold** [link](https://example.invalid/x)" },
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("bold");
		expect(text).toContain("link");
		const link = renderer.root.findByType("a");
		expect(link.props.href).toBe("https://example.invalid/x");
		renderer.unmount();
	});

	test("a disallowed scheme renders as text, not a link", () => {
		const { renderer } = renderBlock(
			{ type: "markdown", text: "call [tel:123](tel:123) or [javascript:x](javascript:x)" },
		);
		expect(renderer.root.findAllByType("a")).toHaveLength(0);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("tel:123");
		expect(text).toContain("javascript:x");
		renderer.unmount();
	});
});

describe("BlockView: fields", () => {
	test("renders each label/value row with tone and icon", () => {
		const { renderer } = renderBlock({ type: "fields", rows: [
			{ label: "Host", value: "acme.example" },
			{ label: "Errors", value: 2, tone: "bad", icon: "error" },
		] });
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Host");
		expect(text).toContain("acme.example");
		expect(text).toContain("Errors");
		expect(text).toContain("2");
		const rows = renderer.root.findAllByProps({ "data-tone": "bad" });
		expect(rows).toHaveLength(1);
		expect(renderer.root.findAllByType("svg").length).toBeGreaterThan(0);
		renderer.unmount();
	});

	test("a bound rows array resolves against surface data", () => {
		const { renderer } = renderBlock(
			{ type: "fields", rows: { $: "/rows" } },
			{ data: { rows: [{ label: "Bound", value: "yes" }] } },
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Bound");
		expect(text).toContain("yes");
		renderer.unmount();
	});
});

describe("BlockView: stat", () => {
	test("renders label, value, unit and caption", () => {
		const { renderer } = renderBlock(
			{ type: "stat", label: "Latency", value: 42, unit: "ms", caption: "p95" },
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Latency");
		expect(text).toContain("42");
		expect(text).toContain("ms");
		expect(text).toContain("p95");
		renderer.unmount();
	});

	test("a sparkline renders an svg path", () => {
		const { renderer } = renderBlock(
			{ type: "stat", label: "L", value: 1, sparkline: [1, 2, 3] },
		);
		expect(
			renderer.root.findAllByType("path").filter((p) =>
				String(p.props.d ?? "").includes("M"),
			).length,
		).toBeGreaterThan(0);
		renderer.unmount();
	});

	test("size rides the data-size attribute", () => {
		const { renderer } = renderBlock(
			{ type: "stat", label: "L", value: 1, size: "l" },
		);
		expect(
			renderer.root.findByProps({ "data-block": "stat" }).props["data-size"],
		).toBe("l");
		renderer.unmount();
	});
});

describe("BlockView: callout", () => {
	test("renders tone, title, body and its action buttons", () => {
		const { renderer } = renderBlock({ type: "callout", id: "callout", tone: "warn", title: "Degraded", body: "acme upstream is slow", actions: [
			{ id: "open", label: "Open console", icon: "external", action: { type: "open", url: "https://example.invalid/console" } },
		] });
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Degraded");
		expect(text).toContain("acme upstream is slow");
		expect(
			renderer.root.findByProps({ "data-block": "callout" }).props["data-tone"],
		).toBe("warn");
		const buttons = renderer.root.findAllByType("button");
		expect(buttons.map((b) => textContentOf(b))).toContain("Open console");
		renderer.unmount();
	});
});

describe("BlockView: image", () => {
	test("renders src and alt; a broken load shows the alt text", () => {
		const { renderer } = renderBlock(
			{ type: "image", src: "asset:acme/diagram.png", alt: "acme cluster diagram" },
		);
		const img = renderer.root.findByType("img");
		expect(img.props.src).toBe("asset:acme/diagram.png");
		expect(img.props.alt).toBe("acme cluster diagram");
		act(() => {
			img.props.onError();
		});
		expect(textContent(renderer.toJSON())).toContain("acme cluster diagram");
		renderer.unmount();
	});
});

describe("BlockView: diff", () => {
	test("renders before and after with the path", () => {
		const { renderer } = renderBlock(
			{ type: "diff", before: "const a = 1;", after: "const a = 2;", path: "src/acme.ts" },
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("const a = 1;");
		expect(text).toContain("const a = 2;");
		expect(text).toContain("src/acme.ts");
		renderer.unmount();
	});
});

describe("BlockView: details", () => {
	test("renders collapsed; expanding pretty-prints the JSON", () => {
		const { renderer } = renderBlock(
			{ type: "details", value: { host: "acme.example" } },
		);
		const summary = renderer.root.findByType("summary");
		act(() => {
			summary.props.onClick({ preventDefault: () => {} });
		});
		expect(textContent(renderer.toJSON())).toContain("acme.example");
		renderer.unmount();
	});
});

// ─── actions (spec §6.1/§6.2) ─────────────────────────────────────────────

describe("BlockView: actions", () => {
	test("a callout action button dispatches its action", () => {
		const { renderer, dispatch } = renderBlock({ type: "callout", id: "callout", tone: "info", title: "T", actions: [
			{ id: "a1", label: "Do it", action: { type: "edit", name: "doIt" } },
		] });
		act(() => {
			findByLabel(renderer, "Do it").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "edit", name: "doIt" },
			null,
		);
		renderer.unmount();
	});

	test("access read hides callout action buttons", () => {
		const { dispatch, provider } = makeActions("read");
		const renderer = render(
			h(SurfaceDataContext.Provider, { value: { data: {}, locale: "en-US" } },
				provider(h(BlockView, { block: { type: "callout", id: "callout", tone: "info", title: "T", actions: [
					{ id: "a1", label: "Do it", action: { type: "edit", name: "doIt" } },
				] } }))),
		);
		expect(renderer.root.findAllByType("button")).toHaveLength(0);
		expect(dispatch).not.toHaveBeenCalled();
		renderer.unmount();
	});

	test("a confirm action opens a dialog with title, body and confirmLabel; cancel dispatches nothing", () => {
		const { renderer, dispatch } = renderBlock({ type: "callout", id: "callout", tone: "bad", title: "T", actions: [
			{ id: "a1", label: "Delete", action: { type: "submit", name: "del", confirm: {
				title: "Delete acme?",
				body: "This removes the acme record.",
				confirmLabel: "Delete forever",
			} } },
		] });
		act(() => {
			findByLabel(renderer, "Delete").props.onClick();
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Delete acme?");
		expect(text).toContain("This removes the acme record.");
		expect(dispatch).not.toHaveBeenCalled();
		// Cancel dismisses the dialog without dispatching.
		act(() => {
			findByLabel(renderer, "Cancel").props.onClick();
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).not.toContain("Delete acme?");
		renderer.unmount();
	});

	test("confirming in the dialog dispatches the action", () => {
		const { renderer, dispatch } = renderBlock({ type: "callout", id: "callout", tone: "bad", title: "T", actions: [
			{ id: "a1", label: "Delete", action: { type: "submit", name: "del", confirm: {
				title: "Delete acme?",
			} } },
		] });
		act(() => {
			findByLabel(renderer, "Delete").props.onClick();
		});
		act(() => {
			// No `confirmLabel` on this confirm: the default label is used.
			findByLabel(renderer, "Confirm").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "del", confirm: expect.anything() },
			null,
		);
		renderer.unmount();
	});

	test("copy writes the clipboard with no dispatch", () => {
		const writeText = stubClipboard();
		const { renderer, dispatch } = renderBlock({ type: "callout", id: "callout", tone: "info", title: "T", actions: [
			{ id: "copy", label: "Copy id", action: { type: "copy", text: "acme-42" } },
		] });
		act(() => {
			findByLabel(renderer, "Copy id").props.onClick();
		});
		expect(writeText).toHaveBeenCalledWith("acme-42");
		expect(dispatch).not.toHaveBeenCalled();
		renderer.unmount();
	});

	test("open opens a new tab for https; a javascript url opens nothing", () => {
		const open = vi.fn();
		vi.stubGlobal("open", open);
		const { renderer } = renderBlock({ type: "callout", id: "callout", tone: "info", title: "T", actions: [
			{ id: "ok", label: "Open console", action: { type: "open", url: "https://example.invalid/console" } },
			{ id: "bad", label: "Bad open", action: { type: "open", url: "javascript:x" } },
		] });
		act(() => {
			findByLabel(renderer, "Open console").props.onClick();
		});
		expect(open).toHaveBeenCalledWith("https://example.invalid/console", "_blank", "noopener");
		act(() => {
			findByLabel(renderer, "Bad open").props.onClick();
		});
		expect(open).toHaveBeenCalledTimes(1);
		renderer.unmount();
	});
});

// ─── RTL text slots (review focus 5) ──────────────────────────────────────

describe("BlockView: dir=auto text slots", () => {
	test("markdown text and section titles carry dir=auto", () => {
		const { renderer } = renderBlock({ type: "section", title: "כותרת", children: [
			{ type: "markdown", text: "شكرا" },
		] });
		const autos = renderer.root
			.findAll((node) => node.props?.dir === "auto");
		expect(autos.length).toBeGreaterThanOrEqual(2);
		renderer.unmount();
	});
});

// ─── helpers ──────────────────────────────────────────────────────────────

/** The visible text under a rendered test instance (recursive — button
 *  labels live inside spans). */
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

/** The button whose visible label is exactly `label`; its click handler is non-null. */
function findByLabel(
	renderer: ReturnType<typeof render>,
	label: string,
): { props: { onClick: () => void } } {
	const matches = renderer.root
		.findAllByType("button")
		.filter((button) => textContentOf(button) === label);
	if (matches.length !== 1) {
		throw new Error(`expected one "${label}" button, found ${matches.length}`);
	}
	const onClick = matches[0]!.props.onClick;
	if (typeof onClick !== "function") {
		throw new Error(`button "${label}" has no onClick handler`);
	}
	return { props: { onClick } };
}
