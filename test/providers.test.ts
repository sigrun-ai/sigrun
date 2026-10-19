import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { loadConfig, type Env } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { authPath, AuthStore } from "../src/harness/auth.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	collectProviders,
	createProviderMergeSink,
	UnservedModelError,
	requireServedModel,
} from "../src/harness/providers/index.js";

/** A contributor whose provider serves `ids` under provider id `providerId`. */
function contributor(
	name: string,
	providerId: string,
	ids: readonly { id: string; name: string }[],
	defaultModel?: { provider: string; modelId: string },
): ProviderContributor {
	const faux = fauxProvider({
		provider: providerId,
		models: ids.map((entry) => ({ id: entry.id, name: entry.name })),
	});
	return {
		name,
		providers: [{ provider: faux.provider, ...(defaultModel ? { defaultModel } : {}) }],
	};
}

test("unknown model id at submit fails loud with available ids", () => {
	const { models, defaultModel } = collectProviders(
		[contributor("ext-a", "x", [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }], { provider: "x", modelId: "m1" })],
		// No SIGRUN_DEFAULT_MODEL: the contributor default is the boot default.
		{ OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gw.example/v1" },
	);
	expect(defaultModel).toEqual({ provider: "x", modelId: "m1" });
	// The boot default itself is served.
	expect(requireServedModel(models, defaultModel).id).toBe("m1");

	let thrown: unknown;
	try {
		requireServedModel(models, { provider: "x", modelId: "nope" });
	} catch (error) {
		// never a silent fallback: a typed error Task 9 maps to 4xx.
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(UnservedModelError);
	const error = thrown as UnservedModelError;
	expect(error.ref).toEqual({ provider: "x", modelId: "nope" });
	expect(error.available).toEqual(["x/m1", "x/m2"]);
	expect(error.message).toContain("x/m1");
	expect(error.message).toContain("x/m2");
});

test("two contributors with same model id: last wins, collision logged", () => {
	const sink = createProviderMergeSink();
	const a = contributor("ext-a", "x", [{ id: "m", name: "A-m" }], { provider: "x", modelId: "m" });
	const b = contributor("ext-b", "x", [{ id: "m", name: "B-m" }], { provider: "x", modelId: "m" });

	const { models, defaultModel } = collectProviders([a, b], {}, sink);

	// Deterministic last-registered-wins on the provider/model collision.
	expect(models.getModel("x", "m")?.name).toBe("B-m");
	// The last contributor's default also wins.
	expect(defaultModel).toEqual({ provider: "x", modelId: "m" });
	// The collision is recorded in the sink `GET /v1/meta` reads — never silent.
	expect(sink.collisions).toHaveLength(1);
	expect(sink.collisions[0]).toEqual({
		kind: "provider",
		provider: "x",
		modelIds: ["m"],
		previous: "ext-a",
		contributor: "ext-b",
	});
});

test("SIGRUN_DEFAULT_MODEL overrides any contributor default", () => {
	const { models, defaultModel } = collectProviders(
		[contributor("ext-a", "x", [{ id: "m", name: "M" }], { provider: "x", modelId: "m" })],
		{
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			OPENAI_API_KEY: "sk-test",
			OPENAI_BASE_URL: "https://gw.example/v1",
		},
	);
	expect(defaultModel).toEqual({ provider: "openai", modelId: "gpt-4o" });
	// The env override names a served model: the degenerate env provider serves it.
	expect(requireServedModel(models, defaultModel).id).toBe("gpt-4o");
});

test("degenerate env provider is added when no extension contributes one", async () => {
	const { models } = collectProviders(
		[],
		{
			SIGRUN_DEFAULT_MODEL: "gpt-4o",
			OPENAI_API_KEY: "sk-test",
			OPENAI_BASE_URL: "https://gw.example/v1",
		},
	);
	const provider = models.getProvider("openai");
	expect(provider).toBeDefined();
	const model = models.getModel("openai", "gpt-4o");
	expect(model).toMatchObject({
		id: "gpt-4o",
		api: "openai-completions",
		baseUrl: "https://gw.example/v1",
	});
	// Auth resolves from the captured env (verified shape, App C).
	const auth = await models.getAuth("openai");
	expect(auth?.auth).toEqual({ apiKey: "sk-test", baseUrl: "https://gw.example/v1" });
});

test("degenerate env provider is skipped when a contributor provides one", async () => {
	const custom = contributor("ext-gateway", "openai", [{ id: "gpt-4o", name: "Custom" }]);
	const { models } = collectProviders([custom], {
		SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
		OPENAI_API_KEY: "sk-test",
		OPENAI_BASE_URL: "https://gw.example/v1",
	});
	// The contributor's provider object is installed verbatim, not wrapped.
	expect(models.getProvider("openai")).toBe(
		custom.providers?.[0].provider,
	);
	// Replacing the env default is designed behavior, not a collision.
	const sink = createProviderMergeSink();
	collectProviders([custom], { SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" }, sink);
	expect(sink.collisions).toHaveLength(0);
});

test("missing env credentials leave the degenerate provider unconfigured, not boot-failing", async () => {
	const { models } = collectProviders([], { SIGRUN_DEFAULT_MODEL: "gpt-4o" });
	expect(models.getProvider("openai")).toBeDefined();
	// Unconfigured: auth resolves to undefined; requests fail loud, boot does not.
	expect(await models.getAuth("openai")).toBeUndefined();
});

test("zero-extension boot with a non-openai pin serves it under that namespace", () => {
	const { models, defaultModel } = collectProviders([], {
		SIGRUN_DEFAULT_MODEL: "acme/model-1",
		OPENAI_API_KEY: "sk-test",
		OPENAI_BASE_URL: "https://gw.example/v1",
	});
	// The degenerate provider registers under the pinned namespace, not `openai`.
	expect(defaultModel).toEqual({ provider: "acme", modelId: "model-1" });
	expect(models.getModel("acme", "model-1")).toMatchObject({
		id: "model-1",
		provider: "acme",
	});
	expect(models.getProvider("openai")).toBeUndefined();
});

test("no configured default model and no contributor default fails loud", () => {
	expect(() =>
		collectProviders([contributor("ext-a", "x", [{ id: "m", name: "M" }])], {}),
	).toThrow(/SIGRUN_DEFAULT_MODEL/);
});

test("boot wiring: contributed provider serves SIGRUN_DEFAULT_MODEL-pinned generation end-to-end", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-providers-"));
	try {
		const env: Env = {
			SIGRUN_DEFAULT_MODEL: "x/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		};
		const config = loadConfig(env);
		const faux = fauxProvider({
			provider: "x",
			models: [{ id: "m" }, { id: "m-other" }],
		});
		faux.setResponses([fauxAssistantMessage("generated by m")]);
		const opened = await openHarness(config, {
			extensions: [
				{
					name: "ext-faux",
					providers: [
						{
							provider: faux.provider,
							// The contributor's default loses to SIGRUN_DEFAULT_MODEL.
							defaultModel: { provider: "x", modelId: "m-other" },
						},
					],
				},
			],
			env,
		});
		try {
			// The env override beats the contributor's default model.
			expect(opened.defaultModel).toEqual({ provider: "x", modelId: "m" });
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const settled = await (
				await root.submit({ type: "input", content: "hello" }, BACKGROUND_CONTEXT)
			).wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");
			const view = await root.context(BACKGROUND_CONTEXT);
			const assistant = view.messages
				.filter((message) => message.role === "assistant")
				.at(-1);
			// The pinned model actually served the request.
			expect(assistant?.model).toBe("m");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// auth.json credential resolution (ruling 6) — hermetic tmp config dirs,
// never the real ~/.config.
// ---------------------------------------------------------------------------

/** A fresh AuthStore over a tmp dir + cleanup registration. */
function freshAuthDir(): { dir: string; store: AuthStore } {
	const dir = mkdtempSync(join(tmpdir(), "sigrun-auth-"));
	return { dir, store: new AuthStore({ dir }) };
}

/** A provider whose apiKey auth resolves from the stored credential. */
function keyedProvider(id: string) {
	return createProvider({
		id,
		name: id,
		models: [],
		auth: {
			apiKey: {
				name: "key",
				resolve: async ({ credential }) =>
					credential?.key ? { auth: { apiKey: credential.key } } : undefined,
			},
		},
		// checkAuth/getAuth never stream, but a provider requires an api.
		api: openAICompletionsApi(),
	});
}

test("auth.json \"default\" key supplies the degenerate provider's key", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeFileSync(
			authPath(dir),
			JSON.stringify({ default: { apiKey: "sk-from-default" } }),
			"utf8",
		);
		const { models } = collectProviders(
			[],
			{ SIGRUN_DEFAULT_MODEL: "acme/model-1" },
			createProviderMergeSink(),
			{ auth: store },
		);
		const auth = await models.getAuth("acme");
		expect(auth?.auth).toMatchObject({ apiKey: "sk-from-default" });
		// No env key was involved — and no env baseUrl either: the file's
		// defaultProvider.baseUrl is absent here, so the OpenAI default.
		expect(auth?.auth).toMatchObject({
			baseUrl: "https://api.openai.com/v1",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("auth.json \"default\" key wins over the provider's own entry (ruling order)", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeFileSync(
			authPath(dir),
			JSON.stringify({
				default: { apiKey: "sk-from-default" },
				acme: { apiKey: "sk-from-acme" },
			}),
			"utf8",
		);
		const { models } = collectProviders(
			[],
			{ SIGRUN_DEFAULT_MODEL: "acme/model-1" },
			createProviderMergeSink(),
			{ auth: store },
		);
		// "default" is consulted FIRST — the degenerate-provider magic key
		// for deployments that don't know the resolved provider id.
		expect((await models.getAuth("acme"))?.auth).toMatchObject({
			apiKey: "sk-from-default",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("auth.json \"default\" reaches only the default model's provider, never other plugins", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeFileSync(authPath(dir), JSON.stringify({
			default: { apiKey: "sk-default" },
			acme: { apiKey: "sk-acme" },
		}), "utf8");
		const contributor = { name: "plugins", providers: [
			{ provider: keyedProvider("acme") },
			{ provider: keyedProvider("other") },
			{ provider: keyedProvider("third") },
		] };
		const { models } = collectProviders([contributor], { SIGRUN_DEFAULT_MODEL: "other/m" },
			createProviderMergeSink(), { auth: store });
		// Own entry only — the "default" key never crosses provider boundaries.
		expect((await models.getAuth("acme"))?.auth).toMatchObject({ apiKey: "sk-acme" });
		// The default model's provider: "default" → own entry (none here).
		expect((await models.getAuth("other"))?.auth).toMatchObject({ apiKey: "sk-default" });
		// No entry, not the default: nothing.
		expect(await models.getAuth("third")).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("OPENAI_API_KEY is the compat fallback when auth.json has no entry", async () => {
	const { dir, store } = freshAuthDir();
	try {
		// No auth.json at all…
		let { models } = collectProviders(
			[],
			{ SIGRUN_DEFAULT_MODEL: "acme/model-1", OPENAI_API_KEY: "sk-env" },
			createProviderMergeSink(),
			{ auth: store },
		);
		expect((await models.getAuth("acme"))?.auth).toMatchObject({
			apiKey: "sk-env",
		});
		// …and an auth.json with OTHER providers only falls back too.
		writeFileSync(
			authPath(dir),
			JSON.stringify({ other: { apiKey: "sk-other" } }),
			"utf8",
		);
		({ models } = collectProviders(
			[],
			{ SIGRUN_DEFAULT_MODEL: "acme/model-1", OPENAI_API_KEY: "sk-env" },
			createProviderMergeSink(),
			{ auth: store },
		));
		expect((await models.getAuth("acme"))?.auth).toMatchObject({
			apiKey: "sk-env",
		});
		// But an auth.json entry wins over the env var.
		writeFileSync(
			authPath(dir),
			JSON.stringify({ acme: { apiKey: "sk-file" } }),
			"utf8",
		);
		({ models } = collectProviders(
			[],
			{ SIGRUN_DEFAULT_MODEL: "acme/model-1", OPENAI_API_KEY: "sk-env" },
			createProviderMergeSink(),
			{ auth: store },
		));
		expect((await models.getAuth("acme"))?.auth).toMatchObject({
			apiKey: "sk-file",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("no key anywhere leaves the provider unconfigured (boot does not fail)", async () => {
	const { dir, store } = freshAuthDir();
	try {
		const { models } = collectProviders(
			[],
			{ SIGRUN_DEFAULT_MODEL: "acme/model-1" },
			createProviderMergeSink(),
			{ auth: store },
		);
		expect(await models.getAuth("acme")).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("defaultProvider.baseUrl (the file) supplies the endpoint; OPENAI_BASE_URL wins", async () => {
	const { dir, store } = freshAuthDir();
	try {
		// File value applies where env is absent.
		const fromFile = collectProviders(
			[],
			{ SIGRUN_DEFAULT_MODEL: "acme/model-1" },
			createProviderMergeSink(),
			{ auth: store, baseUrl: "https://file.example/v1" },
		);
		expect(fromFile.models.getModel("acme", "model-1")).toMatchObject({
			baseUrl: "https://file.example/v1",
		});
		// Env wins over the file.
		const mixed = collectProviders(
			[],
			{
				SIGRUN_DEFAULT_MODEL: "acme/model-1",
				OPENAI_BASE_URL: "https://env.example/v1",
			},
			createProviderMergeSink(),
			{ auth: store, baseUrl: "https://file.example/v1" },
		);
		expect(mixed.models.getModel("acme", "model-1")).toMatchObject({
			baseUrl: "https://env.example/v1",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AuthStore.write creates the file mode 0o600 and validates reads", async () => {
	const { dir, store } = freshAuthDir();
	try {
		store.write({ acme: { apiKey: "sk-written" } });
		// Owner-only permissions (0o600) on the key-material file.
		expect(statSync(authPath(dir)).mode & 0o777).toBe(0o600);
		expect(store.read()).toEqual({ acme: { apiKey: "sk-written" } });
		// Malformed files fail loud — naming the key path, never the value.
		writeFileSync(authPath(dir), "{not json", "utf8");
		expect(() => store.read()).toThrow(/not valid JSON/);
		writeFileSync(authPath(dir), '{"acme": {"apiKey": ""}}', "utf8");
		expect(() => store.read()).toThrow(/acme\.apiKey/);
		writeFileSync(authPath(dir), '["acme"]', "utf8");
		expect(() => store.read()).toThrow(/must contain a JSON object/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
