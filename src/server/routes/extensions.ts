/**
 * Extension settings/secrets routes (core hardening W3 Task 7, spec
 * §7.7): the operator surface over the loaded extension set.
 *
 * - `GET /v1/extensions` — one entry per loaded outcome with `status`,
 *   `error?`, the manifest `version?`, the declared
 *   `interactionKinds`/`ambientKeys`, and the idle-worker projection.
 * - `GET`/`PUT /v1/extensions/:slug/settings` (PUT admin) — the
 *   `settings/<slug>.json` object verbatim. Values an extension reads at
 *   factory time apply at RESTART; per-run reads see the write live.
 * - `GET /v1/extensions/:slug/secrets` — `{secrets: [{key, source}]}`:
 *   stored keys plus the `SIGRUN_EXT_<SLUG>_` env fallbacks that are not
 *   stored. VALUES ARE NEVER RETURNED by any route here — the API lists
 *   and writes secrets, never reads them back.
 * - `PUT`/`DELETE /v1/extensions/:slug/secrets/:key` (admin).
 *
 * Every `:slug` route 404s `extension_not_found` when the slug is not
 * among the loaded outcomes (the same list `GET /v1/meta` reports).
 */

import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { BUILTIN_EXTENSIONS } from "../../harness/builtins.js";
import type {
	ExtensionInfo,
	ExtensionsResponse,
	ExtensionSecretsResponse,
} from "../views.js";

/** Register the extension settings/secrets routes. */
export function registerExtensionRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;

	// The loaded-outcome lookup every :slug route gates on: ok outcomes
	// carry the slug; quarantined outcomes carry the display specifier —
	// both are "among the loaded outcomes" for the 404 rule.
	const isKnownSlug = (slug: string): boolean =>
		opened.extensionOutcomes.some((outcome) => outcome.name === slug);

	// The inventory: outcomes + declared kinds + workers + routes, one
	// entry per configured extension, in load order. Pure synchronous
	// derivations over boot-retained state (the /v1/meta discipline) — a
	// client may cache it per boot. Built-in extensions (Task 2) carry
	// `builtin: true` from their outcomes; a REPLACED built-in (a
	// configured extension resolved to the same package name) appends a
	// row here — `builtin: true`, `replacedBy` the configured specifier,
	// status "replaced" — while a DISABLED one is absent entirely
	// (ruling 6).
	app.get("/v1/extensions", async (): Promise<ExtensionsResponse> => {
		const workerStatuses = opened.workerStatuses();
		const extensions: ExtensionInfo[] = opened.extensionOutcomes.map(
			(outcome) => {
				const kinds = opened.seamKinds.get(outcome.name);
				const workers = workerStatuses.get(outcome.name);
				const routes = opened.extensionRoutes.find(
					(binding) => binding.extension === outcome.name,
				);
				return {
					name: outcome.name,
					status: outcome.status,
					...(outcome.error === undefined ? {} : { error: outcome.error }),
					...(outcome.version === undefined
						? {}
						: { version: outcome.version }),
					...(outcome.builtin === true ? { builtin: true } : {}),
					interactionKinds: [...(kinds?.interaction ?? [])],
					ambientKeys: [...(kinds?.ambient ?? [])],
					workers: workers ?? [],
					routes:
						routes?.routes.map((route) => ({
							method: route.method,
							path: route.path,
							auth: route.auth,
						})) ?? [],
				};
			},
		);
		// Replaced built-ins (Task 2 ruling 5): one row each, under the slug
		// the built-in itself would have loaded under (`BUILTIN_EXTENSIONS
		// .slug` — the declared extension name's slug, e.g. `sigrun-mcp` for
		// the package `@sigrun/ext-mcp`), appended after the loaded set.
		for (const skipped of opened.builtinSkipped) {
			if (skipped.reason !== "replaced") continue;
			const slug = BUILTIN_EXTENSIONS.find(
				(builtin) => builtin.key === skipped.key,
			)?.slug;
			if (slug === undefined) continue;
			extensions.push({
				name: slug,
				status: "replaced",
				builtin: true,
				...(skipped.by === undefined ? {} : { replacedBy: skipped.by }),
				interactionKinds: [],
				ambientKeys: [],
				workers: [],
				routes: [],
			});
		}
		return { extensions };
	});

	// The per-extension settings object (`settings/<slug>.json`), absent
	// file → `{}`. GET is ungated beyond the pipeline: settings values are
	// operator-facing config, not secrets.
	app.get(
		"/v1/extensions/:slug/settings",
		async (request, reply): Promise<Record<string, unknown>> => {
			const { slug } = request.params as { slug: string };
			if (!isKnownSlug(slug)) {
				return await reply.code(404).send({ error: "extension_not_found" });
			}
			return opened.extensionStores.settingsFor(slug).get();
		},
	);

	// Replace the settings object VERBATIM (admin — a settings file is
	// code-adjacent input the extension consumes). The body must be a
	// JSON object; arrays/scalars are 400 (the PATCH /v1/settings
	// vocabulary). The write lands live for per-run reads; a
	// factory-time reader applies it at restart.
	app.put(
		"/v1/extensions/:slug/settings",
		async (request, reply): Promise<Record<string, unknown>> => {
			if (!request.principal.admin) {
				return await reply.code(403).send({ error: "forbidden" });
			}
			const { slug } = request.params as { slug: string };
			if (!isKnownSlug(slug)) {
				return await reply.code(404).send({ error: "extension_not_found" });
			}
			const body = request.body;
			if (
				typeof body !== "object" ||
				body === null ||
				Array.isArray(body)
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const value = body as Record<string, unknown>;
			await opened.extensionStores.settingsFor(slug).set(value);
			return value;
		},
	);

	// The secret key list: stored keys plus the env fallbacks that are not
	// stored. Key names and sources only — the response never carries a
	// value, and the store surface has no value-returning read at all.
	app.get(
		"/v1/extensions/:slug/secrets",
		async (request, reply): Promise<ExtensionSecretsResponse> => {
			const { slug } = request.params as { slug: string };
			if (!isKnownSlug(slug)) {
				return await reply.code(404).send({ error: "extension_not_found" });
			}
			return { secrets: await opened.extensionStores.secretKeys(slug) };
		},
	);

	// Set one secret (admin): `{value: string}` — a non-empty string,
	// nothing else (errors name the field, never the value). Returns the
	// updated key list so the UI refreshes in one round-trip. The stored
	// write takes precedence over any env twin from the next read on —
	// the same `resolveSecretFor` rule the listing reports.
	app.put(
		"/v1/extensions/:slug/secrets/:key",
		async (request, reply): Promise<ExtensionSecretsResponse> => {
			if (!request.principal.admin) {
				return await reply.code(403).send({ error: "forbidden" });
			}
			const { slug, key } = request.params as { slug: string; key: string };
			if (!isKnownSlug(slug)) {
				return await reply.code(404).send({ error: "extension_not_found" });
			}
			const body = request.body;
			if (
				typeof body !== "object" ||
				body === null ||
				Array.isArray(body) ||
				typeof (body as Record<string, unknown>).value !== "string" ||
				(body as Record<string, unknown>).value === ""
			) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "value" });
			}
			const { value } = body as { value: string };
			await opened.extensionStores.setSecret(slug, key, value);
			return { secrets: await opened.extensionStores.secretKeys(slug) };
		},
	);

	// Delete one secret (admin): an idempotent section-key removal —
	// deleting an absent key is a no-op success, and an env-sourced key
	// has nothing stored to delete (the env var is the deploy's).
	app.delete(
		"/v1/extensions/:slug/secrets/:key",
		async (request, reply): Promise<ExtensionSecretsResponse> => {
			if (!request.principal.admin) {
				return await reply.code(403).send({ error: "forbidden" });
			}
			const { slug, key } = request.params as { slug: string; key: string };
			if (!isKnownSlug(slug)) {
				return await reply.code(404).send({ error: "extension_not_found" });
			}
			await opened.extensionStores.deleteSecret(slug, key);
			return { secrets: await opened.extensionStores.secretKeys(slug) };
		},
	);
}
