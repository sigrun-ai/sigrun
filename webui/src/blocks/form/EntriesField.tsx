/**
 * Entries fields (settings rework §3): array and table values render as
 * one-line summaries whose forms open in place. Table keys are edited as
 * the entry's first field; `$from` preserves the loaded identity so core
 * can distinguish a rename from a delete plus add.
 */

import { useState, type ReactNode } from "react";
import type {
	EntriesField,
	Field,
	JsonObject,
	JsonValue,
	SectionBlock,
} from "@sigrun/shared/blocks";
import { boundString, useSurfaceData } from "../context";
import { BlockView } from "../BlockView";
import { FieldRow, FieldView, type FieldProps } from "./fields";
import { defaultEntry, nestedFields } from "./values";

interface EntryRecord {
	readonly id: string;
	readonly key: string;
	readonly value: JsonObject;
}

function records(field: EntriesField, value: JsonValue): readonly EntryRecord[] {
	if (field.shape === "array") {
		if (!Array.isArray(value)) return [];
		return value.map((entry, index) => {
			const object = typeof entry === "object" && entry !== null && !Array.isArray(entry)
				? entry as JsonObject
				: {};
			const identity = field.key === undefined ? undefined : object[field.key];
			return {
				id: String(index),
				key: typeof identity === "string" ? identity : String(index + 1),
				value: object,
			};
		});
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	return Object.entries(value).map(([key, entry]) => ({
		id: key,
		key: displayKey(key),
		value: typeof entry === "object" && entry !== null && !Array.isArray(entry)
			? entry as JsonObject
			: {},
	}));
}

function pack(field: EntriesField, entries: readonly EntryRecord[]): JsonValue {
	if (field.shape === "array") return entries.map((entry) => entry.value);
	return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

/** Duplicate keys stay visible in local state so submit can reject them. */
function packForEdit(field: EntriesField, entries: readonly EntryRecord[]): JsonValue {
	if (field.shape !== "table") return pack(field, entries);
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
	return Object.fromEntries(entries.map((entry) => [
		counts.get(entry.key) === 1 ? entry.key : `${entry.key}\0${entry.id}`,
		entry.value,
	]));
}

function displayKey(key: string): string {
	return key.split("\0", 1)[0] ?? key;
}

function summaryText(field: EntriesField, entry: JsonObject): string {
	return field.summary.map((name) => {
		const item = nestedFields(field.item).find((candidate) => candidate.name === name);
		if (item?.type === "secret") {
			return entry[name] === "stored" || entry[name] === "env" ? "set" : "not set";
		}
		const value = entry[name];
		return value === undefined || value === null || value === "" ? "—" : String(value);
	}).join(" · ");
}

function EntryChildren(props: {
	readonly field: EntriesField;
	readonly entry: EntryRecord;
	readonly disabled: boolean;
	readonly formBind?: string;
	readonly onChange: (entry: JsonObject) => void;
}): ReactNode {
	const { field, entry } = props;
	const keyField: Field = {
		type: "text",
		name: "$key",
		label: field.keyLabel ?? "Name",
		required: true,
	};
	const children: readonly (Field | SectionBlock)[] = field.shape === "table"
		? [keyField, ...field.item]
		: field.item;
	return (
		<div className="blk-entry-form">
			{children.map((child, index) => {
				if (child.type === "section") {
					return (
						<div className="blk blk-section" data-block="section" key={index}>
							{child.title !== undefined && <h3 className="blk-section-title">{boundString(useSurfaceData(), child.title)}</h3>}
							{child.children.map((nested, nestedIndex) => (
								"name" in nested ? (
									<FieldView
										key={nestedIndex}
										field={nested}
										value={entry.value[nested.name]}
										disabled={props.disabled || nested.disabled === true}
										formBind={props.formBind}
										onChange={(_name, value) => props.onChange({ ...entry.value, [nested.name]: value })}
									/>
								) : <BlockView key={nestedIndex} block={nested as never} />
							))}
						</div>
					);
				}
				return (
					<FieldView
						key={index}
						field={child}
						value={child.name === "$key" ? entry.key : entry.value[child.name]}
						disabled={props.disabled || child.disabled === true}
						formBind={props.formBind}
						onChange={(_name, value) => {
							if (child.name === "$key") {
								props.onChange({ ...entry.value, $key: value });
								return;
							}
							props.onChange({ ...entry.value, [child.name]: value });
						}}
					/>
				);
			})}
		</div>
	);
}

function SecretClear(props: {
	readonly field: EntriesField;
	readonly entry: EntryRecord;
	readonly disabled: boolean;
	readonly onChange: (entry: JsonObject) => void;
}): ReactNode {
	return (
		<>
			{nestedFields(props.field.item).filter((field) => field.type === "secret").map((field) => (
				<button
					key={field.name}
					type="button"
					aria-label={`Clear ${boundString(useSurfaceData(), field.label)}`}
					disabled={props.disabled}
					onClick={() => props.onChange({ ...props.entry.value, [field.name]: null })}
				>
					{`Clear ${boundString(useSurfaceData(), field.label)}`}
				</button>
			))}
		</>
	);
}

export function EntriesFieldView(props: FieldProps<EntriesField>): ReactNode {
	const { field } = props;
	const entries = records(field, props.value);
	const [openId, setOpenId] = useState<string | null>(null);
	const min = field.min ?? 0;
	const max = field.max;
	const canAdd = !props.disabled && (max === undefined || entries.length < max);
	const canRemove = !props.disabled && entries.length > min;
	const canReorder = !props.disabled && field.shape === "array" && field.reorder === true;
	const write = (next: readonly EntryRecord[]): void => props.onChange(field.name, pack(field, next));
	const writeEdit = (next: readonly EntryRecord[]): void => props.onChange(field.name, packForEdit(field, next));
	const entryBind = (entry: EntryRecord): string | undefined => props.formBind === undefined
		? undefined
		: `${props.formBind}/${field.name}/${field.shape === "table" ? entry.id : entry.value.$from ?? entry.id}`;

	const changeEntry = (index: number, value: JsonObject): void => {
		const next = entries.map((entry, at) => at === index
			? { ...entry, key: typeof value.$key === "string" ? value.$key : entry.key, value: Object.fromEntries(Object.entries(value).filter(([name]) => name !== "$key")) }
			: entry);
		writeEdit(next);
	};
	const duplicate = (index: number): void => {
		const original = entries[index];
		if (original === undefined) return;
		const value = Object.fromEntries(Object.entries(original.value).filter(([name]) => name !== "$from"));
		const copy = { ...original, id: `${original.id}-copy-${Date.now()}`, key: field.shape === "table" ? `${original.key}-copy` : original.key, value };
		write([...entries.slice(0, index + 1), copy, ...entries.slice(index + 1)]);
		setOpenId(copy.id);
	};
	const remove = (index: number): void => {
		write(entries.filter((_, at) => at !== index));
		setOpenId(null);
	};
	const move = (index: number, delta: number): void => {
		const target = index + delta;
		if (target < 0 || target >= entries.length) return;
		const next = [...entries];
		const [entry] = next.splice(index, 1);
		if (entry !== undefined) next.splice(target, 0, entry);
		write(next);
	};
	const add = (): void => {
		const entry: EntryRecord = {
			id: `new-${Date.now()}`,
			key: "",
			value: defaultEntry(field.item),
		};
		write([...entries, entry]);
		setOpenId(entry.id);
	};
	const isOpen = (entry: EntryRecord): boolean => openId === entry.id || openId === entry.key || (entry.key === "" && openId?.startsWith("new-") === true);

	return (
		<FieldRow field={field} error={props.error}>
			<div className="blk-entries" data-shape={field.shape}>
				{entries.map((entry, index) => (
					<div className="blk-entry" key={entry.id}>
						<div className="blk-entry-row">
							<button
								type="button"
								className="blk-entry-summary"
								aria-label={`Edit entry ${entry.key}`}
								aria-expanded={isOpen(entry)}
								onClick={() => setOpenId(isOpen(entry) ? null : entry.id)}
							>
								<span className="blk-entry-key" dir="auto">{entry.key || "(new entry)"}</span>
								<span dir="auto">{summaryText(field, entry.value)}</span>
							</button>
							<div className="blk-entry-actions">
								{canReorder && (
									<>
										<button type="button" aria-label={`move entry ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
										<button type="button" aria-label={`move entry ${index + 1} down`} disabled={index === entries.length - 1} onClick={() => move(index, 1)}>↓</button>
									</>
								)}
								<button type="button" aria-label={`Duplicate entry ${entry.key}`} disabled={props.disabled || !canAdd} onClick={() => duplicate(index)}>Duplicate</button>
								<button type="button" aria-label={`Delete entry ${entry.key}`} disabled={!canRemove} onClick={() => remove(index)}>Delete</button>
							</div>
						</div>
						{isOpen(entry) && (
							<>
								<EntryChildren field={field} entry={entry} disabled={props.disabled} formBind={entryBind(entry)} onChange={(value) => changeEntry(index, value)} />
								<SecretClear field={field} entry={entry} disabled={props.disabled} onChange={(value) => changeEntry(index, value)} />
							</>
						)}
					</div>
				))}
				<button type="button" disabled={!canAdd} onClick={add}>+ Add</button>
			</div>
		</FieldRow>
	);
}
