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
import type { Locality } from "../../harness/locality.js";
import { listModels, providerAuthStatus } from "../helpers.js";
import type {
	AuthCheckProvider,
	AuthStatus,
	AuthCheckResponse,
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
		local: opened.locality.isLocalExtension(owner ?? "core"),
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
	// A stored credential (the id's own auth.json entry, or the magic
	// "default" entry the credential route writes for the default chat
	// provider's id) is POSITIVE evidence a provider is configured — a
	// readiness tracker that has not seen a call yet cannot know it. Rows
	// whose tracker still says not_configured while a key IS stored render
	// honestly: ready, with a note that the first call confirms it (the
	// tracker flips on its own evidence at the first authenticated call).
	const hasStoredCredential = (id: string): boolean => {
		const file = opened.auth.read();
		return file[id]?.apiKey !== undefined
			|| (id === opened.defaultModel.provider
					&& file[DEFAULT_AUTH_KEY]?.apiKey !== undefined);
	};
	const credentialAware = <T extends { readonly provider: string; readonly status: AuthStatus; readonly detail?: string }>(
		entry: T,
	): T => {
		if (entry.status !== "not_configured" || !hasStoredCredential(entry.provider)) return entry;
		return {
			...entry,
			status: "ready",
			detail: "credential saved; the first call verifies it",
		};
	};
	const providers: AuthCheckProvider[] = [];
	for (const { id: providerId } of opened.models.getProviders()) {
		providers.push(credentialAware(readinessEntry(opened, providerId, producersByName)));
	}
	// Warden Task 7: decision providers append as their own entries
	// (`kind: "decision"`, the model ids listed) — a decision provider
	// whose id collides with a chat provider stays SEPARATE (distinct
	// kinds, never merged).
	for (const decision of opened.decisions.providers()) {
		providers.push(credentialAware(decisionEntry(decision, opened.locality)));
	}
	for (const embedding of opened.embeddings.providers()) {
		providers.push(credentialAware(embeddingEntry(embedding, opened.locality)));
	}
	return { providers };
}

/**
 * One decision provider's report entry (warden Task 7): the registry
 * row projected onto the shared entry shape — `models` the count,
 * `modelIds` the bare ids, `owner` the contributing extension.
 */
function decisionEntry(decision: {
	id: string;
	extension: string;
	models: readonly string[];
	status: AuthCheckProvider["status"];
}, locality: Locality): AuthCheckProvider {
	return {
		provider: decision.id,
		kind: "decision",
		status: decision.status,
		models: decision.models.length,
		modelIds: decision.models,
		owner: decision.extension,
		local: locality.isLocalExtension(decision.extension),
	};
}

function embeddingEntry(embedding: {
	id: string;
	extension: string;
	models: readonly string[];
	status: AuthCheckProvider["status"];
}, locality: Locality): AuthCheckProvider {
	return {
		provider: embedding.id,
		kind: "embedding",
		status: embedding.status,
		models: embedding.models.length,
		modelIds: embedding.models,
		owner: embedding.extension,
		local: locality.isLocalExtension(embedding.extension),
	};
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

	// Warden Task 7: a DECISION-only provider id is equally routable (the
	// registry enumerates its ids). The mutation bodies branch on the
	// kind: chat ids refresh, decision ids re-read — the registry
	// derives readiness per call, so a credential write is visible
	// without a refresh (and the decision seam has no catalog leg to
	// refresh).
	const isDecisionProvider = (providerId: string): boolean =>
		opened.decisions.providers().some((row) => row.id === providerId);
	const isEmbeddingProvider = (providerId: string): boolean =>
		opened.embeddings.providers().some((row) => row.id === providerId);
	const isRoutableProvider = (providerId: string): boolean =>
		isKnownProvider(providerId) || isDecisionProvider(providerId) || isEmbeddingProvider(providerId);
	// Embedding-providers Task 3: decision- or embedding-only ids use
	// their id verbatim; the magic key names the default CHAT provider.
	// The entry back prefers chat, then decision, then embedding.
	const routableEntry = (providerId: string): AuthCheckProvider => {
		if (isKnownProvider(providerId)) {
			return readinessEntry(opened, providerId, producersIndex(opened));
		}
		const decision = opened.decisions
			.providers()
			.find((row) => row.id === providerId);
		if (decision !== undefined) return decisionEntry(decision, opened.locality);
		const embedding = opened.embeddings
			.providers()
			.find((row) => row.id === providerId);
		if (embedding !== undefined) return embeddingEntry(embedding, opened.locality);
		throw new Error(`provider "${providerId}" is not routable`);
	};
	// The post-write refresh: chat ids only.
	const refreshAfterWrite = async (providerId: string): Promise<void> => {
		if (isKnownProvider(providerId)) await opened.refreshProvider(providerId);
	};

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
		if (!isRoutableProvider(id)) {
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
		// The credential key: chat ids redirect the DEFAULT provider's id
		// to the magic "default" key; non-chat ids use their own id.
		const key = isKnownProvider(id) ? credentialKey(id) : id;
		await opened.auth.setApiKey(key, apiKey);
		await refreshAfterWrite(id);
		return routableEntry(id);
	});

	// Remove the provider's credential (admin): store delete of that SAME
	// key → one refresh → the entry. Restart-free the same way — the
	// tracker re-seeds `not_configured` on the refresh's auth resolution.
	app.delete("/v1/providers/:id/credential", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const { id } = request.params as { id: string };
		if (!isRoutableProvider(id)) {
			return await reply.code(404).send({ error: "provider_not_found" });
		}
		const key = isKnownProvider(id) ? credentialKey(id) : id;
		await opened.auth.deleteApiKey(key);
		await refreshAfterWrite(id);
		return routableEntry(id);
	});

	// Settings split Plan 2 Task 2: the ONE locality switch — admin,
	// per provider EXTENSION slug (pseudo-slug `core` covers an env-driven
	// served provider, whose ownership map entry is absent). Writes sorted
	// unique `localProviders` through the store (its onWrite observer
	// publishes settings.changed on exactly that key).
	app.put("/v1/providers/local/:extension", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const { extension } = request.params as { extension: string };
		const owners = new Set<string>();
		for (const { id } of opened.models.getProviders()) {
			owners.add(opened.providerOwnership.get(id) ?? "core");
		}
		for (const row of opened.decisions.providers()) owners.add(row.extension);
		for (const row of opened.embeddings.providers()) owners.add(row.extension);
		if (!owners.has(extension)) {
			return await reply.code(404).send({ error: "provider_not_found" });
		}
		const body = request.body as unknown;
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const local = (body as { local?: unknown }).local;
		if (typeof local !== "boolean") {
			return await reply.code(400).send({ error: "invalid_field", field: "local" });
		}
		const current = new Set(opened.settings.read().localProviders ?? []);
		if (local) current.add(extension);
		else current.delete(extension);
		opened.settings.apply({ localProviders: [...current].sort() });
		return { local };
	});

	// Models: the merged chat-model catalog as picker entries (no provider
	// internals — baseUrl/headers/auth stay server-side). The shared
	// construction (gateway C4b): the host's `models.list()` serves the
	// SAME list through helpers.listModels.
	app.get("/v1/models", async (): Promise<ModelsResponse> => {
		return { models: listModels(opened) };
	});
}
