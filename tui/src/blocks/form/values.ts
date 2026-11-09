/**
 * Form values plumbing (UI-blocks U2 Task 5, spec §5.6 — the port of
 * U1's `form/values.ts`): the form reads its initial values from the
 * bound object and tracks edits locally; these helpers flatten the
 * field tree (sections nest fields), read a field's value out of the
 * bound object, and validate a value against the shared field props
 * (`required`, `min`/`max`, `minLength`/`maxLength`, `pattern`).
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

/** All fields of the form, depth-first through sections. */
export function collectFields(block: FormBlock): readonly Field[] {
	const out: Field[] = [];
	const walk = (children: FormBlock["children"] | SectionBlock["children"]): void => {
		for (const child of children) {
			if (isFieldNode(child)) out.push(child);
			else if (
				typeof child === "object" &&
				child !== null &&
				(child as SectionBlock).type === "section"
			) {
				walk((child as SectionBlock).children);
			}
		}
	}
	walk(block.children);
	return out;
}

/** Fields nested in an entries item or a variant option. */
export function nestedFields(children: readonly (Field | SectionBlock)[]): readonly Field[] {
	return collectFields({ children } as FormBlock);
}

/** A fresh entry seeded from the item fields' defaults. */
export function defaultEntry(children: readonly (Field | SectionBlock)[]): JsonObject {
	const entry: JsonObject = {};
	for (const child of nestedFields(children)) {
		const declared = "default" in child
			? (child as Field & { readonly default?: JsonValue }).default
			: undefined;
		entry[child.name] = declared ?? initialValue(child, {});
	}
	return entry;
}

/** Entries retain the identity they were loaded under (`$from`). */
function initialEntries(field: EntriesField, value: JsonValue | undefined): JsonValue {
	if (field.shape === "array") {
		if (!Array.isArray(value)) return [];
		return value.map((entry) => {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
			const identity = field.key === undefined ? undefined : (entry as JsonObject)[field.key];
			return {
				...defaultEntry(field.item),
				...(entry as JsonObject),
				...(typeof identity === "string" ? { $from: identity } : {}),
			};
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

/** The initial value of a field from the bound object (missing →
 *  a type-appropriate empty; a secret is write-only — the bound slot
 *  carries the STATUS, never a value to echo back, §5.6/§15). */
export function initialValue(field: Field, bound: Record<string, JsonValue>): JsonValue {
	if (field.type === "secret") return "";
	const value = bound[field.name];
	if (field.type === "entries") return initialEntries(field, value);
	if (field.type === "variant") return initialVariant(field, value);
	if (value !== undefined) return value;
	switch (field.type) {
		case "toggle":
			// §13.4 fix: a default-ON toggle initializes ON when the bound
			// value is absent (absent = the default).
			return field.default === true;
		case "choice":
			return field.multi === true ? [] : "";
		case "list":
			return [];
		case "daterange":
			return {};
		default:
			return "";
	}
}

/** Table keys remain visible in local state but must be valid on save. */
function validateTableKeys(field: EntriesField, value: JsonValue): string | null {
	if (field.shape !== "table" || typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const keys = Object.keys(value as JsonObject).map((key) => key.split("\0", 1)[0] ?? key);
	if (keys.some((key) => key.trim() === "")) return `${field.keyLabel ?? "Name"} is required`;
	if (new Set(keys).size !== keys.length) return `${field.keyLabel ?? "Name"} must be unique`;
	return null;
}

/** Client validation (spec §5.6): the error message or null.
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
