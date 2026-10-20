/**
 * Provider surface routes: `GET /v1/models` (the merged chat-model
 * catalog as picker entries — no provider internals: baseUrl, headers,
 * and auth stay server-side) and `GET /v1/providers` (the secret-free
 * per-provider readiness report, spec §6.4/§7.6).
 *
 * Core hardening W1 Task 6 (spec §5.7): the readiness report MOVED here
 * from `/v1/auth/check` so `/v1/auth` is API auth only — the old path
 * serves the identical body as a deprecated alias for one release,
 * marking its responses with a `Deprecation: true` header.
 *
 * Core hardening W3 Task 6 (spec §7.6) adds the MUTATIONS: `POST
 * /v1/providers/:id/refresh` (one bounded refresh, the entry back),
 * `PUT /v1/providers/:id/credential {apiKey}` (admin) and `DELETE …
 * /credential` (admin) — writes through `opened.auth` (the bridge stays
 * read-only; the ROUTE is the writer), then ONE refresh, then the entry.
 * Restart-free by the credential-precedence design: the auth bridge
 * resolves auth.json per use, so the same in-process catalog picks the
 * new key up on the next refresh — no provider restart, no re-boot.
 */

import type { FastifyInstance } from "fastify";
import type { OpenedHarness } from "../../harness/boot.js";
import { DEFAULT_AUTH_KEY } from "../../harness/auth.js";
import type { ServerContext } from "../context.js";
import { providerAuthStatus } from "../helpers.js";
import type {
	AuthCheckProvider,
	AuthCheckResponse,
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
/** The per-request index of `opened.providerHealth` producers by name. */
function producersIndex(
	opened: OpenedHarness,
): ReadonlyMap<
	string,
	{ readonly name: string; readonly health: () => "ok" | "degraded" }
> {
	return new Map(
		opened.providerHealth.map((producer) => [producer.name, producer]),
	);
}

/**
 * One provider's report entry: the readiness derivation PLUS the W3
 * Task 6 enrichment (spec §7.6) — the catalog `models` count
 * (`models.getModels(id)`, pi-ai's best-effort count) and the owning
 * contributor `owner` from the collector's ownership map (absent for
 * the env-degenerate provider). The same entry serves every provider
 * route: the report, the refresh response, and the credential
 * write/delete responses — one shape, never two.
 */
function readinessEntry(
	opened: OpenedHarness,
	providerId: string,
	producersByName: ReadonlyMap<
		string,
		{ readonly name: string; readonly health: () => "ok" | "degraded" }
	>,
): AuthCheckProvider {
	const { status, detail } = providerAuthStatus(
		opened,
		providerId,
		producersByName,
	);
	const owner = opened.providerOwnership.get(providerId);
	return {
		provider: providerId,
		status,
		models: opened.models.getModels(providerId).length,
		...(owner === undefined ? {} : { owner }),
		...(detail === undefined ? {} : { detail }),
	};
}

function providerReadinessReport(
	opened: OpenedHarness,
): ProvidersResponse {
	// W2 Task 8's reconciliation: the per-provider derivation lives in ONE
	// place — `providerAuthStatus` (helpers.ts, shared with the
	// `sigrun_provider_ready{provider,status}` metric) — so this report and
	// the metrics exposition can never drift. The response shape is W1's
	// `/v1/providers` + deprecated-`/v1/auth/check` body plus the W3 Task 6
	// enrichment (`models`, `owner`).
	const producersByName = producersIndex(opened);
	const providers: AuthCheckProvider[] = [];
	for (const { id: providerId } of opened.models.getProviders()) {
		providers.push(readinessEntry(opened, providerId, producersByName));
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

	// The `:id` prelude shared by every mutation route: the provider must
	// exist in the catalog (`getProviders()` is the enumeration the report
	// serves, so the 404 vocabulary matches it). Key material never
	// appears in any of these routes — statuses and counts only.
	const isKnownProvider = (providerId: string): boolean =>
		opened.models.getProvider(providerId) !== undefined;

	// One bounded refresh of the named provider (W3 Task 6, spec §7.6):
	// the SAME policy the boot/interval/refresh-on-miss paths run — bounded
	// by the deadline, failures warned (never the route's error), a
	// flipped provider publishes `providers.changed`. Not admin-gated
	// (spec §7.6 gates the credential writes only).
	app.post("/v1/providers/:id/refresh", async (request, reply) => {
		const { id } = request.params as { id: string };
		if (!isKnownProvider(id)) {
			return await reply.code(404).send({ error: "provider_not_found" });
		}
		await opened.refreshProvider(id);
		return readinessEntry(opened, id, producersIndex(opened));
	});

	// The auth.json key a credential write targets (spec §7.6): the magic
	// `"default"` for the DEFAULT model's provider (the precedence fix
	// makes that the winning key for exactly that provider), the
	// provider's own id otherwise.
	const credentialKey = (providerId: string): string =>
		providerId === opened.defaultModel.provider
			? DEFAULT_AUTH_KEY
			: providerId;

	// Write the provider's credential (admin): store write → one refresh
	// (the bridge resolves per use, so the new key is live with NO restart)
	// → the entry. The body is `{apiKey: string}` — a non-empty string,
	// nothing else (errors name the field, never the value).
	app.put("/v1/providers/:id/credential", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const { id } = request.params as { id: string };
		if (!isKnownProvider(id)) {
			return await reply.code(404).send({ error: "provider_not_found" });
		}
		const body = request.body;
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body)
		) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const apiKey = (body as Record<string, unknown>).apiKey;
		if (typeof apiKey !== "string" || apiKey === "") {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: "apiKey" });
		}
		await opened.auth.setApiKey(credentialKey(id), apiKey);
		await opened.refreshProvider(id);
		return readinessEntry(opened, id, producersIndex(opened));
	});

	// Remove the provider's credential (admin): store delete of that SAME
	// key → one refresh → the entry. Restart-free the same way — the
	// tracker re-seeds `not_configured` on the refresh's auth resolution.
	app.delete("/v1/providers/:id/credential", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const { id } = request.params as { id: string };
		if (!isKnownProvider(id)) {
			return await reply.code(404).send({ error: "provider_not_found" });
		}
		await opened.auth.deleteApiKey(credentialKey(id));
		await opened.refreshProvider(id);
		return readinessEntry(opened, id, producersIndex(opened));
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
