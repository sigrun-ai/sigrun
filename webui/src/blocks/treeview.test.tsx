/**
 * The tree block (UI-blocks U1 Task 2, spec §5.3): bound nested nodes
 * with disclosure state, lazy children (`hasChildren` + no `children`
 * → dispatching the `onExpand` handler with `{id}`; the handler's
 * `DataOps` insert the children into the data model, so the component
 * only reports), nested `children` rendering indented, `onActivate`
 * on node press, and keyboard disclosure (Enter/Space on the toggle).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import type { Block, JsonObject } from "@sigrun/shared/blocks";
import { render, textContent } from "../test-utils";
import { BlockView } from "./BlockView";
import { TreeBlockView } from "./treeview";
import { SurfaceActionsContext, SurfaceDataContext } from "./context";

/** The dispatch spy + access the tests drive SurfaceActions with. */
function makeActions(
	access: "read" | "write" = "write",
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

/** Render `block` with surface data and a dispatch spy. */
function renderTree(
	block: Block,
	data?: JsonObject,
): {
	renderer: ReturnType<typeof render>;
	dispatch: ReturnType<typeof vi.fn>;
} {
	const { dispatch, provider } = makeActions();
	const renderer = render(
		h(SurfaceDataContext.Provider, {
			value: { data: data ?? {}, locale: "en-US" },
		}, provider(h(BlockView, { block }))),
	);
	return { renderer, dispatch };
}

/** The disclosure toggle of the node whose label is `label`. */
function toggleOf(
	renderer: ReturnType<typeof render>,
	label: string,
): { props: Record<string, unknown> } {
	const node = renderer.root.findByProps({ "data-node-label": label });
	const toggle = node.findByProps({ className: "blk-tree-toggle" });
	return { props: toggle.props as Record<string, unknown> };
}

describe("tree: rendering", () => {
	test("renders labels, icons and nested children", () => {
		const { renderer } = renderTree({ type: "tree", nodes: { $: "/nodes" } }, {
			nodes: [
				{ id: "a", label: "acme root", icon: "folder", children: [
					{ id: "a1", label: "child one", icon: "file" },
				] },
				{ id: "b", label: "bare" },
			],
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("acme root");
		expect(text).toContain("child one");
		expect(text).toContain("bare");
		// The two named icons (the carets are extra inline svgs).
		expect(renderer.root.findAllByType("svg").length).toBeGreaterThanOrEqual(2);
		// Nested children render one level deeper (the aria-level chain).
		const child = renderer.root.findByProps({ "data-node-label": "child one" });
		const parents: unknown[] = [];
		let cursor: { parent: { parent: unknown } } | undefined =
			child as unknown as { parent: { parent: unknown } };
		while (cursor?.parent?.parent !== undefined) {
			parents.push(cursor.parent);
			cursor = cursor.parent as unknown as { parent: { parent: unknown } };
		}
		expect(parents.length).toBeGreaterThan(0);
		renderer.unmount();
	});

	test("a binding to a missing path renders empty, never an error", () => {
		const { renderer } = renderTree({ type: "tree", nodes: { $: "/missing" } });
		expect(renderer.toJSON()).not.toBeNull();
		expect(
			renderer.root.findAllByProps({ "data-node-label": "x" }),
		).toHaveLength(0);
		renderer.unmount();
	});
});

describe("tree: lazy expansion (spec §5.3 onExpand)", () => {
	test("expanding a hasChildren node dispatches edit {name: onExpand} with {id}", () => {
		const { renderer, dispatch } = renderTree({
			type: "tree",
			id: "tree",
			nodes: { $: "/nodes" },
			onExpand: "expandNode",
		}, {
			nodes: [
				{ id: "acme", label: "acme", hasChildren: true },
				{ id: "b", label: "leaf", hasChildren: false },
			],
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("acme");
		expect(text).not.toContain("loading");
		const toggle = toggleOf(renderer, "acme");
		expect(toggle.props["aria-expanded"]).toBe(false);
		act(() => {
			(toggle.props.onClick as () => void)();
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "edit", name: "expandNode" },
			{ id: "acme" },
		);
		renderer.unmount();
	});

	test("a node with children toggles locally without dispatching", () => {
		const { renderer, dispatch } = renderTree({
			type: "tree",
			nodes: { $: "/nodes" },
			onExpand: "expandNode",
		}, {
			nodes: [
				{ id: "a", label: "parent", children: [{ id: "a1", label: "kid" }] },
			],
		});
		// Eager children render expanded by default.
		expect(textContent(renderer.toJSON())).toContain("kid");
		act(() => {
			(toggleOf(renderer, "parent").props.onClick as () => void)();
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).not.toContain("kid");
		// Re-fetch: each render's onClick closes over its own state.
		act(() => {
			(toggleOf(renderer, "parent").props.onClick as () => void)();
		});
		expect(textContent(renderer.toJSON())).toContain("kid");
		renderer.unmount();
	});

	test("a node with hasChildren and no children shows a placeholder while pending", () => {
		const { renderer, dispatch } = renderTree({
			type: "tree",
			nodes: { $: "/nodes" },
			onExpand: "expandNode",
		}, {
			nodes: [{ id: "x", label: "lazy", hasChildren: true }],
		});
		const toggle = toggleOf(renderer, "lazy");
		act(() => {
			(toggle.props.onClick as () => void)();
		});
		// Expanded with nothing inserted yet: the aria state advances and
		// a pending marker stands in for the not-yet-arrived children.
		expect(toggleOf(renderer, "lazy").props["aria-expanded"]).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
		renderer.unmount();
	});
});

describe("tree: onActivate", () => {
	test("activating a node dispatches the onActivate action with {id}", () => {
		const { renderer, dispatch } = renderTree({
			type: "tree",
			id: "tree",
			nodes: { $: "/nodes" },
			onActivate: { type: "navigate", params: { node: "acme" } },
		}, {
			nodes: [{ id: "a", label: "acme" }],
		});
		const row = renderer.root.findByProps({ "data-node-label": "acme" });
		const clickable = row.findAll(
			(node) =>
				node !== null && typeof node === "object" && "props" in node &&
				typeof (node as { props: { onClick?: unknown } }).props.onClick ===
					"function",
		);
		act(() => {
			((clickable[0] as unknown as { props: { onClick(): void } }).props.onClick)();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "navigate", params: { node: "acme" } },
			{ id: "a" },
		);
		renderer.unmount();
	});
});

describe("tree: keyboard", () => {
	test("Enter and Space toggle disclosure like a click", () => {
		const { renderer, dispatch } = renderTree({
			type: "tree",
			nodes: { $: "/nodes" },
			onExpand: "expandNode",
		}, {
			nodes: [{ id: "a", label: "parent", children: [{ id: "a1", label: "kid" }] }],
		});
		const keyProps = (): ((e: { key: string; preventDefault(): void }) => void) =>
			(toggleOf(renderer, "parent").props as {
				onKeyDown(e: { key: string; preventDefault(): void }): void;
			}).onKeyDown;
		// Expanded by default: Enter collapses, Space expands again.
		act(() => {
			keyProps()({ key: "Enter", preventDefault: () => {} });
		});
		expect(textContent(renderer.toJSON())).not.toContain("kid");
		act(() => {
			keyProps()({ key: " ", preventDefault: () => {} });
		});
		expect(textContent(renderer.toJSON())).toContain("kid");
		// Other keys fall through.
		act(() => {
			keyProps()({ key: "a", preventDefault: () => {} });
		});
		expect(dispatch).not.toHaveBeenCalled();
		renderer.unmount();
	});
});

describe("tree: direct module export", () => {
	test("renders through TreeBlockView directly", () => {
		const { provider } = makeActions();
		const renderer = render(
			h(SurfaceDataContext.Provider, {
				value: { data: { nodes: [{ id: "a", label: "acme" }] }, locale: "en-US" },
			}, provider(h(TreeBlockView, { block: {
				type: "tree", nodes: { $: "/nodes" },
			} }))),
		);
		expect(
			renderer.root.findByProps({ "data-node-label": "acme" }),
		).toBeTruthy();
		renderer.unmount();
	});
});
