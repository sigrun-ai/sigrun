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
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { FastifyInstance } from "fastify";
import type { DecisionRequest } from "@sigrun/shared/decisions";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SettingsStore } from "../src/harness/settings.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	calls as gatedEmbeddingCalls,
	resetGatedEmbeddingProvider,
} from "./fixtures/fixture-embedding-provider-gated/index.js";
import {
	calls as decisionCalls,
	resetDecisionProvider,
} from "./fixtures/fixture-decision-provider/index.js";

// ---------------------------------------------------------------------------
// The fixture upstream + the ollama-shaped dynamic provider
// ---------------------------------------------------------------------------

const EMBEDDING_PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-embedding-provider", "index.js"),
).href;
/**
 * The credential-GATED embedding fixture: its readiness tracker reports
 * `not_configured` until a call PRESENTS a credential (the shipped
 * `provider-openai` shape), so core's "credential missing AND tracker
 * not_configured" gate — not a missing tracker — decides the refusal.
 */
const GATED_EMBEDDING_PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-embedding-provider-gated", "index.js"),
).href;
/** The decision fixture (warden Task 6): provider `acme-judge`. */
const DECISION_PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-decision-provider", "index.js"),
).href;
const CHAT_PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-providers", "index.js"),
).href;

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
	extensionSpecifiers: readonly string[] = [],
	options: {
		/**
		 * The chat provider's id the fixture contributes (default `acme`).
		 * A test that needs the DEFAULT model's provider id to be some other
		 * kind's id (the credential-key regression) names it here.
		 */
		readonly chatProviderId?: string;
	} = {},
	preseed?: Record<string, unknown>,
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
	if (preseed !== undefined) new SettingsStore({ dir }).update(preseed);
	await identity.users.add({ user: "pleb", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [fixtureContributor(options.chatProviderId ?? "acme", upstream)],
		extensionSpecifiers,
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
	kind?: "chat" | "decision" | "embedding";
	modelIds?: readonly string[];
	systemDefault?: true;
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

describe("settings split: provider management metadata", () => {
	test("provider extensions are marked", async () => {
		const rig = await bootServer("acme/m1", [CHAT_PROVIDER, DECISION_PROVIDER, EMBEDDING_PROVIDER]);
		// Exercise the production loader path for all three provider kinds.
		const response = await call(rig.app, { method: "GET", url: "/v1/extensions", token: rig.adminToken });
		expect(response.status).toBe(200);
		const { extensions } = response.json() as { extensions: { name: string; provider?: true }[] };
		expect(extensions.find((entry) => entry.name === "sigrun-fixture-providers")).toMatchObject({ provider: true });
		expect(extensions.find((entry) => entry.name === "acme-judge")).toMatchObject({ provider: true });
		expect(extensions.find((entry) => entry.name === "acme-embed")).toMatchObject({ provider: true });
		for (const entry of extensions.filter((entry) => !["sigrun-fixture-providers", "acme-judge", "acme-embed"].includes(entry.name))) {
			expect(entry.provider).toBeUndefined();
		}
	});

	test("chat rows carry model ids", async () => {
		const rig = await bootServer("openai/gpt-test");
		await rig.opened.auth.setApiKey("acme", "acme-catalog-fixture-key");
		await rig.opened.refreshProvider("acme");
		const entries = await listProviders(rig.app, rig.adminToken);
		expect(entries.find((entry) => entry.provider === "acme")).toMatchObject({ modelIds: ["m1", "m2"] });
		expect(entries.find((entry) => entry.provider === "openai")).toMatchObject({ modelIds: ["gpt-test"] });
	});

	test("the default-credential row is marked", async () => {
		const rig = await bootServer("acme/m1", [], {}, { defaultProvider: { baseUrl: "https://acme.example.invalid/v1" } });
		const entries = await listProviders(rig.app, rig.adminToken);
		expect(entries.find((entry) => entry.provider === "acme")).toMatchObject({ systemDefault: true });
		const rigOther = await bootServer("openai/gpt-test");
		const otherEntries = await listProviders(rigOther.app, rigOther.adminToken);
		expect(otherEntries.find((entry) => entry.provider === "acme")?.systemDefault).toBeUndefined();
		expect(otherEntries.find((entry) => entry.provider === "openai")).toMatchObject({ systemDefault: true });
	});
});

describe("embedding provider entries", () => {
	test("Providers lists an embedding entry with owner and modelIds", async () => {
		const rig = await bootServer("acme/m1", [EMBEDDING_PROVIDER]);
		const entries = await listProviders(rig.app, rig.adminToken);
		const entry = entries.find(
			(candidate) => candidate.provider === "acme-embed" && candidate.kind === "embedding",
		);
		expect(entry).toMatchObject({
			provider: "acme-embed",
			kind: "embedding",
			status: "ready",
			models: 2,
			modelIds: ["embed-1", "embed-2"],
			owner: "acme-embed",
		});
	});

	test("credential PUT works for an embedding-only provider id", async () => {
		const rig = await bootServer("acme/m1", [EMBEDDING_PROVIDER]);
		const response = await call(rig.app, {
			method: "PUT",
			url: "/v1/providers/acme-embed/credential",
			token: rig.adminToken,
			payload: { apiKey: "acme-embedding-route-key" },
		});
		expect(response.status).toBe(200);
		expect(response.json()).toMatchObject({
			provider: "acme-embed",
			kind: "embedding",
			modelIds: ["embed-1", "embed-2"],
			owner: "acme-embed",
		});
		expect(rig.opened.auth.read()["acme-embed"]?.apiKey).toBe(
			"acme-embedding-route-key",
		);
	});
});

// ---------------------------------------------------------------------------
// The credential-key regression (fix wave): a Providers-page Save for a row
// whose id IS the default model's provider writes the magic "default" key.
// Both non-chat registries read only `auth.json[id]`, so that key was
// INVISIBLE to them — a permanent, silent `not_configured` the UI could
// never clear (the earlier coverage missed it: its default model was
// `acme/m1`, so the magic-key branch never fired).
// ---------------------------------------------------------------------------

describe("the Providers-page credential reaches the non-chat registries", () => {
	test("an embedding call sees the magic \"default\" key when the embedding provider IS the default model's provider", async () => {
		resetGatedEmbeddingProvider();
		// The default chat provider and the embedding provider share the id
		// `acme-gated` — the shape that makes the route redirect the write.
		const rig = await bootServer("acme-gated/m1", [GATED_EMBEDDING_PROVIDER], {
			chatProviderId: "acme-gated",
		});
		// Premise: nothing is configured yet. The tracker cannot read auth.json,
		// so it says not_configured — the state a keyed install starts in.
		expect(rig.opened.embeddings.providers()).toMatchObject([
			{ id: "acme-gated", status: "not_configured" },
		]);
		// The Save the Providers page performs for this row: the id IS the
		// default model's provider, so the key lands under "default".
		const put = await call(rig.app, {
			method: "PUT",
			url: "/v1/providers/acme-gated/credential",
			token: rig.adminToken,
			payload: { apiKey: "acme-gated-route-key" },
		});
		expect(put.status).toBe(200);
		const auth = rig.opened.auth.read();
		expect(auth.default?.apiKey).toBe("acme-gated-route-key");
		expect(auth["acme-gated"]).toBeUndefined();
		// The regression: the embedding reader looked at auth.json[id] only, so
		// the saved key was invisible and this call was refused as
		// not_configured forever. It must now reach the provider WITH the key.
		const result = await rig.opened.embeddings.embed("fixwave", ["x"], {
			model: "acme-gated/embed-1",
		});
		expect(result).toMatchObject({ ok: true, model: "acme-gated/embed-1" });
		expect(gatedEmbeddingCalls).toEqual([
			{ model: "embed-1", credential: "acme-gated-route-key" },
		]);
	});

	test("a decision call sees the magic \"default\" key when the decision provider IS the default model's provider", async () => {
		resetDecisionProvider();
		const rig = await bootServer("acme-judge/m1", [DECISION_PROVIDER], {
			chatProviderId: "acme-judge",
		});
		const put = await call(rig.app, {
			method: "PUT",
			url: "/v1/providers/acme-judge/credential",
			token: rig.adminToken,
			payload: { apiKey: "acme-judge-route-key" },
		});
		expect(put.status).toBe(200);
		const auth = rig.opened.auth.read();
		expect(auth.default?.apiKey).toBe("acme-judge-route-key");
		expect(auth["acme-judge"]).toBeUndefined();
		// Same regression on the decisions reader (the magic key DOES apply
		// here when the ids match, because the route writes it there).
		const request: DecisionRequest = {
			state: "acme",
			questions: { q: { type: "noul" } },
		};
		const result = await rig.opened.decisions.evaluate("fixwave", request, {
			model: "acme-judge/judge-1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(`evaluate failed: ${result.code} ${result.error}`);
		expect(decisionCalls.at(-1)?.credential).toBe("acme-judge-route-key");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/providers: model counts + owners
// ---------------------------------------------------------------------------

describe("credential-aware readiness display", () => {
	test("a stored credential renders a not_configured tracker as ready (the tracker only learns from calls)", async () => {
		resetGatedEmbeddingProvider();
		// The shape where the route writes the magic "default" key: the
		// embedding/decision/chat provider id IS the default model's provider.
		const rig = await bootServer("acme-gated/m1", [GATED_EMBEDDING_PROVIDER], {
			chatProviderId: "acme-gated",
		});
		// Premise: before any save, the row honestly reads not_configured.
		const before = (await listProviders(rig.app, rig.adminToken)).find(
			(candidate) => candidate.provider === "acme-gated" && candidate.kind === "embedding",
		);
		expect(before).toMatchObject({ status: "not_configured" });
		// The Save: the key lands under "default" (the id IS the default
		// chat provider), and the re-fetch must NOT still claim
		// not_configured — the stored key is positive evidence.
		const put = await call(rig.app, {
			method: "PUT",
			url: "/v1/providers/acme-gated/credential",
			token: rig.adminToken,
			payload: { apiKey: "display-probe-key" },
		});
		expect(put.status).toBe(200);
		const after = (await listProviders(rig.app, rig.adminToken)).find(
			(candidate) => candidate.provider === "acme-gated" && candidate.kind === "embedding",
		);
		expect(after).toMatchObject({ status: "ready" });
		expect(after?.detail).toBe("credential saved; the first call verifies it");
		// A tracker that has already degraded (a failed call) is NOT
		// overridden — the failure is live information.
		const cleared = await call(rig.app, {
			method: "DELETE",
			url: "/v1/providers/acme-gated/credential",
			token: rig.adminToken,
		});
		expect(cleared.status).toBe(200);
		const postClear = (await listProviders(rig.app, rig.adminToken)).find(
			(candidate) => candidate.provider === "acme-gated" && candidate.kind === "embedding",
		);
		expect(postClear).toMatchObject({ status: "not_configured" });
	});
});

describe("GET /v1/providers entries (models + owner)", () => {
	test("a tracker provider carries its catalog count and owning contributor; the degenerate provider carries neither owner nor keys", async () => {
		const { app, adminToken } = await bootServer("openai/gpt-test");
		const entries = await listProviders(app, adminToken);
		expect(entries).toEqual([
			// The fixture: unconfigured at boot → three-state vocabulary +
			// count 0 (empty baseline) + the contributor that owns it, and
			// the admin-local switch off until an admin toggles it.
			{ provider: "acme", status: "not_configured", models: 0, owner: "ext-acme", local: false, modelIds: [] },
			// The env-degenerate default provider: exactly its one pinned
			// model, no owning contributor, legacy not_ready (no key), the
			// `core` pseudo-slug's locality off.
			{ provider: "openai", status: "not_ready", models: 1, modelIds: ["gpt-test"], local: false, systemDefault: true },
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
			local: false,
			modelIds: ["m1", "m2"],
		});
		// No restart happened — the SAME opened handle's tracker flipped
		// because the auth bridge re-read auth.json on the refresh.
		const entries = await listProviders(app, adminToken);
		expect(entries.find((entry) => entry.provider === "acme")).toEqual({
			provider: "acme",
			status: "ready",
			models: 2,
			owner: "ext-acme",
			local: false,
			modelIds: ["m1", "m2"],
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
			local: false,
			modelIds: ["m1", "m2"],
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
			local: false,
			modelIds: ["m1", "m2"],
			systemDefault: true,
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
			local: false,
			modelIds: ["m1", "m2"],
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
