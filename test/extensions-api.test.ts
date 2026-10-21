/**
 * Core hardening W3 Task 7 (spec §7.7): the extension settings/secrets
 * endpoints over the loader's loaded outcomes and the shared store trio's
 * new slug-addressed admin surface.
 *
 * - `GET /v1/extensions`: one entry per loaded outcome with `status`,
 *   `error?`, `version?` (from the entry's package manifest — the loader
 *   records it), the declared `interactionKinds`/`ambientKeys`
 *   (`opened.seamKinds`), and `workers` (the idle-worker projection).
 * - `GET`/`PUT /v1/extensions/:slug/settings` (PUT admin; body must be a
 *   JSON object else 400): the `settings/<slug>.json` object, stored
 *   verbatim — the file IS the store's file.
 * - `GET /v1/extensions/:slug/secrets`: `{secrets: [{key, source}]}` —
 *   stored keys from `secrets.json` plus env keys under
 *   `SIGRUN_EXT_<SLUG>_` that are not stored. VALUES ARE NEVER RETURNED
 *   (the closing sweep asserts the round-tripped secret string appears in
 *   no response body this suite recorded).
 * - `PUT`/`DELETE /v1/extensions/:slug/secrets/:key` (admin).
 * - Unknown slug → 404 `extension_not_found`.
 *
 * Fixtures: `fixture-stores` (slug `acme-tool`, no package manifest — no
 * version) + `fixture-stores-read` (slug `acme-settings-tool`, manifest
 * version 0.0.0). Admin gating follows the token-method pattern of
 * providers-api.test.ts (seeded admin `tester` + non-admin `pleb`).
 */

import { readFile } from "node:fs/promises";
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
import { seededIdentity } from "./helpers/identity.js";

const STORES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-stores", "index.js"),
).href;
const SETTINGS_READ_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-stores-read", "index.js"),
).href;

/** One hermetic server: harness + fixture extensions + Fastify app + tokens. */
interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	/** The tmp config root (`SIGRUN_CONFIG_DIR`) the store files land under. */
	readonly configDir: string;
	readonly adminToken: string;
	readonly plebToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Every response body the suite observed (the closing secret sweep). */
const bodies: string[] = [];

async function bootServer(
	env: Record<string, string> = {},
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-extensions-api-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
	});
	const identity = await seededIdentity(join(dir, "seed"));
	await identity.users.add({ user: "pleb", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		// Hermetic: this suite exercises the /v1/extensions endpoint's
		// contract against FIXTURE extensions; the built-in rows themselves
		// are test/builtins.test.ts's subject (builtins: false = the
		// pre-Task-2 boot shape).
		builtins: false,
		extensionSpecifiers: [STORES_SPECIFIER, SETTINGS_READ_SPECIFIER],
		// The harness env must carry the store-root vars (boot resolves the
		// shared trio's roots from THIS env — `options.env` REPLACES
		// process.env, so a bare `{...env}` would fall back to the real
		// XDG config root). The env-secret listing derives from it too.
		env: { SIGRUN_CONFIG_DIR: configDir, ...env },
		settingsDir: dir,
	});
	const { token: plebToken } = await opened.identity.tokens.create(
		"pleb-cli",
		"pleb",
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
	return { app, opened, configDir, adminToken, plebToken };
}

async function call(
	app: FastifyInstance,
	options: {
		readonly method: string;
		readonly url: string;
		readonly token?: string;
		readonly payload?: unknown;
	},
): Promise<{ status: number; body: string; json: () => unknown }> {
	const response = await app.inject({
		method: options.method as "GET",
		url: options.url,
		headers: {
			...(options.token === undefined
				? {}
				: { authorization: `Bearer ${options.token}` }),
			...(options.payload === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		...(options.payload === undefined
			? {}
			: { payload: options.payload as Record<string, unknown> }),
	});
	bodies.push(response.body);
	return {
		status: response.statusCode,
		body: response.body,
		json: () => response.json(),
	};
}

// ---------------------------------------------------------------------------
// GET /v1/extensions
// ---------------------------------------------------------------------------

describe("GET /v1/extensions", () => {
	test("lists every loaded outcome with kinds, workers, and the manifest version", async () => {
		const { app, adminToken } = await bootServer();
		const response = await call(app, {
			method: "GET",
			url: "/v1/extensions",
			token: adminToken,
		});
		expect(response.status).toBe(200);
		expect(response.json()).toEqual({
			extensions: [
				// fixture-stores: no package manifest → no version field.
				{
					name: "acme-tool",
					status: "ok",
					interactionKinds: [],
					ambientKeys: [],
					workers: [],
					routes: [],
				},
				// fixture-stores-read: the manifest's version rides the outcome.
				{
					name: "acme-settings-tool",
					status: "ok",
					version: "0.0.0",
					interactionKinds: [],
					ambientKeys: [],
					workers: [],
					routes: [],
				},
			],
		});
	});
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("GET/PUT /v1/extensions/:slug/settings", () => {
	test("an admin PUT stores the object verbatim and GET round-trips it; the file IS settings/<slug>.json", async () => {
		const { app, configDir, adminToken } = await bootServer();
		const put = await call(app, {
			method: "PUT",
			url: "/v1/extensions/acme-tool/settings",
			token: adminToken,
			payload: { theme: "dark", retries: 2, nested: { on: true } },
		});
		expect(put.status).toBe(200);
		expect(put.json()).toEqual({
			theme: "dark",
			retries: 2,
			nested: { on: true },
		});
		const get = await call(app, {
			method: "GET",
			url: "/v1/extensions/acme-tool/settings",
			token: adminToken,
		});
		expect(get.status).toBe(200);
		expect(get.json()).toEqual({
			theme: "dark",
			retries: 2,
			nested: { on: true },
		});
		// The endpoint writes the SAME file the scoped handle reads: the
		// extension's own `host.stores.settings` and this API are one store.
		const file = await readFile(join(configDir, "settings", "acme-tool.json"));
		expect(JSON.parse(file.toString())).toEqual({
			theme: "dark",
			retries: 2,
			nested: { on: true },
		});
	});

	test("an absent settings file GETs as {}", async () => {
		const { app, adminToken } = await bootServer();
		const get = await call(app, {
			method: "GET",
			url: "/v1/extensions/acme-tool/settings",
			token: adminToken,
		});
		expect(get.status).toBe(200);
		expect(get.json()).toEqual({});
	});

	test("a non-admin PUT → 403; a non-object body → 400", async () => {
		const { app, adminToken, plebToken } = await bootServer();
		const forbidden = await call(app, {
			method: "PUT",
			url: "/v1/extensions/acme-tool/settings",
			token: plebToken,
			payload: { theme: "dark" },
		});
		expect(forbidden.status).toBe(403);
		expect(forbidden.json()).toEqual({ error: "forbidden" });
		// A JSON ARRAY parses fine but is not an object; the raw-string
		// forms exercise JSON scalars (null, number) through the same 400.
		for (const bad of [["a", "b"], "null", "3"]) {
			const invalid = await call(app, {
				method: "PUT",
				url: "/v1/extensions/acme-tool/settings",
				token: adminToken,
				payload: bad,
			});
			expect(invalid.status).toBe(400);
			expect(invalid.json()).toEqual({ error: "invalid_body" });
		}
	});

	test("an unknown slug → 404 extension_not_found", async () => {
		const { app, adminToken } = await bootServer();
		for (const method of ["GET", "PUT"]) {
			const response = await call(app, {
				method,
				url: "/v1/extensions/nope-tool/settings",
				token: adminToken,
				...(method === "PUT"
					? { token: adminToken, payload: { a: 1 } }
					: {}),
			});
			expect(response.status).toBe(404);
			expect(response.json()).toEqual({ error: "extension_not_found" });
		}
	});
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("GET/PUT/DELETE /v1/extensions/:slug/secrets", () => {
	test("an admin secret PUT lists {key, source: \"stored\"} and NEVER the value; DELETE removes it", async () => {
		const { app, adminToken, plebToken } = await bootServer();
		const put = await call(app, {
			method: "PUT",
			url: "/v1/extensions/acme-tool/secrets/api-key",
			token: adminToken,
			payload: { value: "s3cr3t-roundtrip" },
		});
		expect(put.status).toBe(200);
		expect(put.json()).toEqual({
			secrets: [{ key: "api-key", source: "stored" }],
		});
		// GET (ungated) lists the key + source, never the value.
		const get = await call(app, {
			method: "GET",
			url: "/v1/extensions/acme-tool/secrets",
			token: adminToken,
		});
		expect(get.status).toBe(200);
		expect(get.json()).toEqual({
			secrets: [{ key: "api-key", source: "stored" }],
		});
		// The scoped handle (the extension's own view) sees the value: the
		// API and the factory host are one secrets.json section.
		const host = (
			globalThis as { __fixtureStoresHost?: { stores: {
				secrets: { get(key: string): Promise<string | undefined> };
			} } }
		).__fixtureStoresHost;
		expect(host).toBeDefined();
		expect(await host?.stores.secrets.get("api-key")).toBe("s3cr3t-roundtrip");
		// A non-admin cannot write or delete.
		const forbiddenPut = await call(app, {
			method: "PUT",
			url: "/v1/extensions/acme-tool/secrets/api-key",
			token: plebToken,
			payload: { value: "nope" },
		});
		expect(forbiddenPut.status).toBe(403);
		const forbiddenDelete = await call(app, {
			method: "DELETE",
			url: "/v1/extensions/acme-tool/secrets/api-key",
			token: plebToken,
		});
		expect(forbiddenDelete.status).toBe(403);
		// Admin DELETE removes the key from the list.
		const del = await call(app, {
			method: "DELETE",
			url: "/v1/extensions/acme-tool/secrets/api-key",
			token: adminToken,
		});
		expect(del.status).toBe(200);
		expect(del.json()).toEqual({ secrets: [] });
	});

	test("a SIGRUN_EXT_<SLUG>_TOKEN env var lists {key: \"token\", source: \"env\"}; a stored key wins over env", async () => {
		const { app, adminToken } = await bootServer({
			SIGRUN_EXT_ACME_TOOL_TOKEN: "envtok",
			// A stored key shadows an env var of the same name.
			SIGRUN_EXT_ACME_TOOL_API_KEY: "env-shadowed",
		});
		const get = await call(app, {
			method: "GET",
			url: "/v1/extensions/acme-tool/secrets",
			token: adminToken,
		});
		expect(get.status).toBe(200);
		expect(get.json()).toEqual({
			secrets: [
				{ key: "token", source: "env" },
				{ key: "api-key", source: "env" },
			],
		});
		// Storing api-key flips the env entry to stored (stored precedence,
		// exactly resolveSecretFor's rule — one entry, never two).
		await call(app, {
			method: "PUT",
			url: "/v1/extensions/acme-tool/secrets/api-key",
			token: adminToken,
			payload: { value: "stored-now" },
		});
		const after = await call(app, {
			method: "GET",
			url: "/v1/extensions/acme-tool/secrets",
			token: adminToken,
		});
		expect(after.json()).toEqual({
			secrets: [
				{ key: "api-key", source: "stored" },
				{ key: "token", source: "env" },
			],
		});
	});

	test("an unknown slug → 404; a non-string value → 400", async () => {
		const { app, adminToken } = await bootServer();
		const unknown = await call(app, {
			method: "PUT",
			url: "/v1/extensions/nope-tool/secrets/api-key",
			token: adminToken,
			payload: { value: "x" },
		});
		expect(unknown.status).toBe(404);
		expect(unknown.json()).toEqual({ error: "extension_not_found" });
		const unknownGet = await call(app, {
			method: "GET",
			url: "/v1/extensions/nope-tool/secrets",
			token: adminToken,
		});
		expect(unknownGet.status).toBe(404);
		expect(unknownGet.json()).toEqual({ error: "extension_not_found" });
		for (const bad of [undefined, "", 3, { deep: "er" }]) {
			const invalid = await call(app, {
				method: "PUT",
				url: "/v1/extensions/acme-tool/secrets/api-key",
				token: adminToken,
				...(bad === undefined ? {} : { payload: { value: bad } }),
			});
			expect(invalid.status).toBe(400);
			expect(invalid.json()).toEqual({ error: "invalid_field", field: "value" });
		}
	});
});

// ---------------------------------------------------------------------------
// The secret sweep: values never leave the server
// ---------------------------------------------------------------------------

test("no secret VALUE appears in any response body this suite observed", async () => {
	await bootServer();
	// "s3cr3t-roundtrip" and "stored-now" were written by the tests above;
	// "envtok"/"env-shadowed" never even reach a response (env keys list
	// as {key, source} only). The sweep guards the whole suite.
	for (const secret of ["s3cr3t-roundtrip", "stored-now", "envtok"]) {
		expect(bodies.some((body) => body.includes(secret))).toBe(false);
	}
});
