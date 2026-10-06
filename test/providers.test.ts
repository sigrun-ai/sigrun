import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Env } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
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
		// No SIGRUN_MODEL: the contributor default is the boot default.
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

test("SIGRUN_MODEL overrides any contributor default", () => {
	const { models, defaultModel } = collectProviders(
		[contributor("ext-a", "x", [{ id: "m", name: "M" }], { provider: "x", modelId: "m" })],
		{
			SIGRUN_MODEL: "openai/gpt-4o",
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
			SIGRUN_MODEL: "gpt-4o",
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
		SIGRUN_MODEL: "openai/gpt-4o",
		OPENAI_API_KEY: "sk-test",
		OPENAI_BASE_URL: "https://gw.example/v1",
	});
	// The contributor's provider object is installed verbatim, not wrapped.
	expect(models.getProvider("openai")).toBe(
		custom.providers?.[0].provider,
	);
	// Replacing the env default is designed behavior, not a collision.
	const sink = createProviderMergeSink();
	collectProviders([custom], { SIGRUN_MODEL: "openai/gpt-4o" }, sink);
	expect(sink.collisions).toHaveLength(0);
});

test("missing env credentials leave the degenerate provider unconfigured, not boot-failing", async () => {
	const { models } = collectProviders([], { SIGRUN_MODEL: "gpt-4o" });
	expect(models.getProvider("openai")).toBeDefined();
	// Unconfigured: auth resolves to undefined; requests fail loud, boot does not.
	expect(await models.getAuth("openai")).toBeUndefined();
});

test("no SIGRUN_MODEL and no contributor default fails loud", () => {
	expect(() =>
		collectProviders([contributor("ext-a", "x", [{ id: "m", name: "M" }])], {}),
	).toThrow(/SIGRUN_MODEL/);
});

test("boot wiring: contributed provider serves SIGRUN_MODEL-pinned generation end-to-end", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-providers-"));
	try {
		const env: Env = {
			SIGRUN_MODEL: "x/m",
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
							// The contributor's default loses to SIGRUN_MODEL.
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
