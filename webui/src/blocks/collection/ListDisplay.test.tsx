/**
 * The list display (UI-blocks U1 Task 3, spec §5.5): group headings in
 * `groups` order, nested `children` indent, `numbered`, `checkable`
 * toggles dispatching `onCheck` with `{itemId, value}`, quiet items
 * folded behind "N more", multi-select bulk actions (a `form` action
 * opens the form and dispatches `{ids, values}`), and view-only state
 * surviving a data update.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import type { CollectionBlock, JsonObject } from "@sigrun/shared/blocks";
import { render, textContent } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { CollectionBlockView } from "./Collection";

/** The dispatch spy + write-access provider. */
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

/** Render a collection block with surface data. */
function renderCollection(
	block: CollectionBlock,
	data: JsonObject,
): { renderer: ReturnType<typeof render>; dispatch: ReturnType<typeof vi.fn> } {
	const { dispatch, provider } = makeActions();
	const renderer = render(
		h(SurfaceDataContext.Provider, {
			value: { data, locale: "en-US" },
		}, provider(h(CollectionBlockView, { block }))),
	);
	return { renderer, dispatch };
}

const title = { $: "./title" } as const;

describe("list display (spec §5.5)", () => {
	test("renders group headings in `groups` order", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title },
			display: "list",
			groupBy: "state",
			groups: [
				{ id: "doing", title: "Doing" },
				{ id: "todo", title: "To do" },
			],
		};
		const { renderer } = renderCollection(block, {
			tasks: [
				{ id: "t1", title: "Later", state: "todo" },
				{ id: "t2", title: "Now", state: "doing" },
			],
		});
		const text = textContent(renderer.toJSON());
		// "Doing" (first group) comes before "To do" even though the todo
		// item arrives first.
		expect(text.indexOf("Doing")).toBeLessThan(text.indexOf("To do"));
		expect(text.indexOf("Now")).toBeLessThan(text.indexOf("Later"));
	});

	test("nested `children` indent (depth grows per level)", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title },
			display: "list",
			children: "sub",
		};
		const { renderer } = renderCollection(block, {
			tasks: [
				{
					id: "t1",
					title: "Parent",
					sub: [{ id: "t1a", title: "Child", sub: [{ id: "t1a1", title: "Grand" }] }],
				},
			],
		});
		const json = JSON.stringify(renderer.toJSON());
		expect(json).toContain('"data-depth":0');
		expect(json).toContain('"data-depth":1');
		expect(json).toContain('"data-depth":2');
		expect(textContent(renderer.toJSON())).toContain("Grand");
	});

	test("numbered lists number rows", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title },
			display: "list",
			numbered: true,
		};
		const { renderer } = renderCollection(block, {
			tasks: [
				{ id: "a", title: "Alpha" },
				{ id: "b", title: "Beta" },
			],
		});
		const numbers = renderer.root
			.findAll((node) => node.props.className === "blk-list-number")
			.map((node) => {
				let text = "";
				for (const child of node.children) {
					if (typeof child === "string") text += child;
				}
				return text;
			});
		expect(numbers).toEqual(["1", "2"]);
	});

	test("checkable toggles dispatch onCheck edit with {itemId, value}", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title },
			display: "list",
			checkable: "done",
			onCheck: "setDone",
		};
		const { renderer, dispatch } = renderCollection(block, {
			tasks: [{ id: "t1", title: "Alpha", done: false }],
		});
		const box = renderer.root.find(
			(node) => node.type === "input" && node.props.className === "blk-check",
		);
		expect(box.props.checked).toBe(false);
		act(() => {
			box.props.onChange();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "edit", name: "setDone" },
			{ itemId: "t1", value: true },
		);
	});

	test("quiet items fold behind 'N more', then expand", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title, quiet: { $: "./quiet" } },
			display: "list",
		};
		const { renderer } = renderCollection(block, {
			tasks: [
				{ id: "t1", title: "Loud one", quiet: false },
				{ id: "t2", title: "Quiet one", quiet: true },
				{ id: "t3", title: "Quiet two", quiet: true },
			],
		});
		let text = textContent(renderer.toJSON());
		expect(text).toContain("Loud one");
		expect(text).not.toContain("Quiet one");
		expect(text).toContain("2 more");
		const toggle = renderer.root.find(
			(node) => node.props.className === "blk-quiet-toggle",
		);
		act(() => {
			toggle.props.onClick();
		});
		text = textContent(renderer.toJSON());
		expect(text).toContain("Quiet one");
		expect(text).toContain("Quiet two");
	});

	test("multi-select shows bulkActions; a form action dispatches {ids, values}", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title },
			display: "list",
			select: "multi",
			bulkActions: [
				{ id: "ping", label: "Ping", onSubmit: "onPing" },
				{
					id: "setState",
					label: "Set state",
					onSubmit: "onSetState",
					// SAFETY: the fixture's Tree shape is minimal (Task 5 owns
					// forms); the inline bulk form only reads top-level field
					// `name`s, so the cast pins the narrow shape the code reads.
					form: {
						type: "form",
						bind: "/view/bulk",
						mode: "submit",
						children: [{ type: "text", name: "state", label: "State" }],
					} as unknown as NonNullable<
						NonNullable<CollectionBlock["bulkActions"]>[number]["form"]
					>,
				},
			],
		};
		const { renderer, dispatch } = renderCollection(block, {
			tasks: [
				{ id: "t1", title: "Alpha" },
				{ id: "t2", title: "Beta" },
			],
		});
		// No selection yet: no bulk bar.
		expect(
			renderer.root.findAll((node) => node.props.className === "blk-bulk").length,
		).toBe(0);
		// Select both items.
		const boxes = renderer.root.findAll(
			(node) => node.type === "input" && node.props.className === "blk-select",
		);
		act(() => {
			boxes[0].props.onChange();
			boxes[1].props.onChange();
		});
		// The no-form bulk action dispatches {ids}.
		const ping = renderer.root.find(
			(node) =>
				node.type === "button" &&
				node.props.className === "blk-bulk-action" &&
				textOf(node) === "Ping",
		);
		act(() => {
			ping.props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "onPing" },
			{ ids: ["t1", "t2"], values: {} },
		);
		// The form action opens the form; submitting dispatches {ids, values}.
		const setState = renderer.root.find(
			(node) =>
				node.type === "button" &&
				node.props.className === "blk-bulk-action" &&
				textOf(node) === "Set state",
		);
		act(() => {
			setState.props.onClick();
		});
		const input = renderer.root.find(
			(node) => node.type === "input" && node.props.name === "state",
		);
		act(() => {
			input.props.onChange({ target: { value: "closed" } });
		});
		const form = renderer.root.find(
			(node) => node.type === "form" && node.props.className === "blk-bulk-form",
		);
		act(() => {
			form.props.onSubmit({ preventDefault: () => {} });
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "onSetState" },
			{ ids: ["t1", "t2"], values: { state: "closed" } },
		);
	});

	test("a card action dispatches WITHOUT firing onActivate", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: {
				title,
				actions: [
					{ id: "act", label: "Do it", action: { type: "submit", name: "onDo" } },
				],
			},
			display: "list",
			onActivate: { type: "navigate", params: { view: "item" } },
		};
		const { renderer, dispatch } = renderCollection(block, {
			tasks: [{ id: "t1", title: "Alpha" }],
		});
		const actionButton = renderer.root.find(
			(node) => node.type === "button" && textOf(node) === "Do it",
		);
		// The click stops propagation at the card-actions container, so the
		// row's onActivate never fires — only the action dispatches.
		act(() => {
			actionButton.props.onClick({ stopPropagation: () => {} });
		});
		expect(dispatch).toHaveBeenCalledWith({ type: "submit", name: "onDo" }, null);
		expect(
			dispatch.mock.calls.some(
				(call) => (call[0] as { type: string }).type === "navigate",
			),
		).toBe(false);
	});

	test("a collapsed group hides its rows behind the heading", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title },
			display: "list",
			groupBy: "state",
			groups: [
				{ id: "doing", title: "Doing" },
				{ id: "done", title: "Done", collapsed: true },
			],
		};
		const { renderer } = renderCollection(block, {
			tasks: [
				{ id: "t1", title: "Open one", state: "doing" },
				{ id: "t2", title: "Finished one", state: "done" },
			],
		});
		let text = textContent(renderer.toJSON());
		expect(text).toContain("Done"); // heading shows
		expect(text).not.toContain("Finished one"); // rows hidden
		// Click the collapsed heading to unfold.
		const heading = renderer.root.findAll(
			(node) => node.props.className === "blk-list-heading" && textOf(node) === "Done",
		)[0];
		act(() => {
			heading.props.onClick();
		});
		text = textContent(renderer.toJSON());
		expect(text).toContain("Finished one");
	});

	test("view-only state (selection) survives a data update", () => {
		const block: CollectionBlock = {
			type: "collection",
			items: { $: "/tasks" },
			item: { title },
			display: "list",
			select: "multi",
		};
		const { dispatch, provider } = makeActions();
		const element = (data: JsonObject): ReactElement =>
			h(SurfaceDataContext.Provider, {
				value: { data, locale: "en-US" },
			}, provider(h(CollectionBlockView, { block })));
		const renderer = render(element({ tasks: [{ id: "t1", title: "Alpha" }] }));
		const box = renderer.root.find(
			(node) => node.type === "input" && node.props.className === "blk-select",
		);
		act(() => {
			box.props.onChange();
		});
		expect(
			renderer.root.find(
				(node) => node.type === "input" && node.props.className === "blk-select",
			).props.checked,
		).toBe(true);
		// A data update (new items array) keeps the selection.
		act(() => {
			renderer.update(
				element({
					tasks: [
						{ id: "t1", title: "Alpha v2" },
						{ id: "t2", title: "Beta" },
					],
				}),
			);
		});
		const boxes = renderer.root.findAll(
			(node) => node.type === "input" && node.props.className === "blk-select",
		);
		expect(boxes[0].props.checked).toBe(true);
		expect(boxes[1].props.checked).toBe(false);
		void dispatch;
	});
});

/** All text under a found test instance. */
function textOf(node: { readonly children: readonly unknown[] }): string {
	let text = "";
	for (const child of node.children) {
		text += typeof child === "string" ? child : textOf(child as typeof node);
	}
	return text;
}
