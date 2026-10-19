/**
 * Provider surface routes: `GET /v1/models` (the merged chat-model
 * catalog as picker entries — no provider internals: baseUrl, headers,
 * and auth stay server-side) and `GET /v1/auth/check` (the secret-free
 * per-provider auth readiness report, spec §6.4).
 */

import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { providerAuthStatus } from "../helpers.js";
import type {
	AuthCheckProvider,
	AuthCheckResponse,
	ModelEntry,
	ModelsResponse,
} from "../views.js";

/** Register the model-catalog and auth-readiness routes. */
export function registerProviderRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;

	// Auth readiness (spec §6.4: "The API never accepts or returns
	// credentials"): a SECRET-FREE report. The response carries ONLY a
	// per-provider status (+ optional tracker detail) — no env values, no
	// key material, no hints beyond the status itself. The derivation is
	// `providerAuthStatus` (helpers.ts — shared with W2 Task 8's
	// `sigrun_provider_ready`), consulted per request over boot-retained
	// state, per provider in catalog order (enumeration is over PROVIDERS —
	// `getProviders()` — not models, so an empty-catalog boot contribution
	// still appears).
	app.get("/v1/auth/check", async (): Promise<AuthCheckResponse> => {
		const producersByName = new Map(
			opened.providerHealth.map((producer) => [producer.name, producer]),
		);
		const providers: AuthCheckProvider[] = [];
		for (const { id: providerId } of opened.models.getProviders()) {
			const { status, detail } = providerAuthStatus(
				opened,
				providerId,
				producersByName,
			);
			providers.push(
				detail === undefined
					? { provider: providerId, status }
					: { provider: providerId, status, detail },
			);
		}
		return { providers };
	});

	// Models: the merged chat-model catalog as picker entries (no provider
	// internals — baseUrl/headers/auth stay server-side).
	app.get("/v1/models", async (): Promise<ModelsResponse> => {
		const models: ModelEntry[] = opened.models.getModels().map((model) => ({
			id: `${model.provider}/${model.id}`,
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: model.input,
			// Project the four rate fields explicitly (ModelCostRates); `tiers` is
			// dropped for v1 (the picker doesn't use them) — no unsound cast.
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
		}));
		return { models };
	});
}
