/**
 * Task 9e: real `GET /v1/meta` health aggregation (spec §3 + §5).
 *
 * The three §5 health fields derive PURELY from boot state (the meta route
 * stays synchronous — no network, no storage):
 *
 * - `providers`: aggregate the §3 producers provider contributors defined —
 *   ANY "degraded" degrades the surface; no producers → "ok" (degenerate
 *   surfaces report ok by absence).
 * - `memory`: the loaded memory extension's §3 producer (retained by the
 *   loader from its factory result), else "ok" — the no-op memory default
 *   and quarantined extensions contribute no producer, and quarantines
 *   already surface via `extensions[].status` (no double-reporting).
 * - `backup`: derived from `config.backup` presence ("configured" when set;
 *   Task 11 owns the "degraded" case).
 *
 * Hermetic pattern (server.test.ts): a faux provider serves `faux/m`
 * through a provider contributor; `openHarness(config, {
		identity: await seededIdentity(dir), env: {} })` boots
 * in a tmpdir; `createServer` builds the Fastify app; `app.inject()`
 * exercises the meta route in-process. Memory-extension fixtures drive the
 * loader seam (`extensionSpecifiers`).
 *
 * Task 6 extends the same harness to `GET /v1/auth/check`: the secret-free
 * per-provider readiness report (env-degenerate `OPENAI_API_KEY` presence;
 * contributor-owned producer status), asserting the response never carries
 * credential material (spec §6.4).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type BackupConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SettingsFile } from "../src/harness/settings.js";
import {
	aggregateHealth,
	type HealthStatus,
} from "../src/harness/health.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity, unclaimedIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** Fixture: memory-surface extension carrying a degraded §3 producer. */
const FIXTURE_MEMORY = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory-degraded", "index.js"),
).href;

/** Fixture: NON-memory extension carrying a degraded §3 producer. */
const FIXTURE_NON_MEMORY = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ext-degraded", "index.js"),
).href;

/** Fixture: memory-surface extension whose factory throws (quarantined). */
const FIXTURE_BROKEN_MEMORY = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-broken-memory", "index.js"),
).href;

/** Fixture: valid extension with a malformed (non-function) health field. */
const FIXTURE_MALFORMED = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-malformed-health", "index.js"),
).href;

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/** GET /v1/meta as JSON — every test reads the same shape. */
async function getMeta(app: FastifyInstance): Promise<{
	health: {
		backup: string;
		memory: string;
		providers: string;
	};
	auth: {
		methods: string[];
		claimed: boolean;
	};
	backup: { lastSuccessAt?: string };
	extensions: { name: string; status: string; error?: string }[];
	dev: boolean;
}> {
	const response = await app.inject({ method: "GET", url: "/v1/meta" });
	expect(response.statusCode).toBe(200);
	return response.json();
}

/**
 * Boot a hermetic harness + server in a tmpdir; registers cleanup. The faux
 * contributor carries a PRESENT-healthy producer by default (covers the
 * "producer retained, reports ok" path); the degraded test overrides it.
 * Task 6 options: `contributors` (default: the faux contributor with its
 * producer), `model` (default `faux/m`), and `env` (default `{}`) — the
 * auth-check inputs (env-degenerate registration, `OPENAI_API_KEY`
 * presence).
 */
async function bootServer(options?: {
	extensionSpecifiers?: readonly string[];
	contributorHealth?: () => HealthStatus;
	backup?: BackupConfig;
	contributors?: (faux: ReturnType<typeof fauxProvider>) => readonly ProviderContributor[];
	model?: string;
	env?: Record<string, string | undefined>;
	/** Boot UNCLAIMED (no seeded directory user) — the setup-code posture. */
	unclaimed?: boolean;
	/** An explicit state root (§6.8: where the marker is read from). */
	stateDir?: string;
	/** A settings file to resolve through (the `server.*` file tier). */
	settings?: SettingsFile;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-meta-"));
	if (options?.settings !== undefined) {
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify(options.settings, null, "\t")}\n`,
		);
	}
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributors =
		options?.contributors?.(faux) ?? [
			{
				name: "ext-faux",
				providers: [{ provider: faux.provider }],
				health: options?.contributorHealth ?? (() => "ok"),
			},
		];
	const config = loadConfig(
		{
			SIGRUN_DEFAULT_MODEL: options?.model ?? "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
			...(options?.stateDir === undefined
				? {}
				: { SIGRUN_STATE_DIR: options.stateDir }),
			...(options?.settings === undefined
				? {}
				: { SIGRUN_CONFIG_DIR: dir }),
			// The env record feeds BOTH config parsing and the boot env — the
			// service-token test needs `SIGRUN_API_TOKEN` parsed into
			// `config.auth.serviceToken`, not just present to providers.
			...options?.env,
		},
		options?.settings,
	);
	const opened = await openHarness(config, {
		identity: options?.unclaimed
			? await unclaimedIdentity(dir)
			: await seededIdentity(dir),
		extensions: contributors,
		env: options?.env ?? {},
		// Hermetic: this suite pins memory-health + quarantine outcomes for
		// its FIXTURE extensions, not the built-in surface (builtins: false
		// = the pre-Task-2 boot shape).
		builtins: false,
		extensionSpecifiers: options?.extensionSpecifiers,
	});
	// The §6.8 derivation tests hand-set `backup` (no target env here);
	// the marker reads happen against the state root resolved above.
	const app = await createServer(
		opened,
		options?.backup === undefined ? config : { ...config, backup: options.backup },
	);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

// ---------------------------------------------------------------------------
// GET /v1/auth/check (T6: secret-free per-provider readiness)
// ---------------------------------------------------------------------------

/** Dummy key fixture — asserted ABSENT from every auth-check response (§6.4). */
const DUMMY_OPENAI_KEY = "sigrun-dummy-key-fixture";

/** GET /v1/auth/check as an inject response (raw body kept for §6.4 assertions). */
async function getAuthCheck(app: FastifyInstance) {
	return app.inject({ method: "GET", url: "/v1/auth/check" });
}

describe("GET /v1/auth/check", () => {
	test("env-degenerate provider: OPENAI_API_KEY set non-empty → ready", async () => {
		const { app } = await bootServer({
			contributors: () => [],
			model: "openai/gpt-test",
			env: { OPENAI_API_KEY: DUMMY_OPENAI_KEY },
		});
		const response = await getAuthCheck(app);
		expect(response.statusCode).toBe(200);
		// W3 Task 6 enrichment: `models` (count) + `owner` when contributed.
		expect(response.json()).toEqual({
			providers: [{ provider: "openai", status: "ready", models: 1 }],
		});
		// §6.4: statuses only — the key material never appears.
		expect(response.body).not.toContain(DUMMY_OPENAI_KEY);
	});

	test("env-degenerate provider: key absent → not_ready", async () => {
		const { app } = await bootServer({
			contributors: () => [],
			model: "openai/gpt-test",
			env: {},
		});
		const response = await getAuthCheck(app);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			providers: [{ provider: "openai", status: "not_ready", models: 1 }],
		});
	});

	test("env-degenerate provider: empty-string key → not_ready (non-empty ruling)", async () => {
		const { app } = await bootServer({
			contributors: () => [],
			model: "openai/gpt-test",
			env: { OPENAI_API_KEY: "" },
		});
		const response = await getAuthCheck(app);
		expect(response.json()).toEqual({
			providers: [{ provider: "openai", status: "not_ready", models: 1 }],
		});
	});

	test("contributor-owned provider: ok producer → ready", async () => {
		const { app } = await bootServer();
		const response = await getAuthCheck(app);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			providers: [
				{ provider: "faux", status: "ready", models: 1, owner: "ext-faux" },
			],
		});
	});

	test("contributor-owned provider: degraded producer → invalid", async () => {
		const { app } = await bootServer({
			contributorHealth: () => "degraded",
		});
		const response = await getAuthCheck(app);
		expect(response.json()).toEqual({
			providers: [
				{ provider: "faux", status: "invalid", models: 1, owner: "ext-faux" },
			],
		});
	});

	test("contributor-owned provider without a producer → not_ready (nothing to verify)", async () => {
		const { app } = await bootServer({
			contributors: (faux) => [
				{ name: "ext-faux", providers: [{ provider: faux.provider }] },
			],
		});
		const response = await getAuthCheck(app);
		expect(response.json()).toEqual({
			providers: [
				{ provider: "faux", status: "not_ready", models: 1, owner: "ext-faux" },
			],
		});
	});

	test("mixed catalog: contributor and env-degenerate providers report independently", async () => {
		const { app } = await bootServer({
			model: "openai/gpt-test",
			env: { OPENAI_API_KEY: DUMMY_OPENAI_KEY },
		});
		// Default ext-faux (ok producer) contributed first, then the
		// env-degenerate openai fallback registered for the SIGRUN_MODEL pin.
		const response = await getAuthCheck(app);
		expect(response.json()).toEqual({
			providers: [
				{ provider: "faux", status: "ready", models: 1, owner: "ext-faux" },
			{ provider: "openai", status: "ready", models: 1 },
			],
		});
	});

	test("response carries only provider+status — no credential material (§6.4)", async () => {
		const { app } = await bootServer({
			contributors: () => [],
			model: "openai/gpt-test",
			env: {
				OPENAI_API_KEY: DUMMY_OPENAI_KEY,
				OPENAI_BASE_URL: "https://auth-check-fixture.invalid/v1",
			},
		});
		const response = await getAuthCheck(app);
		const body = response.json();
		expect(Object.keys(body)).toEqual(["providers"]);
		for (const entry of body.providers) {
			// W3 Task 6: `models` joined the entry; still no credential
			// material — every field is status/count/ownership.
			expect(Object.keys(entry).sort()).toEqual([
				"models",
				"provider",
				"status",
			]);
		}
		expect(response.body).not.toContain(DUMMY_OPENAI_KEY);
		expect(response.body).not.toContain("auth-check-fixture.invalid");
	});
});

// ---------------------------------------------------------------------------
// The pure provider aggregation (§3 → §5 health.providers)
// ---------------------------------------------------------------------------

describe("aggregateHealth (the §3 pure aggregation)", () => {
	test("no producers is ok (degenerate surfaces report ok by absence)", () => {
		expect(aggregateHealth([])).toBe("ok");
	});

	test("all-ok producers stay ok", () => {
		expect(
			aggregateHealth([
				{ name: "a", health: () => "ok" },
				{ name: "b", health: () => "ok" },
			]),
		).toBe("ok");
	});

	test("ANY degraded producer degrades the surface", () => {
		expect(
			aggregateHealth([
				{ name: "a", health: () => "ok" },
				{ name: "b", health: () => "degraded" },
				{ name: "c", health: () => "ok" },
			]),
		).toBe("degraded");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/meta health block
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /v1/meta auth block (W1 Task 6, spec §5.7)
// ---------------------------------------------------------------------------

describe("GET /v1/meta dev (spec §14.2/§14.4: the development flag)", () => {
	test("default false; SIGRUN_DEV=1 reports true", async () => {
		const plain = await bootServer();
		expect((await getMeta(plain.app)).dev).toBe(false);
		const dev = await bootServer({ env: { SIGRUN_DEV: "1" } });
		expect((await getMeta(dev.app)).dev).toBe(true);
	});

	test("SIGRUN_DEV=yes fails loud at boot (config parse), naming the variable", async () => {
		await expect(bootServer({ env: { SIGRUN_DEV: "yes" } })).rejects.toThrow(
			/SIGRUN_DEV must be "true" or "false"/,
		);
	});
});

describe("GET /v1/meta auth", () => {
	test("claimed boot: auth.claimed true + the effective method list", async () => {
		const { app } = await bootServer();
		const meta = await getMeta(app);
		// SIGRUN_AUTH: "none" in the test config → the derived method list
		// is EMPTY (the naive workstation path); the seeded directory user
		// claims the server.
		expect(meta.auth).toEqual({ methods: [], claimed: true });
	});

	test("unclaimed boot: auth.claimed false (read via the env service token — the setup gate holds every other path)", async () => {
		const SERVICE_TOKEN = "sgr-test-service-token-fixture";
		const { app } = await bootServer({
			unclaimed: true,
			env: { SIGRUN_API_TOKEN: SERVICE_TOKEN },
		});
		// Without a credential the setup gate (403 setup_required) owns
		// /v1/meta — the auth block is only readable once trust resolves.
		const gated = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(gated.statusCode).toBe(403);
		expect(gated.json()).toEqual({ error: "setup_required" });
		// The env service token skips the gate (pipeline stage 3).
		const response = await app.inject({
			method: "GET",
			url: "/v1/meta",
			headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().auth).toEqual({ methods: [], claimed: false });
	});
});

describe("GET /v1/meta health", () => {
	test("default boot: present-healthy producer, no memory extension, no backup", async () => {
		const { app } = await bootServer();
		const meta = await getMeta(app);
		expect(meta.health).toEqual({
			backup: "unconfigured",
			memory: "ok",
			providers: "ok",
		});
	});

	test("a contributor whose health() reports degraded degrades providers", async () => {
		const { app } = await bootServer({
			contributorHealth: () => "degraded",
		});
		const meta = await getMeta(app);
		expect(meta.health).toEqual({
			backup: "unconfigured",
			memory: "ok",
			providers: "degraded",
		});
	});

	test("the memory extension's factory-result producer drives memory health", async () => {
		const { app } = await bootServer({
			extensionSpecifiers: [FIXTURE_MEMORY],
		});
		const meta = await getMeta(app);
		expect(meta.extensions).toEqual([
			{ name: "sigrun-fixture-memory-degraded", status: "ok" },
		]);
		expect(meta.health).toEqual({
			backup: "unconfigured",
			memory: "degraded",
			providers: "ok",
		});
	});

	test("a non-memory extension's producer does not feed memory health", async () => {
		const { app } = await bootServer({
			extensionSpecifiers: [FIXTURE_NON_MEMORY],
		});
		const meta = await getMeta(app);
		expect(meta.extensions).toEqual([
			{ name: "sigrun-fixture-ext-degraded", status: "ok" },
		]);
		// Memory health is the LOADED MEMORY EXTENSION's producer — not any
		// extension's producer; a non-memory producer is retained but inert.
		expect(meta.health).toEqual({
			backup: "unconfigured",
			memory: "ok",
			providers: "ok",
		});
	});

	test("a quarantined memory extension reports via extensions[].status, not health.memory", async () => {
		const { app } = await bootServer({
			extensionSpecifiers: [FIXTURE_BROKEN_MEMORY],
		});
		const meta = await getMeta(app);
		expect(meta.extensions).toEqual([
			{
				name: FIXTURE_BROKEN_MEMORY,
				status: "quarantined",
				error: expect.stringContaining(
					"fixture: memory backend unavailable",
				) as unknown,
			},
		]);
		// No double-report: the quarantine surfaces through extensions[].status;
		// the memory surface fell back to the no-op default (degenerate ok).
		expect(meta.health).toEqual({
			backup: "unconfigured",
			memory: "ok",
			providers: "ok",
		});
	});

	test("a malformed factory health field quarantines the extension (fail-loud)", async () => {
		const { app } = await bootServer({
			extensionSpecifiers: [FIXTURE_MALFORMED],
		});
		const meta = await getMeta(app);
		expect(meta.extensions).toEqual([
			{
				name: FIXTURE_MALFORMED,
				status: "quarantined",
				error: expect.stringContaining("health") as unknown,
			},
		]);
		expect(meta.health).toEqual({
			backup: "unconfigured",
			memory: "ok",
			providers: "ok",
		});
	});

	test("a configured target with a fresh marker derives configured (§6.8)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		await writeMarker(stateDir, new Date().toISOString());
		const { app } = await bootServer({
			backup: { target: "path", path: "/tmp/sigrun-backups" },
			stateDir,
		});
		const meta = await getMeta(app);
		expect(meta.health).toEqual({
			backup: "configured",
			memory: "ok",
			providers: "ok",
		});
	});
});

// ---------------------------------------------------------------------------
// GET /v1/meta health.backup — §6.8 backup honesty (the last-success marker)
// ---------------------------------------------------------------------------

/** Fabricate `<stateDir>/backup/last-success.json` (§6.8's shape). */
async function writeMarker(
	stateDir: string,
	at: string,
	target: "path" | "s3" = "path",
): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(stateDir, "backup"), { recursive: true });
	await writeFile(
			join(stateDir, "backup", "last-success.json"),
			`${JSON.stringify({ at, target, bytes: 4096 }, null, "\t")}\n`,
		);
}

const HOUR = 60 * 60 * 1000;

describe("GET /v1/meta health.backup (§6.8 marker honesty)", () => {
	test("configured + a fresh marker → configured, lastSuccessAt surfaces", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const at = new Date().toISOString();
		await writeMarker(stateDir, at);
		const { app } = await bootServer({
			backup: { target: "path", path: "/tmp/sigrun-backups" },
			stateDir,
		});
		const meta = await getMeta(app);
		expect(meta.health.backup).toBe("configured");
		expect(meta.backup.lastSuccessAt).toBe(at);
	});

	test("a marker 37 h old → degraded (the 36 h default window)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const at = new Date(Date.now() - 37 * HOUR).toISOString();
		await writeMarker(stateDir, at);
		const { app } = await bootServer({
			backup: { target: "s3", bucket: "sigrun-backups" },
			stateDir,
		});
		const meta = await getMeta(app);
		expect(meta.health.backup).toBe("degraded");
		// The stale timestamp still surfaces — the operator's "when WAS the
		// last success" is exactly what a degraded badge begs for.
		expect(meta.backup.lastSuccessAt).toBe(at);
	});

	test("no marker → degraded (the badge no longer lies about silent failure)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const { app } = await bootServer({
			backup: { target: "path", path: "/tmp/sigrun-backups" },
			stateDir,
		});
		const meta = await getMeta(app);
		expect(meta.health.backup).toBe("degraded");
		expect(meta.backup.lastSuccessAt).toBeUndefined();
	});

	test("unconfigured → unconfigured (a marker alone claims nothing)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		await writeMarker(stateDir, new Date().toISOString());
		const { app } = await bootServer({ stateDir });
		const meta = await getMeta(app);
		expect(meta.health.backup).toBe("unconfigured");
	});

	test("server.backup.staleAfterHours (file) retunes the window: 37 h old, 48 h window → configured", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const at = new Date(Date.now() - 37 * HOUR).toISOString();
		await writeMarker(stateDir, at);
		const { app } = await bootServer({
			backup: { target: "path", path: "/tmp/sigrun-backups" },
			stateDir,
			settings: { server: { backup: { staleAfterHours: 48 } } },
		});
		const meta = await getMeta(app);
		expect(meta.health.backup).toBe("configured");
		expect(meta.backup.lastSuccessAt).toBe(at);
	});

	test("a corrupt marker degrades (never a 500): unparseable JSON", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(stateDir, "backup"), { recursive: true });
		await writeFile(join(stateDir, "backup", "last-success.json"), "{not json");
		const { app } = await bootServer({
			backup: { target: "path", path: "/tmp/sigrun-backups" },
			stateDir,
		});
		const meta = await getMeta(app);
		expect(meta.health.backup).toBe("degraded");
		expect(meta.backup.lastSuccessAt).toBeUndefined();
	});

	test("a wrong-shape marker degrades: `at` that is not a timestamp", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sigrun-meta-marker-"));
		cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
		await writeMarker(stateDir, "yesterday, probably");
		const { app } = await bootServer({
			backup: { target: "path", path: "/tmp/sigrun-backups" },
			stateDir,
		});
		const meta = await getMeta(app);
		expect(meta.health.backup).toBe("degraded");
		expect(meta.backup.lastSuccessAt).toBeUndefined();
	});
});
