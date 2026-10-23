/**
 * The list field (UI-blocks U2 Task 5, spec §5.6): a repeatable group —
 * `item` describes the field of ONE entry; the value is an array of
 * entry values. Add (`a` on the field), remove (`d`), and reorder (`u`
 * up / `j` down) honour `min`/`max`. Entries edit inline through the
 * item field's text editor (choice/other items stay text-shaped in v1 —
 * noted in the module header of the form).
 */

import type { JsonValue, ListField } from "@sigrun/shared/blocks";
import { truncate } from "../width.js";

/** The entries of a list value (never undefined). */
export function listEntries(value: JsonValue): readonly JsonValue[] {
	return Array.isArray(value) ? value : [];
}

/** Can the list add an entry (`max`)? */
export function listCanAdd(field: ListField, value: JsonValue): boolean {
	return field.max === undefined || listEntries(value).length < field.max;
}

/** Can the list remove an entry (`min`)? */
export function listCanRemove(field: ListField, value: JsonValue): boolean {
	return listEntries(value).length > (field.min ?? 0);
}

/** Add an entry (the item field's empty value). */
export function listAdd(value: JsonValue): JsonValue {
	return [...listEntries(value), ""];
}

/** Remove the entry at `index`. */
export function listRemove(value: JsonValue, index: number): JsonValue {
	return listEntries(value).filter((_, at) => at !== index);
}

/** Move the entry at `index` by `delta` (reorder; clamped). */
export function listMove(value: JsonValue, index: number, delta: number): JsonValue {
	const entries = [...listEntries(value)];
	const target = index + delta;
	if (target < 0 || target >= entries.length) return entries;
	const [entry] = entries.splice(index, 1);
	entries.splice(target, 0, entry as JsonValue);
	return entries;
}

/** Replace the entry at `index`. */
export function listSet(value: JsonValue, index: number, entry: JsonValue): JsonValue {
	return listEntries(value).map((current, at) => (at === index ? entry : current));
}

/** The per-field list state: the entry cursor. */
export class ListFieldState {
	cursor = 0;
}

/** Render the entries (one editor line each) plus the hint row. */
export function listLines(opts: {
	field: ListField;
	width: number;
	value: JsonValue;
	state: ListFieldState;
	focused: boolean;
	/** The rendered editor line of an entry (the form seeds caret state). */
	entryLine(index: number, entry: JsonValue, focused: boolean): string;
}): string[] {
	const { field, width, value, state, focused } = opts;
	const entries = listEntries(value);
	const lines: string[] = [];
	entries.forEach((entry, index) => {
		const cursor = focused && index === state.cursor ? "> " : "  ";
		lines.push(truncate(`${cursor}${opts.entryLine(index, entry, focused && index === state.cursor)}`, width));
	});
	if (focused) {
		const hints: string[] = [];
		if (listCanAdd(field, value)) hints.push("a add");
		if (entries.length > 0 && listCanRemove(field, value)) hints.push("d remove");
		if (field.reorder === true && entries.length > 1) hints.push("u/j move");
		if (hints.length > 0) {
			lines.push(truncate(`  ${hints.join(" · ")}`, width));
		}
	}
	return lines;
}
