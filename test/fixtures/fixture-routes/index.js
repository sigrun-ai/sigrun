/**
 * Test-fixture extension package (core hardening W5 Task 2 — extension
 * HTTP routes): declares the five routes the adapter tests target —
 * `ping` (user), `hook` (public), `boom` (user, throws), `bad` (user,
 * returns a non-Response), `admin-only` (admin, 204).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * fixture-jobs pattern). Contract: the default export is an arity-1
 * factory returning `{ extension, routes }` — the `routes` field is the
 * W5 Task 2 factory-result contract. The `hook` handler echoes the
 * request body as the response body and the absolute request URL
 * through the `x-request-url` response header (the adapter's base-URL
 * pin); everything else uses web-standard `Response` only.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureRoutes(host) {
	void host;
	return {
		extension: defineExtension({ name: "fixture-routes" }),
		routes: [
			{
				method: "GET",
				path: "ping",
				auth: "user",
				handler: async (_request, ctx) =>
					Response.json({ user: ctx.principal?.user }),
			},
			{
				method: "POST",
				path: "hook",
				auth: "public",
				handler: async (request) =>
					new Response(await request.text(), {
						status: 200,
						headers: {
							"content-type": "text/plain",
							"x-request-url": request.url,
						},
					}),
			},
			{
				method: "GET",
				path: "boom",
				auth: "user",
				handler: async () => {
					throw new Error("fixture boom");
				},
			},
			{
				method: "GET",
				path: "bad",
				auth: "user",
				handler: async () => "not a response",
			},
			{
				method: "GET",
				path: "admin-only",
				auth: "admin",
				handler: async () => new Response(null, { status: 204 }),
			},
		],
	};
}
