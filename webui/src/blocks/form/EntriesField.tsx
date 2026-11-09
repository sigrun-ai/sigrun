/**
 * Entries fields (settings rework §3): array and table values render as
 * one-line summaries whose forms open in place. Table keys are edited as
 * the entry's first field; `$from` preserves the loaded identity so core
 * can distinguish a rename from a delete plus add.
 */

import { useRef, useState, type ReactNode } from "react";
import type {
	EntriesField,
	Field,
	JsonObject,
	JsonValue,
	SectionBlock,
} from "@sigrun/shared/blocks";
import { boundString, useSurfaceData, type SurfaceDataCtx } from "../context";
import { BlockView } from "../BlockView";
import { FieldRow, FieldView, type FieldProps } from "./fields";
import { defaultEntry, nestedFields } from "./values";

interface EntryRecord {
	/** Stable across value edits, reorder, and duplicate-key local states. */
	readonly id: string;
	readonly key: string;
	readonly value: JsonObject;
}

type IdRegistry = {
	readonly ids: WeakMap<JsonObject, string>;
	next: number;
};

function records(
	field: EntriesField,
	value: JsonValue,
	registry: IdRegistry,
): readonly EntryRecord[] {
	const idFor = (entry: JsonObject): string => {
		const existing = registry.ids.get(entry);
		if (existing !== undefined) return existing;
		registry.next += 1;
		const id = `entry-${registry.next}`;
		registry.ids.set(entry, id);
		return id;
	};
	const record = (key: string, entry: JsonValue): EntryRecord => {
		const object = typeof entry === "object" && entry !== null && !Array.isArray(entry)
			? entry as JsonObject
			: {};
		return { id: idFor(object), key, value: object };
	};
	if (field.shape === "array") {
		if (!Array.isArray(value)) return [];
		return value.map((entry, index) => {
			const object = typeof entry === "object" && entry !== null && !Array.isArray(entry)
				? entry as JsonObject
				: {};
			const identity = field.key === undefined ? undefined : object[field.key];
			return record(typeof identity === "string" ? identity : String(index + 1), object);
		});
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	return Object.entries(value).map(([key, entry]) => record(displayKey(key), entry));
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

/** The saved entry identity; new and duplicated entries have none. */
function savedIdentity(entry: EntryRecord): string | undefined {
	return typeof entry.value.$from === "string" ? entry.value.$from : undefined;
}

function summaryText(
	field: EntriesField,
	entry: EntryRecord,
	data: SurfaceDataCtx,
): string {
	return field.summary.map((name) => {
		const item = nestedFields(field.item).find((candidate) => candidate.name === name);
		if (item?.type === "secret" || (item?.type === "entries" && item.item.some((child) => child.type === "secret"))) {
			const identity = savedIdentity(entry);
			const statuses = data.data.secrets;
			if (identity === undefined || typeof statuses !== "object" || statuses === null || Array.isArray(statuses)) return "not set";
			const records: JsonObject = statuses;
			if (item.type === "entries") {
				const prefix = `${field.name}/${identity}/${name}/`;
				return Object.entries(records).some(([key, status]) => key.startsWith(prefix) && (status === "stored" || status === "env")) ? "set" : "not set";
			}
			const status = records[`${field.name}/${identity}/${name}`];
			return status === "stored" || status === "env" ? "set" : "not set";
		}
		const value = entry.value[name];
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
	const data = useSurfaceData();
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
							{child.title !== undefined && <h3 className="blk-section-title">{boundString(data, child.title)}</h3>}
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
	const data = useSurfaceData();
	return (
		<>
			{nestedFields(props.field.item).filter((field) => field.type === "secret").map((field) => (
				<button
					key={field.name}
					type="button"
					aria-label={`Clear ${boundString(data, field.label)}`}
					disabled={props.disabled}
					onClick={() => props.onChange({ ...props.entry.value, [field.name]: null })}
				>
					{`Clear ${boundString(data, field.label)}`}
				</button>
			))}
		</>
	);
}

export function EntriesFieldView(props: FieldProps<EntriesField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	const registry = useRef<IdRegistry>({ ids: new WeakMap(), next: 0 });
	const entries = records(field, props.value, registry.current);
	const [openId, setOpenId] = useState<string | null>(null);
	const min = field.min ?? 0;
	const max = field.max;
	const canAdd = !props.disabled && (max === undefined || entries.length < max);
	const canRemove = !props.disabled && entries.length > min;
	const canReorder = !props.disabled && field.shape === "array" && field.reorder === true;
	const writeEdit = (next: readonly EntryRecord[]): void => props.onChange(field.name, packForEdit(field, next));
	const entryBind = (entry: EntryRecord): string | undefined => {
		if (props.formBind === undefined) return undefined;
		const identity = savedIdentity(entry) ?? `unsaved-${entry.id}`;
		return `${props.formBind}/${field.name}/${identity}`;
	};

	const changeEntry = (index: number, value: JsonObject): void => {
		const next = entries.map((entry, at) => {
			if (at !== index) return entry;
			const nextValue = Object.fromEntries(Object.entries(value).filter(([name]) => name !== "$key"));
			// Preserve the row id when a controlled field replaces its object.
			registry.current.ids.set(nextValue, entry.id);
			return {
				...entry,
				key: typeof value.$key === "string" ? value.$key : entry.key,
				value: nextValue,
			};
		});
		writeEdit(next);
	};
	const duplicate = (index: number): void => {
		const original = entries[index];
		if (original === undefined) return;
		const value = Object.fromEntries(Object.entries(original.value).filter(([name]) => name !== "$from"));
		registry.current.next += 1;
		const copy: EntryRecord = {
			id: `entry-${registry.current.next}`,
			key: field.shape === "table" ? `${original.key}-copy` : original.key,
			value,
		};
		registry.current.ids.set(value, copy.id);
		writeEdit([...entries.slice(0, index + 1), copy, ...entries.slice(index + 1)]);
		setOpenId(copy.id);
	};
	const remove = (index: number): void => {
		writeEdit(entries.filter((_, at) => at !== index));
		setOpenId(null);
	};
	const move = (index: number, delta: number): void => {
		const target = index + delta;
		if (target < 0 || target >= entries.length) return;
		const next = [...entries];
		const [entry] = next.splice(index, 1);
		if (entry !== undefined) next.splice(target, 0, entry);
		writeEdit(next);
	};
	const add = (): void => {
		const value = defaultEntry(field.item);
		registry.current.next += 1;
		const entry: EntryRecord = { id: `entry-${registry.current.next}`, key: "", value };
		registry.current.ids.set(value, entry.id);
		writeEdit([...entries, entry]);
		setOpenId(entry.id);
	};

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
								aria-expanded={openId === entry.id}
								onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
							>
								<span className="blk-entry-key" dir="auto">{entry.key || "(new entry)"}</span>
								<span dir="auto">{summaryText(field, entry, data)}</span>
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
						{openId === entry.id && (
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
