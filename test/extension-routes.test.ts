/**
 * Extension HTTP routes (core hardening W5 Task 2, spec §9.2): the
 * `/v1/ext/<slug>/<path>` mount, the web-standard Request/Response
 * adapter, per-route auth (public/user/admin), the 1 MiB body ceiling,
 * the `server.publicUrl` base, and the load-time validation that
 * quarantines a malformed `routes` declaration.
 *
 * Fixtures: `fixture-routes` (slug `fixture-routes`; ping/hook/boom/
 * bad/admin-only) and `fixture-routes-bad` (a `path: "../x"` route —
 * quarantined at load). Token-method boots with a claimed directory
 * (the auth-pipeline pattern); the unclaimed case boots the
 * `unclaimedIdentity` bundle instead.
 *
 * Review-focus pins (the plan's §Review Focus 1-2):
 * - an UNCLAIMED server answers a `public` route 403 `setup_required`
 *   (stage 4 still applies — public skips stage 5 ONLY);
 * - a handler that throws or returns a non-`Response` answers
 *   500 `extension_route_failed` naming the extension, and the server
 *   keeps answering (`/healthz` after the failure).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity, unclaimedIdentity } from "./helpers/identity.js";

const ROUTES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-routes", "index.js"),
).href;
const BAD_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-routes-bad", "index.js"),
).href;

/** The default ext-route body ceiling (spec §9.2): 1 MiB. */
const ONE_MIB = 1_048_576;

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
	readonly adminToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot one hermetic token-method server. Claimed by default (admin
 * `tester` + non-admin `alice`); `claimed: false` boots the unclaimed
 * posture for the setup-gate pin.
 */
async function bootServer(options?: {
	readonly claimed?: boolean;
	readonly publicUrl?: string;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-ext-routes-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
		...(options?.publicUrl === undefined
			? {}
			: { SIGRUN_PUBLIC_URL: options.publicUrl }),
	});
	const identity =
		options?.claimed === false
			? await unclaimedIdentity(join(dir, "seed"))
			: await seededIdentity(join(dir, "seed"));
	// alice only on the CLAIMED posture — adding a user to the unclaimed
	// bundle would CLAIM it (the first directory user is the claim).
	if (options?.claimed !== false && identity.users.get("alice") === undefined) {
		await identity.users.add({ user: "alice", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [ROUTES_SPECIFIER, BAD_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const { token: adminToken } = await opened.identity.tokens.create(
		"tester-cli",
		"tester",
	);
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, aliceToken, adminToken };
}

/** One injected request; returns status + parsed-or-raw body. */
async function call(
	app: FastifyInstance,
	options: {
		readonly method: string;
		readonly url: string;
		readonly token?: string;
		readonly payload?: string;
		readonly headers?: Record<string, string>;
	},
): Promise<{ status: number; json: () => unknown; body: string }> {
	const response = await app.inject({
		method: options.method as "GET",
		url: options.url,
		headers: {
			...(options.token === undefined
				? {}
				: { authorization: `Bearer ${options.token}` }),
			...(options.headers ?? {}),
		},
		...(options.payload === undefined ? {} : { payload: options.payload }),
	});
	return {
		status: response.statusCode,
		json: () => response.json(),
		body: response.body,
	};
}

describe("extension HTTP routes", () => {
	test("a user route with alice's token answers the principal", async () => {
		const { app, aliceToken } = await bootServer();
		const response = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-routes/ping",
			token: aliceToken,
		});
		expect(response.status).toBe(200);
		expect(response.json()).toEqual({ user: "alice" });
	});

	test("a user route without a credential is 401", async () => {
		const { app } = await bootServer();
		const response = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-routes/ping",
		});
		expect(response.status).toBe(401);
		expect(response.json()).toEqual({ error: "unauthenticated" });
	});

	test("a public route answers without a credential, echoing the body", async () => {
		const { app } = await bootServer();
		const response = await call(app, {
			method: "POST",
			url: "/v1/ext/fixture-routes/hook",
			headers: { "content-type": "text/plain" },
			payload: "webhook-payload",
		});
		expect(response.status).toBe(200);
		expect(response.body).toBe("webhook-payload");
	});

	test("the handler's Request URL is absolute (server.publicUrl when set)", async () => {
		// The fixture echoes the absolute URL it received through a
		// response header (the body stays the echoed request body).
		const { app } = await bootServer({ publicUrl: "https://sigrun.example/" });
		const response = await app.inject({
			method: "POST",
			url: "/v1/ext/fixture-routes/hook",
			headers: { "content-type": "text/plain" },
			payload: "x",
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["x-request-url"]).toBe(
			"https://sigrun.example/v1/ext/fixture-routes/hook",
		);
	});

	test("without server.publicUrl the Request URL falls back to the Host header", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/ext/fixture-routes/hook",
			headers: { "content-type": "text/plain", host: "box.example:8080" },
			payload: "x",
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["x-request-url"]).toBe(
			"http://box.example:8080/v1/ext/fixture-routes/hook",
		);
	});

	test("a public route on an UNCLAIMED server is 403 setup_required", async () => {
		const { app } = await bootServer({ claimed: false });
		const response = await call(app, {
			method: "POST",
			url: "/v1/ext/fixture-routes/hook",
			headers: { "content-type": "text/plain" },
			payload: "x",
		});
		expect(response.status).toBe(403);
		expect(response.json()).toEqual({ error: "setup_required" });
	});

	test("a throwing handler is 500 extension_route_failed, and the server lives on", async () => {
		const { app, aliceToken } = await bootServer();
		const boom = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-routes/boom",
			token: aliceToken,
		});
		expect(boom.status).toBe(500);
		expect(boom.json()).toEqual({
			error: "extension_route_failed",
			extension: "fixture-routes",
		});
		const health = await call(app, { method: "GET", url: "/healthz" });
		expect(health.status).toBe(200);
	});

	test("a non-Response return is the same 500 body", async () => {
		const { app, aliceToken } = await bootServer();
		const bad = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-routes/bad",
			token: aliceToken,
		});
		expect(bad.status).toBe(500);
		expect(bad.json()).toEqual({
			error: "extension_route_failed",
			extension: "fixture-routes",
		});
	});

	test("an admin route is 403 for a non-admin and 204 for an admin", async () => {
		const { app, aliceToken, adminToken } = await bootServer();
		const denied = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-routes/admin-only",
			token: aliceToken,
		});
		expect(denied.status).toBe(403);
		expect(denied.json()).toEqual({ error: "forbidden" });
		const allowed = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-routes/admin-only",
			token: adminToken,
		});
		expect(allowed.status).toBe(204);
		expect(allowed.body).toBe("");
	});

	test("a body over the 1 MiB default ceiling is 413", async () => {
		const { app } = await bootServer();
		const response = await call(app, {
			method: "POST",
			url: "/v1/ext/fixture-routes/hook",
			headers: { "content-type": "text/plain" },
			payload: "x".repeat(ONE_MIB + 1),
		});
		expect(response.status).toBe(413);
		expect(response.json()).toEqual({
			error: "too_large",
			maxBytes: ONE_MIB,
		});
	});

	test("GET /v1/extensions lists the mounted routes", async () => {
		const { app, adminToken } = await bootServer();
		const response = await call(app, {
			method: "GET",
			url: "/v1/extensions",
			token: adminToken,
		});
		expect(response.status).toBe(200);
		const extensions = (
			response.json() as {
				extensions: Array<{
					name: string;
					routes?: Array<{ method: string; path: string; auth: string }>;
				}>;
			}
		).extensions;
		const fixture = extensions.find((entry) => entry.name === "fixture-routes");
		expect(fixture?.routes).toEqual([
			{ method: "GET", path: "ping", auth: "user" },
			{ method: "POST", path: "hook", auth: "public" },
			{ method: "GET", path: "boom", auth: "user" },
			{ method: "GET", path: "bad", auth: "user" },
			{ method: "GET", path: "admin-only", auth: "admin" },
		]);
	});

	test("a route path containing '..' quarantines the extension at load", async () => {
		const { opened, app, adminToken } = await bootServer();
		const outcome = opened.extensionOutcomes.find((entry) =>
			// Quarantined outcomes carry the display specifier, not the slug.
			entry.name.includes("fixture-routes-bad"),
		);
		expect(outcome?.status).toBe("quarantined");
		expect(outcome?.error).toContain("..");
		// The malformed route never mounted: the path answers 404, not a
		// handler response.
		const response = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-routes-bad/x",
			token: adminToken,
		});
		expect(response.status).toBe(404);
	});
});
