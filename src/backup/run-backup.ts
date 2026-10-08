/**
 * The optional backup script (spec §4.3, Task 11) — the CronJob's payload.
 *
 * Invoked (tsx / node) with `SIGRUN_STORAGE_PATH` pointing at the live
 * harness sqlite database plus the backup target env (see
 * `parseBackupConfig`). It takes a `sqlite3 .backup` — the ONLINE-SAFE
 * backup API: sqlite3's VACUUM-into API locks the source only per page,
 * so the copy is consistent even while the harness process holds the
 * database in WAL mode (a second process touching the file is exactly the
 * class of assumption spec §4.3's App C ledger rule covers; the restore
 * drill in test/backup.test.ts verifies it live).
 *
 * Flow, fail-loud at every step:
 *  1. `sqlite3 <db> ".backup '<tmpfile>'"` into a sibling temp file (same
 *     filesystem as the target for the atomic rename; never a half-written
 *     target). A sqlite3 failure deletes the temp file and exits non-zero
 *     (sqlite3 leaves a 0-byte file on failure — it must not survive).
 *  2. path target: rename into `<dir>/sigrun-<UTC timestamp>.db`, then
 *     30-day retention (`applyRetention`).
 *  2'. s3 target: `aws s3 cp` the temp file to
 *     `s3://<bucket>[/<prefix>]sigrun-<UTC timestamp>.db`. Endpoint and
 *     credentials come from the environment (`AWS_*`,
 *     `SIGRUN_BACKUP_S3_ENDPOINT`) — core secrets per spec §4.3, injected
 *     into the CronJob from a Secret. A failed upload exits non-zero.
 *  3. No backup target env → exit 1 with a config error (the CronJob must
 *     not silently do nothing).
 *
 * The script deliberately touches NOTHING but the db file and the target —
 * no pi-durable internals, no lock negotiation; that is the whole point of
 * `sqlite3 .backup` over an application-level snapshot.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBackupConfig, type BackupConfig } from "../config.js";

/** Retention floor (spec §4.3: "retention ≥ 30 days"). */
export const BACKUP_RETENTION_DAYS = 30;

/** The db path under backup — `SIGRUN_STORAGE_PATH` in deployment. */
const DB_PATH = process.env.SIGRUN_STORAGE_PATH ?? "";

/** Promise-wrapped spawn: a step's exit code and stderr. */
function run(
	command: string,
	args: readonly string[],
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
	});
}

/**
 * Timestamp segment of a backup filename: `2026-10-07T03-15-02Z` — UTC,
 * sortable, colon-free (safe on every filesystem / object-store key).
 */
function timestampSegment(date = new Date()): string {
	return date.toISOString().replace(/:/g, "-").slice(0, 19) + "Z";
}

/** Run `sqlite3 <db> ".backup '<dest>'"`; fail loud on a non-zero exit. */
async function sqliteBackup(dbPath: string, dest: string): Promise<void> {
	// The quoting inside the dot-command is sqlite3's own (the dot-command
	// parser treats the quoted string as one filename; an unquoted path with
	// spaces would split).
	const result = await run("sqlite3", [dbPath, `.backup '${dest}'`]);
	if (result.code !== 0) {
		// sqlite3 leaves a 0-byte dest on failure — a later restore would
		// open a valid EMPTY database and "resume" to nothing. Delete it.
		await rm(dest, { force: true });
		throw new Error(
			`sqlite3 .backup failed with exit ${result.code}: ${result.stderr.trim()}`,
		);
	}
}

/**
 * Path-target retention: delete `sigrun-*.db` files in `dir` whose mtime is
 * older than {@link BACKUP_RETENTION_DAYS} days. Non-matching names are
 * never touched (the directory is the deployment's backup dir, but it is
 * still conservative to prune only what this script produced).
 */
export async function applyRetention(dir: string): Promise<void> {
	const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	for (const name of await readdir(dir)) {
		if (!name.startsWith("sigrun-") || !name.endsWith(".db")) continue;
		const path = join(dir, name);
		const info = await stat(path);
		if (info.mtimeMs < cutoff) await unlink(path);
	}
}

/** Upload the backup to the s3 target; fail loud when aws fails. */
async function s3Upload(
	backup: Extract<BackupConfig, { target: "s3" }>,
	file: string,
): Promise<void> {
	const key = `${backup.prefix ?? ""}sigrun-${timestampSegment()}.db`;
	const target = `s3://${backup.bucket}/${key}`;
	// --endpoint-url only when configured (default: AWS's own endpoints);
	// credentials stay in the standard AWS_* env, forwarded untouched.
	const endpointArgs =
		process.env.SIGRUN_BACKUP_S3_ENDPOINT === undefined
			? []
			: ["--endpoint-url", process.env.SIGRUN_BACKUP_S3_ENDPOINT];
	const result = await run("aws", [
		"s3",
		"cp",
		file,
		target,
		...endpointArgs,
	]);
	if (result.code !== 0) {
		throw new Error(
			`aws s3 cp failed with exit ${result.code}: ${result.stderr.trim()}`,
		);
	}
}

/**
 * One backup run: take the sqlite backup, then ship it to the target.
 * Exported for the test's direct (in-process) invocation; the script's
 * main() wraps it with env parsing and process exit codes.
 */
export async function runBackup(
	dbPath: string,
	backup: BackupConfig,
): Promise<void> {
	if (!dbPath) {
		throw new Error("SIGRUN_STORAGE_PATH is required (the db to back up)");
	}
	// sqlite3 opens its source with create flags: a MISSING db file backs up
	// "successfully" as an empty database (a SIGRUN_STORAGE_PATH typo or a
	// CronJob firing before first boot would then produce nightly empty
	// backups indistinguishable from real ones). Fail loud instead.
	const dbStat = await stat(dbPath).catch(() => undefined);
	if (dbStat === undefined || dbStat.size === 0) {
		throw new Error(
			`database ${dbPath} does not exist or is empty — refusing to back up nothing`,
		);
	}
	// Temp file in the TARGET's filesystem (path target) so the final move
	// is an atomic rename, not a copy; for s3 the temp dir is irrelevant to
	// atomicity (the upload is the move) so the OS temp dir serves.
	const tempDir = backup.target === "path" ? backup.path : tmpdir();
	const tempFile = join(
		await mkdtemp(join(tempDir, ".sigrun-backup-")),
		`backup-${timestampSegment()}.db`,
	);
	try {
		await sqliteBackup(dbPath, tempFile);
		if (backup.target === "path") {
			const dest = join(backup.path, `sigrun-${timestampSegment()}.db`);
			await rename(tempFile, dest);
			await applyRetention(backup.path);
		} else {
			await s3Upload(backup, tempFile);
		}
	} finally {
		// The temp file survives only on the failure paths between sqlite
		// success and the rename/upload — always clean it up.
		await rm(tempFile, { force: true });
		await rm(dirname(tempFile), { force: true, recursive: true });
	}
}

/**
 * Script entry — runs only when executed directly (tsx run-backup.ts / a
 * built node dist), not when the test imports `runBackup` in-process.
 * Compares the realpath of argv[1] with this module (tsx and ts-node both
 * keep argv[1] as the script path).
 */
const invokedAsScript = (() => {
	if (process.argv[1] === undefined) return false;
	try {
		return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
	} catch {
		return false;
	}
})();

if (invokedAsScript) {
	const backup = parseBackupConfig(process.env);
	if (backup === undefined) {
		console.error(
			"No backup target configured: set SIGRUN_BACKUP_PATH or SIGRUN_BACKUP_S3_BUCKET",
		);
		process.exit(1);
	}
	try {
		await runBackup(DB_PATH, backup);
	} catch (error) {
		console.error(`sigrun backup failed: ${String(error)}`);
		process.exit(1);
	}
}
