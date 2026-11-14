/**
 * Blank-means-unset drop (settings finishing pass): an untouched optional
 * field is submitted as `""` (or `null`, or — for a list — `[]`, or — for
 * an object — `{}` after its own children blanked out), and the schema
 * would otherwise reject the whole save (`must be integer`, `must be
 * number`, `must not have fewer than 1 items`). The drop treats those
 * values on an OPTIONAL, non-`writeOnly` property as "unset" and removes
 * the key before validation/persistence.
 *
 * The rules, per optional property value:
 *   - `""` on any scalar type is unset.
 *   - `null` is unset.
 *   - `[]` is unset when the resolved schema has `minItems >= 1` (the
 *     minItems constraint means the empty list carries no signal — e.g.
 *     Bifrost's "no model matches, use the heuristic").
 *   - `{}` is unset when its own children all dropped out (so the empty
 *     object was the parent's only real content).
 *
 * Required properties and `writeOnly` secrets are never touched (a blank
 * required value still reaches the schema and fails its constraint; a
 * blank `writeOnly` field means "unchanged" and is handled by the secret
 * walk). Array ITEMS are traversed but never removed.
 *
 * The pass recurses into nested `properties` objects,
 * `additionalProperties` table rows, and `items` array members, following
 * local `$ref`s against the root document.
 */

import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";
import type { JsonSchema } from "./keywords.js";
import { deref, isRecord as isRec } from "./keywords.js";

export function dropBlankUnsets(
	values: Record<string, unknown>,
	schema: JsonSchema,
): Record<string, unknown> {
	return walk(values, schema, schema) as Record<string, unknown>;
}

/** Back-compat alias for one minor — the published subpath export. */
export const dropBlankOptionalStrings = dropBlankUnsets;

function walk(value: unknown, node: unknown, root: JsonSchema): JsonValue {
	if (!isRec(node)) return value as JsonValue;
	const schema = deref(root, node);
	if (Array.isArray(value)) {
		return value.map((entry) => walk(entry, schema.items, root));
	}
	if (!isRec(value)) return value as JsonValue;
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((key): key is string => typeof key === "string")
			: [],
	);
	const properties = isRec(schema.properties) ? schema.properties : {};
	const additional = schema.additionalProperties;
	const result: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		const property = Object.hasOwn(properties, key) ? properties[key] : additional;
		if (!isRec(property)) {
			result[key] = child as JsonValue;
			continue;
		}
		const resolved = deref(root, property);
		// writeOnly keeps today's handling: blank = unchanged (the secret
		// walk handles it), null = clear (also the secret walk).
		const isWriteOnly = resolved.writeOnly === true;
		// Required fields still reach the schema; only OPTIONAL properties
		// participate in blank-means-unset.
		const isOptional = !required.has(key);
		if (isOptional && !isWriteOnly) {
			if (child === "" || child === null) continue;
			if (
				Array.isArray(child) &&
				child.length === 0 &&
				typeof resolved.minItems === "number" &&
				resolved.minItems >= 1
			) {
				continue;
			}
		}
		const walked = walk(child, property, root);
		// After the recursive walk, an optional object whose children ALL
		// dropped out becomes the empty {} — that empty object is itself
		// unset (its only content was the blanks we just dropped).
		if (
			isOptional &&
			!isWriteOnly &&
			isRec(walked) &&
			resolved.type === "object" &&
			Object.keys(walked).length === 0
		) {
			continue;
		}
		result[key] = walked;
	}
	return result;
}
