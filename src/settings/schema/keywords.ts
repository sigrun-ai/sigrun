/**
 * The four sigrun keywords a settings schema may carry (spec §1):
 * `x-sigrun-apply`, `x-sigrun-summary`, `x-sigrun-key`, `x-sigrun-env` — plus the shared
 * structural predicates and JSON-pointer helpers the generator and the
 * load-time checker both use.
 */

/** A JSON Schema document (or subschema), viewed structurally. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** An application class of a settings property (spec §1; default restart). */
export type Apply = "live" | "restart";

export const APPLY_KEYWORD = "x-sigrun-apply";
export const SUMMARY_KEYWORD = "x-sigrun-summary";
export const KEY_KEYWORD = "x-sigrun-key";
export const ENV_KEYWORD = "x-sigrun-env";
export const OVERRIDABLE_KEYWORD = "x-sigrun-overridable";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the apply class of a property schema (default `"restart"`). */
export function applyOf(schema: JsonSchema): Apply {
	return schema[APPLY_KEYWORD] === "live" ? "live" : "restart";
}

/** The row-summary field names declared on an array/table item schema. */
export function summaryOf(schema: JsonSchema): readonly string[] {
	const summary = schema[SUMMARY_KEYWORD];
	return Array.isArray(summary) ? summary.filter((s): s is string => typeof s === "string") : [];
}

/** The identity property declared on an array item schema. */
export function keyOf(schema: JsonSchema): string | undefined {
	const key = schema[KEY_KEYWORD];
	return typeof key === "string" ? key : undefined;
}

/** The environment variable a non-secret string property falls back to. */
export function envOf(schema: JsonSchema): string | undefined {
	const variable = schema[ENV_KEYWORD];
	return typeof variable === "string" ? variable : undefined;
}

/** JSON-pointer escape of one segment (`~` → `~0`, `/` → `~1`). */
export function pointerEscape(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Append a segment to a JSON pointer ("" is the root). */
export function pointerJoin(pointer: string, segment: string): string {
	return `${pointer}/${pointerEscape(segment)}`;
}

/**
 * Resolve a local `$ref` ("#/definitions/x", "#/$defs/x") against the
 * root document. Returns `undefined` for non-local refs or a broken path.
 */
export function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
	if (!ref.startsWith("#/")) return undefined;
	let node: unknown = root;
	for (const raw of ref.slice(2).split("/")) {
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (!isRecord(node)) return undefined;
		node = node[segment];
	}
	return isRecord(node) ? node : undefined;
}

/** Follow `$ref` chains (local only) to the target schema. */
export function deref(root: JsonSchema, schema: JsonSchema): JsonSchema {
	const seen = new Set<string>();
	let current = schema;
	while (typeof current.$ref === "string" && !seen.has(current.$ref)) {
		seen.add(current.$ref);
		const target = resolveRef(root, current.$ref);
		if (!target) return current;
		current = target;
	}
	return current;
}

/**
 * The properties of an object schema, with `$ref`s resolved against the
 * root document. Non-record entries are skipped (checkSchema reports them).
 */
export function propertiesOf(
	root: JsonSchema,
	schema: JsonSchema,
): readonly (readonly [string, JsonSchema])[] {
	const properties = schema.properties;
	if (!isRecord(properties)) return [];
	const result: [string, JsonSchema][] = [];
	for (const [name, child] of Object.entries(properties)) {
		if (isRecord(child)) result.push([name, deref(root, child)]);
	}
	return result;
}

/**
 * The keywords outside the drawable subset.
 *
 * Two drawable keywords are deliberately absent. `propertyNames` constrains
 * a table's row keys only, while the form draws the row values (spec §1
 * admits an `additionalProperties` table "and optional `propertyNames`").
 * `anyOf` is the spelling TypeBox's `Type.Union` emits, so the generator
 * reads a union as a choice or a variant before consulting this list.
 */
const CONDITIONAL_KEYWORDS = [
	"if",
	"then",
	"else",
	"allOf",
	"anyOf",
	"not",
	"dependentSchemas",
	"dependentRequired",
	"patternProperties",
	"prefixItems",
	"contains",
	"unevaluatedProperties",
	"unevaluatedItems",
] as const;

/**
 * Whether the schema carries a keyword outside the drawable subset, so a
 * union the recognisers cannot draw still reaches its fallback.
 */
export function hasNonDrawableKeyword(schema: JsonSchema): boolean {
	return CONDITIONAL_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
}

/**
 * Whether the schema carries a blocking keyword other than `anyOf`. The
 * generator asks this before reading a union, so a union costs nothing
 * while `if`, `allOf`, `patternProperties` and the rest still force the
 * JSON box.
 */
export function hasOtherNonDrawableKeyword(schema: JsonSchema): boolean {
	return CONDITIONAL_KEYWORDS.some((keyword) => keyword !== "anyOf" && schema[keyword] !== undefined);
}

/**
 * The alternatives a schema spells — `oneOf`, or the `anyOf` TypeBox's
 * `Type.Union` emits. Both spellings mean the same thing here.
 */
export function unionBranches(schema: JsonSchema): readonly unknown[] | undefined {
	for (const keyword of ["oneOf", "anyOf"] as const) {
		const value = schema[keyword];
		if (Array.isArray(value) && value.length > 0) return value;
	}
	return undefined;
}
