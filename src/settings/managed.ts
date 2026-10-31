/**
 * Deployment-managed settings (0.4.0 follow-up Task 3).
 *
 * The chart's settings seeder writes the top-level settings keys it owns
 * into `<configDir>/managed-settings.json`. The server reads that file
 * fresh on every request so a deployment edit takes effect without a
 * restart; a missing or malformed file manages nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The seeder's managed-key manifest, beside settings.json. */
export const MANAGED_SETTINGS_FILE = "managed-settings.json";

/** The help prefix attached to every managed form field. */
const MANAGED_HELP = "Managed by deployment";

/** Paths for which this process already reported a malformed manifest. */
const reportedMalformedPaths = new Set<string>();

/**
 * Read the deployment's managed top-level keys. Absent files return [].
 * Unparseable JSON and non-string-array documents return [] and log one
 * process-wide error per path (request-fresh reads must not spam logs).
 */
export function readManagedKeys(configDir: string): readonly string[] {
	const path = join(configDir, MANAGED_SETTINGS_FILE);
	if (!existsSync(path)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			!Array.isArray(parsed) ||
			!parsed.every((entry) => typeof entry === "string")
		) {
			throw new Error("expected an array of strings");
		}
		return parsed;
	} catch (cause) {
		if (!reportedMalformedPaths.has(path)) {
			reportedMalformedPaths.add(path);
			console.error(
				`settings: ${path} is not a valid managed-key manifest; managing no keys (${
					cause instanceof Error ? cause.message : String(cause)
				})`,
			);
		}
		return [];
	}
}

/** The managed top-level keys a PATCH touches, in patch order. */
export function managedKeysTouched(
	patch: Readonly<Record<string, unknown>>,
	managed: readonly string[],
): string[] {
	const managedSet = new Set(managed);
	return Object.keys(patch).filter((key) => managedSet.has(key));
}

/** A tree node during the JSON-preserving copy. */
type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-copy a settings form tree and lock managed fields. Only the form
 * containers (`children` arrays and `root`) recurse; unrelated data is
 * copied but never interpreted as a field. The input is never mutated.
 */
export function markManagedFields<T>(tree: T, managed: readonly string[]): T {
	const managedSet = new Set(managed);

	const copy = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(copy);
		if (!isNode(value)) return value;
		const result: Node = {};
		for (const [key, child] of Object.entries(value)) {
			result[key] = key === "children" || key === "root" ? copy(child) : child;
		}
		if (typeof result.name === "string" && typeof result.type === "string") {
			const topLevel = result.name.split(".", 1)[0];
			if (topLevel !== undefined && managedSet.has(topLevel)) {
				result.disabled = true;
				result.help =
					typeof result.help === "string"
						? `${MANAGED_HELP}. ${result.help}`
						: MANAGED_HELP;
			}
		}
		return result;
	};

	return copy(tree) as T;
}
