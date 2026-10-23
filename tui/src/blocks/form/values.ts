/**
 * Form values plumbing (UI-blocks U2 Task 5, spec §5.6 — the port of
 * U1's `form/values.ts`): the form reads its initial values from the
 * bound object and tracks edits locally; these helpers flatten the
 * field tree (sections nest fields), read a field's value out of the
 * bound object, and validate a value against the shared field props
 * (`required`, `min`/`max`, `minLength`/`maxLength`, `pattern`).
 */

import type { Field, FormBlock, JsonValue, SectionBlock } from "@sigrun/shared/blocks";

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

/** The initial value of a field from the bound object (missing →
 *  a type-appropriate empty; a secret is write-only — the bound slot
 *  carries the STATUS, never a value to echo back, §5.6/§15). */
export function initialValue(field: Field, bound: Record<string, JsonValue>): JsonValue {
	if (field.type === "secret") return "";
	const value = bound[field.name];
	if (value !== undefined) return value;
	switch (field.type) {
		case "toggle":
			return false;
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

/** Client validation (spec §5.6): the error message or null.
 *  `label` names the field in the message. */
export function validateField(field: Field, value: JsonValue, label: string): string | null {
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
