/**
 * Shared collection machinery (UI-blocks spec §5.5): item resolution,
 * grouping, sorting and the view-only interaction state (selection,
 * folds, menu) the list/table/grid displays drive.
 *
 * Every interactive display owns a {@link CollectionState} — its shape
 * mirrors the `/view/<blockId>/` branch Task 4's surface state will own
 * (sort, page, selection, expanded, quietShown). View-only state never
 * dispatches (§6.2): only `onCheck` (`edit`), `onActivate`, and bulk
 * `submit` actions reach `ctx.dispatch`.
 */

import type { Action, CollectionBlock, JsonObject, JsonValue, Tree } from "@sigrun/shared/blocks";
import { bindRaw, bindText, type BlockCtx } from "../context.js";

/** A resolved collection row: the item and its stable id. */
export interface CollectionItem {
	id: string;
	item: JsonObject;
}

/** A resolved group: heading text and its items, in `groups` order. */
export interface ItemGroup {
	id: string;
	title: string;
	collapsed: boolean;
	items: CollectionItem[];
}

/** Resolve `items` to rows, dropping malformed entries. */
export function collectionItems(block: CollectionBlock, ctx: BlockCtx): CollectionItem[] {
	const raw = bindRaw(block.items, ctx);
	if (!Array.isArray(raw)) return [];
	const out: CollectionItem[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record: JsonObject = entry;
		const id = typeof record.id === "string" ? record.id : String(record.id ?? "");
		if (id === "") continue;
		out.push({ id, item: record });
	}
	return out;
}

/** Nested child rows of an item (the `children` field's records). */
export function childItems(block: CollectionBlock, item: JsonObject): CollectionItem[] {
	const field = block.children;
	if (field === undefined || field === "") return [];
	const raw = item[field];
	if (!Array.isArray(raw)) return [];
	const out: CollectionItem[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record: JsonObject = entry;
		const id = typeof record.id === "string" ? record.id : String(record.id ?? "");
		if (id === "") continue;
		out.push({ id, item: record });
	}
	return out;
}

/** The sort key of an item for a field (numbers sort numerically). */
function sortValue(item: JsonObject, field: string): JsonValue {
	return item[field] ?? null;
}

/** Compare two items on `field`, ascending. */
export function compareItems(a: JsonObject, b: JsonObject, field: string): number {
	const left = sortValue(a, field);
	const right = sortValue(b, field);
	if (typeof left === "number" && typeof right === "number") {
		return left === right ? 0 : left < right ? -1 : 1;
	}
	const leftKey = left === null ? "" : String(left);
	const rightKey = right === null ? "" : String(right);
	if (leftKey === rightKey) return 0;
	return leftKey < rightKey ? -1 : 1;
}

/** Order items by a `{field, dir}` sort (stable; view state wins over the block's). */
export function sortItems(
	items: readonly CollectionItem[],
	sort: { field: string; dir: "asc" | "desc" } | undefined,
): CollectionItem[] {
	if (sort === undefined) return [...items];
	const sign = sort.dir === "desc" ? -1 : 1;
	return [...items].sort((a, b) => compareItems(a.item, b.item, sort.field) * sign);
}

/**
 * Group items by `groupBy`: declared `groups` in declared order, then
 * unseen values in first-appearance item order. With no `groupBy`,
 * one anonymous group holds everything.
 */
export function groupItems(
	block: CollectionBlock,
	items: readonly CollectionItem[],
	ctx: BlockCtx,
): ItemGroup[] {
	const by = block.groupBy;
	if (by === undefined || by === "") {
		return [{ id: "", title: "", collapsed: false, items: [...items] }];
	}
	const groups: ItemGroup[] = [];
	const indexById = new Map<string, number>();
	for (const declared of block.groups ?? []) {
		indexById.set(declared.id, groups.length);
		groups.push({
			id: declared.id,
			title: bindText(declared.title, ctx),
			collapsed: declared.collapsed === true,
			items: [],
		});
	}
	for (const row of items) {
		const value = row.item[by];
		const id = value === undefined || value === null ? "" : String(value);
		const index = indexById.get(id);
		if (index !== undefined) {
			groups[index]?.items.push(row);
			continue;
		}
		indexById.set(id, groups.length);
		groups.push({ id, title: id, collapsed: false, items: [row] });
	}
	return groups;
}

/** Is an item quiet (folded behind "N more")? */
export function isQuiet(block: CollectionBlock, ctx: BlockCtx, item: JsonValue): boolean {
	if (block.item.quiet === undefined) return false;
	return bindRaw(block.item.quiet, { ...ctx, item }) === true;
}

/**
 * The view-only interaction state of one collection component. The
 * checkable toggle's optimistic flip is part of it: the data update
 * that follows a successful `onCheck` replaces the optimistic value
 * (§6.3's convention, without moves).
 */
export class CollectionState {
	cursor = 0;
	readonly selected = new Set<string>();
	readonly checkedOverrides = new Map<string, boolean>();
	readonly expanded = new Set<string>();
	readonly unfoldedGroups = new Set<string>();
	quietShown = false;
	/** The open overlay: the sort choice, the bulk menu, or the seam form. */
	menu: { kind: "sort" } | { kind: "bulk" } | { kind: "form"; form: Tree; onSubmit: string } | null =
		null;
	menuCursor = 0;
	formBuffer = "";

	/** The effective checked value of an item (data plus the optimistic flip). */
	checkedValue(block: CollectionBlock, row: CollectionItem): boolean {
		const override = this.checkedOverrides.get(row.id);
		if (override !== undefined) return override;
		if (block.checkable === undefined) return false;
		return row.item[block.checkable] === true;
	}
}

/** Dispatch the `onCheck` edit for an item (spec §5.5: `{itemId, value}`). */
export function dispatchCheck(
	block: CollectionBlock,
	ctx: BlockCtx,
	state: CollectionState,
	row: CollectionItem,
): void {
	if (block.onCheck === undefined || block.checkable === undefined) return;
	const value = !state.checkedValue(block, row);
	state.checkedOverrides.set(row.id, value);
	ctx.dispatch({ type: "edit", name: block.onCheck }, { itemId: row.id, value });
}

/** Dispatch `onActivate` for an item, payload `{itemId}`. */
export function dispatchActivate(
	block: CollectionBlock,
	ctx: BlockCtx,
	row: CollectionItem,
): void {
	if (block.onActivate === undefined) return;
	ctx.dispatch(block.onActivate, { itemId: row.id });
}

/** Dispatch a bulk action's submit for the current selection. */
export function dispatchBulk(
	ctx: BlockCtx,
	state: CollectionState,
	onSubmit: string,
	values?: JsonObject,
): void {
	const ids = [...state.selected];
	const payload: JsonObject = values === undefined ? { ids } : { ids, values };
	const action: Action = { type: "submit", name: onSubmit };
	ctx.dispatch(action, payload);
	state.selected.clear();
	state.menu = null;
}
