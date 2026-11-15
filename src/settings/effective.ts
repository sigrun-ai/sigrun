/**
 * Task 4: Overridable settings and effective resolution.
 *
 * `x-sigrun-overridable` marks a leaf schema property as user-overridable.
 * `overridableKeys` lists the dotted keys; `overridesSchema` derives the
 * user-facing form schema (nested, defaults stripped, additionalProperties
 * false at every object level).
 *
 * `mergedUserSchema` adds an extension's overridable system settings to
 * its own per-user schema; `applyOverrides` resolves one user's raw stored
 * overrides over the checked system values.
 *
 * `createEffectiveSettings` resolves a setting per user: the stored
 * override when the key is marked and set, else the system value.
 */

import { Errors } from "typebox/schema";
import type { JsonValue } from "@sigrun/shared/blocks";
import {
	ENV_KEYWORD,
	INHERIT_KEYWORD,
	OVERRIDABLE_KEYWORD,
	deref,
	isRecord,
	propertiesOf,
	type JsonSchema,
} from "./schema/keywords.js";
import type { DirectoryUser } from "../harness/identity/users.js";
import { primaryAdmin } from "../harness/identity/primary-admin.js";

export { OVERRIDABLE_KEYWORD } from "./schema/keywords.js";
export { checkSchema } from "./schema/generate.js";

// ─── overridableKeys ────────────────────────────────────────────────────

/** Walk the schema and return dotted keys of every marked leaf. */
export function overridableKeys(schema: JsonSchema): readonly string[] {
	const keys: string[] = [];
	function walk(node: JsonSchema, prefix: string): void {
		if (node[OVERRIDABLE_KEYWORD] === true) {
			keys.push(prefix);
			return;
		}
		for (const [name, child] of propertiesOf(node, node)) {
			walk(child, prefix === "" ? name : `${prefix}.${name}`);
		}
	}
	walk(schema, "");
	return keys;
}

// ─── overridesSchema ────────────────────────────────────────────────────

/** Derive the user-facing overrides schema from the full core schema. */
export function overridesSchema(schema: JsonSchema): JsonSchema {
	function walk(node: JsonSchema, root: JsonSchema): JsonSchema | undefined {
		// Leaf with the marker → strip default, keep the rest
		if (node[OVERRIDABLE_KEYWORD] === true) {
			const { default: _default, [OVERRIDABLE_KEYWORD]: _marker, ...rest } = node;
			return rest;
		}
		// Object with properties → recurse
		if (node.type === "object" || isRecord(node.properties)) {
			const result: Record<string, unknown> = {};
			for (const [name, child] of propertiesOf(root, node)) {
				const filtered = walk(child, root);
				if (filtered !== undefined) result[name] = filtered;
			}
			if (Object.keys(result).length === 0) return undefined;
			return {
				type: "object",
				properties: result,
				additionalProperties: false,
			};
		}
		// Not marked, not an object → excluded
		return undefined;
	}

	const root = walk(schema, schema);
	return root ?? { type: "object", properties: {}, additionalProperties: false };
}

// ─── extension overrides ────────────────────────────────────────────────

/** Remove server env metadata from every drawable descendant of a leaf. */
function stripEnv(node: JsonSchema): JsonSchema {
	const { [ENV_KEYWORD]: _serverEnv, ...stripped } = node;
	const properties = isRecord(node.properties)
		? Object.fromEntries(Object.entries(node.properties).map(([name, child]) =>
			isRecord(child) ? [name, stripEnv(child)] : [name, child]
		))
		: undefined;
	return {
		...stripped,
		...(properties === undefined ? {} : { properties }),
		...(isRecord(node.items) ? { items: stripEnv(node.items) } : {}),
		...(isRecord(node.additionalProperties)
			? { additionalProperties: stripEnv(node.additionalProperties) }
			: {}),
	};
}

/** Merge definition bags; system wins a name collision. Personal schemas
 * cannot declare env metadata, so stripping the merged bag closes $ref leaks
 * without changing personal references. */
function mergeDefinitions(
	personal: unknown,
	system: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(personal) && !isRecord(system)) return undefined;
	const merged = {
		...(isRecord(personal) ? personal : {}),
		...(isRecord(system) ? system : {}),
	};
	return Object.fromEntries(Object.entries(merged).map(([name, definition]) =>
		isRecord(definition) ? [name, stripEnv(definition)] : [name, definition]
	));
}

/** TypeBox's detached-leaf context resolves local refs by pointer key. */
function refContext(schema: JsonSchema): Record<PropertyKey, JsonSchema> {
	const context: Record<PropertyKey, JsonSchema> = {};
	for (const keyword of ["$defs", "definitions"]) {
		const definitions = schema[keyword];
		if (!isRecord(definitions)) continue;
		for (const [name, definition] of Object.entries(definitions)) {
			if (isRecord(definition)) context[`#/${keyword}/${name}`] = definition;
		}
	}
	return context;
}

/** One dotted setting path, read from an ordinary nested settings object. */
function valueAtKey(value: Record<string, unknown>, key: string): JsonValue | undefined {
	let current: unknown = value;
	for (const segment of key.split(".")) {
		if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
		current = current[segment];
	}
	return current as JsonValue | undefined;
}

/** Write one dotted setting path into an ordinary nested settings object. */
function setAtKey(value: Record<string, unknown>, key: string, replacement: unknown): void {
	const segments = key.split(".");
	let current = value;
	for (const segment of segments.slice(0, -1)) {
		const existing = current[segment];
		if (!isRecord(existing)) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[segments.at(-1)!] = replacement;
}

function propertyAtKey(schema: JsonSchema, key: string): JsonSchema | undefined {
	let current = schema;
	for (const segment of key.split(".")) {
		current = deref(schema, current);
		const property = propertiesOf(schema, current).find(([name]) => name === segment)?.[1];
		if (property === undefined) return undefined;
		current = property;
	}
	return deref(schema, current);
}

/**
 * Resolve an extension's checked system settings for one user. Presence in
 * the user's raw file decides: null and schema-invalid values stay system;
 * every valid value, including "" and [], replaces the system value.
 */
export function applyOverrides(
	schema: JsonSchema,
	system: Record<string, unknown>,
	stored: Record<string, unknown>,
	warn: (key: string) => void = () => {},
): Record<string, unknown> {
	const effective = structuredClone(system);
	const context = refContext(schema);
	for (const key of overridableKeys(schema)) {
		const override = valueAtKey(stored, key);
		if (override === undefined || override === null) continue;
		const property = propertyAtKey(schema, key);
		if (property !== undefined && Errors(context, property, override)[0] === true) {
			setAtKey(effective, key, override);
		} else {
			warn(key);
		}
	}
	return effective;
}

/**
 * Merge an extension's personal schema with its overridable system leaves.
 * The personal root stays open: existing files may carry stray keys, and a
 * checked read must not suddenly repair them or post an invalid notice.
 */
export function mergedUserSchema(
	schema: JsonSchema,
	userSchema: JsonSchema | undefined,
): JsonSchema | undefined {
	const overrides = overridesSchema(schema);
	const overrideProperties = isRecord(overrides.properties) ? overrides.properties : {};
	const userProperties = userSchema !== undefined && isRecord(userSchema.properties)
		? userSchema.properties
		: {};
	if (Object.keys(overrideProperties).length === 0 && Object.keys(userProperties).length === 0) {
		return undefined;
	}
	function inheritLeaves(
		node: JsonSchema,
		personal: JsonSchema | undefined,
	): JsonSchema {
		if (node.type === "object" || isRecord(node.properties)) {
			const personalProperties = personal !== undefined && isRecord(personal.properties)
				? personal.properties
				: {};
			const properties: Record<string, unknown> = { ...personalProperties };
			for (const [name, child] of propertiesOf(node, node)) {
				const personalChild = personalProperties[name];
				properties[name] = inheritLeaves(
					child,
					isRecord(personalChild) ? personalChild : undefined,
				);
			}
			return { ...(personal ?? node), properties };
		}
		return { ...stripEnv(node), [INHERIT_KEYWORD]: true };
	}
	const inherited = Object.fromEntries(
		Object.entries(overrideProperties).flatMap(([name, property]) => {
			if (!isRecord(property)) return [];
			const personal = userProperties[name];
			return [[name, inheritLeaves(property, isRecord(personal) ? personal : undefined)]];
		}),
	);
	const $defs = mergeDefinitions(userSchema?.$defs, schema.$defs);
	const definitions = mergeDefinitions(userSchema?.definitions, schema.definitions);
	return {
		...(userSchema ?? { type: "object" }),
		...($defs === undefined ? {} : { $defs }),
		...(definitions === undefined ? {} : { definitions }),
		properties: { ...userProperties, ...inherited },
	};
}

/** Dotted overridable keys declared directly in userSchema (a conflict). */
export function userDeclaredOverridableKeys(
	schema: JsonSchema,
	userSchema: JsonSchema,
): readonly string[] {
	return overridableKeys(schema).filter((key) => propertyAtKey(userSchema, key) !== undefined);
}

// ─── createEffectiveSettings ────────────────────────────────────────────

export interface EffectiveSettingsDeps {
	/** The core schema (for overridableKeys). */
	readonly schema: JsonSchema;
	/** The RESOLVED system value for a key (env-first for defaultModel). */
	readonly system: (key: string) => unknown;
	/** Read the user's stored overrides file (user-settings/<user>/core.json). */
	readonly overrides: (user: string) => Promise<Record<string, unknown>>;
	/** The live user directory. */
	readonly directory: () => readonly DirectoryUser[];
}

export interface EffectiveSettings {
	/** Resolve a user: undefined stays undefined; a named user missing from the directory becomes the primary admin; empty directory → undefined. */
	user(user: string | undefined): string | undefined;
	/** The effective value for a key: the resolved user's stored override when marked and set, else system(key). */
	value(key: string, user: string | undefined): Promise<unknown>;
}

export function createEffectiveSettings(deps: EffectiveSettingsDeps): EffectiveSettings {
	const marked = new Set(overridableKeys(deps.schema));

	function resolveUser(user: string | undefined): string | undefined {
		if (user === undefined) return undefined;
		const records = deps.directory();
		if (records.length === 0) return undefined;
		if (records.some((r) => r.user === user)) return user;
		return primaryAdmin(records)?.user;
	}

	return {
		user: resolveUser,
		async value(key: string, user: string | undefined): Promise<unknown> {
			const resolved = resolveUser(user);
			if (resolved !== undefined && marked.has(key)) {
				const stored = await deps.overrides(resolved);
				const override = stored[key];
				// Blank strings are unset (parity with plan 1's blank-strip rule)
				if (override !== undefined && override !== "") return override;
			}
			return deps.system(key);
		},
	};
}
