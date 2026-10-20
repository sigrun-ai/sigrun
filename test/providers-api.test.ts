/**
 * Core hardening W3 Task 6 (spec §7.6): the provider surface's refresh
 * and credential mutations over `GET /v1/providers`'s enriched entries.
 *
 * - `GET /v1/providers` entries gain `models` (the catalog count) and
 *   `owner` (the owning contributor; absent for the env-degenerate
 *   provider). The deprecated `/v1/auth/check` alias serves the same
 *   body (the W1 identical-body contract).
 * - `POST /v1/providers/:id/refresh` runs ONE bounded refresh of the
 *   named provider (the same machinery `resolveServedModelRefreshing`
 *   uses) and returns the entry; unknown → 404 `provider_not_found`.
 * - `PUT /v1/providers/:id/credential {apiKey}` (ADMIN) writes auth.json
 *   through `AuthStore` (the bridge stays read-only — the ROUTE owns the
 *   write), then refreshes, then returns the entry. The write is
 *   RESTART-FREE: the auth bridge resolves per use, so the same in-
 *   process `Models` sees the new credential on the next refresh — the
 *   readiness tracker flips `not_configured` → `ready` with no re-boot,
 *   and the fixture upstream observes the key on the wire. For the
 *   default model's provider the write lands under the magic `"default"`
 *   key (the credential-precedence fix makes that the winning key for
 *   that provider); every other provider writes its own id.
 * - `DELETE /v1/providers/:id/credential` (ADMIN) removes that same key,
 *   then refreshes → `not_configured` again.
 * - Key material NEVER leaves the server: the closing test sweeps every
 *   response body this suite recorded and asserts `sk-test` appears in
 *   none of them.
 *
 * Fixture: an ollama-shaped dynamic provider (tracker seeded from
 * credential resolution, flipped per refresh outcome) against a local
 * 127.0.0.1 upstream that logs the Authorization header it received.
 * Admin gating follows the token-method pattern of
 * `server-settings.test.ts` (seeded admin `tester` + non-admin `pleb`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

// ---------------------------------------------------------------------------
// The fixture upstream + the ollama-shaped dynamic provider
// ---------------------------------------------------------------------------

/** One fixture catalog row the upstream serves. */
interface UpstreamModel {
	readonly id: string;
}

/** The local upstream: serves `/models`, logs the auth header per call. */
interface Upstream {
	readonly baseUrl: string;
	/** Every observed request: the path and the exact Authorization value. */
	readonly requests: { path: string; authorization?: string }[];
	close(): Promise<void>;
}

async function startUpstream(models: readonly UpstreamModel[]): Promise<Upstream> {
	const requests: { path: string; authorization?: string }[] = [];
	const server = http.createServer((req, res) => {
		requests.push({
			path: (req.url ?? "").split("?")[0] ?? "",
			authorization: req.headers.authorization,
		});
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ models }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("fixture upstream did not report a port");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * The ollama-shaped fixture provider: an EMPTY baseline catalog, a
 * credential tracker seeded from auth resolution (pi-ai never refreshes
 * an unconfigured provider, so refresh outcomes alone cannot express
 * `not_configured`), and a `fetchModels` that refuses to publish an
 * empty catalog without a credential and otherwise pulls the upstream's
 * rows with the resolved key on the wire.
 */
function fixtureContributor(
	id: string,
	upstream: Upstream,
): ProviderContributor {
	let credentialResolved = false;
	let lastRefreshFailed = false;
	const status = (): "not_configured" | "degraded" | "ready" => {
		if (!credentialResolved) return "not_configured";
		return lastRefreshFailed ? "degraded" : "ready";
	};
	const model = (modelId: string): Model<"openai-completions"> => ({
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: id,
		baseUrl: upstream.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
	const provider = createProvider({
		id,
		name: `Credential fixture (${id})`,
		baseUrl: upstream.baseUrl,
		models: [],
		auth: {
			apiKey: {
				name: "fixture key (auth.json bridge)",
				resolve: async ({ credential }) => {
					// The bridged auth.json credential (the route's PUT wrote
					// it) wins; nothing else is configured in these tests.
					const stored = credential?.key?.trim() || undefined;
					credentialResolved = stored !== undefined;
					if (stored === undefined) return undefined;
					return { auth: { apiKey: stored }, source: "auth.json" };
				},
			},
		},
		fetchModels: async (context) => {
			const key =
				context.credential?.type === "api_key"
					? context.credential.key?.trim() || undefined
					: undefined;
			if (key === undefined) {
				credentialResolved = false;
				// NEVER return [] — the wrapper would publish (and persist)
				// the empty catalog.
				throw new Error(`${id}: not configured`);
			}
			try {
				const root = upstream.baseUrl.endsWith("/")
					? upstream.baseUrl
					: `${upstream.baseUrl}/`;
				const response = await fetch(new URL("models", root), {
					headers: { Authorization: `Bearer ${key}` },
					signal: context.signal,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const body = (await response.json()) as { models: UpstreamModel[] };
				lastRefreshFailed = false;
				return body.models.map((row) => model(row.id));
			} catch (cause) {
				if (context.signal.aborted) throw cause;
				lastRefreshFailed = true;
				throw cause;
			}
		},
		api: openAICompletionsApi(),
	});
	return {
		name: `ext-${id}`,
		providers: [
			{
				provider,
				readiness: () => ({ status: status() }),
			},
		],
	};
}

// ---------------------------------------------------------------------------
// The hermetic server (token auth: seeded admin + non-admin)
// ---------------------------------------------------------------------------

/** One hermetic server: harness + Fastify app + fixture upstream + tokens. */
interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly upstream: Upstream;
	readonly adminToken: string;
	readonly plebToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Every response body the suite observed (the closing secret sweep). */
const bodies: string[] = [];

/**
 * Boot a token-method server: the fixture provider `acme`, the default
 * model `defaultModel` (either the fixture's own provider or the env
 * degenerate `openai`), a seeded admin (`tester`) plus a non-admin
 * (`pleb`) with one token each. Awaits the boot refresh so the initial
 * tracker state is deterministic (`not_configured` — no credential).
 */
async function bootServer(
	defaultModel: string,
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-providers-api-"));
	const upstream = await startUpstream([
		{ id: "m1" },
		{ id: "m2" },
	]);
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: defaultModel,
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		// Hermetic catalog persistence: the file models store lives under
		// the data dir — pin it or the offline-restore phase reads (and
		// writes) the developer's real XDG catalog (provider-refresh.test.ts
		// pins the same var for the same reason).
		SIGRUN_DATA_DIR: join(dir, "data"),
	});
	const identity = await seededIdentity(dir);
	await identity.users.add({ user: "pleb", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [fixtureContributor("acme", upstream)],
		env: {},
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
		await upstream.close();
		await rm(dir, { recursive: true, force: true });
	});
	// Deterministic start: the boot refresh (no credential) has settled
	// the tracker at not_configured before any route call.
	await opened.bootRefresh;
	return { app, opened, upstream, adminToken, plebToken };
}

/** `app.inject` + record the body for the closing secret sweep. */
async function call(
	app: FastifyInstance,
	options: {
		readonly method: string;
		readonly url: string;
		readonly token?: string;
		readonly payload?: unknown;
		/** Payload content type (JSON by default). */
		readonly contentType?: string;
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
				: { "content-type": options.contentType ?? "application/json" }),
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

/** One provider entry off `GET /v1/providers` (the enriched shape). */
interface ProviderEntry {
	provider: string;
	status: string;
	models: number;
	owner?: string;
	detail?: string;
}

async function listProviders(
	app: FastifyInstance,
	token?: string,
): Promise<ProviderEntry[]> {
	const response = await call(app, {
		method: "GET",
		url: "/v1/providers",
		...(token === undefined ? {} : { token }),
	});
	expect(response.status).toBe(200);
	return (response.json() as { providers: ProviderEntry[] }).providers;
}

// ---------------------------------------------------------------------------
// GET /v1/providers: model counts + owners
// ---------------------------------------------------------------------------

describe("GET /v1/providers entries (models + owner)", () => {
	test("a tracker provider carries its catalog count and owning contributor; the degenerate provider carries neither owner nor keys", async () => {
		const { app, adminToken } = await bootServer("openai/gpt-test");
		const entries = await listProviders(app, adminToken);
		expect(entries).toEqual([
			// The fixture: unconfigured at boot → three-state vocabulary +
			// count 0 (empty baseline) + the contributor that owns it.
			{ provider: "acme", status: "not_configured", models: 0, owner: "ext-acme" },
			// The env-degenerate default provider: exactly its one pinned
			// model, no owning contributor, legacy not_ready (no key).
			{ provider: "openai", status: "not_ready", models: 1 },
		]);
		// The deprecated alias serves the identical (enriched) body.
		const alias = await call(app, {
			method: "GET",
			url: "/v1/auth/check",
			token: adminToken,
		});
		expect(alias.status).toBe(200);
		expect(alias.json()).toEqual({ providers: entries });
	});
});

// ---------------------------------------------------------------------------
// PUT/DELETE credential + POST refresh
// ---------------------------------------------------------------------------

describe("PUT/DELETE /v1/providers/:id/credential + POST refresh", () => {
	test("PUT as admin flips not_configured → ready RESTART-FREE and auth.json holds the key under the provider id", async () => {
		const server = await bootServer("openai/gpt-test");
		const { app, opened, upstream, adminToken } = server;
		// A providers.changed event must fire for the flip (the refresh
		// paths observe readiness — Task 4's hub wiring).
		const events: { type: string; provider?: string; status?: string }[] = [];
		const unsubscribe = opened.events.subscribe((event) => {
			if (event.type === "providers.changed") events.push(event);
		});
		cleanups.push(async () => unsubscribe());

		const put = await call(app, {
			method: "PUT",
			url: "/v1/providers/acme/credential",
			token: adminToken,
			payload: { apiKey: "sk-test" },
		});
		expect(put.status).toBe(200);
		expect(put.json()).toEqual({
			provider: "acme",
			status: "ready",
			models: 2,
			owner: "ext-acme",
		});
		// No restart happened — the SAME opened handle's tracker flipped
		// because the auth bridge re-read auth.json on the refresh.
		const entries = await listProviders(app, adminToken);
		expect(entries.find((entry) => entry.provider === "acme")).toEqual({
			provider: "acme",
			status: "ready",
			models: 2,
			owner: "ext-acme",
		});
		// auth.json holds the key under the PROVIDER id (acme is not the
		// default model's provider here — the default is the degenerate
		// openai provider).
		const auth = opened.auth.read();
		expect(auth.acme?.apiKey).toBe("sk-test");
		expect(auth.default).toBeUndefined();
		// Restart-free, end to end: the refresh drove the fixture upstream
		// with the written key on the wire.
		expect(
			upstream.requests.some(
				(request) => request.authorization === "Bearer sk-test",
			),
		).toBe(true);
		// The flip published one providers.changed event.
		expect(events).toEqual([
			{ type: "providers.changed", provider: "acme", status: "ready" },
		]);

		// POST refresh on the known id: one bounded refresh, the entry back.
		const refresh = await call(app, {
			method: "POST",
			url: "/v1/providers/acme/refresh",
			token: adminToken,
		});
		expect(refresh.status).toBe(200);
		expect(refresh.json()).toEqual({
			provider: "acme",
			status: "ready",
			models: 2,
			owner: "ext-acme",
		});
	});

	test("PUT writes the magic \"default\" key when the provider IS the default model's provider", async () => {
		const server = await bootServer("acme/m1");
		const { app, opened, adminToken } = server;
		const put = await call(app, {
			method: "PUT",
			url: "/v1/providers/acme/credential",
			token: adminToken,
			payload: { apiKey: "sk-test" },
		});
		expect(put.status).toBe(200);
		expect(put.json()).toEqual({
			provider: "acme",
			status: "ready",
			models: 2,
			owner: "ext-acme",
		});
		// The write landed under "default" (spec §7.6: the precedence fix
		// makes it the winning key for the default model's provider), NOT
		// under the provider's own id — and the bridge resolved it (ready).
		const auth = opened.auth.read();
		expect(auth.default?.apiKey).toBe("sk-test");
		expect(auth.acme).toBeUndefined();
	});

	test("a non-admin PUT → 403 forbidden, nothing written", async () => {
		const server = await bootServer("openai/gpt-test");
		const { app, opened, plebToken } = server;
		const put = await call(app, {
			method: "PUT",
			url: "/v1/providers/acme/credential",
			token: plebToken,
			payload: { apiKey: "sk-test" },
		});
		expect(put.status).toBe(403);
		expect(put.json()).toEqual({ error: "forbidden" });
		expect(opened.auth.read()).toEqual({});
		// The non-admin DELETE is gated identically.
		const del = await call(app, {
			method: "DELETE",
			url: "/v1/providers/acme/credential",
			token: plebToken,
		});
		expect(del.status).toBe(403);
		expect(del.json()).toEqual({ error: "forbidden" });
	});

	test("DELETE as admin removes the entry and returns not_configured", async () => {
		const server = await bootServer("openai/gpt-test");
		const { app, opened, adminToken } = server;
		const put = await call(app, {
			method: "PUT",
			url: "/v1/providers/acme/credential",
			token: adminToken,
			payload: { apiKey: "sk-test" },
		});
		expect(put.status).toBe(200);
		const del = await call(app, {
			method: "DELETE",
			url: "/v1/providers/acme/credential",
			token: adminToken,
		});
		expect(del.status).toBe(200);
		expect(del.json()).toEqual({
			provider: "acme",
			status: "not_configured",
			models: 2,
			owner: "ext-acme",
		});
		// The entry is gone (the catalog holds its last-known rows).
		expect(opened.auth.read()).toEqual({});
		const entries = await listProviders(app, adminToken);
		expect(entries.find((entry) => entry.provider === "acme")?.status).toBe(
			"not_configured",
		);
	});

	test("unknown provider ids → 404 provider_not_found (refresh, PUT, DELETE)", async () => {
		const server = await bootServer("openai/gpt-test");
		const { app, adminToken } = server;
		const refresh = await call(app, {
			method: "POST",
			url: "/v1/providers/nope/refresh",
			token: adminToken,
		});
		expect(refresh.status).toBe(404);
		expect(refresh.json()).toEqual({ error: "provider_not_found" });
		const put = await call(app, {
			method: "PUT",
			url: "/v1/providers/nope/credential",
			token: adminToken,
			payload: { apiKey: "sk-test" },
		});
		expect(put.status).toBe(404);
		expect(put.json()).toEqual({ error: "provider_not_found" });
		const del = await call(app, {
			method: "DELETE",
			url: "/v1/providers/nope/credential",
			token: adminToken,
		});
		expect(del.status).toBe(404);
		expect(del.json()).toEqual({ error: "provider_not_found" });
	});

	test("PUT body validation: non-object → invalid_body; apiKey wrong type → invalid_field", async () => {
		const server = await bootServer("openai/gpt-test");
		const { app, opened, adminToken } = server;
		const notObject = await call(app, {
			method: "PUT",
			url: "/v1/providers/acme/credential",
			token: adminToken,
			// A JSON string body: parses fine, then the route rejects the
			// non-object (the server-settings invalid_body pattern).
			payload: JSON.stringify("sk-test"),
			contentType: "application/json",
		});
		expect(notObject.status).toBe(400);
		expect(notObject.json()).toEqual({ error: "invalid_body" });
		const wrongType = await call(app, {
			method: "PUT",
			url: "/v1/providers/acme/credential",
			token: adminToken,
			payload: { apiKey: 42 },
		});
		expect(wrongType.status).toBe(400);
		expect(wrongType.json()).toEqual({
			error: "invalid_field",
			field: "apiKey",
		});
		expect(opened.auth.read()).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// The secret sweep
// ---------------------------------------------------------------------------

describe("secret hygiene", () => {
	test("no response body this suite observed contains the written key", () => {
		expect(bodies.length).toBeGreaterThan(0);
		for (const body of bodies) {
			expect(body).not.toContain("sk-test");
		}
	});
});
