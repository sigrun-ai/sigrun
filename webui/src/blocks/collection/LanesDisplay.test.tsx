/**
 * The lanes display (UI-blocks U1 Task 4, spec §5.5/§12.3/§12.4): lanes
 * side by side in regular width with pointer-drag across lanes; compact
 * shows one lane plus a switcher and a "Move to…" action menu; keyboard
 * `m`/`→`/`↓`/`Enter`/`Esc` drives the same move payload.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CollectionBlock, JsonObject } from "@sigrun/shared/blocks";
import { render, textContent } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { ContainerWidth } from "../width";
import { CollectionBlockView } from "./Collection";

// A fake ResizeObserver drives the width class (width.test.tsx's pattern).
let fire: ((widthPx: number) => void) | undefined;
class FakeResizeObserver {
	constructor(
		callback: (entries: readonly { readonly contentRect: { readonly width: number } }[]) => void,
	) {
		fire = (widthPx: number): void => {
			callback([{ contentRect: { width: widthPx } }]);
		};
	}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

afterEach(() => {
	fire = undefined;
	vi.unstubAllGlobals();
});

function makeActions(access: "read" | "write" = "write"): {
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

/** Render a lanes collection, optionally inside a measuring width. */
function renderLanes(
	block: CollectionBlock,
	data: JsonObject,
	widthPx?: number,
): { renderer: ReturnType<typeof render>; dispatch: ReturnType<typeof vi.fn> } {
	vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	const { dispatch, provider } = makeActions();
	const inner = h(SurfaceDataContext.Provider, {
		value: { data, locale: "en-US" },
	}, provider(h(CollectionBlockView, { block })));
	const renderer = render(
		widthPx === undefined ? inner : h(ContainerWidth, null, inner),
	);
	if (widthPx !== undefined && fire !== undefined) {
		act(() => fire?.(widthPx));
	}
	return { renderer, dispatch };
}

const title = { $: "./title" } as const;

function lanesBlock(extra?: Partial<CollectionBlock>): CollectionBlock {
	return {
		type: "collection",
		items: { $: "/tasks" },
		item: { title },
		display: "lanes",
		groupBy: "state",
		groups: [
			{ id: "todo", title: "To do" },
			{ id: "doing", title: "Doing" },
		],
		onMove: "onMove",
		...extra,
	};
}

function tasks(...rows: readonly [string, string][]): JsonObject {
	return {
		tasks: rows.map(([id, state]) => ({ id, state, title: `Task ${id}` })),
	};
}

/** Find lanes root JSON (assertion helper). */
function lanesJson(renderer: ReturnType<typeof render>): string {
	return JSON.stringify(renderer.toJSON());
}

describe("lanes display (spec §5.5/§12.3/§12.4)", () => {
	test("renders lanes side by side in regular width, grouped by groupBy", () => {
		const { renderer } = renderLanes(
			lanesBlock(),
			tasks(["a", "todo"], ["b", "doing"], ["c", "todo"]),
			60 * 16,
		);
		const json = lanesRoot(renderer);
		expect(json).toContain('"data-display":"lanes"');
		expect(json).toContain('"data-layout":"side-by-side"');
		const text = textContent(renderer.toJSON());
		expect(text).toContain("To do");
		expect(text).toContain("Doing");
		expect(text).toContain("Task a");
		expect(text).toContain("Task b");
		expect(text).toContain("Task c");
	});

	test("pointer drag across lanes dispatches move {itemId, from, to}", () => {
		// No layout in the test env: stub document.elementFromPoint so the
		// release point resolves to lane "doing" index 1 (the drop-target
		// attributes the rendered lane carries).
		vi.stubGlobal("document", {
			elementFromPoint: () => ({
				closest: (selector: string) =>
					selector === "[data-drop-group][data-drop-index]"
						? {
								getAttribute: (name: string) =>
									name === "data-drop-group"
										? "doing"
										: name === "data-drop-index"
											? "1"
											: null,
							}
						: null,
			}),
		});
		const { renderer, dispatch } = renderLanes(
			lanesBlock(),
			tasks(["a", "todo"], ["b", "doing"]),
			60 * 16,
		);
		const card = renderer.root.find(
			(node) =>
				node.props["data-drag-item"] === "a" &&
				typeof node.props.onPointerDown === "function",
		);
		const release = { pointerId: 1, clientX: 10, clientY: 10 };
		act(() => {
			card.props.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0 });
			card.props.onPointerUp(release);
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "move", name: "onMove" },
			{
				itemId: "a",
				from: { group: "todo", index: 0 },
				to: { group: "doing", index: 1 },
			},
		);
	});

	test("a pointerup released over a DIFFERENT element still completes the drop (pointer capture)", () => {
		vi.stubGlobal("document", {
			elementFromPoint: () => ({
				closest: (selector: string) =>
					selector === "[data-drop-group][data-drop-index]"
						? {
								getAttribute: (name: string) =>
									name === "data-drop-group"
										? "doing"
										: name === "data-drop-index"
											? "0"
											: null,
							}
						: null,
			}),
		});
		const { renderer, dispatch } = renderLanes(
			lanesBlock(),
			tasks(["a", "todo"], ["b", "doing"]),
			60 * 16,
		);
		const card = renderer.root.find(
			(node) =>
				node.props["data-drag-item"] === "a" &&
				typeof node.props.onPointerDown === "function",
		);
		// The OTHER card's element (release outside the source card).
		const other = renderer.root.find(
			(node) =>
				node.props["data-drag-item"] === "b" &&
				typeof node.props.onPointerUp === "function",
		);
		const captured: { el?: unknown; pointerId?: number } = {};
		act(() => {
			card.props.onPointerDown({
				pointerId: 7,
				clientX: 0,
				clientY: 0,
				currentTarget: {
					setPointerCapture: (id: number) => {
						captured.pointerId = id;
					},
				},
			});
		});
		// Pointer capture was engaged on the source card.
		expect(captured.pointerId).toBe(7);
		// The pointer-up lands on a DIFFERENT element; the captured drag
		// still completes against the drop target under the point.
		act(() => {
			other.props.onPointerUp({ pointerId: 7, clientX: 10, clientY: 10 });
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "move", name: "onMove" },
			{
				itemId: "a",
				from: { group: "todo", index: 0 },
				to: { group: "doing", index: 0 },
			},
		);
	});

	test("a pointercancel clears the pending drag with no dispatch", () => {
		const { renderer, dispatch } = renderLanes(
			lanesBlock(),
			tasks(["a", "todo"], ["b", "doing"]),
			60 * 16,
		);
		const card = renderer.root.find(
			(node) =>
				node.props["data-drag-item"] === "a" &&
				typeof node.props.onPointerDown === "function",
		);
		const released: number[] = [];
		act(() => {
			card.props.onPointerDown({
				pointerId: 9,
				clientX: 0,
				clientY: 0,
				currentTarget: {
					setPointerCapture: () => undefined,
					releasePointerCapture: (id: number) => released.push(id),
				},
			});
		});
		act(() => {
			card.props.onPointerCancel({
				pointerId: 9,
				currentTarget: {
					releasePointerCapture: (id: number) => released.push(id),
				},
			});
		});
		expect(dispatch).not.toHaveBeenCalled();
		// Capture released on cancel.
		expect(released).toContain(9);
		// A later pointerup finds no pending drag.
		act(() => {
			card.props.onPointerUp({ pointerId: 9, clientX: 5, clientY: 5 });
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	test("compact width shows one lane with a switcher; the selected lane survives a width change across the boundary", () => {
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const { provider } = makeActions();
		const inner = h(SurfaceDataContext.Provider, {
			value: { data: tasks(["a", "todo"], ["b", "doing"]), locale: "en-US" },
		}, provider(h(CollectionBlockView, { block: lanesBlock() })));
		const renderer = render(h(ContainerWidth, null, inner));
		act(() => fire?.(20 * 16)); // compact
		let json = lanesJson(renderer);
		expect(json).toContain('"data-layout":"single"');
		// The lane switcher lists both lanes.
		const select = renderer.root.findByType("select");
		expect(textContent(renderer.toJSON())).toContain("To do");
		expect(select.props.value ?? select.props.defaultValue).toBe("todo");
		// Select the second lane.
		act(() => {
			select.props.onChange({ target: { value: "doing" } });
		});
		expect(textContent(renderer.toJSON())).toContain("Task b");
		// Review Focus 3: resize ACROSS the class boundary with the
		// switcher open — the selected lane is preserved.
		act(() => fire?.(60 * 16)); // regular
		act(() => fire?.(20 * 16)); // back to compact
		json = lanesJson(renderer);
		expect(json).toContain('"data-layout":"single"');
		const selectAfter = renderer.root.findByType("select");
		expect(selectAfter.props.value ?? selectAfter.props.defaultValue).toBe(
			"doing",
		);
		expect(textContent(renderer.toJSON())).toContain("Task b");
	});

	test('compact "Move to…" in the item action menu lists the OTHER groups and dispatches the move', () => {
		const { renderer, dispatch } = renderLanes(
			lanesBlock(),
			tasks(["a", "todo"], ["b", "doing"]),
			20 * 16,
		);
		// Item a (in todo) gets a Move to… menu offering "Doing".
		const menu = renderer.root.find(
			(node) =>
				node.props["aria-label"] === "Move to…" &&
				node.props["data-item"] === "a",
		);
		expect(menu.props["data-targets"]).toBe("doing");
		act(() => {
			menu.props.onClick();
		});
		// Clicking the menu dispatches the move into the other lane's end.
		const target = renderer.root.find(
			(node) =>
				node.props["data-move-target"] === "doing" &&
				node.props["data-item"] === "a",
		);
		act(() => {
			target.props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "move", name: "onMove" },
			{
				itemId: "a",
				from: { group: "todo", index: 0 },
				to: { group: "doing", index: 1 },
			},
		);
	});

	test("keyboard m / → / ↓ / Enter produces the same move payload as the pointer", () => {
		const { renderer, dispatch } = renderLanes(
			lanesBlock(),
			tasks(["a", "todo"], ["b", "doing"]),
			60 * 16,
		);
		const surface = renderer.root.find(
			(node) => node.props["data-display"] === "lanes",
		);
		act(() => {
			surface.props.onKeyDown({ key: "m", target: cardTarget("a") });
		});
		act(() => {
			surface.props.onKeyDown({ key: "ArrowRight", target: cardFor(surface, "a") });
		});
		act(() => {
			surface.props.onKeyDown({ key: "ArrowDown", target: cardFor(surface, "a") });
		});
		act(() => {
			surface.props.onKeyDown({ key: "Enter", target: cardFor(surface, "a") });
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "move", name: "onMove" },
			{
				itemId: "a",
				from: { group: "todo", index: 0 },
				to: { group: "doing", index: 1 },
			},
		);
	});

	test("Esc cancels the picked-up item with no dispatch", () => {
		const { renderer, dispatch } = renderLanes(
			lanesBlock(),
			tasks(["a", "todo"], ["b", "doing"]),
			60 * 16,
		);
		const surface = renderer.root.find(
			(node) => node.props["data-display"] === "lanes",
		);
		act(() => {
			surface.props.onKeyDown({ key: "m", target: cardTarget("a") });
		});
		act(() => {
			surface.props.onKeyDown({ key: "Esc", target: cardFor(surface, "a") });
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	test("read access disables dragging and the Move to… menu", () => {
		const readDispatch = vi.fn();
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		const renderer = render(
			h(ContainerWidth, null, h(SurfaceDataContext.Provider, {
				value: { data: tasks(["a", "todo"]), locale: "en-US" },
			}, h(SurfaceActionsContext.Provider, {
				value: { dispatch: readDispatch, access: "read", viewState: {} as JsonObject },
			}, h(CollectionBlockView, { block: lanesBlock() })))),
		);
		act(() => fire?.(20 * 16)); // compact, where Move to… would show
		const json = lanesJson(renderer);
		expect(json).not.toContain("Move to");
	});
});

/** The JSON of the rendered lanes root (assertion helper). */
function lanesRoot(renderer: ReturnType<typeof render>): string {
	return JSON.stringify(renderer.toJSON());
}

/** A fake event target naming an item (the keyboard handler reads
 *  the focused card's data-drag-item via closest; the test stub carries
 *  the item id directly). */
function cardTarget(itemId: string): { closest(selector: string): { getAttribute(name: string): string | null } | null } {
	return {
		closest: (selector: string) =>
			selector === "[data-drag-item]"
				? { getAttribute: (name: string) => (name === "data-drag-item" ? itemId : null) }
				: null,
	};
}

/** Same stub through the surface's card lookup (keyboard events carry
 *  their target; the fake satisfies the narrow read). */
function cardFor(
	_surface: unknown,
	itemId: string,
): { closest(selector: string): { getAttribute(name: string): string | null } | null } {
	return cardTarget(itemId);
}
