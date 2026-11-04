/**
 * The `/v1/notices` routes (notices Task 4, spec §3/§4): the user's
 * notice pile and its one action dispatch, over the shared
 * `NoticesService` (the store files' one mediation point).
 *
 * Access: every notice id is per-user — a notice only ever exists on
 * its recipient's pile. A foreign / unknown / user-less id is therefore
 * indistinguishable from an absent one: 404 `notice_not_found` on
 * every `:id` route (never a 403 tell), and the user-less principal's
 * GET is the empty list. There is no cross-user selector: an admin
 * asking with another user's id still 404s — the id is only ever
 * addressed through the CALLER's pile.
 *
 * Route params: notice ids are UUID strings (store-assigned), so the
 * schemas declare a string param — never the conversations'
 * `ID_PARAMS_SCHEMA` (integer).
 */

import type { FastifyInstance } from "fastify";
import type { NoticesResponse } from "@sigrun/shared/notices";
import type { ServerContext } from "../context.js";

/**
 * The one notice-id param: a UUID string (the store mints random ids).
 * Declared as a string so Fastify's param validation cannot mask the
 * lookup with an integer-coercion 400.
 */
const NOTICE_ID_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "string" } },
	required: ["id"],
	additionalProperties: false,
} as const;

/** The action route's params: the notice id plus the action id. */
const NOTICE_ACTION_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "string" }, actionId: { type: "string" } },
	required: ["id", "actionId"],
	additionalProperties: false,
} as const;

/** The action route's body: the optional client request id (dedup). */
const NOTICE_ACTION_BODY_SCHEMA = {
	type: "object",
	properties: { requestId: { type: "string" } },
	additionalProperties: false,
} as const;

/** The not-found body — shared by every notice route's lookup. */
const NOT_FOUND = { error: "notice_not_found" } as const;

/** Register the `/v1/notices` routes. */
export function registerNoticeRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { notices } = ctx;

	// The user's own pile (spec §3): newest first, minus any
	// conversation notice whose share was revoked (the service prunes
	// them off disk on the same read). A user-less principal has no
	// pile — the empty list, never an error.
	app.get("/v1/notices", async (request): Promise<NoticesResponse> => {
		const user = request.principal.user;
		if (user === undefined) return { notices: [] };
		return { notices: await notices.listForUser(user) };
	});

	// Dismiss one of the caller's notices: 204 when it existed, 404
	// when it did not (foreign / unknown / already dismissed — all the
	// same answer).
	app.post(
		"/v1/notices/:id/dismiss",
		{ schema: { params: NOTICE_ID_PARAMS_SCHEMA } },
		async (request, reply) => {
			const user = request.principal.user;
			if (user === undefined) {
				return await reply.code(404).send(NOT_FOUND);
			}
			const { id } = request.params as { id: string };
			if (!(await notices.dismiss(user, id))) {
				return await reply.code(404).send(NOT_FOUND);
			}
			return await reply.code(204).send();
		},
	);

	// Dismiss everything of the caller's. Idempotent: always 204.
	app.post("/v1/notices/dismiss-all", async (request, reply) => {
		const user = request.principal.user;
		if (user !== undefined) {
			await notices.dismissAll(user);
		}
		return await reply.code(204).send();
	});

	// The one action dispatch (spec §4): the service's dispatch order
	// (rate-limit → dedup → lookup → action find → binding find →
	// handler call) answers the 200/400/404/409/429 union; the route
	// only maps it onto the wire.
	app.post(
		"/v1/notices/:id/actions/:actionId",
		{
			schema: {
				params: NOTICE_ACTION_PARAMS_SCHEMA,
				body: NOTICE_ACTION_BODY_SCHEMA,
			},
		},
		async (request, reply) => {
			const { id, actionId } = request.params as {
				id: string;
				actionId: string;
			};
			const body = (request.body ?? {}) as { requestId?: string };
			const answer = await notices.runAction(
				request.principal,
				id,
				actionId,
				body.requestId,
			);
			return await reply.code(answer.status).send(answer.body);
		},
	);
}
