/**
 * The process-wide SQLite heap limit, applied once by the host at boot.
 * Enforcement is verified on Node 26.13.0 but NOT on Node 22.22.0, 22.23.5,
 * or 24.22.3 (the latter three tested with SQLite 3.50.4/3.54.1). Where the
 * runtime does not enforce it this ceiling is inert; crash protection then
 * relies on the bounded recall queries.
 */

import { DatabaseSync } from "node:sqlite";

/**
 * Apply SQLite's process-wide heap limit and return the value SQLite
 * reports. A separate in-memory connection owns the pragma so no durable
 * store connection is borrowed. Zero is passed through for test reset
 * attempts; current SQLite builds may report the prior limit instead of
 * clearing it, so limit-mutating tests use child processes.
 */
export function applySqliteHeapLimit(bytes: number): number {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`PRAGMA hard_heap_limit = ${bytes}`);
		const row = db.prepare("PRAGMA hard_heap_limit").get() as {
			hard_heap_limit: number;
		};
		return row.hard_heap_limit;
	} finally {
		db.close();
	}
}
