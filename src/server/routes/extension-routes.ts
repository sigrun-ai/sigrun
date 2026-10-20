/**
 * Extension HTTP routes (core hardening W5 Task 2, spec §9.2): every
 * `routes` contribution a loaded extension declared, mounted at
 * `/v1/ext/<slug>/<path>` behind a web-standard Request/Response
 * adapter — no Fastify type crosses the extension contract.
 *
 * Mount shape: each extension's routes register inside ONE ENCAPSULATED
 * Fastify plugin scope that parses EVERY content type as a raw buffer —
 * the built-in JSON/text/plain parsers AND the app-level text/plain
 * parser are removed inside the scope, then a `"*"` catch-all buffer
 * parser covers every content type — so the app's core routes keep
 * their own parsers (encapsulation contains the override) and the
 * adapter always sees the raw bytes. `bodyLimit` rides the route
 * options (default 1 MiB, spec §9.2); Fastify's
 * `FST_ERR_CTP_BODY_TOO_LARGE` maps to `413 too_large` through the app
 * error handler.
 *
 * Auth (the §5 pipeline plus the route's declared `auth`):
 * - `public` — the pipeline skips stage 5 (authentication) ONLY: stages
 *   1 (Host/Origin) and 4 (the unclaimed setup gate) still ran, and the
 *   handler verifies its own caller (a webhook signature, an OAuth
 *   `state`). No principal is attached.
 * - `user` — the pipeline authenticates like every other `/v1` route.
 * - `admin` — authenticated AND `principal.admin`, else 403.
 *
 * The adapter builds `new Request(absoluteUrl, {method, headers,
 * body})` — `absoluteUrl` is `server.publicUrl` (`SIGRUN_PUBLIC_URL`)
 * when set, else `http://<Host header>` — and writes the returned
 * `Response`'s status, headers, and body back to the reply. A handler
 * that THROWS or returns a non-`Response` maps to
 * `500 {error: "extension_route_failed", extension}` (logged; the
 * process never crashes). The handler's `Request` body may be read ONCE
 * per the web standard (a second `text()` rejects "Body is unusable");
 * the adapter hands it a fresh `Request` over the buffered body and
 * needs no handling for that.
 */

import type { FastifyInstance } from "fastify";
import type { ExtensionRouteContribution, SigrunHost } from "../../extension.js";
import type { ServerContext } from "../context.js";

/** The default ext-route body ceiling (spec §9.2): 1 MiB. */
export const DEFAULT_EXT_ROUTE_BODY_LIMIT = 1_048_576;

/** Headers the reply owns — forwarding them would fight Fastify's framing. */
const HOP_BY_HOP = new Set(["transfer-encoding", "connection"]);

/**
 * Mount every collected extension route. Called from `createServer`
 * AFTER the auth pipeline (the root-level onRequest hook applies to the
 * encapsulated scopes' routes too); a boot with no route bindings
 * registers nothing.
 */
export function registerExtensionRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, config } = ctx;
	for (const binding of opened.extensionRoutes) {
		// The handler context's `host` is the extension's seam host — the
		// contract's `SigrunHost` seam surface. The conversation/identity/
		// access members land with the host bridge (W5 Task 5 extends
		// SeamHost to the full contract shape); the cast spans that gap
		// without widening this task, and routes that never touch the
		// not-yet-bridged members are unaffected.
		const host = opened.seamHosts.get(binding.extension) as
			| SigrunHost
			| undefined;
		app.register(async (scope) => {
			// Raw bodies for this extension's routes ONLY: the encapsulated
			// scope drops the inherited parsers (the built-ins and whatever
			// the app registered) and installs one catch-all buffer parser —
			// `addContentTypeParser("*")` alone would NOT override them, and
			// a JSON webhook body would arrive pre-parsed.
			scope.removeContentTypeParser("application/json");
			scope.removeContentTypeParser("text/plain");
			scope.addContentTypeParser(
				"*",
				{ parseAs: "buffer" },
				(_request, body, done) => done(null, body),
			);
			for (const route of binding.routes) {
				scope.route({
					method: route.method,
					url: `/v1/ext/${binding.extension}/${route.path}`,
					bodyLimit: route.bodyLimit ?? DEFAULT_EXT_ROUTE_BODY_LIMIT,
					// The auth pipeline's stage-4b read (public skips stage 5).
					config: { extAuth: route.auth },
					handler: async (request, reply) => {
						if (route.auth === "admin" && request.principal?.admin !== true) {
							return await reply.code(403).send({ error: "forbidden" });
						}
						try {
							const base =
								config.publicUrl ??
								`http://${request.headers.host ?? "localhost"}`;
							const incoming = new Request(`${base}${request.url}`, {
								method: request.method,
								headers: request.headers as Record<string, string>,
								// The scope's catch-all parser hands the raw bytes; unknown
								// at the type level (Fastify cannot know the parser shape),
								// and undici accepts a Buffer as BodyInit at runtime.
								...(request.body === undefined
									? {}
									: { body: request.body as BodyInit }),
							});
							const response = await route.handler(incoming, {
								...(request.principal === undefined
									? {}
									: { principal: request.principal }),
								host: host as SigrunHost,
							});
							if (!(response instanceof Response)) {
								throw new Error(
									`returned a non-Response (${typeof response})`,
								);
							}
							reply.code(response.status);
							for (const [name, value] of response.headers) {
								if (HOP_BY_HOP.has(name)) continue;
								reply.header(name, value);
							}
							// set-cookie is the one multi-valued header the
							// spec's iterator joins (information loss); serve
							// each cookie as its own header.
							for (const cookie of response.headers.getSetCookie()) {
								reply.header("set-cookie", cookie);
							}
							const body = Buffer.from(await response.arrayBuffer());
							return await reply.send(body.length > 0 ? body : null);
						} catch (cause) {
							const mounted = `/v1/ext/${binding.extension}/${route.path}`;
							console.warn(
								`extension route failed: ${binding.extension} ${request.method} ${mounted}: ${
									cause instanceof Error ? cause.message : String(cause)
								}`,
							);
							return await reply.code(500).send({
								error: "extension_route_failed",
								extension: binding.extension,
							});
						}
					},
				});
			}
		});
	}
}
