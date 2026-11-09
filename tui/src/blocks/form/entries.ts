/**
 * Entries fields (settings rework §3): array/table entries render as
 * summary rows. Enter opens a nested form; `a` adds, `d` duplicates,
 * `x` arms a y/N delete, and K/J reorder arrays. `$from` is the loaded
 * identity, retained across renames and removed from new/duplicated
 * entries. Duplicate table keys use an internal NUL suffix so local
 * edits never overwrite one another; display and validation strip it.
 */

import type { EntriesField, Field, JsonObject, JsonValue } from "@sigrun/shared/blocks";
import type { BlockCtx } from "../context.js";
import { truncate } from "../width.js";
import { defaultEntry, nestedFields } from "./values.js";

export interface EntryRecord {
	readonly id: string;
	readonly key: string;
	readonly value: JsonObject;
}

export class EntriesFieldState {
	cursor = 0;
	open: string | null = null;
	confirmDelete: string | null = null;
	nextId = 0;
	readonly ids = new WeakMap<JsonObject, string>();
}

function objectValue(value: JsonValue): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as JsonObject
		: {};
}

export function displayKey(key: string): string {
	return key.split("\0", 1)[0] ?? key;
}

export function savedIdentity(entry: EntryRecord): string | undefined {
	return typeof entry.value.$from === "string" ? entry.value.$from : undefined;
}

export function entryRecords(
	field: EntriesField,
	value: JsonValue,
	state: EntriesFieldState,
): readonly EntryRecord[] {
	const records: EntryRecord[] = [];
	if (field.shape === "array") {
		if (!Array.isArray(value)) return [];
		value.forEach((entry, index) => {
			const object = objectValue(entry);
			const identity = field.key === undefined ? undefined : object[field.key];
			let id = state.ids.get(object);
			if (id === undefined) {
				state.nextId += 1;
				id = `array-${state.nextId}`;
				state.ids.set(object, id);
			}
			records.push({
				id,
				key: typeof identity === "string" ? identity : String(index + 1),
				value: object,
			});
		});
		return records;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	for (const [key, entry] of Object.entries(value as JsonObject)) {
		const valueObject = objectValue(entry);
		let id = state.ids.get(valueObject);
		if (id === undefined) {
			state.nextId += 1;
			id = `table-${state.nextId}`;
			state.ids.set(valueObject, id);
		}
		records.push({ id, key: displayKey(key), value: valueObject });
	}
	return records;
}

/** Pack entries, preserving duplicate table keys until validation. */
export function packEntries(field: EntriesField, entries: readonly EntryRecord[]): JsonValue {
	if (field.shape === "array") return entries.map((entry) => entry.value);
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
	return Object.fromEntries(entries.map((entry) => [
		counts.get(entry.key) === 1 ? entry.key : `${entry.key}\0${entry.id}`,
		entry.value,
	]));
}

export function entriesCanAdd(field: EntriesField, entries: readonly EntryRecord[]): boolean {
	return field.max === undefined || entries.length < field.max;
}

export function entriesCanRemove(field: EntriesField, entries: readonly EntryRecord[]): boolean {
	return entries.length > (field.min ?? 0);
}

export function addEntry(
	field: EntriesField,
	entries: readonly EntryRecord[],
	state: EntriesFieldState,
): readonly EntryRecord[] {
	state.nextId += 1;
	const id = `new-${state.nextId}`;
	const value = defaultEntry(field.item);
	state.ids.set(value, id);
	state.open = id;
	return [...entries, { id, key: "", value }];
}

export function duplicateEntry(
	field: EntriesField,
	entries: readonly EntryRecord[],
	index: number,
	state: EntriesFieldState,
): readonly EntryRecord[] {
	const original = entries[index];
	if (original === undefined) return entries;
	state.nextId += 1;
	const id = `copy-${state.nextId}`;
	const value = Object.fromEntries(
		Object.entries(original.value).filter(([name]) => name !== "$from"),
	);
	const copy: EntryRecord = {
		id,
		key: field.shape === "table" ? `${original.key}-copy` : original.key,
		value,
	};
	state.ids.set(value, id);
	state.open = id;
	return [...entries.slice(0, index + 1), copy, ...entries.slice(index + 1)];
}

export function moveEntry(
	entries: readonly EntryRecord[],
	index: number,
	delta: number,
): readonly EntryRecord[] {
	const target = index + delta;
	if (target < 0 || target >= entries.length) return entries;
	const next = [...entries];
	const [entry] = next.splice(index, 1);
	if (entry !== undefined) next.splice(target, 0, entry);
	return next;
}

export function entryFormChildren(field: EntriesField): EntriesField["item"] {
	if (field.shape !== "table") return field.item;
	const keyField: Field = {
		type: "text",
		name: "$key",
		label: field.keyLabel ?? "Name",
		required: true,
	};
	return [keyField, ...field.item];
}

/** A summary never exposes a secret's value or raw storage status. */
export function entrySummary(
	field: EntriesField,
	entry: EntryRecord,
	ctx: BlockCtx,
): string {
	return field.summary.map((name) => {
		const item = nestedFields(field.item).find((candidate) => candidate.name === name);
		if (item?.type === "secret") {
			const identity = savedIdentity(entry);
			const statuses = ctx.data.secrets;
			const status = identity !== undefined && typeof statuses === "object" && statuses !== null && !Array.isArray(statuses)
				? statuses[`${field.name}/${identity}/${name}`]
				: undefined;
			return status === "stored" || status === "env" ? "set" : "not set";
		}
		const value = entry.value[name];
		return value === undefined || value === null || value === "" ? "—" : String(value);
	}).join(" · ");
}

export function entriesLines(opts: {
	field: EntriesField;
	entries: readonly EntryRecord[];
	state: EntriesFieldState;
	focused: boolean;
	width: number;
	ctx: BlockCtx;
}): string[] {
	const { field, entries, state, focused, width, ctx } = opts;
	return entries.map((entry, index) => {
		const cursor = focused && index === state.cursor ? "> " : "  ";
		return truncate(`${cursor}${entry.key || "(new entry)"} — ${entrySummary(field, entry, ctx)}`, width);
	});
}

export function entriesHintLine(
	field: EntriesField,
	entries: readonly EntryRecord[],
	width: number,
): string {
	const hints = ["Enter edit"];
	if (entriesCanAdd(field, entries)) hints.push("a add", "d duplicate");
	if (entriesCanRemove(field, entries)) hints.push("x delete");
	if (field.shape === "array" && field.reorder === true && entries.length > 1) hints.push("K/J move");
	hints.push("Esc back");
	return truncate(`  ${hints.join(" · ")}`, width);
}

export function deleteConfirmLine(key: string, width: number): string {
	return truncate(`Delete ${key || "(new entry)"}? y/N`, width);
}
