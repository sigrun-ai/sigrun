/**
 * Interaction + ambient seam routes (docs/approval-ux-seams.md): the
 * pending-interaction list, the ONE generic answer route, and the
 * conversation's ambient surfaces.
 *
 * The polling surfaces (`GET …/interactions`, `GET …/ambient`) take NO
 * conversation pre-handler — the polling convention (codified on
 * `loadConversation` in `conversation-handler.ts`): a channel polling a
 * torn-down conversation must not error, so they read the seam index
 * docs directly and answer 200 with an empty list for an absent
 * conversation. They are still §5.9 `:id` routes, so each handler applies
 * the VISIBILITY half of the access rule itself (`visibleTo`): a caller
 * with `accessOf === "none"` gets the hidden-is-404
 * `conversation_not_found`, exactly as the pre-handler would give (read
 * access suffices — these routes can never write).
 *
 * The answer route is a write: it resolves its conversation through the
 * `loadConversation(ctx, "write")` pre-handler like every other write
 * `:id` route, with a params schema covering BOTH `id` and `callId` so
 * Fastify's param validation cannot mask the lookup. A human answer
 * stamps `answeredByUser` with the principal's user (spec §5.9: who
 * answered matters to every participant a conversation is shared with).
 *
 * The cross-conversation inbox (`GET /v1/interactions?status=pending`,
 * spec §7.5) also lives here. It has NO `:id`, so no pre-handler — it
 * snapshots the session-singleton `InteractionsIndexDoc` once per
 * request (seed/answer/expire commits maintain it; there is no cache to
 * invalidate), then applies the visibility half of the access rule per
 * conversation (`accessOf` against its SessionMeta — hidden is ABSENT
 * from the list, the list-side half of §5.9's hidden-is-404) before
 * reading each pending record. This is how "answer the agent from my
 * phone" works without opening each conversation; answers still go
 * through the per-conversation answer route above.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	AmbientDoc,
	AmbientOwnersDoc,
	asAmbientRecord,
	type AmbientRecord,
} from "../../harness/ambient.js";
import {
	InteractionDoc,
	InteractionsIndexDoc,
	answerFromBody,
	applyAnswer,
	asInteractionRecord,
	indexSettled,
	maskedAnswerValues,
	sweepSecretDelivery,
	type InteractionRecord,
} from "../../harness/interactions.js";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import { ID_PARAMS_SCHEMA, conversationId } from "../helpers.js";
import { accessOf } from "@sigrun/shared/access";
import { isSuperuser, type Principal } from "../auth/principal.js";
import { SessionMetaDoc } from "../session-meta.js";
import type {
	AmbientList,
	InteractionAnswered,
	InteractionList,
	InboxInteraction,
	InboxResponse,
} from "../views.js";

/**
 * Path params for the answer route — `ID_PARAMS_SCHEMA`'s shape plus the
 * `callId` segment its address carries. Declaring BOTH params keeps
 * Fastify's param validation from masking the pre-handler's lookup: a
 * malformed id is a 400 like every other `:id` route.
 */
const ANSWER_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "integer" }, callId: { type: "string" } },
	required: ["id", "callId"],
	additionalProperties: false,
} as const;

/**
 * The §5.9 visibility half of the access rule for the pre-handler-free
 * polling GETs: resolve the conversation's session-meta and answer
 * whether the caller may SEE it (`accessOf !== "none"`). Absent doc →
 * defaults → ownerless → visible. These routes are read-only by
 * construction, so read/write need never be distinguished here.
 */
async function visibleTo(
	ctx: ServerContext,
	convId: ReturnType<typeof conversationId>,
	principal: Principal,
): Promise<boolean> {
	const meta = await ctx.opened.harness.snapshot(
		SessionMetaDoc,
		convId,
		BACKGROUND_CONTEXT,
	);
	return (
		accessOf(
			{ user: principal.user, superuser: isSuperuser(principal) },
			meta ?? {},
		) !== "none"
	);
}

/** Register the interaction-seam and ambient-surface routes. */
export function registerInteractionRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;

	// ─── Interaction seam (docs/approval-ux-seams.md) ────────────────────
	// One generic surface shared by every extension: pending interactions
	// (list) and answers (the ONE generic route). Resolution semantics stay
	// extension-owned — the route only writes the envelope's answer field.

	// ─── Cross-conversation inbox (spec §7.5) ──────────────────────
	// ONE list over every conversation the caller can see: a single
	// snapshot of the session-singleton index (seed/answer/expire commits
	// maintain it — nothing to invalidate), §5.9 visibility per
	// conversation (hidden is ABSENT, the list-side half of the rule),
	// then the still-pending records. `pending` is the only indexed
	// status: any other query value is a fail-loud 400 (absent means
	// pending).
	app.get(
		"/v1/interactions",
		async (request, reply): Promise<InboxResponse> => {
			const query = request.query as Record<string, unknown>;
			if (query.status !== undefined && query.status !== "pending") {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "status" });
			}
			const index = await opened.harness.snapshot(
				InteractionsIndexDoc,
				BACKGROUND_CONTEXT,
			);
			const pending = index?.pending ?? {};
			const interactions: InboxInteraction[] = [];
			for (const key of Object.keys(pending)) {
				const id = Number(key);
				const convId = conversationId(id);
				// §5.9 visibility, applied in-handler (a no-`:id` route has no
				// pre-handler): a hidden conversation contributes nothing.
				if (!(await visibleTo(ctx, convId, request.principal))) {
					continue;
				}
				for (const callId of pending[key] ?? []) {
					const record = await opened.harness.snapshot(
						InteractionDoc,
						convId,
						callId,
						BACKGROUND_CONTEXT,
					);
				// The index is maintained in the same commits as the records,
				// but a raced settle can leave a stale entry — serve only
				// what still reads pending (the per-conversation list's guard).
				if (record !== undefined && record.status === "pending") {
					interactions.push({
						...asInteractionRecord(record),
						conversationId: id,
					});
				}
				}
			}
			interactions.sort((a, b) => a.createdAt - b.createdAt);
			return { interactions };
		},
	);

	/** The list route's wire record: envelope + body + details, unmodified. */
	app.get(
		"/v1/conversations/:id/interactions",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<InteractionList> => {
			const { id } = request.params as { id: number };
			const convId = conversationId(id);
			// §5.9 visibility (the pre-handler-free polling convention means
			// the rule is applied HERE): hidden → 404 conversation_not_found.
			if (!(await visibleTo(ctx, convId, request.principal))) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Absent conversation → empty list (the ambient list's convention:
			// a channel polling a torn-down conversation must not error).
			const index = await opened.harness.snapshot(
				InteractionsIndexDoc,
				BACKGROUND_CONTEXT,
			);
			const pending = index?.pending[String(convId)] ?? [];
			const records: InteractionRecord[] = [];
			for (const callId of pending) {
				const record = await opened.harness.snapshot(
					InteractionDoc,
					convId,
					callId,
					BACKGROUND_CONTEXT,
				);
				if (record !== undefined && record.status === "pending") {
					records.push(asInteractionRecord(record));
				}
			}
			return { interactions: records };
		},
	);

	// The single-record read (U6 Task 2): ANY status — the channel's
	// refetch path (Review Focus 1's “a GET returns the winning answer”;
	// Review Focus 2's expired refetch; the transport `load`). The SAME
	// §5.9 visibility half as the list (hidden → the indistinguishable
	// 404), applied in-handler by the polling convention. The record rides
	// as-is (envelope + body + details) — the stored answer carries only
	// the SECRET_MASK for secret fields (never the values).
	app.get(
		"/v1/conversations/:id/interactions/:callId",
		{
			schema: { params: ANSWER_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx, "write"),
		},
		async (request, reply): Promise<InteractionRecord> => {
			const { callId } = request.params as { callId: string };
			const conversation = request.conversation;
			const record = await opened.harness.snapshot(
				InteractionDoc,
				conversation.id,
				callId,
				BACKGROUND_CONTEXT,
			);
			// Unknown callId (an empty doc materializes with kind "") is the
			// same 404 as the answer route's.
			if (record === undefined || record.kind === "") {
				return await reply.code(404).send({ error: "no_such_interaction" });
			}
			return asInteractionRecord(record);
		},
	);

	// The ONE generic answer route: writes `answer` into the envelope with
	// first-answer-wins inside the commit. 404 for unknown/not-pending;
	// 400 for a malformed answer. `by` is "human" (the only v1 caller).
	app.post(
		"/v1/conversations/:id/interactions/:callId/answer",
		{
			schema: { params: ANSWER_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx, "write"),
		},
		async (request, reply): Promise<InteractionAnswered> => {
			const { callId } = request.params as { callId: string };
			const conversation = request.conversation;
			// Ruling 20: the route body is `{values}` ONLY (every field's value
			// under its name); the legacy `{ids, text}` shapes are a 400 — no
			// compatibility layer (ruling 16). An absent body is a 400 too: an
			// answer carries values.
			const answer = answerFromBody(request.body);
			if (answer === null) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// The commit returns a plain outcome; reply shaping happens
			// AFTER the commit (a Fastify reply must never travel through
			// the harness mutation line).
			const committed = await conversation.commit(async (tx) => {
				const draft = await tx.doc(
					InteractionDoc,
					conversation.id,
					callId,
					callId,
				);
				// Unknown callId: the doc materializes empty — detect via kind
				// never having been seeded (an empty seed has kind "").
				if (draft.kind === "") {
					sweepSecretDelivery(conversation.id, callId);
					return { found: false } as const;
				}
				// Review Focus 4: project the STORED (masked) answer for the
				// response BEFORE the mutation — reading the tree is safe (the
				// body is never mutated), and re-reading a mutated nested field
				// after the write trips chord's settled-overlay check.
				const stored = maskedAnswerValues(draft.body, answer);
				const applied = applyAnswer(
					draft,
					answer,
					"human",
					Date.now(),
					request.principal.user,
					{ conversationId: conversation.id },
				);
				if (!applied) {
					// A loser of the first-answer-wins race: its (possibly secret)
				// payload never delivered — sweep so it cannot linger.
					sweepSecretDelivery(conversation.id, callId);
					return { found: true, applied: false } as const;
				}
				const index = await tx.doc(InteractionsIndexDoc);
				indexSettled(index, conversation.id, callId);
				return {
					found: true,
					applied: true,
					answer: stored,
				} as const;
			}, BACKGROUND_CONTEXT);
			if (!committed.found) {
				return await reply.code(404).send({ error: "no_such_interaction" });
			}
			if (!committed.applied) {
				return await reply.code(404).send({ error: "not_pending" });
			}
			return {
				callId,
				status: "answered",
				answer: committed.answer,
			};
		},
	);

	// ─── Ambient seam ────────────────────────────────────────────────────
	// The conversation's ambient surfaces, replacement-state reads.

	app.get(
		"/v1/conversations/:id/ambient",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<AmbientList> => {
			const { id } = request.params as { id: number };
			const convId = conversationId(id);
			// §5.9 visibility, applied in-handler like the interactions list.
			if (!(await visibleTo(ctx, convId, request.principal))) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const index = await opened.harness.snapshot(
				AmbientOwnersDoc,
				BACKGROUND_CONTEXT,
			);
			const keys = Object.keys(index?.owners ?? {});
			const surfaces: AmbientRecord[] = [];
			for (const key of keys) {
				const surface = await opened.harness.snapshot(
					AmbientDoc,
					convId,
					key,
					BACKGROUND_CONTEXT,
				);
				// A surface owned but never written in THIS conversation is
				// absent (owner registration is session-global; surfaces are
				// conversation-scoped).
				if (surface !== undefined && surface.body !== undefined) {
					surfaces.push(asAmbientRecord(surface));
				}
			}
			return { ambient: surfaces };
		},
	);
}
