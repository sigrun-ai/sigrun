/**
 * Per-section opt-in backup (extension-config-surfaces Task 7): the DB
 * backup keeps its existing env contract byte-identically, and
 * `SIGRUN_BACKUP_SECTIONS=config,secrets,data,state` additionally tars
 * the named store roots to the same target. `cache` is NEVER a valid
 * section (enforced by the fail-loud parse).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { parseBackupConfig } from "../src/config.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "src", "backup", "run-backup.ts");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Invoke the backup script as a child process (test/backup.test.ts idiom). */
function runScript(
	dbPath: string,
	backupEnv: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
	const result = spawnSync(
		process.execPath,
		[join(REPO_ROOT, "node_modules", ".bin", "tsx"), SCRIPT],
		{
			env: { ...process.env, ...backupEnv, SIGRUN_STORAGE_PATH: dbPath },
			encoding: "utf8",
		},
	);
	return {
		code: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
};

async function makeTmpDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** Write `name` into a store root dir (kept as one call for brevity). */
async function seed(rootDir: string, name: string, contents: string): Promise<void> {
	await writeFile(join(rootDir, name), contents);
}

/** Create a non-empty sqlite database file (a table + a payload row). */
async function seedDbFile(): Promise<string> {
	const dir = await makeTmpDir("sigrun-sections-db-");
	const dbPath = join(dir, "sigrun.db");
	execFileSync("sqlite3", [
		dbPath,
		"CREATE TABLE t(x TEXT); INSERT INTO t VALUES('payload');",
	]);
	return dbPath;
}

/** List a tarball's entry names. */
function tarList(tarball: string): string[] {
	return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((line) => line.replace(/^\.\//, ""))
		.filter((line) => line !== "" && line !== ".");
}

// ---------------------------------------------------------------------------
// Parse matrix (config.ts: SIGRUN_BACKUP_SECTIONS)
// ---------------------------------------------------------------------------

describe("parseBackupConfig sections", () => {
	test("no SECTIONS env → NO sections key at all (Ruling F: DB-only shape byte-identical)", () => {
		const cfg = parseBackupConfig({ SIGRUN_BACKUP_PATH: "/backups" });
		expect(cfg).toEqual({
			target: "path",
			path: "/backups",
		});
		expect(cfg !== undefined && "sections" in cfg).toBe(false);
	});

	test("empty SECTIONS env → NO sections key (absent means all-false)", () => {
		const cfg = parseBackupConfig({
			SIGRUN_BACKUP_PATH: "/backups",
			SIGRUN_BACKUP_SECTIONS: "",
		});
		expect(cfg !== undefined && "sections" in cfg).toBe(false);
	});

	test("SIGRUN_BACKUP_SECTIONS=config,data → exactly those two true", () => {
		const cfg = parseBackupConfig({
			SIGRUN_BACKUP_PATH: "/backups",
			SIGRUN_BACKUP_SECTIONS: "config,data",
		});
		expect(cfg?.sections).toEqual({
			config: true,
			secrets: false,
			data: true,
			state: false,
		});
	});

	test("sections parse on the s3 target too", () => {
		const cfg = parseBackupConfig({
			SIGRUN_BACKUP_S3_BUCKET: "bucket",
			SIGRUN_BACKUP_SECTIONS: "secrets,state",
		});
		expect(cfg?.sections).toEqual({
			config: false,
			secrets: true,
			data: false,
			state: true,
		});
	});

	test("cache is NEVER a valid section name — throws naming it", () => {
		expect(() =>
			parseBackupConfig({
				SIGRUN_BACKUP_PATH: "/backups",
				SIGRUN_BACKUP_SECTIONS: "cache",
			}),
		).toThrow(/cache/);
	});

	test("unknown section name throws naming it", () => {
		expect(() =>
			parseBackupConfig({
				SIGRUN_BACKUP_PATH: "/backups",
				SIGRUN_BACKUP_SECTIONS: "config,transcripts",
			}),
		).toThrow(/transcripts/);
	});

	test("duplicate section name dedups (config,config → config true)", () => {
		const cfg = parseBackupConfig({
			SIGRUN_BACKUP_PATH: "/backups",
			SIGRUN_BACKUP_SECTIONS: "config,config",
		});
		expect(cfg?.sections).toEqual({
			config: true,
			secrets: false,
			data: false,
			state: false,
		});
	});

	test("sections env without a target stays unconfigured (default-off)", () => {
		expect(
			parseBackupConfig({ SIGRUN_BACKUP_SECTIONS: "config" }),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Section tars — path target
// ---------------------------------------------------------------------------

describe("runBackup section tars (path target)", () => {
	test("sections=config,secrets → tarballs with expected entries; secrets mode 0600; cache contents in NO tarball", async () => {
		const target = await makeTmpDir("sigrun-sections-target-");
		const cfgRoot = await makeTmpDir("sigrun-sections-cfg-");
		const dataRoot = await makeTmpDir("sigrun-sections-data-");
		const stateRoot = await makeTmpDir("sigrun-sections-state-");
		const cacheRoot = await makeTmpDir("sigrun-sections-cache-");
		// config and secrets both tar the config root (settings.json +
		// auth.json live there); secrets differs by its 0600 tarball mode.
		await seed(cfgRoot, "settings.json", '{"models":{}}');
		await seed(cfgRoot, "auth.json", '{"default":{}}');
		await seed(dataRoot, "data-payload.txt", "data");
		await seed(stateRoot, "state-payload.txt", "state");
		await seed(cacheRoot, "cache-only.bin", "cache-payload");

		const dbPath = await seedDbFile();
		const result = runScript(dbPath, {
			SIGRUN_BACKUP_PATH: target,
			SIGRUN_BACKUP_SECTIONS: "config,secrets",
			SIGRUN_CONFIG_DIR: cfgRoot,
			SIGRUN_DATA_DIR: dataRoot,
			SIGRUN_STATE_DIR: stateRoot,
			SIGRUN_CACHE_DIR: cacheRoot,
		});
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);

		const names = await readdir(target);
		const configTar = names.find(
			(n) => n.startsWith("config-") && n.endsWith(".tar.gz"),
		);
		const secretsTar = names.find(
			(n) => n.startsWith("secrets-") && n.endsWith(".tar.gz"),
		);
		expect(configTar).toBeDefined();
		expect(secretsTar).toBeDefined();
		// data/state were NOT enabled: no tarballs for them.
		expect(names.some((n) => n.startsWith("data-"))).toBe(false);
		expect(names.some((n) => n.startsWith("state-"))).toBe(false);

		expect(tarList(join(target, configTar!))).toContain("settings.json");
		expect(tarList(join(target, secretsTar!))).toContain("auth.json");

		// Secrets tarball is 0600 — key material, not world-readable.
		const secretsMode = (await stat(join(target, secretsTar!))).mode & 0o777;
		expect(secretsMode).toBe(0o600);
		// Fix round 1: the config tarball rides the same root (auth.json
		// is in BOTH archives), so it must share the 0600 mode —
		// otherwise enabling `config` defeats the secrets tarball's mode.
		const configMode = (await stat(join(target, configTar!))).mode & 0o777;
		expect(configMode).toBe(0o600);

		// cache contents NEVER appear in any produced tarball.
		for (const name of names.filter((n) => n.endsWith(".tar.gz"))) {
			expect(tarList(join(target, name))).not.toContain("cache-only.bin");
		}
	});

	test("no SECTIONS env → DB-only, byte-identical contract (only sigrun-*.db produced)", async () => {
		const target = await makeTmpDir("sigrun-sections-db-only-");
		const cfgRoot = await makeTmpDir("sigrun-sections-db-only-cfg-");
		await seed(cfgRoot, "settings.json", "{}");
		const dbPath = await seedDbFile();
		const result = runScript(dbPath, {
			SIGRUN_BACKUP_PATH: target,
			SIGRUN_CONFIG_DIR: cfgRoot,
		});
		expect(result.code).toBe(0);
		const names = await readdir(target);
		expect(
			names.every((n) => n.startsWith("sigrun-") && n.endsWith(".db")),
		).toBe(true);
		expect(names).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Section tars — s3 target via a stubbed aws binary
// ---------------------------------------------------------------------------

describe("runBackup section tars (s3 target, stubbed aws)", () => {
	test("aws s3 cp argv carries the DB key and the section tarball paths", async () => {
		const binDir = await makeTmpDir("sigrun-sections-bin-");
		const logFile = join(binDir, "argv.log");
		await writeFile(
			join(binDir, "aws"),
			[
				"#!/bin/sh",
				`echo "$@" >> "${logFile}"`,
				'exit "${AWS_STUB_EXIT:-0}"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const cfgRoot = await makeTmpDir("sigrun-sections-s3-cfg-");
		await seed(cfgRoot, "settings.json", "{}");
		const dbPath = await seedDbFile();
		const result = runScript(dbPath, {
			SIGRUN_BACKUP_S3_BUCKET: "sigrun-backups",
			SIGRUN_BACKUP_S3_PREFIX: "nightly/",
			SIGRUN_BACKUP_SECTIONS: "config",
			SIGRUN_CONFIG_DIR: cfgRoot,
			PATH: `${binDir}:${process.env.PATH}`,
		});
		expect(result.code).toBe(0);
		const log = await readFile(logFile, "utf8");
		const lines = log.trim().split("\n");
		// DB upload + one section upload.
		expect(lines).toHaveLength(2);
		expect(log).toContain("s3://sigrun-backups/nightly/sigrun-");
		expect(log).toMatch(/s3 cp \S*config-[^ ]*\.tar\.gz/);
		expect(log).toContain("s3://sigrun-backups/nightly/config-");
	});
});
