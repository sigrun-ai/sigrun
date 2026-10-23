/**
 * Selection + view-state helpers (UI-blocks U1 Task 3, spec §5.5/§6.2):
 * the view-only state every collection display keeps — selection,
 * sort, page, expanded rows, folded quiet/overflow groups.
 *
 * THE SHAPE Task 4 moves verbatim into the surface's `/view/` branch
 * (the channel owns it; it never goes to the server):
 *
 *   /view/<blockId>/selection : string[]          (item ids, insertion order)
 *   /view/<blockId>/sort      : {field, dir} | undefined   (table)
 *   /view/<blockId>/page      : number                     (table)
 *   /view/<blockId>/expanded  : string[]                   (compact table rows)
 *   /view/<blockId>/folded    : string[]                   (fold keys; folded
 *       groups are derived as (group ∪ {quiet|overflow}) \ folded)
 *
 * All ids/keys are strings; arrays are insertion-ordered, deduped.
 */

import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";

/** The view-state slice one collection block owns. */
export interface CollectionViewState {
	readonly selection: readonly string[];
	readonly sort: { readonly field: string; readonly dir: "asc" | "desc" } | undefined;
	readonly page: number;
	readonly expanded: readonly string[];
	readonly folded: readonly string[];
}

/** The empty view state (a fresh surface). */
export const EMPTY_VIEW: CollectionViewState = {
	selection: [],
	sort: undefined,
	page: 0,
	expanded: [],
	folded: [],
};

/** An item's id (spec §5.5: each item has a unique `id`). */
export function itemId(item: JsonValue, index: number): string {
	if (
		typeof item === "object" &&
		item !== null &&
		!Array.isArray(item) &&
		"id" in item
	) {
		const id = (item as JsonObject).id;
		if (typeof id === "string") return id;
		if (typeof id === "number") return String(id);
	}
	return `item-${index}`;
}

/** Toggle `id` in the selection; `single` keeps only the latest. */
export function toggleSelection(
	selection: readonly string[],
	id: string,
	mode: "single" | "multi",
): readonly string[] {
	if (mode === "single") {
		return selection.includes(id) ? [] : [id];
	}
	return selection.includes(id)
		? selection.filter((existing) => existing !== id)
		: [...selection, id];
}

/** Toggle `key` in a folded/expanded id list. */
export function toggleKey(
	keys: readonly string[],
	key: string,
): readonly string[] {
	return keys.includes(key)
		? keys.filter((existing) => existing !== key)
		: [...keys, key];
}

/** The cycle a clicked sortable column takes: none → asc → desc → asc. */
export function nextSort(
	current: CollectionViewState["sort"],
	field: string,
): { readonly field: string; readonly dir: "asc" | "desc" } {
	if (current === undefined || current.field !== field) {
		return { field, dir: "asc" };
	}
	return { field, dir: current.dir === "asc" ? "desc" : "asc" };
}
