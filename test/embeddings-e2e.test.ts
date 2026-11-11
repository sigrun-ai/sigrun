/**
 * Embedding-providers Task 7: the shipped `@sigrun/provider-openai`
 * package's embedding contribution, loaded from the SIBLING checkout's
 * built `dist/index.js` (the published-package shape) through the
 * `sibling-repo` helper — the `warden-e2e` pattern.
 *
 * What this proves that the plugin's own suite cannot: the REAL loader
 * accepts the contribution (factory-result validation), the REAL boot
 * folds it into the embedding registry, core settings (`embeddingModel`)
 * and credentials (the ambient `OPENAI_API_KEY`) resolve through boot's
 * live readers, and `opened.embeddings.embed` reaches the provider's
 * `POST /v1/embeddings` on the fake upstream and returns vectors core
 * accepts at the declared dimensions.
 *
 * Hermetic: a `node:http` fake `/v1/embeddings` on 127.0.0.1, a scoped
 * `settings/provider-openai.json` steering `baseUrl` at it (proving the
 * factory-time settings read), a synthetic key, and built-ins off. The
 * chat and decision kinds are switched off so the run touches exactly the
 * kind under test. Core CI does not check this sibling out, so the suite
 * SKIPS when the package is absent (a dev machine has it).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { seededIdentity } from "./helpers/identity.js";
import { siblingRepo } from "./helpers/sibling-repo.js";

/** The provider package's built entry, when a sibling checkout exists. */
const PACKAGE_DIR = (() => {
	try {
		return siblingRepo("sigrun-provider-openai");
	} catch {
		return undefined;
	}
})();
const ENTRY = join(PACKAGE_DIR ?? "", "dist", "index.js");
const AVAILABLE = PACKAGE_DIR !== undefined && existsSync(ENTRY);

const KEY = "sk-test";
const DIMENSIONS = 1536;
const MODEL = "text-embedding-3-small";

interface Captured {
	readonly model: string;
	readonly input: readonly string[];
	readonly authorization: string | undefined;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) {
		try {
			await teardown();
		} catch (error) {
			console.error("embeddings-e2e teardown failed", error);
		}
	}
});

/** The fake upstream: `POST /v1/embeddings`, rows in reverse wire order. */
async function fakeEmbeddingsServer(): Promise<{ baseUrl: string; requests: Captured[] }> {
	const requests: Captured[] = [];
	const server: Server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/embeddings") {
			res.writeHead(404).end();
			return;
		}
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw) as { readonly model: string; readonly input: readonly string[] };
			requests.push({
				model: body.model,
				input: body.input,
				authorization: req.headers.authorization,
			});
			const data = body.input
				.map((text, index) => ({
					object: "embedding",
					index,
					// Two models → two dimensions; the registry accepts only the
					// declared one.
					embedding: new Array<number>(
						body.model === "text-embedding-3-large" ? 3072 : DIMENSIONS,
					).fill(text.length / 100),
				}))
				.reverse();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				object: "list",
				model: body.model,
				data,
				usage: { prompt_tokens: 8, total_tokens: 8 },
			}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	cleanups.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

interface Rig {
	readonly opened: OpenedHarness;
	readonly requests: Captured[];
}

/**
 * One real boot: the package's built entry loaded as an extension, its
 * scoped settings pointing at `baseUrl` (the fake upstream by default), and
 * `embeddingModel` naming the model every embedding call resolves.
 */
async function boot(overrides: { baseUrl?: string } = {}): Promise<Rig> {
	const fake = await fakeEmbeddingsServer();
	const dir = await mkdtemp(join(tmpdir(), "sigrun-embeddings-e2e-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_AUTH: "token",
		SIGRUN_TIMEZONE: "UTC",
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
	}, { server: {} } as Parameters<typeof loadConfig>[1]);
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			namingModel: false,
			embeddingModel: `openai/${MODEL}`,
			// The admin approves the WHOLE extension for local-only input
			// (settings split Plan 2 Task 2 — locality is per provider
			// EXTENSION, so both of the provider's loopback-served models
			// are local once the switch is on).
			localProviders: ["provider-openai"],
		}),
	);
	await mkdir(join(configDir, "settings"), { recursive: true });
	await writeFile(
		join(configDir, "settings", "provider-openai.json"),
		JSON.stringify({
			baseUrl: overrides.baseUrl ?? fake.baseUrl,
			chat: { enabled: false },
			decisions: { enabled: false },
			// Core splits by maxBatch only; the provider splits further by
			// tokens. A tiny maxBatch makes core's own split visible here.
			embeddings: { maxBatch: 2 },
		}),
	);
	const identity = await seededIdentity(dir, "root-admin");
	const opened = await openHarness(config, {
		identity,
		builtins: false,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [pathToFileURL(ENTRY).href],
		env: {
			OPENAI_API_KEY: KEY,
			SIGRUN_CONFIG_DIR: configDir,
			SIGRUN_DATA_DIR: join(dir, "data"),
			SIGRUN_STATE_DIR: join(dir, "state"),
			SIGRUN_CACHE_DIR: join(dir, "cache"),
		},
		settingsDir: dir,
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, requests: fake.requests };
}

describe.skipIf(!AVAILABLE)("embeddings e2e: the shipped provider-openai package", () => {
	test("loads as an extension and lists the openai embedding models", async () => {
		const { opened } = await boot();
		expect(opened.extensionOutcomes).toEqual([
			{ name: "provider-openai", status: "ok" },
		]);
		expect(opened.embeddings.providers()).toEqual([
			{
				id: "openai",
				label: "OpenAI",
				extension: "provider-openai",
				models: ["text-embedding-3-small", "text-embedding-3-large"],
				status: "ready",
			},
		]);
		const listed = opened.embeddings.list();
		expect(listed).toEqual([
			{
				model: "openai/text-embedding-3-small",
				provider: "openai",
				dimensions: 1536,
				// Local: the admin lists it AND the provider agrees (loopback host).
				local: true,
				default: true,
				status: "ready",
			},
			{
				model: "openai/text-embedding-3-large",
				provider: "openai",
				dimensions: 3072,
				// Switch-on extension ⇒ BOTH models are local; the switch is
				// per extension, never per model.
				local: true,
				default: false,
				status: "ready",
			},
		]);
	}, 120_000);

	test("host.embeddings.embed returns 1536-length vectors through the fake upstream", async () => {
		const { opened, requests } = await boot();
		const result = await opened.embeddings.embed("e2e", ["alpha", "beta gamma"], {});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(`embed failed: ${result.code} ${result.message}`);
		expect(result.model).toBe(`openai/${MODEL}`);
		expect(result.dimensions).toBe(DIMENSIONS);
		expect(result.vectors).toHaveLength(2);
		for (const vector of result.vectors) {
			expect(vector).toBeInstanceOf(Float32Array);
			expect(vector).toHaveLength(DIMENSIONS);
		}
		// The vectors come back in input order ("alpha" is shorter).
		expect(Number(result.vectors[0]![0])).toBeCloseTo("alpha".length / 100, 4);
		expect(Number(result.vectors[1]![0])).toBeCloseTo("beta gamma".length / 100, 4);
		// The wire carried the settings model id, the inputs, and the env key.
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			model: MODEL,
			input: ["alpha", "beta gamma"],
			authorization: `Bearer ${KEY}`,
		});
		// Core splits by maxBatch (2) and the provider sees each split as its own
		// request, in input order.
		const batched = await opened.embeddings.embed("e2e", ["a", "b", "c", "d", "e"], {});
		expect(batched.ok).toBe(true);
		if (!batched.ok) throw new Error("batched embed failed");
		expect(batched.vectors).toHaveLength(5);
		expect(requests.slice(1).map((request) => request.input)).toEqual([
			["a", "b"],
			["c", "d"],
			["e"],
		]);
		// The local-only gate composes end to end: both of the switched-on
		// extension's served models pass (the fake answers each in its
		// declared dimensions). Refusal paths for non-local extensions are
		// owned by test/locality.test.ts + test/embeddings.test.ts.
		const before = requests.length;
		expect(
			await opened.embeddings.embed("e2e", ["secret"], { confidentiality: "local-only" }),
		).toMatchObject({ ok: true, model: `openai/${MODEL}` });
		expect(requests).toHaveLength(before + 1);
		expect(
			await opened.embeddings.embed("e2e", ["secret"], {
				model: "openai/text-embedding-3-large",
				confidentiality: "local-only",
			}),
		).toMatchObject({ ok: true, model: "openai/text-embedding-3-large" });
		expect(requests).toHaveLength(before + 2);
	}, 120_000);

	/**
	 * The regression pin for the readiness deadlock: the provider's readiness
	 * tracker cannot read `auth.json`, so on the DEFAULT public base URL it
	 * reports `not_configured` until a call has presented a credential. Core
	 * must therefore resolve the credential FIRST and only return
	 * `not_configured` when there is none AND the tracker says so — otherwise
	 * the first call is refused, the tracker never learns the key, and a keyed
	 * default install is stuck forever.
	 *
	 * `fetch` is stubbed for the duration of the call (no network): the
	 * provider must reach `https://api.openai.com/v1/embeddings` with the
	 * resolved key and return real vectors, not a `not_configured` failure.
	 */
	test("a keyed install on the public base URL still embeds", async () => {
		const { opened } = await boot({ baseUrl: "https://api.openai.com/v1" });
		// The premise: the tracker reports not_configured before any call...
		expect(opened.embeddings.providers()).toMatchObject([
			{ id: "openai", status: "not_configured" },
		]);
		// ...and the credential exists (boot env), so core must still call.
		const calls: { url: string; authorization: string | undefined; body: unknown }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(input),
				authorization: new Headers(init?.headers).get("authorization") ?? undefined,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			const body = JSON.parse(String(init?.body)) as { readonly input: readonly string[] };
			return new Response(JSON.stringify({
				object: "list",
				model: "text-embedding-3-small",
				data: body.input.map((text, index) => ({
					object: "embedding",
					index,
					embedding: new Array<number>(1536).fill(text.length / 100),
				})),
			}), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;
		try {
			const result = await opened.embeddings.embed("e2e", ["alpha", "beta gamma"], {});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(`embed failed: ${result.code} ${result.message}`);
			expect(result.model).toBe(`openai/${MODEL}`);
			expect(result.vectors.map((vector) => vector.length)).toEqual([1536, 1536]);
			expect(Number(result.vectors[0]![0])).toBeCloseTo("alpha".length / 100, 4);
			expect(calls).toEqual([{
				url: "https://api.openai.com/v1/embeddings",
				authorization: `Bearer ${KEY}`,
				body: { model: MODEL, input: ["alpha", "beta gamma"] },
			}]);
			// The call taught the tracker about the key: the display self-heals.
			expect(opened.embeddings.providers()).toMatchObject([
				{ id: "openai", status: "ready" },
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}, 120_000);
});