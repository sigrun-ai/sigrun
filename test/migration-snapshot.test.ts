/**
 * Pre-migration snapshot (pi-durable 1.4.0 upgrade, Task B4 / spec D4).
 *
 * Boot probes the SQLite store BEFORE `openNodeSqliteStorage` can apply a
 * durable schema migration. A version behind CURRENT gets a crash-consistent
 * `VACUUM INTO` snapshot named with the target schema and a millisecond UTC
 * stamp; a missing/non-durable/current store, an unopenable file, or the
 * explicit opt-out skips. A needed snapshot that fails throws
 * `MigrationSnapshotError`, leaving the source database untouched.
 *
 * Real files throughout: v1 inputs are copies of the B1 fixture written by
 * pi-durable 1.3.0. The WAL case copies db/-wal/-shm while the writer still
 * has an uncheckpointed row, then closes the writer before probing the copy.
 */

import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import {
	MigrationSnapshotError,
	snapshotBeforeMigration,
} from "../src/harness/migration-snapshot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { readJob } from "../src/jobs/docs.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

const FIXTURE_DB = join(
	import.meta.dirname,
	"fixtures",
	"durable-v1",
	"sigrun.db",
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-migration-snapshot-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function opts(now = new Date("2026-10-28T12:34:56.789Z")) {
	const lines: string[] = [];
	return {
		values: {
			env: {},
			now: () => now,
			log: (line: string) => lines.push(line),
		},
		lines,
	};
}

function schemaVersion(path: string): number {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (
			db.prepare("SELECT version FROM durable_schema").get() as
				| { version: number }
				| undefined
		)!.version;
	} finally {
		db.close();
	}
}

function snapshots(dir: string): Promise<string[]> {
	return readdir(dir).then((names) =>
		names.filter((name) => name.includes(".pre-durable-schema-v")),
	);
}

describe("snapshotBeforeMigration", () => {
	test("no database file skips without writing a snapshot", async () => {
		const dir = await tempDir();
		const log = opts();
		await expect(
			snapshotBeforeMigration(join(dir, "absent.db"), log.values),
		).resolves.toBeUndefined();
		expect(await snapshots(dir)).toEqual([]);
	});

	test("a v1 database gets a readable snapshot and a versioned log line", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "sigrun.db");
		await cp(FIXTURE_DB, storagePath);
		const before = await readFile(storagePath);
		const log = opts();

		const snapshot = await snapshotBeforeMigration(storagePath, log.values);
		expect(snapshot).toBe(
			join(dir, "sigrun.db.pre-durable-schema-v2-20261028T123456789Z.bak"),
		);
		expect(snapshot).toBeDefined();
		expect(schemaVersion(snapshot!)).toBe(1);
		expect(schemaVersion(storagePath)).toBe(1);
		expect(await readFile(storagePath)).toEqual(before);
		expect(log.lines).toHaveLength(1);
		expect(log.lines[0]).toContain(snapshot!);
		expect(log.lines[0]).toContain(`v1 → v${CURRENT_SQLITE_SCHEMA_VERSION}`);
	});

	test("openHarness snapshots before migrating, and the fixture conversation and job remain readable", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "sigrun.db");
		await cp(FIXTURE_DB, storagePath);
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("fixture tick")]);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: storagePath,
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
		});
		const opened = await openHarness(config, {
			identity: await seededIdentity(dir),
			extensions: [contributor],
			env: {},
			settingsDir: dir,
			now: () => new Date("2026-10-28T12:34:56.789Z"),
		});
		try {
			expect(schemaVersion(storagePath)).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
			const files = await snapshots(dir);
			expect(files).toHaveLength(1);
			expect(schemaVersion(join(dir, files[0]!))).toBe(1);

			const conversation = await opened.harness.conversation(
				1 as never,
				BACKGROUND_CONTEXT,
			);
			expect(conversation).toBeDefined();
			const entries = await conversation!.entries(
				{ order: "ascending" },
				100,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const serialized = JSON.stringify(entries.items);
			expect(serialized).toContain("fixture question");
			expect(serialized).toContain("fixture answer");
			const meta = await opened.harness.snapshot(
				SessionMetaDoc,
				1 as never,
				BACKGROUND_CONTEXT,
			);
			expect(meta?.pinned).toBe(true);
			expect(meta?.tagged).toEqual(["fixture"]);
			const job = await readJob(
				opened.harness,
				"api:fixture-job",
				BACKGROUND_CONTEXT,
			);
			expect(job?.spec.name).toBe("fixture-tick");
			expect(job?.enabled).toBe(true);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	});

	test("a hot WAL is recovered by the read-write probe and included in the snapshot", async () => {
		const dir = await tempDir();
		const source = join(dir, "source.db");
		const storagePath = join(dir, "copy.db");
		await cp(FIXTURE_DB, source);
		const writer = new DatabaseSync(source);
		writer.exec("PRAGMA journal_mode=WAL");
		writer.exec("CREATE TABLE snapshot_wal_probe (value TEXT NOT NULL)");
		writer
			.prepare("INSERT INTO snapshot_wal_probe (value) VALUES (?)")
			.run("uncheckpointed row");
		// The source writer stays open while the uncheckpointed WAL is copied.
		for (const suffix of ["", "-wal", "-shm"]) {
			await cp(`${source}${suffix}`, `${storagePath}${suffix}`);
		}
		writer.close();

		const snapshot = await snapshotBeforeMigration(storagePath, opts().values);
		expect(snapshot).toBeDefined();
		const db = new DatabaseSync(snapshot!, { readOnly: true });
		try {
			expect(
				db.prepare("SELECT value FROM snapshot_wal_probe").get(),
			).toMatchObject({ value: "uncheckpointed row" });
		} finally {
			db.close();
		}
	});

	test("a file without durable_schema is not a durable store and skips", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "other.db");
		const db = new DatabaseSync(storagePath);
		db.exec("CREATE TABLE unrelated (value TEXT)");
		db.close();
		await expect(
			snapshotBeforeMigration(storagePath, opts().values),
		).resolves.toBeUndefined();
		expect(await snapshots(dir)).toEqual([]);
	});

	test("a current-version database skips", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "sigrun.db");
		const db = new DatabaseSync(storagePath);
		db.exec("CREATE TABLE durable_schema (singleton INTEGER, version INTEGER)");
		db.prepare("INSERT INTO durable_schema VALUES (1, ?)").run(
			CURRENT_SQLITE_SCHEMA_VERSION,
		);
		db.close();
		await expect(
			snapshotBeforeMigration(storagePath, opts().values),
		).resolves.toBeUndefined();
		expect(await snapshots(dir)).toEqual([]);
	});

	test("SIGRUN_SKIP_MIGRATION_SNAPSHOT=1 skips and says so", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "sigrun.db");
		await cp(FIXTURE_DB, storagePath);
		const log = opts();
		await expect(
			snapshotBeforeMigration(storagePath, {
				...log.values,
				env: { SIGRUN_SKIP_MIGRATION_SNAPSHOT: "1" },
			}),
		).resolves.toBeUndefined();
		expect(await snapshots(dir)).toEqual([]);
		expect(log.lines.join("\n").toLowerCase()).toContain("skip");
	});

	test("an occupied snapshot target throws MigrationSnapshotError and leaves the database byte-identical", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "sigrun.db");
		await cp(FIXTURE_DB, storagePath);
		const before = await readFile(storagePath);
		const log = opts();
		const target = join(
			dir,
			"sigrun.db.pre-durable-schema-v2-20261028T123456789Z.bak",
		);
		// The exact VACUUM INTO destination is occupied, while both the DB
		// and its directory stay writable. This reaches the snapshot catch,
		// not the earlier read-only probe failure an unwritable dir caused.
		await mkdir(target);
		await expect(
			snapshotBeforeMigration(storagePath, log.values),
		).rejects.toBeInstanceOf(MigrationSnapshotError);
		expect(await readFile(storagePath)).toEqual(before);
		expect(schemaVersion(storagePath)).toBe(1);
	});

	test("openHarness rejects before migration when the snapshot target is occupied", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "sigrun.db");
		await cp(FIXTURE_DB, storagePath);
		await mkdir(
			join(dir, "sigrun.db.pre-durable-schema-v2-20261028T123456789Z.bak"),
		);
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("fixture tick")]);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: storagePath,
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
		});
		await expect(
			openHarness(config, {
				identity: await seededIdentity(dir),
				extensions: [contributor],
				env: {},
				settingsDir: dir,
				now: () => new Date("2026-10-28T12:34:56.789Z"),
			}),
		).rejects.toBeInstanceOf(MigrationSnapshotError);
		expect(schemaVersion(storagePath)).toBe(1);
	});

	test("two calls one millisecond apart produce distinct snapshots and preserve the first", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "sigrun.db");
		await cp(FIXTURE_DB, storagePath);
		const first = opts(new Date("2026-10-28T12:34:56.789Z"));
		const second = opts(new Date("2026-10-28T12:34:56.790Z"));
		const one = await snapshotBeforeMigration(storagePath, first.values);
		const firstBytes = await readFile(one!);
		const two = await snapshotBeforeMigration(storagePath, second.values);
		expect(one).not.toBe(two);
		expect(basename(one!)).not.toBe(basename(two!));
		expect(await readFile(one!)).toEqual(firstBytes);
		expect(await snapshots(dir)).toHaveLength(2);
	});

	test("an unopenable database skips and logs so storage can report the real error", async () => {
		const dir = await tempDir();
		const storagePath = join(dir, "broken.db");
		await writeFile(storagePath, "not a sqlite database");
		const log = opts();
		await expect(
			snapshotBeforeMigration(storagePath, log.values),
		).resolves.toBeUndefined();
		expect(await snapshots(dir)).toEqual([]);
		expect(log.lines).toHaveLength(1);
	});
});
