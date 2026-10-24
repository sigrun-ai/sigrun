/**
 * Keyboard moves (UI-blocks U2 Task 4, spec §12.4): the shared
 * placement machinery the lanes and calendar displays drive. `m` picks
 * the item under the cursor up, arrows move the placement (left/right
 * across groups, up/down within), Enter drops — dispatching
 * `{itemId, from: {group, index}, to: {group, index}}`, the EXACT
 * payload U1's pointer drop builds — and Esc cancels.
 *
 * The held item counts as PRESENT in the lane sizing (its removal
 * happens on drop, not on pickup) — the same rule as U1's lanes. A
 * dropped placement equal to the item's current one dispatches nothing.
 *
 * Review Focus 1: a resize while picked up is handled by the DISPLAYS,
 * which recompute placements from the live block data on every key; the
 * held state survives because it lives in the component, not the
 * rendered lines.
 */

import type { CollectionBlock, JsonObject } from "@sigrun/shared/blocks";
import {
	CollectionState,
	collectionItems,
	groupItems,
	isQuiet,
	sortItems,
	type CollectionItem,
	type ItemGroup,
} from "./shared.js";
import type { BlockCtx } from "../context.js";

/** A placement: a group plus the index within its VISIBLE items. */
export interface Placement {
	readonly group: string;
	readonly index: number;
}

/** The keyboard-move session (the picked-up item and its placement). */
export interface MoveState {
	readonly itemId: string;
	readonly from: Placement;
	readonly at: Placement;
}

/** The visible items of a group (sorted, loud items — quiet items are
 *  folded behind the fold row and not placement targets). */
export function visibleLaneItems(
	block: CollectionBlock,
	ctx: BlockCtx,
	group: ItemGroup,
): CollectionItem[] {
	const sorted = sortItems(group.items, block.sort);
	return sorted.filter((row) => !isQuiet(block, ctx, row.item));
}

/** Every group with its visible items, in group order. */
export function lanes(
	block: CollectionBlock,
	ctx: BlockCtx,
): { groups: ItemGroup[]; visible: Map<string, CollectionItem[]> } {
	const groups = groupItems(block, sortItems(collectionItems(block, ctx), block.sort), ctx);
	const visible = new Map<string, CollectionItem[]>();
	for (const group of groups) {
		visible.set(group.id, visibleLaneItems(block, ctx, group));
	}
	return { groups, visible };
}

/** An item's current placement across every group. */
export function placementOf(
	groups: readonly ItemGroup[],
	visible: ReadonlyMap<string, CollectionItem[]>,
	itemId: string,
): Placement | undefined {
	for (const group of groups) {
		const items = visible.get(group.id) ?? [];
		const index = items.findIndex((row) => row.id === itemId);
		if (index >= 0) return { group: group.id, index };
	}
	return undefined;
}

/** The move payload (spec §6.3 step 2; U1's pointer-drop shape exactly). */
export function movePayload(move: {
	itemId: string;
	from: Placement;
	to: Placement;
}): JsonObject {
	return {
		itemId: move.itemId,
		from: { group: move.from.group, index: move.from.index },
		to: { group: move.to.group, index: move.to.index },
	};
}

/** Move the placement left/right across groups (the index clamps to
 *  the target lane's size; out-of-range directions are inert). */
export function shiftAcross(
	move: MoveState,
	groups: readonly ItemGroup[],
	visible: ReadonlyMap<string, CollectionItem[]>,
	delta: 1 | -1,
): MoveState {
	const order = groups.map((group) => group.id);
	const laneIndex = order.indexOf(move.at.group);
	const target = order[laneIndex + delta];
	if (target === undefined) return move;
	const size = (visible.get(target) ?? []).length;
	return {
		...move,
		at: { group: target, index: Math.min(move.at.index, size) },
	};
}

/** Move the placement up/down within its group (clamped). */
export function shiftWithin(
	move: MoveState,
	visible: ReadonlyMap<string, CollectionItem[]>,
	delta: 1 | -1,
): MoveState {
	const size = (visible.get(move.at.group) ?? []).length;
	const index =
		delta === 1 ? Math.min(move.at.index + 1, size) : Math.max(move.at.index - 1, 0);
	return { ...move, at: { group: move.at.group, index } };
}

/**
 * Dispatch the drop: nothing when the placement equals the current
 * position; otherwise the `move` action with the U1 payload. The
 * optimistic flip lives in SurfaceState's overlay — the component
 * itself keeps no per-item move override.
 */
export function dispatchMove(
	block: CollectionBlock,
	ctx: BlockCtx,
	move: MoveState,
): void {
	if (block.onMove === undefined) return;
	if (move.from.group === move.at.group && move.from.index === move.at.index) return;
	ctx.dispatch(
		{ type: "move", name: block.onMove },
		movePayload({ itemId: move.itemId, from: move.from, to: move.at }),
	);
}

/** The per-display move session state (held in the component). */
export class MoveSession {
	held: MoveState | undefined;

	/** Pick up the item (undefined placement = no pickup). */
	pickUp(itemId: string, from: Placement): void {
		this.held = { itemId, from, at: from };
	}

	/** Cancel (Esc): drop the session without dispatching. */
	cancel(): void {
		this.held = undefined;
	}
}
