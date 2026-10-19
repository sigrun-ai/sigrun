/**
 * Provider surface routes: `GET /v1/models` (the merged chat-model
 * catalog as picker entries — no provider internals: baseUrl, headers,
 * and auth stay server-side) and `GET /v1/providers` (the secret-free
 * per-provider auth readiness report, spec §6.4/§7.6).
 *
 * Core hardening W1 Task 6 (spec §5.7): the readiness report MOVED here
 * from `/v1/auth/check` so `/v1/auth` is API auth only — the old path
 * serves the identical body as a deprecated alias for one release,
 * marking its responses with a `Deprecation: true` header.
 */

import type { FastifyInstance } from "fastify";
import { DEFAULT_AUTH_KEY } from "../../harness/auth.js";
import { OPENAI_API_KEY_ENV } from "../../harness/providers/index.js";
import type { OpenedHarness } from "../../harness/boot.js";
import type { ServerContext } from "../context.js";
import type {
	AuthCheckProvider,
	AuthCheckResponse,
	AuthStatus,
	ModelEntry,
	ModelsResponse,
	ProvidersResponse,
} from "../views.js";

/**
 * The per-provider readiness report (the shared derivation BOTH routes
 * serve — one body, never two). The response carries ONLY a per-provider
 * status (+ optional tracker detail) — no env values, no key material, no
 * hints beyond the status itself (spec §6.4: "The API never accepts or
 * returns credentials"). The status is a pure synchronous derivation over
 * boot-retained state (same discipline as /v1/meta), per provider in
 * catalog order (enumeration is over PROVIDERS — `getProviders()` — not
 * models, so an empty-catalog boot contribution still appears):
 *
 *  1. readiness tracker registered by the owning contributor
 *     (`contribution.readiness`): reported verbatim — the three-state
 *     vocabulary `not_configured` (no credential resolved — an
 *     unconfigured optional plugin, not a degraded process) |
 *     `degraded` (configured, last refresh failed) | `ready` (refresh
 *     succeeded / static catalog), plus its optional `detail`.
 *  2. contributor-owned WITHOUT a tracker: the legacy producer mapping
 *     is preserved — "ok" → `ready`, "degraded" → `invalid` (the §3
 *     union is exactly ok | degraded; "degraded" is the known-bad
 *     signal). A producer is per-contributor, not per-provider, so
 *     every provider a contributor owns shares its status. No producer
 *     → `not_ready` (nothing to verify).
 *  3. env-degenerate provider (no contributor owns it — the collector's
 *     ownership map has no entry): the legacy env-presence mapping is
 *     preserved — `ready` iff a key resolves (`auth.json` `"default"`
 *     or the provider's own entry, or a non-empty `OPENAI_API_KEY` in
 *     the boot-retained provider env), else `not_ready`. (The
 *     degenerate provider reports §3 health "ok" by absence, so key
 *     presence is the honest readiness check for it; the three-state
 *     vocabulary applies to plugin trackers only.)
 */
function providerReadinessReport(
	opened: OpenedHarness,
): ProvidersResponse {
	const producersByName = new Map(
		opened.providerHealth.map((producer) => [producer.name, producer]),
	);
	const providers: AuthCheckProvider[] = [];
	for (const { id: providerId } of opened.models.getProviders()) {
		let status: AuthStatus;
		let detail: string | undefined;
		const tracker = opened.providerReadiness.get(providerId);
		if (tracker !== undefined) {
			// Priority 1: the owning contributor's three-state tracker,
			// consulted per request (plugin-owned state — never a boot
			// snapshot).
			const readiness = tracker();
			status = readiness.status;
			detail = readiness.detail;
		} else {
			const owner = opened.providerOwnership.get(providerId);
			if (owner !== undefined) {
				// Priority 2: legacy producer mapping, preserved for
				// tracker-less contributors.
				const producer = producersByName.get(owner);
				status =
						producer === undefined
							? "not_ready"
							: producer.health() === "ok"
								? "ready"
								: "invalid";
			} else {
				// Priority 3: ruling 6 — the degenerate provider's key resolves
				// auth.json (the "default" magic key or the provider's own
				// entry) BEFORE the OPENAI_API_KEY env fallback. Presence
				// only — key material never leaves the store. A malformed
				// auth file marks the provider not_ready rather than failing
				// the route (boot-time fail-loud covers the genuinely-broken
				// deploy).
				let storedKey = false;
				try {
					const authFile = opened.auth.read();
					storedKey =
							authFile[DEFAULT_AUTH_KEY]?.apiKey !== undefined ||
							authFile[providerId]?.apiKey !== undefined;
				} catch {
					storedKey = false;
				}
				status =
					storedKey ||
					(opened.providerEnv[OPENAI_API_KEY_ENV] ?? "").trim() !== ""
						? "ready"
						: "not_ready";
			}
		}
		providers.push(
			detail === undefined
				? { provider: providerId, status }
				: { provider: providerId, status, detail },
		);
	}
	return { providers };
}

/** Register the model-catalog and provider-readiness routes. */
export function registerProviderRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;

	// The readiness home (spec §5.7/§7.6): the secret-free per-provider
	// report, served from the one shared derivation above.
	app.get("/v1/providers", async (): Promise<ProvidersResponse> => {
		return providerReadinessReport(opened);
	});

	// The deprecated alias (spec §5.7: "The old path stays as a deprecated
	// alias for one release"): the identical body plus the RFC 8594-style
	// `Deprecation` header so clients can see the move on the wire.
	app.get(
		"/v1/auth/check",
		async (_request, reply): Promise<AuthCheckResponse> => {
			reply.header("Deprecation", "true");
			return providerReadinessReport(opened);
		},
	);

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
