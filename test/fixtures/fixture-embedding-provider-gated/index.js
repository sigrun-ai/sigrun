/**
 * Test-fixture extension package (embedding-providers fix wave): an
 * EMBEDDING PROVIDER that mirrors the shipped `provider-openai` tracker —
 * `not_configured` until a call has PRESENTED a credential, `ready` from
 * then on.
 *
 * That shape is what makes the credential-key regression observable: core
 * refuses an embedding call as `not_configured` only when the resolved
 * credential is missing AND the tracker says `not_configured`, so a
 * tracker that cannot read auth.json (every real provider's) is exactly
 * the install this gate exists for. With the registration bug the
 * credential resolved to `undefined` forever, the tracker never learned
 * about the key, and recall stayed lexical with a "not_configured" that
 * no Providers-page Save could clear.
 *
 * Provider `acme-gated`, model `embed-1` (dimensions 3), `credentialEnv`
 * ACME_GATED_API_KEY (the tests own these literals). Every `embed`
 * records `{model, credential}` so a test proves the key REACHED the
 * provider, not merely that a call was attempted.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

/** Every provider call: `{model, credential}`. */
export const calls = [];

// The tracker state: flipped by the first credentialed call. Module state,
// not factory state — the loader and the test import the SAME file:// URL,
// one module instance (the decision-provider fixture pattern).
let configured = false;

/** Clear the records and the tracker (tests own their fixtures' state). */
export function resetGatedEmbeddingProvider() {
	calls.length = 0;
	configured = false;
}

export default function createFixtureGatedEmbeddingProvider() {
	return {
		name: "acme-gated",
		embeddingProviders: [
			{
				id: "acme-gated",
				label: "Acme Gated Embeddings",
				credentialEnv: "ACME_GATED_API_KEY",
				models: [{ id: "embed-1", dimensions: 3 }],
				readiness() {
					return { status: configured ? "ready" : "not_configured" };
				},
				async embed(request, ctx) {
					calls.push({ model: request.model, credential: ctx.credential });
					if (ctx.credential !== undefined) configured = true;
					return {
						vectors: request.input.map(() => new Array(3).fill(0.5)),
					};
				},
			},
		],
	};
}