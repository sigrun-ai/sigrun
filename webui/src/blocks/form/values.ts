/**
 * Form values plumbing (UI-blocks U1 Task 5, spec §5.6): the form reads
 * its initial values from the bound object and tracks edits locally;
 * these helpers flatten the field tree (sections nest fields), read a
 * field's value out of the bound object, and validate a value against
 * the shared field props (`required`, `min`/`max`, `minLength`/
 * `maxLength`, `pattern`).
 */

import type {
	EntriesField,
	Field,
	FormBlock,
	JsonObject,
	JsonValue,
	SectionBlock,
	VariantField,
} from "@sigrun/shared/blocks";

/** Whether a form child is a field (sections hold fields/blocks). */
export function isFieldNode(node: unknown): node is Field {
	return (
		typeof node === "object" &&
		node !== null &&
		typeof (node as Field).type === "string" &&
		typeof (node as Field).name === "string"
	);
}

/** Alias kept to the brief's vocabulary (fields are nodes of a form). */
const isField = isFieldNode;

/** The fields nested in an entries item or a variant option. */
export function nestedFields(children: readonly (Field | SectionBlock)[]): readonly Field[] {
	return collectFields({ children } as FormBlock);
}

/** A fresh object entry from the item's field defaults. */
export function defaultEntry(children: readonly (Field | SectionBlock)[]): JsonObject {
	const entry: JsonObject = {};
	for (const child of nestedFields(children)) entry[child.name] = initialValue(child, {});
	return entry;
}

/** Entries keep the identity they were loaded under for secret moves. */
function initialEntries(field: EntriesField, value: JsonValue | undefined): JsonValue {
	if (field.shape === "array") {
		if (!Array.isArray(value)) return [];
		return value.map((entry) => {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
			const identity = field.key === undefined ? undefined : (entry as JsonObject)[field.key];
			return { ...defaultEntry(field.item), ...(entry as JsonObject), ...(typeof identity === "string" ? { $from: identity } : {}) };
		});
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as JsonObject).map(([key, entry]) => [
			key,
			typeof entry === "object" && entry !== null && !Array.isArray(entry)
				? { ...defaultEntry(field.item), ...(entry as JsonObject), $from: key }
				: entry,
		]),
	);
}

function initialVariant(field: VariantField, value: JsonValue | undefined): JsonValue {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
	return { [field.discriminator]: field.options[0]?.id ?? "" };
}

/** All fields of the form, depth-first through sections. */
export function collectFields(block: FormBlock): readonly Field[] {
	const out: Field[] = [];
	const walk = (children: FormBlock["children"] | SectionBlock["children"]): void => {
		for (const child of children) {
			if (isField(child)) out.push(child);
			else if (
				typeof child === "object" &&
				child !== null &&
				(child as SectionBlock).type === "section"
			) {
				walk((child as SectionBlock).children);
			}
		}
	};
	walk(block.children);
	return out;
}

/** The initial value of a field from the bound object (missing →
 *  a type-appropriate empty: the render contract renders missing as
 *  empty, never undefined into a controlled input). */
export function initialValue(field: Field, bound: Record<string, JsonValue>): JsonValue {
	// Write-only (§5.6/§15): the bound slot carries the STATUS
	// (`stored`/`env`), never a value to echo back — check before the
	// bound lookup so the status string never lands in the input.
	if (field.type === "secret") return "";
	const value = bound[field.name];
	if (field.type === "entries") return initialEntries(field, value);
	if (field.type === "variant") return initialVariant(field, value);
	if (value !== undefined) return value;
	if (field.type !== "toggle" && "default" in field) {
		const value = (field as Field & { readonly default?: JsonValue }).default;
		if (value !== undefined) return value;
	}
	switch (field.type) {
		case "toggle":
			// §13.4 fix: a default-ON settings toggle initializes ON when
			// the bound value is absent (absent = the default).
			return field.default === true;
		case "choice": {
			// An interaction's recommended option pre-selects (the §9.1
			// presentation rule); bound data always wins (a settled record's
			// stored answer seeds above).
			if (Array.isArray(field.options)) {
				const recommended = field.options
					.filter((option) => option.recommended === true)
					.map((option) => option.id);
				if (field.multi === true) {
					return recommended;
				}
				if (recommended.length > 0) return recommended[0] as string;
			}
			return field.multi === true ? [] : "";
		}
		case "list":
			return [];
		case "daterange":
			return {};
		default:
			return "";
	}
}

/** Table identity is validated against every sibling before dispatch. */
function validateTableKeys(field: EntriesField, value: JsonValue): string | null {
	if (field.shape !== "table" || typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const keys = Object.keys(value as JsonObject).map((key) => key.split("\0", 1)[0] ?? key);
	if (keys.some((key) => key.trim() === "")) return `${field.keyLabel ?? "Name"} is required`;
	if (new Set(keys).size !== keys.length) return `${field.keyLabel ?? "Name"} must be unique`;
	return null;
}

/** Client validation (spec §5.6): returns the error message or null.
 *  `label` names the field in the message. */
export function validateField(field: Field, value: JsonValue, label: string): string | null {
	if (field.type === "entries") {
		const keyError = validateTableKeys(field, value);
		if (keyError !== null) return keyError;
	}
	const empty =
		value === undefined ||
		value === null ||
		value === "" ||
		(Array.isArray(value) && value.length === 0) ||
		(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
	if (field.required === true && empty) return `${label} is required`;
	if (empty) return null;

	if (typeof value === "number") {
		if (field.min !== undefined && value < field.min) {
			return `${label} must be at least ${field.min}`;
		}
		if (field.max !== undefined && value > field.max) {
			return `${label} must be at most ${field.max}`;
		}
	}
	if (typeof value === "string") {
		if (field.minLength !== undefined && value.length < field.minLength) {
			return `${label} must be at least ${field.minLength} characters`;
		}
		if (field.maxLength !== undefined && value.length > field.maxLength) {
			return `${label} must be at most ${field.maxLength} characters`;
		}
		if (field.pattern !== undefined && value !== "") {
			let regex: RegExp | null = null;
			try {
				regex = new RegExp(`^(?:${field.pattern})$`);
			} catch {
				regex = null;
			}
			if (regex !== null && !regex.test(value)) {
				return `${label} does not match ${field.pattern}`;
			}
		}
	}
	if (Array.isArray(value)) {
		if (field.min !== undefined && value.length < field.min) {
			return `${label} needs at least ${field.min} entries`;
		}
		if (field.max !== undefined && value.length > field.max) {
			return `${label} allows at most ${field.max} entries`;
		}
	}
	return null;
}
