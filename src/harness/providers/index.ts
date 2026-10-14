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
 * `SIGRUN_DEFAULT_MODEL` (or the file's `defaultModel`) overrides any
 * contributor default. When no extension contributes a provider for the
 * pinned namespace, the env-driven OpenAI-compat degenerate provider
 * serves it — its credentials resolve from `auth.json` (the `"default"`
 * key, or the resolved provider's own entry) with `OPENAI_API_KEY` as
 * the compat fallback. Each contributor's §3 `health()` producer is
 * retained on the collected result for the §5 meta `health.providers`
 * aggregation (Task 9e); the degenerate provider reports `"ok"` by
 * absence.
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
import { AuthStore, DEFAULT_AUTH_KEY } from "../auth.js";
import type { HealthProducer, HealthStatus } from "../health.js";

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
	 * This contributor's proposed default model. Ignored when the default
	 * model is configured (`SIGRUN_DEFAULT_MODEL` env or the file's
	 * `defaultModel`); the last contributor to propose one wins otherwise.
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
	 * report `"ok"` — omitting the producer entirely is the same convention
	 * (degenerate ok by absence).
	 */
	readonly health?: () => HealthStatus;
}

export interface CollectedProviders {
	readonly models: Models;
	/** The boot default model: the configured one (env/file) if set, else the last contributor default. */
	readonly defaultModel: ModelRef;
	/**
	 * §3 health producers from contributors that define one (spec §5):
	 * `GET /v1/meta` aggregates them into `health.providers` — any
	 * `"degraded"` degrades the surface. The env-driven degenerate provider
	 * reports `"ok"` by absence: no synthetic producer is added for it.
	 */
	readonly healthProducers: readonly HealthProducer[];
	/**
	 * Provider id → owning contributor name (Task 6): every provider a
	 * contributor registered, keyed by `ProviderContribution.provider.id`.
	 * Providers installed by the env-driven degenerate fallback have NO
	 * entry — the discriminator `GET /v1/auth/check` uses to pick
	 * env-presence readiness (degenerate) over producer-status readiness
	 * (contributor-owned).
	 */
	readonly providerOwnership: ReadonlyMap<string, string>;
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
 * @param env raw environment (`process.env`); a set `SIGRUN_DEFAULT_MODEL`
 * overrides every contributor default and names the model the env provider
 * serves.
 * @param sink receives collisions; defaults to a fresh sink. Boot passes the
 * sink it returns so `GET /v1/meta` reads the same list.
 *
 * @throws Error naming `SIGRUN_DEFAULT_MODEL` when no default model is
 * configured and no contributor proposed one — there would be no boot
 * default at all.
 */
export function collectProviders(
	extensions: readonly ProviderContributor[],
	env: Env,
	sink: ProviderMergeSink = createProviderMergeSink(),
	options?: {
		readonly auth?: AuthStore;
		readonly baseUrl?: string;
	},
): CollectedProviders {
	const models: MutableModels = createModels();
	let defaultModel: ModelRef | undefined;
	const ownership = new Map<string, string>();
	const healthProducers: HealthProducer[] = [];

	for (const extension of extensions) {
		// §3 producers are collected from every contributor that defines one,
		// independent of its provider contributions (a health-only contributor
		// still reports its surface's health).
		if (extension.health !== undefined) {
			healthProducers.push({
				name: extension.name,
				health: extension.health,
			});
		}
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

	// A configured default model (env `SIGRUN_DEFAULT_MODEL` / deprecated
	// alias `SIGRUN_MODEL`, or the file's `defaultModel` — the caller
	// restates the resolution into the env seam) overrides any contributor
	// default.
	const envSpec =
		env.SIGRUN_DEFAULT_MODEL?.trim() || env.SIGRUN_MODEL?.trim();
	if (envSpec) {
		defaultModel = parseModelSpec(envSpec);
	}

	if (defaultModel === undefined) {
		throw new Error(
			"SIGRUN_DEFAULT_MODEL or settings.json defaultModel is required when no provider contributor proposes a default model " +
				"(format: provider/model-id, e.g. openai/gpt-4o)",
		);
	}

	// Degenerate fallback: when no extension contributed a provider for the
	// pinned default model's namespace, register the env-driven OpenAI-compat
	// provider there (any namespace), so a zero-extension boot still serves its
	// pin instead of leaving the catalog empty and failing loud at submit.
	if (!models.getProvider(defaultModel.provider)) {
		models.setProvider(
			envDegenerateProvider(
				env,
				defaultModel.provider,
				defaultModel.modelId,
				options,
			),
		);
	}

	return {
		models,
		defaultModel,
		healthProducers,
		providerOwnership: ownership,
	};
}

/**
 * Resolve the env-driven degenerate provider's API key (ruling 6). Order:
 * auth.json `"default".apiKey`, then the resolved provider's own auth.json
 * entry, then the `OPENAI_API_KEY` env var (compat fallback, still
 * honored). Key material is never logged — this function returns it
 * opaquely.
 */
function resolveDegenerateApiKey(
	env: Env,
	providerId: string,
	auth?: AuthStore,
): string | undefined {
	if (auth !== undefined) {
		const file = auth.read();
		const fromDefault = file[DEFAULT_AUTH_KEY]?.apiKey;
		if (fromDefault !== undefined) return fromDefault;
		const fromProvider = file[providerId]?.apiKey;
		if (fromProvider !== undefined) return fromProvider;
	}
	return env[OPENAI_API_KEY_ENV]?.trim() || undefined;
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
 * id the default-model spec selected — streamed over `openai-completions`,
 * with auth resolved from `auth.json` (`"default"` key or the provider's
 * own entry) falling back to `OPENAI_API_KEY`, and the endpoint from
 * `OPENAI_BASE_URL` over `options.baseUrl` (the file's
 * `defaultProvider.baseUrl`, projected by `openHarness`) over the OpenAI
 * public default (verified shape, App C: `{ auth: { apiKey, baseUrl } }`).
 * Credentials resolve to `undefined` when no key exists anywhere, so the
 * provider registers unconfigured and requests fail loud instead of boot
 * failing.
 *
 * `cost` is required by the `Model` shape but unknown for an arbitrary
 * gateway model, so it is zeroed; usage tracking stays structural.
 */
export function envDegenerateProvider(
	env: Env,
	providerId: string,
	modelId: string,
	options?: {
		readonly auth?: AuthStore;
		readonly baseUrl?: string;
	},
): Provider {
	const apiKey = resolveDegenerateApiKey(env, providerId, options?.auth);
	const baseUrl =
		env[OPENAI_BASE_URL_ENV]?.trim() ||
		options?.baseUrl ||
		DEFAULT_OPENAI_BASE_URL;

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
				name: "OpenAI-compatible API key (auth.json or OPENAI_API_KEY)",
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
