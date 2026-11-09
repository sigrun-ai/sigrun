/**
 * Defaults and invalid-stored-value repair for schema-checked settings.
 * `typebox/schema` is the authority on validity; this module only applies
 * declared defaults and performs the smallest local repair named by the
 * settings contract. It never writes the stored file.
 */

import { Errors } from "typebox/schema";
import type { JsonValue } from "@sigrun/shared/blocks";
import {
	deref,
	isRecord,
	propertiesOf,
	unionBranches,
	type JsonSchema,
} from "./keywords.js";

export interface SettingsRepair {
	readonly path: string;
	readonly action: "replaced" | "removed" | "dropped";
	readonly message: string;
}

export interface CheckedSettings {
	readonly value: Record<string, unknown>;
	readonly repairs: readonly SettingsRepair[];
}

function cloneDefault(schema: JsonSchema): JsonValue | undefined {
	return structuredClone(schema.default) as JsonValue | undefined;
}

function pathSegments(pointer: string): string[] {
	return pointer === ""
		? []
		: pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function atPath(value: unknown, pointer: string): JsonValue | undefined {
	let current = value;
	for (const segment of pathSegments(pointer)) {
		if (Array.isArray(current)) current = current[Number(segment)];
		else if (isRecord(current)) current = current[segment];
		else return undefined;
	}
	return current as JsonValue | undefined;
}

function schemaAt(root: JsonSchema, schemaPath: string): JsonSchema | undefined {
	if (schemaPath === "#") return root;
	if (!schemaPath.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const raw of schemaPath.slice(2).split("/")) {
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return isRecord(current) ? deref(root, current) : undefined;
}

function branches(root: JsonSchema, schema: JsonSchema): JsonSchema[] | undefined {
	return unionBranches(schema)?.flatMap((branch) =>
		isRecord(branch) ? [deref(root, branch)] : [],
	);
}

/** Recursively fill absent values from defaults, including the selected variant. */
function fill(
	root: JsonSchema,
	schema: JsonSchema,
	value: Record<string, unknown> | JsonValue | undefined,
): Record<string, unknown> | JsonValue | undefined {
	const actual = deref(root, schema);
	if (actual.writeOnly === true && (value === undefined || value === "")) return value ?? "";
	if (value === undefined && actual.default !== undefined) return cloneDefault(actual);
	const alternatives = branches(root, actual);
	if (alternatives !== undefined && value !== undefined) {
		const matching = alternatives.find((branch) => Errors(branch, value)[0]);
		if (matching !== undefined) return fill(root, matching, value);
		let candidate: Record<string, unknown> | JsonValue = value;
		for (const branch of alternatives) candidate = fill(root, branch, candidate) ?? null;
		return candidate;
	}
	if (actual.type === "object" && (isRecord(value) || value === undefined)) {
		const result: Record<string, unknown> = { ...(value ?? {}) };
		if (isRecord(actual.additionalProperties)) {
			for (const [name, child] of Object.entries(result)) {
				result[name] = fill(root, actual.additionalProperties, child as JsonValue);
			}
		}
		for (const [name, child] of propertiesOf(root, actual)) {
			const next = fill(root, child, result[name] as JsonValue | undefined);
			if (next !== undefined) result[name] = next;
		}
		if (!isRecord(value) && Object.keys(result).length === 0) return undefined;
		return result as Record<string, JsonValue>;
	}
	if (actual.type === "array" && Array.isArray(value) && isRecord(actual.items)) {
		return value.map((entry) => fill(root, actual.items as JsonSchema, entry) ?? null) as JsonValue[];
	}
	return value;
}

/** Apply schema defaults without changing the input value. */
export function applyDefaults(
	schema: JsonSchema,
	value: Record<string, unknown>,
): Record<string, unknown> {
	return fill(schema, schema, structuredClone(value)) as Record<string, unknown>;
}

interface ParentRef {
	readonly parent: Record<string, unknown> | unknown[];
	readonly key: string | number;
}

function parentAt(root: Record<string, unknown>, pointer: string): ParentRef | undefined {
	const segments = pathSegments(pointer);
	if (segments.length === 0) return undefined;
	let current: unknown = root;
	for (const segment of segments.slice(0, -1)) {
		current = Array.isArray(current)
			? current[Number(segment)]
			: isRecord(current)
				? current[segment]
				: undefined;
	}
	const key = segments.at(-1)!;
	if (Array.isArray(current)) return { parent: current, key: Number(key) };
	if (isRecord(current)) return { parent: current, key };
	return undefined;
}

function enclosingSchema(
	root: JsonSchema,
	value: Record<string, unknown>,
	pointer: string,
): JsonSchema | undefined {
	const segments = pathSegments(pointer);
	let schema = root;
	for (const segment of segments) {
		schema = deref(root, schema);
		const alternatives = branches(root, schema);
		if (alternatives !== undefined) {
			const current = atPath(value, pointer);
			schema = alternatives.find((branch) => Errors(branch, current)[0]) ?? alternatives[0]!;
		}
		if (schema.type === "object") {
			const own = propertiesOf(root, schema).find(([name]) => name === segment)?.[1];
			if (own !== undefined) schema = own;
			else if (isRecord(schema.additionalProperties)) schema = schema.additionalProperties;
			else return undefined;
		} else if (schema.type === "array" && isRecord(schema.items)) {
			schema = schema.items;
		}
	}
	return deref(root, schema);
}

function repairOne(
	value: Record<string, unknown>,
	pointer: string,
	schema: JsonSchema | undefined,
	message: string,
): SettingsRepair | undefined {
	if (pointer === "") return undefined;
	const parent = parentAt(value, pointer);
	if (parent === undefined) return undefined;
	if (schema?.default !== undefined) {
		if (Array.isArray(parent.parent)) parent.parent[parent.key as number] = cloneDefault(schema);
		else parent.parent[parent.key as string] = cloneDefault(schema);
		return { path: pointer, action: "replaced", message };
	}
	if (Array.isArray(parent.parent)) {
		parent.parent.splice(parent.key as number, 1);
		return { path: pointer, action: "dropped", message };
	}
	delete parent.parent[parent.key as string];
	return { path: pointer, action: "removed", message };
}

/** Check and repair one stored object, deduplicating union errors by path. */
export function checkStoredSettings(
	schema: JsonSchema,
	stored: Record<string, unknown>,
): CheckedSettings {
	const value = applyDefaults(schema, stored);
	const repairs: SettingsRepair[] = [];
	const seen = new Set<string>();
	for (let pass = 0; pass < 100; pass++) {
		const [valid, errors] = Errors(schema, value);
		if (valid) return { value, repairs };
		const candidates = errors.filter((error) => {
			if (error.keyword === "oneOf" || error.keyword === "anyOf") return false;
			const key = `${error.instancePath}\0${error.schemaPath}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		const error = candidates[0] ?? errors.find((candidate) => candidate.instancePath !== "");
		if (error === undefined) return { value, repairs };
		const direct = schemaAt(schema, error.schemaPath);
		const repair = repairOne(
			value,
			error.instancePath,
			direct ?? enclosingSchema(schema, value, error.instancePath),
			error.message,
		);
		if (repair === undefined) return { value, repairs };
		repairs.push(repair);
	}
	return { value, repairs };
}
