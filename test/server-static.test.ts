/**
 * Task 20: the webui channel-bundle serving seam (spec §4.1/§6) —
 * `src/server/static.ts` + the `createServer` wiring.
 *
 * Shapes (task-20 brief):
 * - bundle present → `GET /` serves the bundle's index.html and static
 *   assets serve under their paths; `capabilities.channels` includes
 *   "webui".
 * - bundle absent (default path, supported API-only deploy) → `GET /` is
 *   Fastify's default 404 JSON; `capabilities.channels` is [].
 * - SPA fallback: `GET /some/client/route` serves index.html; `/v1/*`
 *   unknowns keep Fastify's 404 JSON (the API error surface is unchanged
 *   whether or not a bundle is mounted); `/healthz`/`/readyz` are probes,
 *   never the SPA.
 * - `SIGRUN_WEBUI_BUNDLE` set-but-missing → `createServer` rejects (fail
 *   loud on a misconfigured deploy).
 *
 * The bundle is a HAND-WRITTEN fixture (`test/fixtures/webui-dist/`) — the
 * server tests never run a vite build (hermetic + fast); the real build is
 * verified by the webui workspace's own build script and the task's manual
 * smoke.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";

/** The hand-written bundle fixture (marked content the tests assert on). */
const FIXTURE_BUNDLE = join(import.meta.dirname, "fixtures", "webui-dist");

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/**
 * Boot a hermetic harness + server in a tmpdir (the server-probes pattern).
 * `webuiBundle` overrides the config's bundle path AFTER loadConfig so the
 * absent-bundle case never depends on the repo's real webui/dist state.
 */
async function bootServer(options?: {
	webuiBundleEnv?: string;
	webuiBundleOverride?: { path: string; explicit: boolean };
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-static-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
		health: () => "ok",
	};
	const env: Record<string, string> = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	};
	if (options?.webuiBundleEnv !== undefined) {
		env.SIGRUN_WEBUI_BUNDLE = options.webuiBundleEnv;
	}
	let config = loadConfig(env);
	if (options?.webuiBundleOverride !== undefined) {
		config = {
			...config,
			webuiBundle: options.webuiBundleOverride.path,
			webuiBundleExplicit: options.webuiBundleOverride.explicit,
		};
	}
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
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
// Config parsing
// ---------------------------------------------------------------------------

describe("SIGRUN_WEBUI_BUNDLE config", () => {
	test("defaults to webui/dist and marks itself non-explicit", () => {
		const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "faux/m" });
		expect(config.webuiBundle).toBe("webui/dist");
		expect(config.webuiBundleExplicit).toBe(false);
	});

	test("an explicit env value wins and marks itself explicit", () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_WEBUI_BUNDLE: "/srv/sigrun/webui",
		});
		expect(config.webuiBundle).toBe("/srv/sigrun/webui");
		expect(config.webuiBundleExplicit).toBe(true);
	});

	test("an empty env value falls back to the default (the shell's unset-adjacent value)", () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_WEBUI_BUNDLE: "",
		});
		expect(config.webuiBundle).toBe("webui/dist");
		expect(config.webuiBundleExplicit).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Bundle present
// ---------------------------------------------------------------------------

describe("webui bundle present", () => {
	test("GET / serves the bundle's index.html", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const response = await app.inject({ method: "GET", url: "/" });
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/html");
		expect(response.body).toContain("sigrun-webui-fixture");
	});

	test("GET /assets/app.js serves a static asset from the bundle root", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const response = await app.inject({ method: "GET", url: "/assets/app.js" });
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("javascript");
		expect(response.body).toContain("sigrun-webui-fixture-asset");
	});

	test("/v1/meta capabilities.channels includes webui", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(200);
		const meta = response.json() as {
			capabilities: { channels: string[] };
		};
		expect(meta.capabilities.channels).toContain("webui");
	});
});

// ---------------------------------------------------------------------------
// Bundle absent (supported API-only deploy)
// ---------------------------------------------------------------------------

describe("webui bundle absent", () => {
	test("GET / is Fastify's default 404 JSON (the stock no-bundle surface)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-static-absent-"));
		cleanups.push(async () => {
			await rm(dir, { recursive: true, force: true });
		});
		const { app } = await bootServer({
			webuiBundleOverride: {
				path: join(dir, "no-such-bundle"),
				explicit: false,
			},
		});
		const response = await app.inject({ method: "GET", url: "/" });
		expect(response.statusCode).toBe(404);
		const body = response.json() as { error: string; statusCode: number };
		expect(body.error).toBe("Not Found");
		expect(body.statusCode).toBe(404);
	});

	test("/v1/meta capabilities.channels is []", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-static-absent-"));
		cleanups.push(async () => {
			await rm(dir, { recursive: true, force: true });
		});
		const { app } = await bootServer({
			webuiBundleOverride: {
				path: join(dir, "no-such-bundle"),
				explicit: false,
			},
		});
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(200);
		const meta = response.json() as {
			capabilities: { channels: string[] };
		};
		expect(meta.capabilities.channels).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

describe("SPA fallback (bundle present)", () => {
	test("GET /some/client/route serves index.html (deep links work)", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const response = await app.inject({
			method: "GET",
			url: "/some/client/route",
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/html");
		expect(response.body).toContain("sigrun-webui-fixture");
	});

	test("GET /v1/unknown stays Fastify's 404 JSON — the fallback never swallows the API", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const response = await app.inject({ method: "GET", url: "/v1/unknown" });
		expect(response.statusCode).toBe(404);
		const body = response.json() as { error: string; statusCode: number };
		expect(body.error).toBe("Not Found");
		expect(body.statusCode).toBe(404);
	});

	test("POST to an unknown non-/v1 path is a 404, not the SPA document", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const response = await app.inject({
			method: "POST",
			url: "/some/client/route",
		});
		expect(response.statusCode).toBe(404);
	});

	test("/healthz and /readyz answer as probes, never the SPA", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const liveness = await app.inject({ method: "GET", url: "/healthz" });
		expect(liveness.statusCode).toBe(200);
		expect(liveness.body).toBe("sigrun_liveness 1\n");
		const readiness = await app.inject({ method: "GET", url: "/readyz" });
		expect(readiness.statusCode).toBe(200);
		expect(readiness.body).toBe("sigrun_readiness 1\n");
	});

	test("/v1/meta and /v1/conversations keep serving the §5 API", async () => {
		const { app } = await bootServer({ webuiBundleEnv: FIXTURE_BUNDLE });
		const meta = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(meta.statusCode).toBe(200);
		expect(meta.headers["content-type"]).toContain("application/json");
		const list = await app.inject({
			method: "GET",
			url: "/v1/conversations",
		});
		expect(list.statusCode).toBe(200);
		expect(list.headers["content-type"]).toContain("application/json");
	});
});

// ---------------------------------------------------------------------------
// Explicit-but-missing bundle: fail loud
// ---------------------------------------------------------------------------

describe("SIGRUN_WEBUI_BUNDLE set but missing", () => {
	test("createServer rejects — a misconfigured deploy must not boot API-only silently", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-static-missing-"));
		cleanups.push(async () => {
			await rm(dir, { recursive: true, force: true });
		});
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
			health: () => "ok",
		};
		const config: SigrunConfig = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_WEBUI_BUNDLE: join(dir, "no-such-bundle"),
		});
		const opened = await openHarness(config, {
			extensions: [contributor],
			env: {},
		});
		cleanups.push(async () => {
			await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		});
		await expect(createServer(opened, config)).rejects.toThrow(
			/SIGRUN_WEBUI_BUNDLE/,
		);
	});
});
