/**
 * Probe endpoints — `GET /healthz` (liveness) + `GET /readyz`
 * (readiness), spec §4.4 "distinguishes process-up from harness-ready".
 *
 * Shapes:
 * - `/healthz`: 200 ALWAYS once listening — no aggregation, no storage; the
 *   dead-simple "the event loop answers" signal. Body is a single
 *   Prometheus-exposition line (`sigrun_liveness 1`) so the endpoint is
 *   scrape-compatible (the M1 ServiceMonitor story; see the task report's
 *   metrics scoping decision).
 * - `/readyz` (W2 §6.1, storage-only): 200 with `sigrun_readiness 1` when
 *   booted AND a cheap REAL storage read succeeds — resolving the reserved
 *   root conversation through the session line. 503 +
 *   `{ ready: false, checks: { storage } }` otherwise. Provider and memory
 *   health do NOT gate readiness ("a degraded upstream is never a Service
 *   outage") — they stay visible in `/v1/meta`, `/v1/providers`, and
 *   `/metrics`.
 *
 * Hermetic pattern (server-meta-health.test.ts): a faux provider serves
 * `faux/m` through a provider contributor; `openHarness(config, {
		identity: await seededIdentity(dir), env: {} })`
 * boots in a tmpdir; `createServer` builds the Fastify app; `app.inject()`
 * exercises the routes in-process. Degraded health is driven through the
 * degraded fixtures (a provider contributor, a memory-surface extension,
 * a non-memory extension — all three must leave readiness alone); storage
 * failure is driven by closing the harness under the server (the session
 * line then refuses reads).
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
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** Fixture: memory-surface extension carrying a degraded §3 producer. */
const FIXTURE_MEMORY = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory-degraded", "index.js"),
).href;

/** Fixture: NON-memory extension carrying a degraded §3 producer. */
const FIXTURE_EXT = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ext-degraded", "index.js"),
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
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
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
		// Liveness must NOT aggregate health or touch storage: a closed harness
		// (storage dead, /readyz 503) leaves /healthz answering 200 — refusing
		// readiness is readiness's job; the kubelet restarts nothing.
		const { app, opened } = await bootServer({
			contributorHealth: () => "degraded",
		});
		await opened.harness.close(BACKGROUND_CONTEXT);
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

	test("stays 200 when a provider and memory report degraded", async () => {
		// W2 §6.1: readiness = boot complete + a real storage read. Provider
		// and memory health leave readiness (they stay visible in /v1/meta,
		// /v1/providers, and /metrics) — a degraded upstream is never a
		// Service outage, so no endpoint gap and no pod eviction.
		const { app } = await bootServer({
			contributorHealth: () => "degraded",
			extensionSpecifiers: [FIXTURE_MEMORY, FIXTURE_EXT],
		});
		const response = await app.inject({ method: "GET", url: "/readyz" });
		expect(response.statusCode).toBe(200);
		expect(response.body).toBe("sigrun_readiness 1\n");
	});

	test("503 + `{ storage: failed }` when the storage read fails (harness closed under the server)", async () => {
		const { app, opened } = await bootServer();
		// The server outlives its harness: closing the session line makes the
		// root-conversation resolution fail — exactly the "storage not
		// answering right now" readiness must catch.
		await opened.harness.close(BACKGROUND_CONTEXT);
		const response = await app.inject({ method: "GET", url: "/readyz" });
		expect(response.statusCode).toBe(503);
		const body = response.json();
		expect(body.ready).toBe(false);
		expect(body.checks).toEqual({ storage: "failed" });
	});
});
