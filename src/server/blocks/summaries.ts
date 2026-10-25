/**
 * Change-record summaries (UI-blocks U5 Task 2, spec §8.3): core writes
 * each `ChangeRecord.summary` from the TREE, using the labels the user
 * saw — the item's `title` slot value, its 1-based position, the
 * group's (or the enclosing section's) title, and the form field's
 * `label`.
 *
 * The pinned strings (the spec's own examples):
 * - `moved 'Clair de Lune' from 4th to 1st in 'Ranking'`
 * - `checked 'milk' in 'Shopping'` (and `unchecked …`)
 * - `set 'Notes' to '…'` (a `turn: false` submit writes the form's
 *   values at its `bind`; one `set` per field, joined by `"; "`;
 *   values over {@link SUMMARY_VALUE_MAX} characters truncate with `…`)
 *
 * Never throws: every lookup is optional-typed (a missing binding, a
 * payload shape the walk does not know) and falls back to the plainest
 * label available — a summary is a human-read string, not a write path.
 */

import type {
	Action,
	Binding,
	Bindable,
	CollectionBlock,
	Field,
	JsonObject,
	JsonValue,
	Tree,
} from "@sigrun/shared/blocks";
import { resolvePointer } from "@sigrun/shared/blocks";

/** The value-render cap (the brief): values over 80 characters truncate with `…`. */
export const SUMMARY_VALUE_MAX = 80;

/** Render one value: plain JSON form, capped at 80 characters (`…`). */
function renderValue(value: JsonValue): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text.length <= SUMMARY_VALUE_MAX) return text;
	return `${text.slice(0, SUMMARY_VALUE_MAX)}…`;
}

/** The 1-based ordinal the position line reads ("1st", "2nd", "11th"). */
export function ordinal(index: number): string {
	const oneBased = index + 1;
	const tail100 = oneBased % 100;
	if (tail100 >= 11 && tail100 <= 13) return `${oneBased}th`;
	switch (oneBased % 10) {
		case 1:
			return `${oneBased}st`;
		case 2:
			return `${oneBased}nd`;
		case 3:
			return `${oneBased}rd`;
		default:
			return `${oneBased}th`;
	}
}

/** A `move`/`edit` payload endpoint (the `{group?, index}` shape §6.3 sends). */
function readSpot(value: unknown): { group?: string; index?: number } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as JsonObject;
	return {
		...(typeof record.group === "string" ? { group: record.group } : {}),
		...(typeof record.index === "number" ? { index: record.index } : {}),
	};
}

/** Resolve a bindable against `data` (`item` scopes `./` bindings). */
function bound(
	value: Bindable<string> | undefined,
	data: JsonObject,
	item: JsonValue | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	const resolved = resolvePointer(data, (value as Binding).$, item);
	return typeof resolved === "string" ? resolved : undefined;
}

/** A plain-record check (the tree walk's node shape). */
function isRec(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Yield every node of a tree, structurally (the service.ts walk). */
function* walkNodes(root: JsonObject): Generator<JsonObject> {
	yield root;
	const childLists = [
		root.root,
		root.children,
		root.fields,
		root.main,
		root.sidebar,
		root.detail,
	];
	for (const list of childLists) {
		if (Array.isArray(list)) {
			for (const child of list) {
				if (isRec(child)) {
					if (isRec(child.block)) {
						yield* walkNodes(child.block);
					} else {
						yield* walkNodes(child);
					}
				}
			}
		} else if (isRec(list)) {
			yield* walkNodes(list);
		}
	}
	if (isRec(root.item)) yield* walkNodes(root.item);
}

/** The label the user saw above one block: the nearest enclosing section title. */
function sectionTitleAround(tree: Tree, inner: JsonObject, data: JsonObject): string | undefined {
	const wanted = inner;
	const visit = (node: JsonObject, title: string | undefined): string | undefined => {
		const nextTitle =
			node.type === "section" && node.title !== undefined
				? bound(node.title as Bindable<string>, data, undefined)
				: title;
		if (node === wanted) return nextTitle;
		const childLists = [node.root, node.children, node.fields, node.main, node.sidebar, node.detail];
		for (const list of childLists) {
			if (Array.isArray(list)) {
				for (const child of list) {
					if (!isRec(child)) continue;
					const hit = isRec(child.block)
						? visit(child.block, nextTitle)
						: visit(child, nextTitle);
					if (hit !== undefined) return hit;
				}
			} else if (isRec(list)) {
				const hit = visit(list, nextTitle);
				if (hit !== undefined) return hit;
			}
		}
		if (isRec(node.item)) {
			const hit = visit(node.item, nextTitle);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};
	// SAFETY: the walk reads only structural record fields (type/children/
	// item/…) — the wire `Tree` and the loose `JsonObject` view agree on
	// those, and every read is typeof-guarded below.
	const found = visit(tree.root as unknown as JsonObject, undefined);
	return found;
}

/** The group's display title: the declared group's `title` (a binding resolves
 *  against the surface data the actor saw), else its id. */
function groupTitleOf(
	collection: CollectionBlock,
	groupId: string,
	data: JsonObject,
): string {
	const declared = (collection.groups ?? []).find(
		(candidate) => candidate.id === groupId,
	);
	if (declared === undefined) return groupId;
	return (
		bound(declared.title as Bindable<string>, data, undefined) ?? declared.id
	);
}

/** One summary line, quoted and labelled; empty when nothing was found. */
function moveSummary(
	tree: Tree,
	data: JsonObject,
	payload: JsonObject,
): string | undefined {
	const itemId = payload.itemId;
	if (typeof itemId !== "string") return undefined;
	const from = readSpot(payload.from);
	const to = readSpot(payload.to);
	if (from === undefined || to === undefined) return undefined;
	// The collection owning this move: the one whose items array holds
	// the item (multiple collections may bind the same name handler;
	// the first holding the item wins).
	// SAFETY: the walk reads only structural record fields (children/items/
	// type names) the wire Tree and the loose JsonObject view agree on;
	// every field read below is typeof-guarded.
	for (const node of walkNodes(tree.root as unknown as JsonObject)) {
		if (node.type !== "collection") continue;
		const itemsPath = node.items;
		if (typeof itemsPath !== "object" || itemsPath === null) continue;
		const pointer = (itemsPath as Binding).$;
		if (typeof pointer !== "string") continue;
		const items = resolvePointer(data, pointer);
		if (!Array.isArray(items)) continue;
		const at = items.findIndex(
			(candidate) => isRec(candidate) && candidate.id === itemId,
		);
		if (at < 0) continue;
		const item = items[at] as JsonValue;
		const card = isRec(node.item) ? node.item : undefined;
		const title =
			card === undefined
				? undefined
				: bound(card.title as Bindable<string>, data, item);
		if (title === undefined) continue;
		// SAFETY: the walk narrowed `node` to a collection record with an
		// items binding and an item template; the remaining props are read
		// only through the declared-block type's own names.
		const collection = node as unknown as CollectionBlock;
		// A grouped collection labels by the GROUP's title (the label the
		// user saw over the row); an ungrouped one by the section's.
		const scope =
			collection.groupBy === undefined
				? (sectionTitleAround(tree, node, data) ?? "")
				: groupTitleOf(collection, to.group ?? from.group ?? "", data);
		const where = scope === "" ? "" : ` in '${scope}'`;
		// The `from` position names the item's located (current) index —
		// the payload's from.index is only a hint: an interleaved edit
		// may have moved the row before this action's commit ran, and
		// the summary must name the positions at APPLY time.
		return `moved '${title}' from ${ordinal(at)} to ${ordinal(
			to.index ?? at,
		)}${where}`;
	}
	return undefined;
}

/** The check summary: `checked 'milk' in 'Shopping'`. */
function checkSummary(
	tree: Tree,
	data: JsonObject,
	payload: JsonObject,
): string | undefined {
	const itemId = payload.itemId;
	if (typeof itemId !== "string") return undefined;
	// SAFETY: the walk reads only structural record fields the wire Tree
	// and the loose JsonObject view agree on; every read is guarded.
	for (const node of walkNodes(tree.root as unknown as JsonObject)) {
		if (node.type !== "collection" || typeof node.checkable !== "string") continue;
		const itemsPath = node.items;
		if (typeof itemsPath !== "object" || itemsPath === null) continue;
		const pointer = (itemsPath as Binding).$;
		if (typeof pointer !== "string") continue;
		const items = resolvePointer(data, pointer);
		if (!Array.isArray(items)) continue;
		const at = items.findIndex(
			(candidate) => isRec(candidate) && candidate.id === itemId,
		);
		if (at < 0) continue;
		const item = items[at] as JsonValue;
		const card = isRec(node.item) ? node.item : undefined;
		const title =
			card === undefined
				? undefined
				: bound(card.title as Bindable<string>, data, item);
		if (title === undefined) continue;
		const scope = sectionTitleAround(tree, node, data) ?? "";
		const where = scope === "" ? "" : ` in '${scope}'`;
		// `value` omitted means the plain toggle-on the client sends for a
		// check (planAction defaults true): the verb must agree with the
		// written value.
		const verb = payload.value === false ? "unchecked" : "checked";
		return `${verb} '${title}'${where}`;
	}
	return undefined;
}

/** A form field's declared label (a binding resolves against `data`). */
function fieldLabel(field: Field, data: JsonObject): string {
	const label = bound(field.label as Bindable<string>, data, undefined);
	return label ?? field.name;
}

/** The submit summary: one `set 'Label' to 'value'` per field, `"; "`-joined. */
function submitSummary(
	tree: Tree,
	data: JsonObject,
	payload: JsonObject,
): string | undefined {
	const values = payload.values;
	if (!isRec(values)) return undefined;
	const parts: string[] = [];
	// SAFETY: the walk reads only structural record fields the wire Tree
	// and the loose JsonObject view agree on; every read is guarded.
	for (const node of walkNodes(tree.root as unknown as JsonObject)) {
		if (node.type !== "form" || !Array.isArray(node.children)) continue;
		const fields: Field[] = [];
		for (const child of node.children) {
			if (!isRec(child)) continue;
			if (typeof child.name === "string" && "label" in child) {
				// SAFETY: the record passed the field shape check (a `name` +
				// a `label` member); Field's own members are read only through
				// `fieldLabel`'s guarded accessors.
				fields.push(child as unknown as Field);
			} else if (child.type === "section" && Array.isArray(child.children)) {
				for (const grandchild of child.children) {
					if (isRec(grandchild) && typeof grandchild.name === "string") {
						// SAFETY: same field-shape check as above.
						fields.push(grandchild as unknown as Field);
					}
				}
			}
		}
		// Only the form(s) whose declared fields appear in the payload.
		const named = fields.filter((field) => field.name in values);
		if (named.length === 0) continue;
		for (const field of named) {
			const value = values[field.name];
			parts.push(
				`set '${fieldLabel(field, data)}' to '${renderValue(value ?? null)}'`,
			);
		}
	}
	if (parts.length === 0) return undefined;
	return parts.join("; ");
}

/**
 * The summary for one action (spec §8.3). `data` is the surface's data
 * BEFORE the edit applies — the positions and titles the user saw.
 */
export function summarizeAction(
	tree: Tree,
	data: JsonObject,
	action: Action,
	payload: JsonValue,
): string {
	const record = isRec(payload) ? payload : {};
	const fallback =
		"name" in action && typeof action.name === "string"
			? `${action.type} ${action.name}`
			: action.type;
	if (action.type === "move") {
		return moveSummary(tree, data, record) ?? fallback;
	}
	if (action.type === "edit") {
		return checkSummary(tree, data, record) ?? fallback;
	}
	if (action.type === "submit") {
		return submitSummary(tree, data, record) ?? fallback;
	}
	return fallback;
}
