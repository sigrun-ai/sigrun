/**
 * The provider-contributor contract (spec §3 "Model providers").
 *
 * Extensions may contribute pi-ai `createProvider()` results plus a default
 * model at boot; the core merges all contributions into one `Models` store
 * before `Harness.open()`. Merge semantics are deterministic,
 * **last-registered-wins** on provider-id/model-id collision, and every
 * collision is recorded in a {@link ProviderMergeSink} — never silent — so
 * `GET /v1/meta` (Task 9) can surface it.
 *
 * `SIGRUN_MODEL` overrides any contributor default. When no extension
 * contributes the `openai` provider, the env-driven OpenAI-compat
 * degenerate provider (the design test's three env vars) serves it.
 */

import {
	createModels,
	createProvider,
	type Models,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai/models";
import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelRef } from "@earendil-works/pi-durable";
import { DEFAULT_PROVIDER, parseModelSpec, type Env } from "../../config.js";

/** One provider two or more contributors both claimed; the later one won. */
export interface ProviderCollision {
	readonly kind: "provider";
	/** The provider id that collided. */
	readonly provider: string;
	/** Model ids present in both the previous and the replacing catalog. */
	readonly modelIds: readonly string[];
	/** Contributor name that previously owned the provider. */
	readonly previous: string;
	/** Contributor name whose contribution won (last-registered-wins). */
	readonly contributor: string;
}

/**
 * Where merge collisions land — the sink `GET /v1/meta` reads. Collisions
 * are also mirrored to `console.warn` at collect time so they are never
 * silent even before the meta endpoint exists.
 */
export interface ProviderMergeSink {
	record(collision: ProviderCollision): void;
	readonly collisions: readonly ProviderCollision[];
}

export function createProviderMergeSink(): ProviderMergeSink {
	const collisions: ProviderCollision[] = [];
	return {
		record: (collision) => {
			collisions.push(collision);
			console.warn(
				`provider collision: ${collision.contributor} replaces ${collision.previous} ` +
					`provider "${collision.provider}"` +
					(collision.modelIds.length > 0
						? ` (models: ${collision.modelIds.join(", ")})`
						: ""),
			);
		},
		get collisions() {
			return collisions;
		},
	};
}

/** One provider contribution from one extension. */
export interface ProviderContribution {
	readonly provider: Provider;
	/**
	 * This contributor's proposed default model. Ignored when `SIGRUN_MODEL`
	 * is set; the last contributor to propose one wins otherwise.
	 */
	readonly defaultModel?: ModelRef;
}

/**
 * What a provider-contributor extension provides at boot. Extensions are
 * trusted code (spec §4.4); contributions are used verbatim. Structurally
 * compatible with pi-durable `Extension` objects, which simply contribute
 * nothing here.
 */
export interface ProviderContributor {
	/** Extension name, used in collision records. */
	readonly name: string;
	/** Providers installed in order; omitted by non-contributor extensions. */
	readonly providers?: readonly ProviderContribution[];
	/**
	 * v1 health producer for this surface (spec §3): `"ok"` unless the
	 * contributor knows its backend is degraded. Degenerate implementations
	 * always report `"ok"`.
	 */
	readonly health?: () => "ok" | "degraded";
}

export interface CollectedProviders {
	readonly models: Models;
	/** The boot default model: `SIGRUN_MODEL` if set, else the last contributor default. */
	readonly defaultModel: ModelRef;
}

/** Environment keys the degenerate env provider reads. */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";

/** Fallback when `OPENAI_BASE_URL` is unset: OpenAI's public API. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Conservative defaults for an unknown OpenAI-compat model. Context
 * management (Task 8) tunes its policy against the default model's window;
 * these placeholders keep that deterministic before tuning.
 */
export const DEFAULT_OPENAI_CONTEXT_WINDOW = 128_000;
export const DEFAULT_OPENAI_MAX_TOKENS = 16_384;

/**
 * Merge contributor providers into one `Models` store, then install the
 * env-driven degenerate `openai` provider when no contributor contributed
 * one. Deterministic order: contributors in array order, each provider
 * upserting by id (last-registered-wins), then the env default — a designed
 * fallback, never a collision.
 *
 * @param env raw environment (`process.env`); a set `SIGRUN_MODEL` overrides
 * every contributor default and names the model the env provider serves.
 * @param sink receives collisions; defaults to a fresh sink. Boot passes the
 * sink it returns so `GET /v1/meta` reads the same list.
 *
 * @throws Error naming `SIGRUN_MODEL` when it is unset and no contributor
 * proposed a default model — there would be no boot default at all.
 */
export function collectProviders(
	extensions: readonly ProviderContributor[],
	env: Env,
	sink: ProviderMergeSink = createProviderMergeSink(),
): CollectedProviders {
	const models: MutableModels = createModels();
	let defaultModel: ModelRef | undefined;
	const ownership = new Map<string, string>();

	for (const extension of extensions) {
		for (const contribution of extension.providers ?? []) {
			const provider = contribution.provider;
			const previous = ownership.get(provider.id);
			if (previous !== undefined) {
				const replaced = modelIdsOf(models, provider.id);
				sink.record({
					kind: "provider",
					provider: provider.id,
					// Record every model the replaced provider served, not just the ids the
					// incoming one re-declares — a contributor replacing `{m1,m2}` with `{m2}`
					// silently drops `m1`; meta must surface the full set that changed.
					modelIds: replaced,
					previous,
					contributor: extension.name,
				});
			}
			ownership.set(provider.id, extension.name);
			models.setProvider(provider);
			if (contribution.defaultModel !== undefined) {
				defaultModel = contribution.defaultModel;
			}
		}
	}

	// `SIGRUN_MODEL` overrides any contributor default.
	const envSpec = env.SIGRUN_MODEL?.trim();
	if (envSpec) {
		defaultModel = parseModelSpec(envSpec);
	}

	if (defaultModel === undefined) {
		throw new Error(
			"SIGRUN_MODEL is required when no provider contributor proposes a default model " +
				"(format: provider/model-id, e.g. openai/gpt-4o)",
		);
	}

	// Degenerate fallback: when no extension contributed a provider for the
	// pinned default model's namespace, register the env-driven OpenAI-compat
	// provider there (any namespace), so a zero-extension boot still serves its
	// pin instead of leaving the catalog empty and failing loud at submit.
	if (!models.getProvider(defaultModel.provider)) {
		models.setProvider(
			envDegenerateProvider(env, defaultModel.provider, defaultModel.modelId),
		);
	}

	return { models, defaultModel };
}

function modelIdsOf(models: Models, providerId: string): string[] {
	return models.getModels(providerId).map((model) => model.id);
}

function modelIdsOfProvider(provider: Provider): string[] {
	try {
		return provider.getModels().map((model) => model.id);
	} catch {
		// Best-effort collision detail (matches `Models.getModels` semantics).
		return [];
	}
}

/**
 * The degenerate env-driven OpenAI-compat provider: exactly one model — the
 * id `SIGRUN_MODEL` selected — streamed over `openai-completions`, with auth
 * resolved from `OPENAI_API_KEY`/`OPENAI_BASE_URL` (verified shape, App C:
 * `{ auth: { apiKey, baseUrl } }`). Credentials resolve to `undefined` when
 * the key is absent, so the provider registers unconfigured and requests
 * fail loud instead of boot failing.
 *
 * `cost` is required by the `Model` shape but unknown for an arbitrary
 * gateway model, so it is zeroed; usage tracking stays structural.
 */
export function envDegenerateProvider(
	env: Env,
	providerId: string,
	modelId: string,
): Provider {
	const apiKey = env[OPENAI_API_KEY_ENV]?.trim() || undefined;
	const baseUrl = env[OPENAI_BASE_URL_ENV]?.trim() || DEFAULT_OPENAI_BASE_URL;

	const model: Model<"openai-completions"> = {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: DEFAULT_OPENAI_CONTEXT_WINDOW,
		maxTokens: DEFAULT_OPENAI_MAX_TOKENS,
	};

	return createProvider({
		id: providerId,
		name: `OpenAI-compatible (env, ${providerId})`,
		baseUrl,
		auth: {
			apiKey: {
				name: "OpenAI-compatible API key (OPENAI_API_KEY)",
				resolve: async () =>
					apiKey === undefined
						? undefined
						: { auth: { apiKey, baseUrl }, source: OPENAI_API_KEY_ENV },
			},
		},
		models: [model],
		api: openAICompletionsApi(),
	});
}

/** Error thrown when a referenced model is served by no contributed provider. */
export class UnservedModelError extends Error {
	readonly ref: ModelRef;
	/** Every served `provider/model-id` at the time of the check. */
	readonly available: readonly string[];

	constructor(ref: ModelRef, available: readonly string[]) {
		super(
			`Model ${ref.provider}/${ref.modelId} is not available. Available models: ` +
				`${available.length > 0 ? available.join(", ") : "(none)"}.`,
		);
		this.name = "UnservedModelError";
		this.ref = ref;
		this.available = available;
	}
}

/**
 * Resolve a model reference against the merged catalog, failing loud with
 * the available ids when no contributor serves it — never a silent
 * fallback. Task 9 maps this to the submit-time 4xx; the harness's own
 * generation path fails independently (`no_model`, run unanswered).
 */
export function requireServedModel(models: Models, ref: ModelRef): Model<Api> {
	const model = models.getModel(ref.provider, ref.modelId);
	if (model === undefined) {
		throw new UnservedModelError(ref, listServedModelIds(models));
	}
	return model;
}

/** Every served chat model as `provider/model-id`, in catalog order. */
export function listServedModelIds(models: Models): string[] {
	return models.getModels().map((model) => `${model.provider}/${model.id}`);
}
