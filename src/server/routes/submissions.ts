/**
 * Submission lifecycle routes: submit (content-part resolution + the §7.1
 * async admit shape — 202 at admission, optional `waitMs`, status route),
 * configure (model/thinking change), abort (withdraw the active
 * submission), and compact (manual compaction).
 * Every route resolves its conversation through the `loadConversation`
 * pre-handler (404 for an unknown id) before touching the body.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { SigrunHost } from "../../extension.js";
import { UnservedModelError } from "../../harness/providers/index.js";
import {
	abortOp,
	compactOp,
	configureOp,
	ConversationOpError,
	submitOp,
} from "../conversation-ops.js";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import { ID_PARAMS_SCHEMA, submissionId } from "../helpers.js";
import type {
	AbortResponse,
	CompactResponse,
	ConfigureResponse,
	SubmissionResponse,
} from "../views.js";

/** Integer path params for the submission status route (§7.1). */
const SUBMISSION_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "integer" }, submissionId: { type: "integer" } },
	required: ["id", "submissionId"],
	additionalProperties: false,
} as const;

/** Path params for the extension-command invoke route (W5 Task 3). */
const COMMAND_INVOKE_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "integer" }, name: { type: "string" } },
	required: ["id", "name"],
	additionalProperties: false,
} as const;

/** Register the submission/configure/abort/compact routes. */
export function registerSubmissionRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;
	// Submissions: content-part resolution + upstream idempotence;
	// `whenBusy` pass-through. The shared submit op (W5 Task 5) is the
	// SAME code path the extension host bridge drives — content-part
	// resolution, the served-model check, and activity stamping are
	// identical by construction; this route owns the HTTP mapping only.
	app.post(
		"/v1/conversations/:id/submissions",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx, "write") },
		async (request, reply): Promise<SubmissionResponse> => {
			const conversation = request.conversation;
			const body = request.body as Record<string, unknown> | undefined;
			if (
				body === undefined ||
				typeof body !== "object" ||
				Array.isArray(body)
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			try {
				const record = await submitOp(ctx, conversation, body.input, {
				...(body.requestId === undefined
					? {}
					: { requestId: String(body.requestId) }),
				...(body.whenBusy === undefined ? {} : { whenBusy: body.whenBusy }),
				...( (request.query as Record<string, unknown> | undefined)?.waitMs ===
				undefined
					? {}
					: {
							waitMs: (
								request.query as Record<string, unknown>
							).waitMs,
						}),
				});
				return await reply.code(202).send({ submission: record });
			} catch (error) {
				if (error instanceof ConversationOpError) {
					return await reply.code(400).send(error.body);
			}
				if (error instanceof UnservedModelError) {
					return await reply.code(400).send({
						error: "unserved_model",
						model: `${error.ref.provider}/${error.ref.modelId}`,
						available: error.available,
					});
				}
				throw error;
			}
		},
	);

	// Submission status (§7.1): the record as it stands — the poll
	// counterpart of the admission-202 submit. The submission must belong
	// to THIS conversation: an unknown id and another conversation's id
	// are the same 404 (never a cross-conversation leak).
	app.get(
		"/v1/conversations/:id/submissions/:submissionId",
		{
			schema: { params: SUBMISSION_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx, "read"),
		},
		async (request, reply): Promise<SubmissionResponse> => {
			const conversation = request.conversation;
			const { submissionId: rawSubmissionId } = request.params as {
				submissionId: number;
			};
			const submission = await opened.harness.submission(
				submissionId(rawSubmissionId),
				BACKGROUND_CONTEXT,
			);
			const record =
				submission === undefined
					? undefined
					: await submission.status(BACKGROUND_CONTEXT);
			if (
				record === undefined ||
				record.conversationId !== conversation.id
			) {
				return await reply
					.code(404)
					.send({ error: "submission_not_found" });
			}
			return { submission: record };
		},
	);

	// Configure: change the conversation's model and/or thinking level.
	// The shared configure op (gateway C4a) is the SAME code path the
	// extension host bridge drives — the validation order and error bodies
	// moved verbatim into the op; this route owns the HTTP mapping only.
	// Configure accepts `model` + `thinking` + `extensions` — any other key is a fail-loud
	// 400 (the agent's other knobs are not wire surface yet).
	app.post(
		"/v1/conversations/:id/configure",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx, "write") },
		async (request, reply): Promise<ConfigureResponse> => {
			try {
				return await configureOp(ctx, request.conversation, request.body as {
					readonly model?: unknown;
					readonly thinking?: unknown;
					readonly extensions?: unknown;
				});
			} catch (error) {
				if (error instanceof ConversationOpError) {
					return await reply.code(error.status).send(error.body);
				}
				throw error;
			}
		},
	);

	// Abort: withdraw/settle the conversation's active submission.
	// The shared abort op (gateway C4a) is the SAME code path the host
	// bridge drives — the inspect/reduce targeting of the conversation's
	// lowest live submission and the 404 `no_active_submission` live in the
	// op; this route owns the HTTP mapping only.
	app.post(
		"/v1/conversations/:id/abort",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx, "write") },
		async (request, reply): Promise<AbortResponse> => {
			try {
				return await abortOp(ctx, request.conversation);
			} catch (error) {
				if (error instanceof ConversationOpError) {
					return await reply.code(error.status).send(error.body);
				}
				throw error;
			}
		},
	);

	// Manual compaction: `POST .../compact` (pi parity).
	// `Conversation.compact(instructions)` (pi-durable's own manual-
	// compaction admission, dist/harness/types.d.ts) creates a
	// conversation-owned durable compaction task with `reason: "manual"`:
	// it compacts even when the conversation is idle — a user's explicit
	// intent — and places its summary through a write submission (at the
	// next boundary when busy). Manual compaction ignores the policy's
	// `enabled` (upstream doc: "manual compaction ignores `enabled`");
	// `compact()` resumes the scheduler itself. The task id is handed back —
	// the SSE stream carries the `pi.compaction` entry when the summary
	// lands. The shared compact op (gateway C4a) is the SAME code path the
	// host bridge drives; this route owns the body validation and the 202.
	app.post(
		"/v1/conversations/:id/compact",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx, "write") },
		async (request, reply): Promise<CompactResponse> => {
			const conversation = request.conversation;
			// Absent body is valid (no instructions); an object may carry
			// ONLY `instructions` — any other key is a fail-loud 400, the
			// configure convention. The instructions value itself is the op's
			// validation (same shape for HTTP and host callers).
			const body: unknown = request.body;
			let instructions: unknown;
			if (body !== undefined && body !== null) {
				if (typeof body !== "object" || Array.isArray(body)) {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				const record = body as Record<string, unknown>;
				const unknownKey = Object.keys(record).find(
					(key) => key !== "instructions",
				);
				if (unknownKey !== undefined) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: unknownKey });
				}
				instructions = record.instructions;
			}
			try {
				const { taskId } = await compactOp(ctx, conversation, instructions);
				return await reply.code(202).send({ taskId });
			} catch (error) {
				if (error instanceof ConversationOpError) {
					return await reply.code(error.status).send(error.body);
				}
				throw error;
			}
		},
	);

	// Extension-command invocation (core hardening W5 Task 3, spec §9.3):
	// `POST /v1/conversations/:id/commands/:name {args?}` runs the winning
	// extension declaration for `name` (the merged catalog's `runnable`
	// map — core names and dropped/collided losers resolve to 404
	// `command_not_found`, never a run). WRITE-gated like every other
	// conversation-mutating route (`loadConversation(ctx, "write")`: a
	// read-only sharee gets 403). The body is at most `{args: string}`
	// (absent body = empty args); the run ctx mirrors the ext-route
	// adapter's — the caller's principal and the extension's seam host
	// (`ctx.host` may be undefined for arity-0 factories, same Task 2
	// semantics). A THROWING run is 500 `command_failed` naming the
	// extension (logged; the server lives on); a normal return is 200
	// with the command's optional `{notice}`.
	app.post(
		"/v1/conversations/:id/commands/:name",
		{
			schema: { params: COMMAND_INVOKE_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx, "write"),
		},
		async (request, reply): Promise<void> => {
			const conversation = request.conversation;
			const { name } = request.params as { name: string };
			// The body convention of configure/compact: absent is valid (no
			// args); an object may carry ONLY `args`, a non-string `args` is a
			// fail-loud 400.
			const body: unknown = request.body;
			let args: string | undefined;
			if (body !== undefined && body !== null) {
				if (typeof body !== "object" || Array.isArray(body)) {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				const record = body as Record<string, unknown>;
				const unknownKey = Object.keys(record).find((key) => key !== "args");
				if (unknownKey !== undefined) {
						return await reply
							.code(400)
							.send({ error: "invalid_field", field: unknownKey });
				}
				if (record.args !== undefined && typeof record.args !== "string") {
						return await reply
							.code(400)
							.send({ error: "invalid_field", field: "args" });
				}
				args = record.args as string | undefined;
			}
			const merged = ctx.commandCatalog.runnable.get(name);
			if (merged === undefined) {
				return await reply.code(404).send({ error: "command_not_found" });
			}
			// The extension's seam host — the Task 2 ext-route semantics: the
			// captured host instance, cast across the not-yet-bridged members
			// (and possibly undefined when the loader ran without a host
			// context factory).
			const host = ctx.opened.seamHosts.get(merged.extension) as
				| SigrunHost
				| undefined;
			try {
				const result = await merged.run({
					conversationId: conversation.id,
					args: args ?? "",
					principal: request.principal,
					host: host as SigrunHost,
				});
				return await reply.code(200).send(
					result === undefined || result.notice === undefined
						? {}
						: { notice: result.notice },
				);
			} catch (cause) {
				console.warn(
					`extension command failed: ${merged.extension} ${name}: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				);
				return await reply.code(500).send({
					error: "command_failed",
					extension: merged.extension,
				});
			}
		},
	);
}
