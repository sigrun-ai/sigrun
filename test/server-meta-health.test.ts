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
 * through a provider contributor; `openHarness(config, { env: {} })` boots
 * in a tmpdir; `createServer` builds the Fastify app; `app.inject()`
 * exercises the meta route in-process. Memory-extension fixtures drive the
 * loader seam (`extensionSpecifiers`).
 */

import { mkdtemp, rm } from "node:fs/promises";
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
import {
	aggregateHealth,
	type HealthStatus,
} from "../src/harness/health.js";
import { createServer } from "../src/server/index.js";
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
	extensions: { name: string; status: string; error?: string }[];
}> {
	const response = await app.inject({ method: "GET", url: "/v1/meta" });
	expect(response.statusCode).toBe(200);
	return response.json();
}

/**
 * Boot a hermetic harness + server in a tmpdir; registers cleanup. The faux
 * contributor carries a PRESENT-healthy producer by default (covers the
 * "producer retained, reports ok" path); the degraded test overrides it.
 */
async function bootServer(options?: {
	extensionSpecifiers?: readonly string[];
	contributorHealth?: () => HealthStatus;
	backup?: BackupConfig;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-meta-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
		health: options?.contributorHealth ?? (() => "ok"),
	};
	const config = loadConfig({
		SIGRUN_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		extensionSpecifiers: options?.extensionSpecifiers,
	});
	// `config.backup` has no env parsing yet (T11); hand-set it to exercise
	// the presence-derived backup health.
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
			{ name: "sigrun.fixture-memory-degraded", status: "ok" },
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
			{ name: "sigrun.fixture-ext-degraded", status: "ok" },
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

	test("config.backup presence derives backup health (T11 owns degraded)", async () => {
		const { app } = await bootServer({
			backup: { target: "path", path: "/tmp/sigrun-backups" },
		});
		const meta = await getMeta(app);
		expect(meta.health).toEqual({
			backup: "configured",
			memory: "ok",
			providers: "ok",
		});
	});
});
