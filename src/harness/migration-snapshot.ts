/**
 * Pre-migration snapshot (spec D4): before pi-durable opens a SQLite store,
 * preserve the last schema the previous release can read.
 *
 * The probe deliberately opens read-write but issues no writes. A read-only
 * connection cannot recover a WAL left by an unclean shutdown, so the read-
 * write open lets SQLite perform crash recovery before `VACUUM INTO` writes a
 * consistent, independent snapshot. Probe/open failures SKIP so the real
 * storage opener can report the underlying error; a failure of a needed
 * snapshot instead fails boot through `MigrationSnapshotError`.
 *
 * This runs before every durable schema migration, not only v1 → v2.
 * Snapshots are never removed automatically. JSONL storage has no schema
 * migration and therefore does not pass through this helper.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

export const SKIP_MIGRATION_SNAPSHOT_ENV = "SIGRUN_SKIP_MIGRATION_SNAPSHOT";

/** A required pre-migration snapshot could not be written. */
export class MigrationSnapshotError extends Error {
	constructor(
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.name = "MigrationSnapshotError";
	}
}

export interface MigrationSnapshotOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly now: () => Date;
	readonly log: (line: string) => void;
}

/** UTC compact stamp through milliseconds; one-millisecond boots never collide. */
function compactUtcStamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** Quote one SQLite string literal (the snapshot path can contain `'`). */
function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Return the snapshot path when a migration is needed, otherwise `undefined`.
 * Throws `MigrationSnapshotError` when a required snapshot cannot be written.
 */
export async function snapshotBeforeMigration(
	storagePath: string,
	opts: MigrationSnapshotOptions,
): Promise<string | undefined> {
	if (opts.env[SKIP_MIGRATION_SNAPSHOT_ENV] === "1") {
		opts.log(
			`sigrun: durable migration snapshot skipped (${SKIP_MIGRATION_SNAPSHOT_ENV}=1): ${storagePath}`,
		);
		return undefined;
	}
	if (!existsSync(storagePath)) return undefined;

	let db: DatabaseSync;
	try {
		db = new DatabaseSync(storagePath);
	} catch (error) {
		opts.log(
			`sigrun: durable migration snapshot skipped; probe could not open ${storagePath}: ${messageOf(error)}`,
		);
		return undefined;
	}

	try {
		let version: number | undefined;
		try {
			const row = db
				.prepare("SELECT version FROM durable_schema WHERE singleton = 1")
				.get() as { version: number } | undefined;
			version = row?.version;
		} catch (error) {
			// A file without durable_schema is not a durable store. Invalid
			// database files also defer to the real storage opener so it can
			// report its own, more useful error.
			const message = messageOf(error);
			if (
				message.includes("no such table: durable_schema") ||
				message.includes("file is not a database")
			) {
				opts.log(
					`sigrun: durable migration snapshot skipped; durable schema probe failed for ${storagePath}: ${message}`,
				);
				return undefined;
			}
			// An environmental failure while probing an existing durable file
			// can surface here too (SQLite may need journal/WAL sidecars even
			// for its first SELECT). Do NOT turn that into a silent skip: a
			// snapshot cannot be assured, so stop before migration.
			throw new MigrationSnapshotError(
				`could not probe ${storagePath} before durable schema migration: ${messageOf(error)}; set ${SKIP_MIGRATION_SNAPSHOT_ENV}=1 only when you have an independent backup`,
				{ cause: error },
			);
		}
		if (version === undefined || version >= CURRENT_SQLITE_SCHEMA_VERSION) {
			return undefined;
		}

		const snapshotPath = `${storagePath}.pre-durable-schema-v${CURRENT_SQLITE_SCHEMA_VERSION}-${compactUtcStamp(opts.now())}.bak`;
		try {
			db.exec(`VACUUM INTO ${sqlString(snapshotPath)}`);
		} catch (error) {
			throw new MigrationSnapshotError(
				`could not snapshot ${storagePath} to ${snapshotPath} before durable schema migration v${version} → v${CURRENT_SQLITE_SCHEMA_VERSION}: ${messageOf(error)}; set ${SKIP_MIGRATION_SNAPSHOT_ENV}=1 only when you have an independent backup`,
				{ cause: error },
			);
		}
		opts.log(
			`sigrun: durable migration snapshot ${snapshotPath} (v${version} → v${CURRENT_SQLITE_SCHEMA_VERSION})`,
		);
		return snapshotPath;
	} finally {
		db.close();
	}
}
