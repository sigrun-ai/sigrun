/**
 * Embedding-providers Task 1: the `embeddingProviders` factory-result
 * field on the loader — collection with slug attribution, the per-rule
 * quarantine messages, and the contributor-only (embedding-only)
 * contract form. The registry, host surface and settings land in later
 * tasks; these tests exercise `loadExtensions` directly (the loader is
 * this task's surface).
 *
 * Fixture extensions under `test/fixtures/` (the decisions-loader
 * pattern): `fixture-embedding-provider` is a contributor-only provider
 * (`acme-embed`, models `embed-1`/`embed-2`), and
 * `fixture-embedding-bad` stages one malformed declaration per
 * quarantine rule. The tests own these literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { loadExtensions } from "../src/harness/loader.js";
import { setBadEmbeddingProviders } from "./fixtures/fixture-embedding-bad/index.js";

const PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-embedding-provider", "index.js"),
).href;
const BAD = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-embedding-bad", "index.js"),
).href;

test("a valid embeddingProviders contribution is collected with its slug", async () => {
	const loaded = await loadExtensions([PROVIDER], createRegistry());
	expect(loaded.outcomes).toEqual([
		expect.objectContaining({ name: "acme-embed", status: "ok" }),
	]);
	expect(loaded.embeddingProviderDeclarations).toHaveLength(1);
	const declaration = loaded.embeddingProviderDeclarations[0];
	expect(declaration?.extension).toBe("acme-embed");
	const contribution = declaration?.contribution;
	expect(contribution?.id).toBe("acme-embed");
	expect(contribution?.label).toBe("Acme Embeddings");
	expect(contribution?.credentialEnv).toBe("ACME_EMBED_API_KEY");
	expect(contribution?.models).toEqual([
		{ id: "embed-1", dimensions: 3 },
		{ id: "embed-2", dimensions: 2, maxBatch: 8, local: true },
	]);
	expect(typeof contribution?.embed).toBe("function");
});

test("embedding-only contributor loads", async () => {
	// A factory result whose ONLY contribution field is
	// embeddingProviders (no `extension`) is a valid contributor-only
	// result — the same contract form a decisions-only contributor uses.
	const loaded = await loadExtensions([PROVIDER], createRegistry());
	expect(loaded.outcomes).toEqual([
		expect.objectContaining({ name: "acme-embed", status: "ok" }),
	]);
	expect(loaded.embeddingProviderDeclarations).toHaveLength(1);
});

test("each quarantine rule quarantines", async () => {
	const validModel = { id: "embed-1", dimensions: 3 };
	const validEmbed = async () => ({ vectors: [] });
	const cases: readonly { name: string; value: unknown; match: RegExp }[] = [
		{
			name: "not an array",
			value: { id: "acme-embed" },
			match: /embeddingProviders.*not an array/,
		},
		{
			name: "a bad provider id",
			value: [
				{ id: "Acme_Bad", models: [validModel], embed: validEmbed },
			],
			match: /embedding provider.*id/,
		},
		{
			name: "a provider id over 64 chars",
			value: [
				{
					id: `a${"b".repeat(64)}`,
					models: [validModel],
					embed: validEmbed,
				},
			],
			match: /embedding provider.*id/,
		},
		{
			name: "no models",
			value: [{ id: "acme-embed", models: [], embed: validEmbed }],
			match: /no models/,
		},
		{
			name: "a bad model id",
			value: [
				{
					id: "acme-embed",
					models: [{ id: "embed 1", dimensions: 3 }],
					embed: validEmbed,
				},
			],
			match: /model.*id/,
		},
		{
			name: "a duplicate model id",
			value: [
				{
					id: "acme-embed",
					models: [validModel, { id: "embed-1", dimensions: 2 }],
					embed: validEmbed,
				},
			],
			match: /duplicate.*embed-1/,
		},
		{
			name: "non-positive dimensions",
			value: [
				{
					id: "acme-embed",
					models: [{ id: "embed-1", dimensions: 0 }],
					embed: validEmbed,
				},
			],
			match: /dimensions/,
		},
		{
			name: "negative dimensions",
			value: [
				{
					id: "acme-embed",
					models: [{ id: "embed-1", dimensions: -3 }],
					embed: validEmbed,
				},
			],
			match: /dimensions/,
		},
		{
			name: "non-integer dimensions",
			value: [
				{
					id: "acme-embed",
					models: [{ id: "embed-1", dimensions: 1.5 }],
					embed: validEmbed,
				},
			],
			match: /dimensions/,
		},
		{
			name: "missing dimensions",
			value: [
				{
					id: "acme-embed",
					models: [{ id: "embed-1" }],
					embed: validEmbed,
				},
			],
			match: /dimensions/,
		},
		{
			name: "a non-positive maxBatch",
			value: [
				{
					id: "acme-embed",
					models: [{ id: "embed-1", dimensions: 3, maxBatch: 0 }],
					embed: validEmbed,
				},
			],
			match: /maxBatch/,
		},
		{
			name: "a non-integer maxBatch",
			value: [
				{
					id: "acme-embed",
					models: [{ id: "embed-1", dimensions: 3, maxBatch: 2.5 }],
					embed: validEmbed,
				},
			],
			match: /maxBatch/,
		},
		{
			name: "embed not a function",
			value: [{ id: "acme-embed", models: [validModel], embed: 42 }],
			match: /embed.*not a function/,
		},
		{
			name: "a readiness that is not a function",
			value: [
				{
					id: "acme-embed",
					models: [validModel],
					embed: validEmbed,
					readiness: "ready",
				},
			],
			match: /readiness.*not a function/,
		},
		{
			name: "a credentialEnv that is not a NAME",
			value: [
				{
					id: "acme-embed",
					models: [validModel],
					embed: validEmbed,
					credentialEnv: "acme_embed_api_key",
				},
			],
			match: /credentialEnv/,
		},
	];
	for (const one of cases) {
		setBadEmbeddingProviders(one.value);
		const loaded = await loadExtensions([BAD], createRegistry());
		expect(loaded.outcomes, one.name).toHaveLength(1);
		const outcome = loaded.outcomes[0];
		expect(outcome?.status, one.name).toBe("quarantined");
		expect(outcome?.error, one.name).toMatch(one.match);
	}
});
