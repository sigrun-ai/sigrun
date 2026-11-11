/**
 * Blank-optional-string drop (settings-split quick fixes, bug 2): an
 * untouched optional text field is submitted as `""` by the channel,
 * and a `minLength: 1` schema would otherwise reject the whole save.
 * The drop treats `""` on an OPTIONAL string property as "unset" and
 * removes the key before validation/persistence. Required strings and
 * writeOnly secrets are never touched (a blank required string still
 * reaches the schema and fails its minLength; a blank writeOnly field
 * means "unchanged" and is handled by the secret walk).
 *
 * The pass recurses into nested `properties` objects,
 * `additionalProperties` table rows, and `items` array members,
 * following local `$ref`s against the root document.
 */

import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";
import type { JsonSchema } from "./keywords.js";
import { deref, isRecord as isRec } from "./keywords.js";

export function dropBlankOptionalStrings(
	values: Record<string, unknown>,
	schema: JsonSchema,
): Record<string, unknown> {
	return walk(values, schema, schema) as Record<string, unknown>;
}

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
		if (
			child === "" &&
			resolved.type === "string" &&
			resolved.writeOnly !== true &&
			!required.has(key)
		) {
			continue;
		}
		result[key] = walk(child, property, root);
	}
	return result;
}
