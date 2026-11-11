/**
 * Embedding-providers Task 2: the pure provider registry. Fixtures own
 * their literals: provider `acme-embed`, model `embed-1`, caller
 * `acme-recall`, synthetic credential and input text.
 */

import { describe, expect, it } from "vitest";
import type {
	EmbeddingProviderContribution,
	EmbeddingResponse,
} from "../src/extension.js";
import { buildEmbeddingRegistry } from "../src/harness/embeddings.js";
import { createLocality } from "../src/harness/locality.js";
import type { EmbeddingDeclaration } from "../src/harness/loader.js";

const CREDENTIAL = "acme-embedding-secret";
const INPUT = "confidential acme input";

interface Call {
	model: string;
	input: readonly string[];
	credential: string | undefined;
	signal: AbortSignal;
}

interface Fixture {
	calls: Call[];
	warnings: string[];
	registry: ReturnType<typeof buildEmbeddingRegistry>;
}

function makeFixture(overrides: {
	contribution?: Partial<EmbeddingProviderContribution>;
	embed?: (call: Call) => Promise<EmbeddingResponse>;
	settings?: { embeddingModel?: string; localProviders?: readonly string[]; timeoutCapMs?: number };
	credential?: (providerId: string, credentialEnv?: string) => Promise<string | undefined>;
	secondContribution?: EmbeddingProviderContribution;
} = {}): Fixture {
	const calls: Call[] = [];
	const warnings: string[] = [];
	const embed = overrides.embed ?? (async (call: Call) => ({
		vectors: call.input.map((_, index) => [index + 1, index + 2]),
	}));
	const contribution: EmbeddingProviderContribution = {
		id: "acme-embed",
		label: "Acme Embeddings",
		credentialEnv: "ACME_EMBED_API_KEY",
		models: [{ id: "embed-1", dimensions: 2 }],
		embed: async (request, context) => {
			const call: Call = {
				model: request.model,
				input: request.input,
				credential: context.credential,
				signal: context.signal,
			};
			calls.push(call);
			return embed(call);
		},
		...overrides.contribution,
	};
	const declarations: EmbeddingDeclaration[] = [
		{ extension: "acme-one", contribution },
	];
	if (overrides.secondContribution) {
		declarations.push({ extension: "acme-two", contribution: overrides.secondContribution });
	}
	const settings = {
		embeddingModel: "acme-embed/embed-1",
		localProviders: [] as readonly string[],
		timeoutCapMs: 1_000,
		...overrides.settings,
	};
	const locality = createLocality({
		localProviders: () => settings.localProviders,
		ownerOf: () => "acme-one",
	});
	return {
		calls,
		warnings,
		registry: buildEmbeddingRegistry(declarations, {
			settings: () => settings,
			locality,
			credential: overrides.credential ?? (async () => CREDENTIAL),
			warn: (message) => warnings.push(message),
		}),
	};
}

describe("buildEmbeddingRegistry", () => {
	it("no setting and no model is no_model", async () => {
		const fixture = makeFixture({ settings: { embeddingModel: undefined } });
		const result = await fixture.registry.embed("acme-recall", [INPUT], {});
		expect(result).toEqual({ ok: false, code: "no_model", message: expect.any(String) });
		expect(fixture.calls).toHaveLength(0);
	});

	it("unknown model is no_model", async () => {
		const fixture = makeFixture();
		const result = await fixture.registry.embed("acme-recall", [INPUT], {
			model: "acme-embed/unknown",
		});
		expect(result).toEqual({ ok: false, code: "no_model", message: expect.any(String) });
		expect(fixture.calls).toHaveLength(0);
	});

	it("local-only embedding refused unless its extension is local", async () => {
		const fixture = makeFixture({ contribution: { models: [{ id: "embed-1", dimensions: 2, local: true }] } });
		const result = await fixture.registry.embed("acme-recall", [INPUT], {
			confidentiality: "local-only",
		});
		expect(result).toEqual({ ok: false, code: "not_local", message: expect.any(String) });
		expect(fixture.calls).toHaveLength(0);
	});

	it("the embedding local:false veto still wins", async () => {
		const fixture = makeFixture({
			contribution: { models: [{ id: "embed-1", dimensions: 2, local: false }] },
			settings: { localProviders: ["acme-one"] },
		});
		const result = await fixture.registry.embed("acme-recall", [INPUT], {
			confidentiality: "local-only",
		});
		expect(result).toEqual({ ok: false, code: "not_local", message: expect.any(String) });
		expect(fixture.calls).toHaveLength(0);
	});

	it("a local extension's model accepts local-only", async () => {
		const fixture = makeFixture({
			settings: { localProviders: ["acme-one"] },
		});
		const result = await fixture.registry.embed("acme-recall", [INPUT], {
			confidentiality: "local-only",
		});
		expect(result.ok).toBe(true);
		expect(fixture.calls).toHaveLength(1);
	});

	it("not_configured comes from provider readiness, not a missing key", async () => {
		const fixture = makeFixture({
			credential: async () => undefined,
			contribution: { readiness: () => ({ status: "not_configured" }) },
		});
		const result = await fixture.registry.embed("acme-recall", [INPUT], {});
		expect(result).toEqual({ ok: false, code: "not_configured", message: expect.any(String) });
		expect(fixture.calls).toHaveLength(0);
	});

	it("a keyless provider is called with credential undefined", async () => {
		const credentialCalls: [string, string | undefined][] = [];
		const fixture = makeFixture({
			credential: async (providerId, credentialEnv) => {
				credentialCalls.push([providerId, credentialEnv]);
				return undefined;
			},
			contribution: { readiness: () => ({ status: "ready" }) },
		});
		const result = await fixture.registry.embed("acme-recall", [INPUT], {});
		expect(result.ok).toBe(true);
		expect(fixture.calls[0]?.credential).toBeUndefined();
		expect(credentialCalls).toEqual([["acme-embed", "ACME_EMBED_API_KEY"]]);
	});

	it("non-finite vector element is bad_response", async () => {
		const fixture = makeFixture({
			embed: async () => ({ vectors: [[1, Number.NaN]] }),
		});
		const result = await fixture.registry.embed("acme-recall", [INPUT], {});
		expect(result).toEqual({ ok: false, code: "bad_response", message: expect.any(String) });
	});

	it("list marks the default row", () => {
		const fixture = makeFixture({
			contribution: {
				readiness: () => ({ status: "degraded" }),
				models: [
					{ id: "embed-1", dimensions: 2 },
					{ id: "embed-2", dimensions: 3, local: false },
				],
			},
			settings: {
				embeddingModel: "acme-embed/embed-2",
				localProviders: ["acme-one"],
			},
		});
		expect(fixture.registry.list()).toEqual([
			{ model: "acme-embed/embed-1", provider: "acme-embed", dimensions: 2, local: true, default: false, status: "degraded" },
			{ model: "acme-embed/embed-2", provider: "acme-embed", dimensions: 3, local: false, default: true, status: "degraded" },
		]);
		expect(fixture.registry.providers()).toEqual([
			{ id: "acme-embed", label: "Acme Embeddings", extension: "acme-one", models: ["embed-1", "embed-2"], status: "degraded" },
		]);
	});

	it("list shows the extension switch and the model veto independently", () => {
		const fixture = makeFixture({
			contribution: {
				models: [
					{ id: "embed-1", dimensions: 2 },
					{ id: "embed-2", dimensions: 3, local: false },
				],
			},
			settings: { localProviders: ["acme-one"] },
		});
		// One extension switch covers BOTH id-less rows; local:false owns
		// the second row, so [true, false] under the switch.
		expect(fixture.registry.list().map((row) => row.local)).toEqual([true, false]);
	});

	it("batches above maxBatch keep order", async () => {
		const fixture = makeFixture({
			contribution: { models: [{ id: "embed-1", dimensions: 1, maxBatch: 2 }] },
			embed: async (call) => ({ vectors: call.input.map((text) => [Number(text)]) }),
		});
		const result = await fixture.registry.embed("acme-recall", ["1", "2", "3", "4", "5"], {});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.vectors.map((vector) => [...vector])).toEqual([[1], [2], [3], [4], [5]]);
		expect(fixture.calls.map((call) => call.input)).toEqual([["1", "2"], ["3", "4"], ["5"]]);
	});

	it("wrong dimensions or count is bad_response", async () => {
		const wrongDimensions = makeFixture({
			embed: async () => ({ vectors: [[1, 2, 3]] }),
		});
		expect(await wrongDimensions.registry.embed("acme-recall", [INPUT], {})).toEqual({
			ok: false,
			code: "bad_response",
			message: expect.any(String),
		});
		const wrongCount = makeFixture({ embed: async () => ({ vectors: [] }) });
		expect(await wrongCount.registry.embed("acme-recall", [INPUT], {})).toEqual({
			ok: false,
			code: "bad_response",
			message: expect.any(String),
		});
	});

	it("timeout", async () => {
		const fixture = makeFixture({
			settings: { timeoutCapMs: 20 },
			embed: async (call) => {
				await new Promise<void>((resolve) => call.signal.addEventListener("abort", () => resolve(), { once: true }));
				return { vectors: [[1, 2]] };
			},
		});
		const result = await fixture.registry.embed("acme-recall", [INPUT], { timeoutMs: 5_000 });
		expect(result).toEqual({ ok: false, code: "timeout", message: expect.any(String) });
		expect(fixture.calls[0]?.signal.aborted).toBe(true);
	});

	it("provider throw is failed and the message carries no credential or input", async () => {
		const fixture = makeFixture({
			embed: async () => {
				throw new Error(`upstream rejected ${CREDENTIAL} while embedding ${INPUT}`);
			},
		});
		const result = await fixture.registry.embed("acme-recall", [INPUT], {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("failed");
			expect(result.message).not.toContain(CREDENTIAL);
			expect(result.message).not.toContain(INPUT);
		}
	});

	it("last-registered wins with a warning", async () => {
		const second: EmbeddingProviderContribution = {
			id: "acme-embed",
			models: [{ id: "embed-2", dimensions: 2 }],
			embed: async () => ({ vectors: [[1, 2]] }),
		};
		const fixture = makeFixture({ secondContribution: second });
		const result = await fixture.registry.embed("acme-recall", [INPUT], {
			model: "acme-embed/embed-2",
		});
		expect(result.ok).toBe(true);
		expect(fixture.calls).toHaveLength(0);
		expect(fixture.warnings).toHaveLength(1);
		expect(fixture.warnings[0]).toContain("acme-one");
		expect(fixture.warnings[0]).toContain("acme-two");
		expect(fixture.registry.collisions()).toEqual([
			{ id: "acme-embed", winner: "acme-two", losers: ["acme-one"] },
		]);
	});

	it("empty input makes no call", async () => {
		const fixture = makeFixture();
		const result = await fixture.registry.embed("acme-recall", [], {});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result).toEqual({ ok: true, model: "acme-embed/embed-1", dimensions: 2, vectors: [] });
		}
		expect(fixture.calls).toHaveLength(0);
	});

	it("empty local-only input to a non-local model is not_local", async () => {
		const fixture = makeFixture();
		const result = await fixture.registry.embed("acme-recall", [], {
			confidentiality: "local-only",
		});
		expect(result).toEqual({ ok: false, code: "not_local", message: expect.any(String) });
		expect(fixture.calls).toHaveLength(0);
	});
});
