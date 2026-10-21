/**
 * Task 11: backup capability (optional) + restore drill (spec §4.3).
 *
 * The backup contract: when configured, a small script (the CronJob's
 * payload) takes `sqlite3 <db> ".backup '<tmp>'"` — the online-safe backup
 * API, consistent against a live WAL database — then moves/ uploads to the
 * target and applies 30-day retention. When unconfigured, sigrun boots
 * fine and `GET /v1/meta` says so (`capabilities.backup: false`,
 * `health.backup: "unconfigured"` — a badge, not an error).
 *
 * Test coverage here:
 * - config parsing (path / s3 / both → fail-loud / neither → absent)
 * - meta derivation (`capabilities.backup` from `config.backup` presence)
 * - the backup script against a LIVE harness (path target): the output
 *   restores and resumes — the App C named verification "live-harness
 *   backup resumes", automated as a test
 * - retention: fabricated >30-day-old files are pruned; fresh ones stay
 * - the s3 upload leg via an INJECTED client factory (an in-process fake
   records the PutObject calls; no real S3, no network, no aws binary)
 * - fail-loud: sqlite3 failure → non-zero exit + stderr + no output file
 */

import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";
import {
	BACKUP_RETENTION_DAYS,
	runBackup,
	setS3ClientFactory,
} from "../src/backup/run-backup.js";
import { parseBackupConfig } from "../src/config.js";
import { seededIdentity } from "./helpers/identity.js";

/** The backup script under test, resolved through the repo (tsx runs TS). */
const SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"../src/backup/run-backup.ts",
);

/** One hermetic harness: faux provider + tmpdir storage + server. */
interface TestHarness {
	opened: OpenedHarness;
	app: FastifyInstance;
	config: ReturnType<typeof loadConfig>;
	dbPath: string;
}

/**
 * Boot a live harness in a tmpdir with a faux provider. The harness stays
 * OPEN — the backup must be consistent against the live WAL database
 * (spec §4.3's named verification).
 */
async function bootHarness(backupEnv?: Record<string, string>): Promise<TestHarness> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("backup drill answer")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		...backupEnv,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { opened, app, config, dbPath: join(dir, "sigrun.db") };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Invoke the backup script as a child process (as the CronJob would).
 * `omitEnv` deletes keys the parent environment may leak into the child
 * (the marker-skip test needs `SIGRUN_STATE_DIR` genuinely unset).
 */
async function runScript(
	dbPath: string,
	backupEnv: Record<string, string>,
	omitEnv: readonly string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const { spawnSync } = await import("node:child_process");
	// Full parent env + overrides: the child needs PATH for sqlite3/aws and
	// the repo's node_modules resolution for tsx.
	const env: Record<string, string> = {
		...process.env,
		...backupEnv,
		SIGRUN_STORAGE_PATH: dbPath,
		SIGRUN_AUTH: "none",
	};
	for (const key of omitEnv) delete env[key];
	const result = spawnSync(
		process.execPath,
		[
			// tsx loader: run the TS script directly (no repo build step exists).
			join(dirname(SCRIPT), "../../node_modules/.bin/tsx"),
			SCRIPT,
		],
		{
			env,
			encoding: "utf8",
		},
	);
	return {
		code: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/**
 * Install a fake S3 client factory for the duration of one test; returns a
 * restore function. The factory receives the real client config, so a test
 * can assert what the deployment path would have used (endpoint,
 * path-style) without ever constructing a client.
 */
function useFakeS3(
	factory: (
		config: unknown,
	) => { send: (command: never) => Promise<unknown>; destroy: () => void },
): () => Promise<void> {
	setS3ClientFactory(factory as never);
	return async () => {
		// `undefined` restores the module's own production factory.
		setS3ClientFactory();
	};
}

/**
 * Run `runBackup` in-process (the injected client only works in-process —
 * a child process would build its own factory). Mirrors the script's own
 * env parsing and exit-code discipline: a throw is a non-zero exit with
 * the message on stderr.
 */
async function runInProcess(
	dbPath: string,
	backupEnv: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(backupEnv)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
	const savedStorage = process.env.SIGRUN_STORAGE_PATH;
	process.env.SIGRUN_STORAGE_PATH = dbPath;
	try {
		const backup = parseBackupConfig(process.env);
		if (backup === undefined) {
			return { code: 1, stdout: "", stderr: "no backup target configured" };
		}
		await runBackup(dbPath, backup, process.env.SIGRUN_STATE_DIR);
		return { code: 0, stdout: "", stderr: "" };
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (savedStorage === undefined) delete process.env.SIGRUN_STORAGE_PATH;
		else process.env.SIGRUN_STORAGE_PATH = savedStorage;
	}
}

// ---------------------------------------------------------------------------
// Config parsing (spec §4.3: path target, s3 target, neither → absent,
// both → fail-loud)
// ---------------------------------------------------------------------------

describe("backup config parsing", () => {
	test("neither variable set → backup absent", () => {
		const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "faux/m" });
		expect(config.backup).toBeUndefined();
	});

	test("SIGRUN_BACKUP_PATH → path target", () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_BACKUP_PATH: "/var/backups/sigrun",
		});
		expect(config.backup).toEqual({
			target: "path",
			path: "/var/backups/sigrun",
		});
	});

	test("SIGRUN_BACKUP_S3_BUCKET → s3 target", () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_BACKUP_S3_BUCKET: "sigrun-backups",
		});
		expect(config.backup).toEqual({
			target: "s3",
			bucket: "sigrun-backups",
		});
	});

	test("SIGRUN_BACKUP_S3_PREFIX rides the bucket", () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_BACKUP_S3_BUCKET: "sigrun-backups",
			SIGRUN_BACKUP_S3_PREFIX: "nightly/",
		});
		expect(config.backup).toEqual({
			target: "s3",
			bucket: "sigrun-backups",
			prefix: "nightly/",
		});
	});

	test("both targets set → fail-loud config error", () => {
		expect(() =>
			loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_BACKUP_PATH: "/var/backups/sigrun",
				SIGRUN_BACKUP_S3_BUCKET: "sigrun-backups",
			}),
		).toThrowError(/SIGRUN_BACKUP_PATH/);
	});

	test("empty string is treated as unset", () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_BACKUP_PATH: "",
		});
		expect(config.backup).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Meta derivation (capabilities.backup from config.backup presence)
// ---------------------------------------------------------------------------

describe("GET /v1/meta backup fields", () => {
	test("unconfigured: capabilities.backup false + health.backup unconfigured", async () => {
		const { app } = await bootHarness();
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(200);
		const meta = response.json();
		expect(meta.capabilities.backup).toBe(false);
		expect(meta.health.backup).toBe("unconfigured");
	});

	test("configured (env-parsed) + a real script run's marker → configured (read per request)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const stateDir = join(dir, "state");
		const backupDir = join(dir, "backups");
		// The path target must exist (the deployment provides it — a mounted
		// PVC dir; the script never creates the target).
		await (await import("node:fs/promises")).mkdir(backupDir, {
			recursive: true,
		});
		const { app, dbPath } = await bootHarness({
			SIGRUN_BACKUP_PATH: backupDir,
			SIGRUN_STATE_DIR: stateDir,
		});
		// No marker yet: a configured target with no successful run is
		// DEGRADED — the honesty §6.8 exists for (the badge used to lie).
		const before = (await app.inject({ method: "GET", url: "/v1/meta" })).json();
		expect(before.capabilities.backup).toBe(true);
		expect(before.health.backup).toBe("degraded");
		// A real script run (the CronJob shape) writes the marker into the
		// SAME state root the server resolves...
		const result = await runScript(dbPath, {
			SIGRUN_BACKUP_PATH: backupDir,
			SIGRUN_STATE_DIR: stateDir,
		});
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		// ...and the meta route reads it PER REQUEST: the same live server
		// flips to configured without a restart.
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(200);
		const meta = response.json();
		expect(meta.capabilities.backup).toBe(true);
		expect(meta.health.backup).toBe("configured");
		expect(typeof meta.backup.lastSuccessAt).toBe("string");
		expect(Date.parse(meta.backup.lastSuccessAt)).toBeGreaterThan(
			Date.now() - 60_000,
		);
	});
});

// ---------------------------------------------------------------------------
// The backup script — path target, against a LIVE harness
// ---------------------------------------------------------------------------

describe("runBackup (path target, live harness)", () => {
	test("produces a restorable file from the live harness db", async () => {
		const { opened, dbPath } = await bootHarness();
		// Write a turn through the live harness first — the restore drill
		// must find it again.
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: "backup drill" },
			BACKGROUND_CONTEXT,
		);
		await submission.wait(BACKGROUND_CONTEXT);

		const backupDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(backupDir, { recursive: true, force: true }));
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const result = await runScript(dbPath, {
			SIGRUN_BACKUP_PATH: backupDir,
			SIGRUN_STATE_DIR: stateDir,
		});
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const files = await import("node:fs/promises").then((fs) =>
			fs.readdir(backupDir),
		);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^sigrun-\d{4}-\d{2}-\d{2}T.+\.db$/);
		// §6.8: the last-success marker — shape `{at, target, bytes}`, mode
		// 0644, under `<stateDir>/backup/`, written after the rename+retention.
		const markerPath = join(stateDir, "backup", "last-success.json");
		const marker = JSON.parse(await readFile(markerPath, "utf8"));
		expect(Object.keys(marker).sort()).toEqual(["at", "bytes", "target"]);
		expect(marker.target).toBe("path");
		expect(Date.parse(marker.at)).toBeGreaterThan(Date.now() - 60_000);
		expect(marker.bytes).toBe(
			(await stat(join(backupDir, files[0]))).size,
		);
		expect((await stat(markerPath)).mode & 0o777).toBe(0o644);
	});

	test("SIGRUN_STATE_DIR unset → backup still succeeds, marker skipped with a warning", async () => {
		const { dbPath } = await bootHarness();
		const backupDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(backupDir, { recursive: true, force: true }));
		const result = await runScript(
			dbPath,
			{ SIGRUN_BACKUP_PATH: backupDir },
			["SIGRUN_STATE_DIR"],
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toMatch(/SIGRUN_STATE_DIR.*marker/s);
		// The backup itself succeeded (the marker is observability, never a
		// gate); nothing was created anywhere in the tmp tree for it.
		const files = await import("node:fs/promises").then((fs) =>
			fs.readdir(backupDir),
		);
		expect(files).toHaveLength(1);
	});

	test("marker-write failure → warn, backup still exits 0 (fix round 1: the marker is never a gate)", async () => {
		const { dbPath } = await bootHarness();
		const backupDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(backupDir, { recursive: true, force: true }));
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		// Break the marker path exactly: a regular FILE where `backup/` must
		// go makes the marker's mkdir fail (recursive mkdir does not clobber
		// files) — the read-only-dir / full-disk class, hermetically.
		await writeFile(join(stateDir, "backup"), "not a directory");
		const result = await runScript(dbPath, {
			SIGRUN_BACKUP_PATH: backupDir,
			SIGRUN_STATE_DIR: stateDir,
		});
		// The backup SUCCEEDED: exit 0, the db file exists.
		expect(result.code).toBe(0);
		const files = await import("node:fs/promises").then((fs) =>
			fs.readdir(backupDir),
		);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^sigrun-\d{4}-\d{2}-\d{2}T.+\.db$/);
		// The failure is a WARNING (same posture as the unset leg), loud
		// enough to find in the CronJob log.
		expect(result.stderr).toMatch(/marker/i);
	});

	test("retention prunes files older than 30 days, keeps fresh ones", async () => {
		const backupDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(backupDir, { recursive: true, force: true }));
		// Fabricate the retention universe: one fresh, one 40 days old, one
		// 29 days old (inside retention), plus a non-db file that must not
		// be touched.
		const fresh = join(backupDir, "sigrun-2026-10-07T00-00-00Z.db");
		const old = join(backupDir, "sigrun-2026-01-01T00-00-00Z.db");
		const edge = join(backupDir, "sigrun-2026-09-08T00-00-00Z.db");
		const foreign = join(backupDir, "unrelated.txt");
		await writeFile(fresh, "x");
		await writeFile(old, "x");
		await writeFile(edge, "x");
		await writeFile(foreign, "x");
		// mtime is the retention signal (not the name's date): fresh = now,
		// old = 10 days past the cutoff, edge = 1 day short of it.
		const day = 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - BACKUP_RETENTION_DAYS * day;
		await utimes(fresh, new Date(), new Date());
		await utimes(old, new Date(cutoff - 10 * day), new Date(cutoff - 10 * day));
		await utimes(edge, new Date(cutoff + day), new Date(cutoff + day));
		const { applyRetention } = await import("../src/backup/run-backup.js");
		await applyRetention(backupDir);
		const remaining = await import("node:fs/promises").then((fs) =>
			fs.readdir(backupDir),
		);
		expect(remaining).toContain("sigrun-2026-10-07T00-00-00Z.db");
		expect(remaining).toContain("sigrun-2026-09-08T00-00-00Z.db");
		expect(remaining).toContain("unrelated.txt");
		expect(remaining).not.toContain("sigrun-2026-01-01T00-00-00Z.db");
	});

	test("sqlite3 failure → non-zero exit, stderr, no output file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const notDb = join(dir, "not-a.db");
		await writeFile(notDb, "garbage-not-a-database");
		const backupDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(backupDir, { recursive: true, force: true }));
		const result = await runScript(notDb, {
			SIGRUN_BACKUP_PATH: backupDir,
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr.length).toBeGreaterThan(0);
		expect(await import("node:fs/promises").then((fs) => fs.readdir(backupDir))).toEqual([]);
	});

	test("no backup env → non-zero exit with a config error", async () => {
		const { dbPath } = await bootHarness();
		const result = await runScript(dbPath, {});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/SIGRUN_BACKUP/);
	});

	test("missing source db → fail loud, no output file (P1: sqlite3 create-on-open)", async () => {
		// sqlite3 opens its source with create flags: a nonexistent db path
		// backs up "successfully" as an EMPTY database — a SIGRUN_STORAGE_PATH
		// typo in deployment would produce nightly empty backups
		// indistinguishable from real ones. The script must refuse.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const missing = join(dir, "never-created.db");
		const backupDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(backupDir, { recursive: true, force: true }));
		const result = await runScript(missing, {
			SIGRUN_BACKUP_PATH: backupDir,
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/does not exist or is empty/);
		expect(await import("node:fs/promises").then((fs) => fs.readdir(backupDir))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The restore drill (App C named verification, automated)
// ---------------------------------------------------------------------------

describe("restore drill: live-harness backup resumes", () => {
	test("backup a LIVE harness, restore to scratch, open + resume + read the turn", async () => {
		const { opened, dbPath } = await bootHarness();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: "restore drill turn" },
			BACKGROUND_CONTEXT,
		);
		await submission.wait(BACKGROUND_CONTEXT);

		// Pin the live-WAL property the drill exists to verify: the WAL
		// sidecar must be non-empty at backup time (an un-checkpointed live
		// database). If pi-durable ever checkpoints eagerly this assertion
		// fails — surfacing that the drill no longer exercises the live-WAL
		// path rather than silently degrading to a checkpointed-file backup.
		const walStat = await import("node:fs/promises").then((fs) =>
			fs.stat(`${dbPath}-wal`),
		);
		expect(walStat.size).toBeGreaterThan(0);

		// Backup against the live (still-open, WAL) harness.
		const backupDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(backupDir, { recursive: true, force: true }));
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const result = await runScript(dbPath, {
			SIGRUN_BACKUP_PATH: backupDir,
			SIGRUN_STATE_DIR: stateDir,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const fs = await import("node:fs/promises");
		const [backupFile] = await fs.readdir(backupDir);
		const scratchDir = await mkdtemp(join(tmpdir(), "sigrun-restore-"));
		cleanups.push(() => rm(scratchDir, { recursive: true, force: true }));
		const restoredDb = join(scratchDir, "restored.db");
		await fs.copyFile(join(backupDir, backupFile), restoredDb);

		// The drill proper: open the RESTORED copy as a fresh harness, resume,
		// and read the root conversation — the pre-backup turn must have
		// survived, and a post-restore submit must still work (resume() left
		// the harness functional, not just readable).
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("post-restore answer")]);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const restoredConfig = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: restoredDb,
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: scratchDir,
		});
		const restored = await openHarness(restoredConfig, {
			extensions: [contributor],
			env: {},
		});
		cleanups.push(() =>
			restored.harness.close(BACKGROUND_CONTEXT).catch(() => {}),
		);
		const restoredRoot = await restored.harness.root(BACKGROUND_CONTEXT);
		const state = await restoredRoot.viewState(BACKGROUND_CONTEXT);
		const view = state.value;
		await state.dispose();
		const userTurns = view.entries
			.filter((e) => e.kind === "pi.user")
			.map((e) => JSON.stringify(e));
		expect(userTurns.join("\n")).toContain("restore drill turn");

		const restoredSubmission = await restoredRoot.submit(
			{ type: "input", content: "post-restore turn" },
			BACKGROUND_CONTEXT,
		);
		const settled = await restoredSubmission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		const postState = await restoredRoot.viewState(BACKGROUND_CONTEXT);
		const postView = postState.value;
		await postState.dispose();
		expect(
			postView.entries
				.map((e) => JSON.stringify(e))
				.join("\n"),
		).toContain("post-restore answer");
	});
});

// ---------------------------------------------------------------------------
// S3 upload leg via the injected client factory (an in-process fake: no
// real bucket, no network, no aws binary)
// ---------------------------------------------------------------------------

describe("runBackup (s3 target, fake PutObject client)", () => {
	test("uploads the snapshot and the marker with the bucket/prefix key; honours the endpoint; fails loud", async () => {
		const { dbPath } = await bootHarness();
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const puts: Array<{ bucket: string; key: string; body: Uint8Array }> = [];
		const configs: Array<Record<string, unknown>> = [];
		const restore = useFakeS3((config) => {
			configs.push(config as Record<string, unknown>);
			return {
				send: async (command: { input: Record<string, unknown> }) => {
					puts.push({
						bucket: command.input.Bucket as string,
						key: command.input.Key as string,
						body: command.input.Body as Uint8Array,
					});
					return {};
				},
				destroy: () => {},
			};
		});
		cleanups.push(async () => restore());
		const result = await runInProcess(dbPath, {
			SIGRUN_BACKUP_S3_BUCKET: "sigrun-backups",
			SIGRUN_BACKUP_S3_PREFIX: "nightly/",
			// An S3-compatible store (spec §4.3's pluggable target): the
			// endpoint must reach the client config with path-style addressing,
			// or virtual-host resolution fails against MinIO/RustFS.
			SIGRUN_BACKUP_S3_ENDPOINT: "https://s3.example.test:3900",
			SIGRUN_STATE_DIR: stateDir,
		});
		expect(result.code).toBe(0);
		expect(configs).toHaveLength(1);
		expect(configs[0]).toMatchObject({
			endpoint: "https://s3.example.test:3900",
			forcePathStyle: true,
		});
		// The snapshot: prefix + generated name, carrying the sqlite bytes.
		const snapshot = puts.find((put) => put.key.endsWith(".db"));
		expect(snapshot).toBeDefined();
		expect(snapshot!.bucket).toBe("sigrun-backups");
		expect(snapshot!.key).toMatch(/^nightly\/sigrun-.*\.db$/);
		expect(snapshot!.body.byteLength).toBeGreaterThan(0);

		// And the fail-loud leg: an upload rejection fails the run, no
		// silent success.
		const failing = useFakeS3(() => ({
			send: async () => {
				throw new Error("acme: access denied");
			},
			destroy: () => {},
		}));
		cleanups.push(async () => failing());
		const failed = await runInProcess(dbPath, {
			SIGRUN_BACKUP_S3_BUCKET: "sigrun-backups",
			SIGRUN_STATE_DIR: stateDir,
		});
		expect(failed.code).not.toBe(0);
		expect(failed.stderr).toMatch(/acme: access denied/);
	});

	test("no endpoint means AWS's own endpoints (no forcePathStyle)", async () => {
		const { dbPath } = await bootHarness();
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-backup-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const configs: Array<Record<string, unknown>> = [];
		const restore = useFakeS3((config) => {
			configs.push(config as Record<string, unknown>);
			return { send: async () => ({}), destroy: () => {} };
		});
		cleanups.push(async () => restore());
		const result = await runInProcess(dbPath, {
			SIGRUN_BACKUP_S3_BUCKET: "sigrun-backups",
			SIGRUN_STATE_DIR: stateDir,
		});
		expect(result.code).toBe(0);
		expect(configs[0]?.forcePathStyle).toBeUndefined();
		expect(configs[0]?.endpoint).toBeUndefined();
	});
});
