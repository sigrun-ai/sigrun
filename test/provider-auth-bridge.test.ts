/**
 * Task 2 (provider plugins): the auth.json → pi-ai credential bridge.
 *
 * `authStoreCredentialStore` adapts the operator-owned `AuthStore`
 * (auth.json) into pi-ai's `CredentialStore`: read-only, `"default"`
 * scoped to the default model's provider, `modify`/`delete`
 * refusing loudly (credentials are operator-provisioned). And
 * `collectProviders` hands that store plus an `AuthContext`
 * (env-from-the-options-seam, fileExists via node:fs) to `createModels`,
 * so a dynamic provider's `Models.checkAuth(providerId)` resolves from
 * auth.json through the bridge. Hermetic: tmp config dirs, synthetic keys,
 * no network, no process.env.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import type { Model } from "@earendil-works/pi-ai";
import { authPath, AuthStore } from "../src/harness/auth.js";
import { authStoreCredentialStore } from "../src/harness/providers/auth-bridge.js";
import { collectProviders } from "../src/harness/providers/index.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

/** A fresh AuthStore over a tmp dir (never the real ~/.config). */
function freshAuthDir(): { dir: string; store: AuthStore } {
	const dir = mkdtempSync(join(tmpdir(), "sigrun-auth-bridge-"));
	return { dir, store: new AuthStore({ dir }) };
}

/** Write an auth file into `dir`. */
function writeAuth(dir: string, file: Record<string, { apiKey?: string }>): void {
	writeFileSync(authPath(dir), JSON.stringify(file), "utf8");
}

test("read returns the provider's apiKey from auth.json", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { bifrost: { apiKey: "sk-bifrost" } });
		const credentials = authStoreCredentialStore(store, () => undefined);
		const credential = await credentials.read("bifrost");
		expect(credential).toEqual({ type: "api_key", key: "sk-bifrost" });
		// list() surfaces every provider key in the file.
		expect(await credentials.list()).toEqual([{ providerId: "bifrost", type: "api_key" }]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a non-default provider reads only its own entry", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { default: { apiKey: "sk-from-default" }, acme: { apiKey: "sk-from-acme" } });
		const credentials = authStoreCredentialStore(store, () => "openai");
		expect(await credentials.read("acme")).toEqual({ type: "api_key", key: "sk-from-acme" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the default model's provider reads default first, then its own entry", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { default: { apiKey: "sk-from-default" }, bifrost: { apiKey: "sk-from-bifrost" } });
		const credentials = authStoreCredentialStore(store, () => "bifrost");
		expect(await credentials.read("bifrost")).toEqual({ type: "api_key", key: "sk-from-default" });
		writeAuth(dir, { bifrost: { apiKey: "sk-from-bifrost" } });
		expect(await credentials.read("bifrost")).toEqual({ type: "api_key", key: "sk-from-bifrost" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a non-default provider without its own entry gets nothing, even with a default entry", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { default: { apiKey: "sk-from-default" } });
		const credentials = authStoreCredentialStore(store, () => "openai");
		expect(await credentials.read("acme")).toBeUndefined();
		// No default resolved yet: "default" applies to nobody.
		expect(await authStoreCredentialStore(store, () => undefined).read("openai")).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("read returns undefined when no entry exists", async () => {
	const { dir, store } = freshAuthDir();
	try {
		// No file at all…
		const credentials = authStoreCredentialStore(store, () => undefined);
		expect(await credentials.read("bifrost")).toBeUndefined();
		// …and a file with only other providers.
		writeAuth(dir, { other: { apiKey: "sk-other" } });
		expect(await credentials.read("bifrost")).toBeUndefined();
		expect(await credentials.list()).toEqual([
			{ providerId: "other", type: "api_key" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("modify and delete throw operator-provisioned", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { bifrost: { apiKey: "sk-bifrost" } });
		const credentials = authStoreCredentialStore(store, () => undefined);
		await expect(credentials.modify("bifrost", async () => undefined)).rejects.toThrow(
			/operator-provisioned/,
		);
		await expect(credentials.delete("bifrost")).rejects.toThrow(
			/operator-provisioned/,
		);
		// The refusal left the file untouched.
		expect(store.read()).toEqual({ bifrost: { apiKey: "sk-bifrost" } });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("createModels receives the bridged store (credential resolves for a dynamic provider)", async () => {
	const { dir, store } = freshAuthDir();
	try {
		// The provider-contribution shape Task 6 plugins use: a full Model
		// entry (same skeleton as the degenerate provider's) + auth resolved
		// FROM THE STORED CREDENTIAL — the real dynamic-provider pattern: no
		// stored key ⇒ unconfigured.
		const model: Model<"openai-completions"> = {
			id: "fixture-m",
			name: "Fixture M",
			api: "openai-completions",
			provider: "fixture-gw",
			baseUrl: "https://fixture.example/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 16_384,
		};
		const provider: Provider = createProvider({
			id: "fixture-gw",
			auth: {
				apiKey: {
					name: "Fixture gateway key (auth.json)",
					resolve: async ({ credential }) =>
							credential?.key === undefined
								? undefined
								: { auth: { apiKey: credential.key }, source: "auth.json" },
				},
			},
			models: [model],
			// checkAuth never streams, but a provider requires an api.
			api: openAICompletionsApi(),
		});
		const contributor: ProviderContributor = {
			name: "ext-fixture",
			providers: [
				{ provider, defaultModel: { provider: "fixture-gw", modelId: "fixture-m" } },
			],
		};
		writeAuth(dir, { "fixture-gw": { apiKey: "sk-fixture" } });

		const { models } = collectProviders(
			[contributor],
			{ SIGRUN_DEFAULT_MODEL: "fixture-gw/fixture-m" },
			undefined,
			{ auth: store },
		);
		// checkAuth consults the credential store through the bridge: the
		// stored auth.json key resolves for the dynamic provider. Without the
		// bridge the store is empty, resolve sees no credential, and the
		// provider is unconfigured (checkAuth → undefined).
		await expect(models.checkAuth("fixture-gw")).resolves.toEqual({
			source: "auth.json",
			type: "api_key",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
