/**
 * Task 13: probe endpoints — `GET /healthz` (liveness) + `GET /readyz`
 * (readiness), spec §4.4 "distinguishes process-up from harness-ready".
 *
 * Shapes (task-13 brief):
 * - `/healthz`: 200 ALWAYS once listening — no aggregation, no storage; the
 *   dead-simple "the event loop answers" signal. Body is a single
 *   Prometheus-exposition line (`sigrun_liveness 1`) so the endpoint is
 *   scrape-compatible (the M1 ServiceMonitor story; see the task report's
 *   metrics scoping decision).
 * - `/readyz`: 200 with `sigrun_readiness 1` only when (a) T9e health
 *   aggregation says not-degraded (memory + providers) AND (b) a cheap REAL
 *   storage read succeeds — resolving the reserved root conversation through
 *   the session line. 503 + `{ ready: false, checks: {...} }` otherwise.
 *
 * Hermetic pattern (server-meta-health.test.ts): a faux provider serves
 * `faux/m` through a provider contributor; `openHarness(config, { env: {} })`
 * boots in a tmpdir; `createServer` builds the Fastify app; `app.inject()`
 * exercises the routes in-process. Degraded health is driven through the T9e
 * seams (`contributorHealth` / the fixture memory extension's factory
 * producer); storage failure is driven by closing the harness under the
 * server (the session line then refuses reads).
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
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { HealthStatus } from "../src/harness/health.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/** Fixture: memory-surface extension carrying a degraded §3 producer. */
const FIXTURE_MEMORY = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory-degraded", "index.js"),
).href;

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/**
 * Boot a hermetic harness + server in a tmpdir; registers a TOLERANT cleanup
 * (the storage-failure test closes the harness itself — a second close throws
 * upstream, so the cleanup swallows per-piece errors and always removes the
 * tmpdir).
 */
async function bootServer(options?: {
	extensionSpecifiers?: readonly string[];
	contributorHealth?: () => HealthStatus;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-probes-"));
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
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		extensionSpecifiers: options?.extensionSpecifiers,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

// ---------------------------------------------------------------------------
// GET /healthz — liveness
// ---------------------------------------------------------------------------

describe("GET /healthz", () => {
	test("answers 200 with the liveness gauge line on a healthy boot", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/healthz" });
		expect(response.statusCode).toBe(200);
		expect(response.body).toBe("sigrun_liveness 1\n");
		expect(response.headers["content-type"]).toContain("text/plain");
	});

	test("stays 200 even while readiness would fail (process-up only)", async () => {
		// Liveness must NOT aggregate health or touch storage: a degraded
		// provider flips /readyz to 503 while /healthz keeps answering 200 —
		// the kubelet must not restart a process that is merely degraded.
		const { app } = await bootServer({
			contributorHealth: () => "degraded",
		});
		const response = await app.inject({ method: "GET", url: "/healthz" });
		expect(response.statusCode).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// GET /readyz — readiness
// ---------------------------------------------------------------------------

describe("GET /readyz", () => {
	test("answers 200 with the readiness gauge line after a normal boot", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/readyz" });
		expect(response.statusCode).toBe(200);
		expect(response.body).toBe("sigrun_readiness 1\n");
		expect(response.headers["content-type"]).toContain("text/plain");
	});

	test("503 + JSON checks when a provider contributor reports degraded", async () => {
		const { app } = await bootServer({
			contributorHealth: () => "degraded",
		});
		const response = await app.inject({ method: "GET", url: "/readyz" });
		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			ready: false,
			checks: { memory: "ok", providers: "degraded", storage: "ok" },
		});
	});

	test("503 + JSON checks when the memory extension's producer reports degraded", async () => {
		const { app } = await bootServer({
			extensionSpecifiers: [FIXTURE_MEMORY],
		});
		const response = await app.inject({ method: "GET", url: "/readyz" });
		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			ready: false,
			checks: { memory: "degraded", providers: "ok", storage: "ok" },
		});
	});

	test("503 + JSON checks when the storage read fails (harness closed under the server)", async () => {
		const { app, opened } = await bootServer();
		// The server outlives its harness: closing the session line makes the
		// root-conversation resolution fail — exactly the "storage not
		// answering right now" readiness must catch.
		await opened.harness.close(BACKGROUND_CONTEXT);
		const response = await app.inject({ method: "GET", url: "/readyz" });
		expect(response.statusCode).toBe(503);
		const body = response.json();
		expect(body.ready).toBe(false);
		expect(body.checks).toEqual({
			memory: "ok",
			providers: "ok",
			storage: "failed",
		});
	});
});
