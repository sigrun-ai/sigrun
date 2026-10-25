/**
 * The conversation pre-handler: one hook every `:id` route declares, so
 * conversation resolution, the unknown-id 404, and the §5.9 content-
 * access check are uniform across route modules. It runs BEFORE the
 * handler — the SSE route's 404 lands as plain JSON before
 * `reply.hijack()` — and after Fastify's param validation (routes keep
 * `schema: { params: ID_PARAMS_SCHEMA }`).
 *
 * Access (spec §5.9): the hook snapshots the session-meta doc and
 * resolves `accessOf(principal, meta)`:
 *
 * - `"none"` (hidden) → 404 `conversation_not_found` — a hidden
 *   conversation is indistinguishable from an unknown one (no 403 tell);
 * - `"read"` on a WRITE route → 403 `forbidden` (the route names its need
 *   with `loadConversation(ctx, need)`; GETs are `"read"`, everything
 *   else is `"write"`).
 *
 * The polling surfaces (GET interactions/ambient) do NOT take this hook —
 * they apply the visibility half of the rule inside their handlers (a
 * channel polling a torn-down conversation must not error; see
 * routes/interactions.ts).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { preHandlerAsyncHookHandler } from "fastify";
import { accessOf } from "@sigrun/shared/access";
import { accessPrincipalOf } from "./auth/access-principal.js";
import type { ServerContext } from "./context.js";
import { conversationId } from "./helpers.js";
import { SessionMetaDoc } from "./session-meta.js";

/**
 * Build the pre-handler: resolve `params.id` through the harness's
 * storage-backed line, enforce the §5.9 access rule for `need`, and
 * decorate `request.conversation`; an id no storage ever recorded — or a
 * conversation the caller may not see — replies 404
 * `{error: "conversation_not_found"}`; a read-only caller on a write
 * route gets 403 `{error: "forbidden"}`.
 */
export function loadConversation(
	ctx: ServerContext,
	need: "read" | "write" = "read",
): preHandlerAsyncHookHandler {
	return async (request, reply) => {
		const { id } = request.params as { id: number };
		const conversation = await ctx.opened.harness.conversation(
			conversationId(id),
			BACKGROUND_CONTEXT,
		);
		if (conversation === undefined) {
			return await reply
				.code(404)
				.send({ error: "conversation_not_found" });
		}
		const meta = await ctx.opened.harness.snapshot(
			SessionMetaDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		const access = accessOf(
			accessPrincipalOf(request.principal, ctx.opened.identity.users),
			meta ?? {},
		);
		if (access === "none") {
			// Hidden is 404 on every :id route (spec §5.9).
			return await reply
				.code(404)
				.send({ error: "conversation_not_found" });
		}
		if (access === "read" && need === "write") {
			return await reply.code(403).send({ error: "forbidden" });
		}
		request.conversation = conversation;
	};
}
