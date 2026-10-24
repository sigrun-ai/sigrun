/**
 * Admin routes (UI-blocks U4 Task 2, spec §13.3):
 * `POST /v1/admin/restart` — the graceful in-place restart.
 *
 * The route exists ONLY under the supervised posture: `server.supervised`
 * (env `SIGRUN_SUPERVISED`, config resolution) promises that something
 * restarts the process after an intentional `exit 0` — the Helm chart
 * and docker compose set it (both restart the container); the
 * Dockerfile deliberately does NOT, so a bare `docker run` reports
 * `not_supervised` rather than dying permanently.
 *
 * Semantics: admin-only (403 before any body read, like PATCH
 * /v1/settings); unsupervised → 409 `{error: "not_supervised"}` and
 * NOTHING runs; supervised admin → 202 `{restarting: true}` and the
 * restart callback is scheduled on the NEXT tick (`setImmediate`) so
 * the response always flushes before the drain begins. The callback
 * (ServerContext.requestRestart, the serve composition's
 * graceful-shutdown + `process.exit(0)`) owns the exit — the route
 * never calls exit itself.
 *
 * Durability (Review Focus 4): the restart rides the SAME ordered
 * shutdown as the SIGTERM path — the event bus drains pending settles
 * and the harness close seals storage, so a run in flight at restart
 * has its submission durable before exit; pi-durable resumes it after
 * the supervisor brings the process back.
 */

import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";

/** Register the `/v1/admin` routes. */
export function registerAdminRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.post("/v1/admin/restart", async (request, reply) => {
		// Admin-only: a restart is a control-plane action (it kills every
		// in-flight connection, including other users' streams) — the
		// gate runs before the supervised check so a non-admin learns
		// nothing about the deploy's supervision posture.
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		if (!ctx.config.supervised) {
			return await reply.code(409).send({ error: "not_supervised" });
		}
		// Deferred past the reply: the 202 must reach the client before
		// the drain closes its connection. A supervisor is expected, so a
		// missing callback (a hand-built server in a test that forgot the
		// seam) is a loud boot-composition error, not a silent no-op.
		if (ctx.requestRestart === undefined) {
			throw new Error(
				"admin restart: supervised but no restart callback wired (serve composition error)",
			);
		}
		const restart = ctx.requestRestart;
		setImmediate(() => {
			void Promise.resolve(restart()).catch((error: unknown) => {
				// The shutdown path is already committed at this point —
				// nothing to roll back to; log loud and let the exit/error
				// surface in the deploy's logs.
				console.error("sigrun: restart shutdown failed:", error);
			});
		});
		return await reply.code(202).send({ restarting: true });
	});
}
