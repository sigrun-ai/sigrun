/**
 * The conversation pre-handler: one hook every `:id` route declares, so
 * conversation resolution and the unknown-id 404 are uniform across route
 * modules. It runs BEFORE the handler — the SSE route's 404 lands as
 * plain JSON before `reply.hijack()` — and after Fastify's param
 * validation (routes keep `schema: { params: ID_PARAMS_SCHEMA }`).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { ServerContext } from "./context.js";
import { conversationId } from "./helpers.js";

/**
 * Build the pre-handler: resolve `params.id` through the harness's
 * storage-backed line and decorate `request.conversation`; an id no
 * storage ever recorded replies 404 `{error: "conversation_not_found"}`.
 * The polling surfaces (GET interactions/ambient) do NOT take this hook —
 * they answer an absent conversation with an empty list by convention.
 */
export function loadConversation(
	ctx: ServerContext,
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
		request.conversation = conversation;
	};
}
