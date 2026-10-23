/**
 * Pointer-drag machinery (UI-blocks U1 Task 4, spec §6.3/§12.4): the
 * shared POINTER-event drag/drop both `lanes` and `list`-style reorder
 * use (NOT HTML5 drag-and-drop — pointer events cover mouse and touch).
 *
 * Drop targets are declarative: elements carry `data-drop-group` /
 * `data-drop-index` attributes, and `dropTargetAt` hit-tests
 * `document.elementFromPoint` against them, so lanes and lists share
 * this one file. The displays call `startDrag` from their pointer-down
 * handlers (pointer capture on the event's `currentTarget` — the up
 * event then reaches the dragged element even when the pointer is
 * released over another element), `endDrag` from pointer-up, and
 * `cancelDrag` from pointer-cancel (touch scroll theft) so a cancelled
 * drag never leaves a stale pending state.
 *
 * The keyboard path (§12.4) is the same payload through `DropMove`:
 * `m` picks an item up, arrows move the cursor, `Enter` drops, `Esc`
 * cancels — see LanesDisplay's keydown handling, which produces the
 * exact `{itemId, from: {group, index}, to: {group, index}}` shape the
 * pointer path produces.
 */

import type { JsonObject } from "@sigrun/shared/blocks";

/** A drop location (the `to` endpoint of a move). */
export interface DropTarget {
	readonly group: string;
	readonly index: number;
}

/** A completed move. */
export interface DropMove {
	readonly itemId: string;
	readonly from: DropTarget;
	readonly to: DropTarget;
}

/** An in-flight drag (pointer capture held by the dragged element). */
export interface DragState {
	readonly itemId: string;
	readonly from: DropTarget;
}

/** The element properties the drag handlers read (test fakes implement
 *  this narrow shape; browsers satisfy it with Element). */
export interface DropHost {
	setPointerCapture?(pointerId: number): void;
	releasePointerCapture?(pointerId: number): void;
}

/** Start a drag: record the origin and capture the pointer on the
 *  dragged element so move/up events keep flowing to it. Returns the
 *  state the caller keeps until `endDrag`. */
export function startDrag(
	element: DropHost,
	pointerId: number,
	state: DragState,
): DragState {
	element.setPointerCapture?.(pointerId);
	return state;
}

/** Abandon a drag without a drop (pointer cancel — e.g. a touch drag
 *  stolen by scroll): releases capture and returns nothing, so the
 *  caller clears its pending state with no dispatch. */
export function cancelDrag(element: DropHost, pointerId: number): void {
	releaseCapture(element, pointerId);
}

/** Hit-test a point for the nearest drop target: the closest element
 *  carrying BOTH `data-drop-group` and `data-drop-index`. `atPoint` is
 *  injectable (tests, environments without layout); the browser's
 *  `document.elementFromPoint` is the default. */
export function dropTargetAt(
	x: number,
	y: number,
	atPoint?: (x: number, y: number) => Element | null,
): DropTarget | undefined {
	const resolve =
		atPoint ??
		(typeof document === "object"
			? (px: number, py: number): Element | null =>
					document.elementFromPoint(px, py)
			: undefined);
	if (resolve === undefined) return undefined;
	const element = resolve(x, y);
	const carrier = element?.closest("[data-drop-group][data-drop-index]");
	if (carrier === null || carrier === undefined) return undefined;
	const group = carrier.getAttribute("data-drop-group");
	const indexRaw = carrier.getAttribute("data-drop-index");
	if (group === null || indexRaw === null) return undefined;
	const index = Number(indexRaw);
	if (!Number.isInteger(index)) return undefined;
	return { group, index };
}

/** Release pointer capture, tolerating an already-lost capture (the
 *  browser auto-releases on pointerup/cancel; synthetic events carry
 *  no active pointer at all). */
function releaseCapture(element: DropHost, pointerId: number): void {
	try {
		element.releasePointerCapture?.(pointerId);
	} catch {
		// NotFoundError: no active pointer for the id (auto-released).
	}
}

/** Finish a drag: hit-test the pointer's last position and return the
 *  move when the drop target differs from the origin (same-group
 *  same-index is a no-op, never dispatched). Releases pointer capture. */
export function endDrag(
	element: DropHost,
	pointerId: number,
	state: DragState,
	x: number,
	y: number,
	atPoint?: (x: number, y: number) => Element | null,
): DropMove | undefined {
	releaseCapture(element, pointerId);
	const to = dropTargetAt(x, y, atPoint);
	if (to === undefined) return undefined;
	if (to.group === state.from.group && to.index === state.from.index) {
		return undefined;
	}
	return { itemId: state.itemId, from: state.from, to };
}

/** The move payload both paths dispatch (spec §6.3 step 2). */
export function movePayload(move: DropMove): JsonObject {
	return {
		itemId: move.itemId,
		from: { group: move.from.group, index: move.from.index },
		to: { group: move.to.group, index: move.to.index },
	};
}
