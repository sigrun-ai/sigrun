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
 * conversation. The answer route is a write: it resolves its
 * conversation through the `loadConversation` pre-handler like every
 * other `:id` route, with a params schema covering BOTH `id` and
 * `callId` so Fastify's param validation cannot mask the lookup.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	AmbientDoc,
	AmbientOwnersDoc,
	type AmbientRecord,
} from "../../harness/ambient.js";
import {
	InteractionDoc,
	InteractionsIndexDoc,
	applyAnswer,
	indexSettled,
	type InteractionAnswer,
	type InteractionRecord,
} from "../../harness/interactions.js";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import { ID_PARAMS_SCHEMA, conversationId } from "../helpers.js";
import type {
	AmbientList,
	InteractionAnswered,
	InteractionList,
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

	/** The list route's wire record: envelope + body + details, unmodified. */
	app.get(
		"/v1/conversations/:id/interactions",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request): Promise<InteractionList> => {
			const { id } = request.params as { id: number };
			const convId = conversationId(id);
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
					records.push(record);
				}
			}
			return { interactions: records };
		},
	);

	// The ONE generic answer route: writes `answer` into the envelope with
	// first-answer-wins inside the commit. 404 for unknown/not-pending;
	// 400 for a malformed answer. `by` is "human" (the only v1 caller).
	app.post(
		"/v1/conversations/:id/interactions/:callId/answer",
		{
			schema: { params: ANSWER_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx),
		},
		async (request, reply): Promise<InteractionAnswered> => {
			const { callId } = request.params as { callId: string };
			const conversation = request.conversation;
			const body: unknown = request.body;
			// SAFETY: the spread of an explicitly-undefined InteractionAnswer
			// builds an empty mutable scaffold — every field is optional, and
			// each is set only after its body value passed validation, so the
			// loose local type never leaks an unvalidated field.
			const answer = {
				...(undefined as unknown as InteractionAnswer),
			} as {
				ids?: string[];
				values?: Record<string, string | number | boolean>;
				text?: string;
			};
			if (body !== undefined && body !== null) {
				if (typeof body !== "object" || Array.isArray(body)) {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				const b = body as Record<string, unknown>;
				const known = new Set(["ids", "values", "text"]);
				const unknownKey = Object.keys(b).find((k) => !known.has(k));
				if (unknownKey !== undefined) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: unknownKey });
				}
				if (b.ids !== undefined) {
					if (
						!Array.isArray(b.ids) ||
						b.ids.some((v) => typeof v !== "string")
					) {
						return await reply
							.code(400)
							.send({ error: "invalid_body" });
					}
					answer.ids = b.ids as string[];
					// (mutable local; the wire type stays readonly)
				}
				if (b.values !== undefined) {
					if (typeof b.values !== "object" || b.values === null) {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					const values: Record<string, string | number | boolean> = {};
					for (const [k, v] of Object.entries(
						b.values as Record<string, unknown>,
					)) {
						if (
							typeof v !== "string" &&
							typeof v !== "number" &&
							typeof v !== "boolean"
						) {
							return await reply
								.code(400)
								.send({ error: "invalid_field", field: `values.${k}` });
						}
						values[k] = v;
					}
					answer.values = values;
				}
				if (b.text !== undefined) {
					if (typeof b.text !== "string") {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					answer.text = b.text;
				}
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
				if (draft.kind === "") return { found: false } as const;
				const applied = applyAnswer(draft, answer, "human", Date.now());
				if (!applied) return { found: true, applied: false } as const;
				// NEVER re-read a mutated draft field (even before the next
				// await): reading a newly-set nested value off the tracked
				// draft trips chord's settled-overlay check. The response
				// projects the INPUT answer — identical to what was written.
				const index = await tx.doc(InteractionsIndexDoc);
				indexSettled(index, conversation.id, callId);
				return {
					found: true,
					applied: true,
					answer,
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
		async (request): Promise<AmbientList> => {
			const { id } = request.params as { id: number };
			const convId = conversationId(id);
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
					surfaces.push(surface);
				}
			}
			return { ambient: surfaces };
		},
	);
}
