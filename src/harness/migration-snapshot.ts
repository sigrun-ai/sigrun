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
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

export const SKIP_MIGRATION_SNAPSHOT_ENV = "SIGRUN_SKIP_MIGRATION_SNAPSHOT";

/**
 * The sidecar recording which pi-durable version last opened a store
 * (spec D4, 1.5.0 upgrade): `<storagePath>.durable-version`. A missing
 * marker means the store predates the marker convention and counts as
 * older than any running version.
 */
export const DURABLE_VERSION_MARKER_SUFFIX = ".durable-version";

/**
 * The running pi-durable package version, read from the installed
 * package's manifest through `createRequire` (the same bundler-stable
 * shape `schema-fixture.ts` uses for HARNESS_VERSION), so a dependency
 * bump moves the upgrade guard without a source edit.
 */
const DURABLE_PACKAGE_VERSION: string = createRequire(import.meta.url)(
	"@earendil-works/pi-durable/package.json",
).version as string;

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

/** Compare two `major.minor[.patch]` versions by their minor. */
function minorIsOlder(version: string, running: string): boolean {
	const parse = (v: string): [number, number] | undefined => {
		const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
		if (match === null) return undefined;
		return [Number(match[1]), Number(match[2])];
	};
	const marked = parse(version);
	const current = parse(running);
	if (marked === undefined || current === undefined) return false;
	return (
		marked[0] < current[0] ||
		(marked[0] === current[0] && marked[1] < current[1])
	);
}

/**
 * Pre-upgrade snapshot (spec D4, pi-durable 1.5.0): before pi-durable opens
 * a store last written by an OLDER minor, preserve a copy the previous
 * release can read. The version signal is the `<storagePath>.durable-version`
 * sidecar — a missing marker (a pre-1.5 store, or one written before the
 * convention) counts as older, so an unmarked existing store snapshots once
 * and then never again once {@link writeDurableVersionMarker} has run.
 *
 * No-op when the skip env is set or the store file is absent (fresh
 * installs have nothing to preserve). A failure to write a NEEDED snapshot
 * throws `MigrationSnapshotError` with the same skip-env hint as the
 * schema-migration guard. Returns the snapshot path, or `undefined`.
 */
export async function snapshotBeforeDurableUpgrade(
	storagePath: string,
	opts: MigrationSnapshotOptions,
): Promise<string | undefined> {
	if (opts.env[SKIP_MIGRATION_SNAPSHOT_ENV] === "1") {
		opts.log(
			`sigrun: durable upgrade snapshot skipped (${SKIP_MIGRATION_SNAPSHOT_ENV}=1): ${storagePath}`,
		);
		return undefined;
	}
	if (!existsSync(storagePath)) return undefined;

	const markerPath = `${storagePath}${DURABLE_VERSION_MARKER_SUFFIX}`;
	let marked: string | undefined;
	try {
		marked = (await readFile(markerPath, "utf8")).trim();
	} catch {
		marked = undefined;
	}
	if (marked !== undefined && !minorIsOlder(marked, DURABLE_PACKAGE_VERSION)) {
		return undefined;
	}

	const snapshotPath = `${storagePath}.pre-pi-durable-${DURABLE_PACKAGE_VERSION}-${compactUtcStamp(opts.now())}.bak`;
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(storagePath);
	} catch (error) {
		opts.log(
			`sigrun: durable upgrade snapshot skipped; probe could not open ${storagePath}: ${messageOf(error)}`,
		);
		return undefined;
	}
	try {
		try {
			db.exec(`VACUUM INTO ${sqlString(snapshotPath)}`);
		} catch (error) {
			throw new MigrationSnapshotError(
				`could not snapshot ${storagePath} to ${snapshotPath} before the pi-durable ${marked ?? "unmarked"} → ${DURABLE_PACKAGE_VERSION} upgrade: ${messageOf(error)}; set ${SKIP_MIGRATION_SNAPSHOT_ENV}=1 only when you have an independent backup`,
				{ cause: error },
			);
		}
	} finally {
		db.close();
	}
	opts.log(
		`sigrun: durable upgrade snapshot ${snapshotPath} (${marked ?? "unmarked"} → ${DURABLE_PACKAGE_VERSION})`,
	);
	return snapshotPath;
}

/**
 * Stamp the running pi-durable version beside the store. Boot calls this
 * only after `openNodeSqliteStorage` succeeds, so the marker never claims a
 * version the store has not actually been opened by.
 */
export async function writeDurableVersionMarker(
	storagePath: string,
): Promise<void> {
	await writeFile(
		`${storagePath}${DURABLE_VERSION_MARKER_SUFFIX}`,
		DURABLE_PACKAGE_VERSION,
		"utf8",
	);
}
