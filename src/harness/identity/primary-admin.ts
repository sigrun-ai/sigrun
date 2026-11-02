import type { DirectoryUser } from "./users.js";

/**
 * The primary admin is the first stored admin in directory insertion
 * order. Callers pass the live directory at each use so demotions and
 * deletions take effect without a cache or a record rewrite.
 */
export function primaryAdmin(
	records: readonly DirectoryUser[],
): DirectoryUser | undefined {
	return records.find((record) => record.admin === true);
}

/**
 * Resolve the effective owner at use time: a live declared owner wins;
 * an absent or orphaned owner falls back to the primary admin. An empty
 * directory (single-operator mode) stays ownerless.
 */
export function effectiveOwner(
	records: readonly DirectoryUser[],
	owner: string | undefined,
): string | undefined {
	if (owner !== undefined && records.some((record) => record.user === owner)) {
		return owner;
	}
	return primaryAdmin(records)?.user;
}
