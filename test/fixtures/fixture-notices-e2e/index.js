/**
 * Test-fixture extension package (notices Task 7 e2e): the e2e's posting
 * + action fixture. TWO contributions:
 *
 * - `noticeActions.ack` — the desktop leg's **Ack** button: answers
 *   `{ok: true, message: "acked"}` (the card shows the message, then the
 *   notice is gone — the service's clear-on-ok rule).
 * - `routes` — one extension HTTP route, `POST /v1/ext/fixture-notices-e2e/post`,
 *   whose body is the notice input (minus `user`); the route posts it to
 *   the CALLING principal's user via `host.notices.post`. An anonymous
 *   caller (no principal user) answers 400 — a notice needs a recipient.
 *
 * Route declaration and `auth` shape follow `fixture-routes`; the
 * extensionSpecifiers load shape follows `fixture-surfaces-e2e`. Plain
 * JavaScript so `import(specifier)` resolves it directly.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureNoticesE2E(host) {
	if (host === undefined) {
		throw new Error("notices e2e fixture requires the host context");
	}
	return {
		extension: defineExtension({ name: "fixture-notices-e2e" }),
		noticeActions: {
			async ack() {
				return { ok: true, message: "acked" };
			},
		},
		routes: [
			{
				method: "POST",
				path: "post",
				auth: "user",
				handler: async (request, ctx) => {
					const user = ctx.principal?.user;
					if (user === undefined) {
						return Response.json(
							{ error: "a notice needs a calling user" },
							{ status: 400 },
						);
					}
					const body = await request.json();
					const { id } = await host.notices.post({ ...body, user });
					return Response.json({ id });
				},
			},
		],
	};
}
