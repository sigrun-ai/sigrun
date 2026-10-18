import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Model, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { fileModelsStore } from "../src/harness/providers/models-store.js";
import {
	collectProviders,
	createProviderMergeSink,
} from "../src/harness/providers/index.js";

/** A minimal full chat-model shape (the same fields the degenerate provider builds). */
function chatModel(id: string, provider: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://acme.example/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 8192,
		maxTokens: 4096,
	};
}

/** A store entry with `ids` served under provider `providerId`. */
function entryOf(providerId: string, ids: readonly string[]): ModelsStoreEntry {
	return { models: ids.map((id) => chatModel(id, providerId)), checkedAt: 123 };
}

test("write then read round-trips a catalog", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-models-store-"));
	try {
		const store = fileModelsStore(dir);
		const entry = entryOf("acme", ["m1", "m2"]);
		await store.write("acme", entry);
		expect(await store.read("acme")).toEqual(entry);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("read of an absent file returns undefined", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-models-store-"));
	try {
		const store = fileModelsStore(dir);
		expect(await store.read("acme")).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("read of a corrupt file warns, deletes, returns undefined", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-models-store-"));
	try {
		const path = join(dir, "models", "acme.json");
		await mkdir(join(dir, "models"), { recursive: true });
		// Garbage bytes: a poisoned catalog must not crash boot.
		await writeFile(path, "{not json at all", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const store = fileModelsStore(dir);
			expect(await store.read("acme")).toBeUndefined();
			// The warn names the file (never its content)…
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0].join(" ")).toContain("acme.json");
			// …and the poisoned file is gone — the next read is silent.
			expect(existsSync(path)).toBe(false);
			expect(await store.read("acme")).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("write is atomic (tmp+rename; no partial file left on the happy path)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-models-store-"));
	try {
		const store = fileModelsStore(dir);
		await store.write("acme", entryOf("acme", ["m1"]));
		// The final file exists and parses…
		const raw = await readFile(join(dir, "models", "acme.json"), "utf8");
		expect(JSON.parse(raw).models).toHaveLength(1);
		// …and no scratch tmp remains anywhere under the store dir.
		const files = await readdir(join(dir, "models"));
		expect(files).toEqual(["acme.json"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("provider ids are filename-sanitized", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-models-store-"));
	try {
		const store = fileModelsStore(dir);
		const entry = entryOf("acme/gw", ["m1"]);
		await store.write("acme/gw", entry);
		// A slash becomes a flat safe filename…
		expect(existsSync(join(dir, "models", "acme_gw.json"))).toBe(true);
		expect(await store.read("acme/gw")).toEqual(entry);
		// …and traversal-shaped ids stay inside the models dir (no dots survive).
		await store.write("../evil", entryOf("../evil", ["m2"]));
		const files = await readdir(join(dir, "models"));
		expect(files.sort()).toEqual(["___evil.json", "acme_gw.json"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("collectProviders wires the store (refresh persists to disk)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-models-store-"));
	try {
		// A dynamic fixture provider: `fetchModels` publishes its overlay and
		// pi-ai persists the publication through the wired store.
		const provider: Provider = createProvider({
			id: "acme",
			auth: {
				apiKey: {
					name: "acme test key",
					resolve: async () => ({
						auth: { apiKey: "sk-test", baseUrl: "https://acme.example/v1" },
						source: "test",
					}),
				},
			},
			models: [],
			api: openAICompletionsApi(),
			fetchModels: async () => [chatModel("m1", "acme"), chatModel("m2", "acme")],
		});
		const { models } = collectProviders(
			[
				{
					name: "ext-dynamic",
					providers: [
						{ provider, defaultModel: { provider: "acme", modelId: "m1" } },
					],
				},
			],
			{},
			createProviderMergeSink(),
			{ modelsStore: fileModelsStore(dir) },
		);
		const result = await models.refresh({ force: true });
		expect(result.errors.size).toBe(0);
		// The refreshed catalog landed at <dataDir>/models/<id>.json.
		const path = join(dir, "models", "acme.json");
		expect(existsSync(path)).toBe(true);
		const persisted = JSON.parse(await readFile(path, "utf8"));
		expect(persisted.models.map((m: { id: string }) => m.id)).toEqual([
			"m1",
			"m2",
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
