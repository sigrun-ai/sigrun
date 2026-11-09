/**
 * Test-fixture extension package (embedding-providers Task 1): an
 * EMBEDDING PROVIDER, contributor-only (a factory result carrying
 * `embeddingProviders` with no `extension`). Provider `acme-embed`,
 * models `embed-1` (dimensions 3) and `embed-2` (dimensions 2,
 * `maxBatch` 8, `local` true), `credentialEnv` ACME_EMBED_API_KEY (the
 * tests own these literals). `embed` returns one vector per input,
 * each of the requested model's dimensions.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

export default function createFixtureEmbeddingProvider() {
	return {
		name: "acme-embed",
		embeddingProviders: [
			{
				id: "acme-embed",
				label: "Acme Embeddings",
				credentialEnv: "ACME_EMBED_API_KEY",
				models: [
					{ id: "embed-1", dimensions: 3 },
					{ id: "embed-2", dimensions: 2, maxBatch: 8, local: true },
				],
				async embed(request) {
					const dimensions = request.model === "embed-2" ? 2 : 3;
					return {
						vectors: request.input.map(() => new Array(dimensions).fill(0.5)),
					};
				},
			},
		],
	};
}
