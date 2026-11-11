/**
 * Task 4: Overridable settings and effective resolution.
 *
 * `x-sigrun-overridable` marks a leaf schema property as user-overridable.
 * `overridableKeys` lists the dotted keys; `overridesSchema` derives the
 * user-facing form schema (nested, defaults stripped, additionalProperties
 * false at every object level).
 *
 * `createEffectiveSettings` resolves a setting per user: the stored
 * override when the key is marked and set, else the system value.
 */

import {
	OVERRIDABLE_KEYWORD,
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
	function walk(node: JsonSchema): JsonSchema | undefined {
		// Leaf with the marker → strip default, keep the rest
		if (node[OVERRIDABLE_KEYWORD] === true) {
			const { default: _default, [OVERRIDABLE_KEYWORD]: _marker, ...rest } = node;
			return rest;
		}
		// Object with properties → recurse
		if (node.type === "object" || isRecord(node.properties)) {
			const result: Record<string, unknown> = {};
			for (const [name, child] of propertiesOf(node, node)) {
				const filtered = walk(child);
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

	const root = walk(schema);
	return root ?? { type: "object", properties: {}, additionalProperties: false };
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
				if (stored[key] !== undefined) return stored[key];
			}
			return deps.system(key);
		},
	};
}
