/**
 * Provider plugins Task 6: three-state readiness on `GET /v1/auth/check`.
 *
 * Plan "Core: readiness & health": the route enumerates PROVIDERS (not
 * models, so an empty-catalog boot contribution still appears) and consults
 * the contributor's readiness tracker — the plugin-owned three-state
 * (`not_configured` = no credential resolved, `degraded` = configured but
 * the last refresh failed, `ready` = refresh succeeded / static catalog).
 *
 * Priority at the route (spec + brief):
 *  1. tracker registered by the owning contributor → three-state reported
 *     verbatim (+ optional `detail`);
 *  2. contributor-owned WITHOUT a tracker → the legacy producer mapping is
 *     preserved untouched (ok→ready, degraded→invalid, absent→not_ready);
 *  3. degenerate env provider → the legacy env-presence mapping is
 *     preserved (key present→ready, absent→not_ready) — the three-state
 *     vocabulary applies to plugin trackers only.
 *
 * Hermetic pattern (server-meta-health.test.ts): contributors boot through
 * the `openHarness` test seam in a tmpdir, `createServer` builds the app,
 * `app.inject()` exercises the route in-process. Tracker providers are
 * hand-built via `createProvider` (pi-ai) so tests control the catalog AND
 * the tracker state independently of any real plugin.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type {
	ProviderContribution,
	ProviderContributor,
	ProviderReadiness,
} from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + Fastify app, torn down after all tests. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/** A provider entry on the auth-check response (three-state + legacy shapes). */
interface AuthCheckEntry {
	provider: string;
	status: string;
	detail?: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot a hermetic harness + server in a tmpdir; registers cleanup. */
async function bootServer(options: {
	contributors: readonly ProviderContributor[];
	model?: string;
	env?: Record<string, string | undefined>;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-auth-check-"));
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: options.model ?? "acme/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: options.contributors,
		env: options.env ?? {},
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened };
}

/** GET /v1/auth/check as parsed JSON. */
async function getAuthCheck(
	app: FastifyInstance,
): Promise<{ providers: AuthCheckEntry[] }> {
	const response = await app.inject({ method: "GET", url: "/v1/auth/check" });
	expect(response.statusCode).toBe(200);
	return response.json();
}

/** The named provider's auth-check entry (undefined when absent). */
function entryOf(
	body: { providers: AuthCheckEntry[] },
	providerId: string,
): AuthCheckEntry | undefined {
	return body.providers.find((entry) => entry.provider === providerId);
}

/**
 * A hand-built fixture provider: `createProvider` over
 * openai-completions with the given static models (possibly NONE — an
 * empty catalog is the whole point of the enumeration change). The
 * readiness tracker rides the CONTRIBUTION, not the provider. Auth
 * resolves undefined: these providers never serve a request, they only
 * occupy the catalog.
 */
function fixtureProvider(
	id: string,
	modelIds: readonly string[],
): Provider {
	const models: Model<"openai-completions">[] = modelIds.map((modelId) => ({
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: id,
		baseUrl: "https://acme.example/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
	}));
	return createProvider({
		id,
		name: `Tracker fixture (${id})`,
		baseUrl: "https://acme.example/v1",
		auth: {
			apiKey: {
				name: "unused fixture key",
				resolve: async () => undefined,
			},
		},
		models,
		api: openAICompletionsApi(),
	});
}

/** One contributor owning the given contributions. */
function contributor(
	name: string,
	...contributions: ProviderContribution[]
): ProviderContributor {
	return { name, providers: contributions };
}

describe("GET /v1/auth/check three-state readiness (Task 6)", () => {
	test("an unconfigured contributor provider reports not_configured and APPEARS despite an empty catalog", async () => {
		const { app } = await bootServer({
			contributors: [
				contributor("ext-acme", {
					// Empty catalog: pre-Task-6 the route enumerated models and
					// this provider NEVER appeared. The tracker seeds from
					// credential resolution (pi-ai never refreshes an
					// unconfigured provider), so its initial state is
					// not_configured.
					provider: fixtureProvider("acme", []),
					readiness: () => ({
						status: "not_configured",
						detail: "no credential resolved",
					}),
				}),
			],
			// The default-model pin rides the env-degenerate provider (no key
			// in env → its own legacy not_ready), keeping the two providers
			// independent in the response.
			model: "openai/gpt-test",
			env: {},
		});
		const body = await getAuthCheck(app);
		const acme = entryOf(body, "acme");
		// Enumeration over providers: the empty-catalog provider appears.
		expect(acme).toBeDefined();
		// Three-state vocabulary, verbatim from the tracker.
		expect(acme).toEqual({
			provider: "acme",
			status: "not_configured",
			detail: "no credential resolved",
		});
	});

	test("configured + last refresh failed → degraded", async () => {
		// The tracker closure mirrors the plugin shape: seeded from credential
		// resolution, updated per refresh — the route consults it per request.
		// `let` rebinding is the update (the record itself is immutable).
		let state: ProviderReadiness = {
			status: "degraded",
			detail: "last refresh failed: 401 unauthorized",
		};
		const { app } = await bootServer({
			contributors: [
			contributor("ext-acme", {
				provider: fixtureProvider("acme", ["m"]),
				readiness: () => state,
			}),
			],
			model: "acme/m",
			env: {},
		});
		const body = await getAuthCheck(app);
		expect(entryOf(body, "acme")).toEqual({
			provider: "acme",
			status: "degraded",
			detail: "last refresh failed: 401 unauthorized",
		});
		// Live tracker state, not a boot snapshot: flip to ready, re-GET.
		state = { status: "ready" };
		const after = await getAuthCheck(app);
		expect(entryOf(after, "acme")).toEqual({
			provider: "acme",
			status: "ready",
		});
	});

	test("configured + refresh ok → ready", async () => {
		const { app } = await bootServer({
			contributors: [
			contributor("ext-acme", {
				provider: fixtureProvider("acme", ["m"]),
				readiness: () => ({ status: "ready" }),
			}),
			],
			model: "acme/m",
			env: {},
		});
		const body = await getAuthCheck(app);
		expect(entryOf(body, "acme")).toEqual({
			provider: "acme",
			status: "ready",
		});
	});

	test("the degenerate env provider keeps its env-presence readiness mapping", async () => {
		// The three-state vocabulary applies to plugin trackers; the
		// degenerate env provider keeps the LEGACY statuses exactly (key
		// present → ready, absent/empty → not_ready).
		const configured = await bootServer({
			contributors: [],
			model: "openai/gpt-test",
			env: { OPENAI_API_KEY: "fixture-key" },
		});
		const ready = await getAuthCheck(configured.app);
		expect(ready.providers).toEqual([
			{ provider: "openai", status: "ready" },
		]);

		const bare = await bootServer({
			contributors: [],
			model: "openai/gpt-test",
			env: {},
		});
		const notReady = await getAuthCheck(bare.app);
		expect(notReady.providers).toEqual([
			{ provider: "openai", status: "not_ready" },
		]);
	});
});
