/**
 * The collection block (UI-blocks U1 Task 3, spec §5.5): one block for
 * every set of items. This module owns the shared item preparation
 * (resolve `items`, group, fold quiet/overflow) and routes the display
 * to `list` / `table` / `grid`. `lanes` and `calendar` are Task 4.
 */

import type { ReactNode } from "react";
import type {
	CollectionBlock,
	CollectionGroup,
	JsonObject,
	JsonValue,
} from "@sigrun/shared/blocks";
import { bound, useSurfaceData } from "../context";
import { GridDisplay } from "./GridDisplay";
import { ListDisplay } from "./ListDisplay";
import { TableDisplay } from "./TableDisplay";
import { itemId } from "./selection";

/** One item, prepared for a display: its id and resolved value. */
export interface PreparedItem {
	readonly id: string;
	readonly item: JsonValue;
}

/** The derived quiet-fold buckets (§5.5.1 `quiet`). */
export interface FoldBuckets {
	/** Items shown by default. */
	readonly visible: readonly PreparedItem[];
	/** Quiet items folded behind an "N more" toggle. */
	readonly quiet: readonly PreparedItem[];
}

/** Read the items a collection binds to (missing path → empty, never
 *  an error — the render contract). */
export function useItems(block: CollectionBlock): readonly PreparedItem[] {
	const ctx = useSurfaceData();
	const items = bound<readonly JsonValue[]>(ctx, block.items);
	if (items === undefined || !Array.isArray(items)) return [];
	return items.map((item, index) => ({ id: itemId(item, index), item }));
}

/** The item field a binding reads (for quiet/tone/groupBy checks). */
export function itemField(item: JsonValue, field: string): JsonValue | undefined {
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		return undefined;
	}
	return (item as JsonObject)[field];
}

/** Whether an item is quiet under the template's `quiet` binding. */
function isQuiet(block: CollectionBlock, item: PreparedItem): boolean {
	const quiet = block.item.quiet;
	if (quiet === undefined) return false;
	if (typeof quiet === "object" && "$" in quiet && typeof quiet.$ === "string") {
		const value = bound<JsonValue>(
			{ data: {}, item: quiet.$.startsWith("./") ? item.item : undefined, locale: "en" },
			quiet,
		);
		return value === true;
	}
	return quiet === true;
}

/** Fold quiet items behind their bucket (§5.5.1). */
export function foldQuiet(
	block: CollectionBlock,
	items: readonly PreparedItem[],
): FoldBuckets {
	const visible: PreparedItem[] = [];
	const quiet: PreparedItem[] = [];
	for (const prepared of items) {
		if (isQuiet(block, prepared)) quiet.push(prepared);
		else visible.push(prepared);
	}
	return { visible, quiet };
}

/** One group's prepared items (group key = `groupBy` field's string). */
export interface PreparedGroup {
	readonly id: string;
	readonly title: string;
	readonly collapsed: boolean;
	readonly buckets: FoldBuckets;
}

/** Group items: with `groups` declared, in `groups` order (unknown
 *  group keys follow, sorted by key); without, one anonymous group. */
export function groupItems(
	block: CollectionBlock,
	items: readonly PreparedItem[],
): readonly PreparedGroup[] {
	if (block.groupBy === undefined) {
		return [{ id: "", title: "", collapsed: false, buckets: foldQuiet(block, items) }];
	}
	const byKey = new Map<string, PreparedItem[]>();
	for (const prepared of items) {
		const value = itemField(prepared.item, block.groupBy);
		const key = typeof value === "string" ? value : String(value ?? "");
		const list = byKey.get(key) ?? [];
		list.push(prepared);
		byKey.set(key, list);
	}
	const declared = new Map<string, CollectionGroup>(
		(block.groups ?? []).map((group) => [group.id, group]),
	);
	const ordered: PreparedGroup[] = [];
	for (const group of block.groups ?? []) {
		const members = byKey.get(group.id) ?? [];
		byKey.delete(group.id);
		ordered.push({
			id: group.id,
			title: typeof group.title === "string" ? group.title : group.id,
			collapsed: group.collapsed === true,
			buckets: foldQuiet(block, members),
		});
	}
	// Undeclared group keys keep their items, sorted by key (stable).
	for (const key of [...byKey.keys()].sort()) {
		ordered.push({
			id: key,
			title: declared.get(key)?.id ?? key,
			collapsed: false,
			buckets: foldQuiet(block, byKey.get(key) ?? []),
		});
	}
	return ordered;
}

/** The collection block: display dispatch (lanes/calendar are Task 4 —
 *  they fall through to the generic unsupported notice upstream). */
export function CollectionBlockView(props: {
	block: CollectionBlock;
}): ReactNode {
	const block = props.block;
	const items = useItems(block);
	const groups = groupItems(block, items);
	switch (block.display) {
		case "list":
			return <ListDisplay block={block} groups={groups} />;
		case "table":
			return <TableDisplay block={block} groups={groups} />;
		case "grid":
			return <GridDisplay block={block} groups={groups} />;
		default:
			// lanes / calendar: Task 4. Render an honest notice rather than
			// a broken half-implementation.
			return (
				<div className="blk blk-collection" data-display={block.display}>
					Not supported in this client
				</div>
			);
	}
}
