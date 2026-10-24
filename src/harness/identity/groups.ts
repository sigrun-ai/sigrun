/** Group-derived views over the user directory (multi-user M3b §11.5). */

import type { DirectoryUser } from "./users.js";

/** The deduplicated union of a user's stored groups, in source order. */
export function storedGroups(record: DirectoryUser): string[] {
	const groups = new Set<string>();
	for (const entry of record.groups ?? []) {
		for (const value of entry.values) groups.add(value);
	}
	return [...groups];
}

/** Effective admin reads stored groups only, never request-supplied groups. */
export function effectiveAdmin(
	record: DirectoryUser,
	adminGroups: readonly string[],
): boolean {
	return record.admin || storedGroups(record).some((group) => adminGroups.includes(group));
}
