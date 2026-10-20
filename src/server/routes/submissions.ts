/**
 * Submission lifecycle routes: submit (content-part resolution + the §7.1
 * async admit shape — 202 at admission, optional `waitMs`, status route),
 * configure (model/thinking change), abort (withdraw the active
 * submission), and compact (manual compaction).
 * Every route resolves its conversation through the `loadConversation`
 * pre-handler (404 for an unknown id) before touching the body.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { FastifyInstance } from "fastify";
import type { SigrunHost } from "../../extension.js";
import { UnservedModelError } from "../../harness/providers/index.js";
import {
	ConversationOpError,
	submitOp,
} from "../conversation-ops.js";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import {
	ID_PARAMS_SCHEMA,
	THINKING_LEVELS,
	storeAgentChange,
	submissionId,
} from "../helpers.js";
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
	// v1 accepts EXACTLY `model` + `thinking` — any other key is a fail-loud
	// 400 (the agent's other knobs are not wire surface yet).
	app.post(
		"/v1/conversations/:id/configure",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx, "write") },
		async (request, reply): Promise<ConfigureResponse> => {
			const conversation = request.conversation;
			const body = request.body as Record<string, unknown> | undefined;
			if (
				body === undefined ||
				body === null ||
				typeof body !== "object" ||
				Array.isArray(body)
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const unknownKey = Object.keys(body).find(
				(key) => key !== "model" && key !== "thinking",
			);
			if (unknownKey !== undefined) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: unknownKey });
			}
			const model = body.model;
			const thinking = body.thinking;
			if (model === undefined && thinking === undefined) {
				// A configure that changes nothing is a client error, not a no-op.
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// `model` is `"provider/modelId"`, split on the FIRST `/` (a modelId
			// may itself contain slashes); both parts must be non-empty.
			let parsedModel: ModelRef | undefined;
			if (model !== undefined) {
				if (typeof model !== "string" || !model.includes("/")) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "model" });
				}
				const slash = model.indexOf("/");
				const provider = model.slice(0, slash);
				const modelId = model.slice(slash + 1);
				if (provider.length === 0 || modelId.length === 0) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "model" });
				}
				parsedModel = { provider, modelId };
			}
			if (
				thinking !== undefined &&
				(typeof thinking !== "string" ||
					!THINKING_LEVELS.includes(thinking))
			) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "thinking" });
			}
			// perModelThinking: a model change re-applies the store's
			// override for the NEW model unless the request pins `thinking` —
			// the map is the deployment default, the explicit field the caller's
			// win. Read from the store here, so a PATCH reaches later configures.
			const storeThinking =
				parsedModel === undefined
					? undefined
					: opened.settings.read().perModelThinking?.[
							`${parsedModel.provider}/${parsedModel.modelId}`
					];
			await conversation.configure(
				{
					...(parsedModel === undefined ? {} : { model: parsedModel }),
					...(thinking !== undefined
						? { thinkingLevel: thinking as ModelThinkingLevel }
						: storeThinking === undefined
							? {}
							: { thinkingLevel: storeThinking as ModelThinkingLevel }),
				},
				BACKGROUND_CONTEXT,
			);
			// Read the agent back and project the configured surface only —
			// resolved extensions/tools/sections stay server-side.
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			return {
				...(agent.model === undefined ? {} : { model: agent.model }),
				thinkingLevel: agent.thinkingLevel,
			};
		},
	);

	// Abort: withdraw/settle the conversation's active submission.
	// `inspect()` is the read-only union of placed run inputs and queued inbox
	// items (all conversations); filtered to this conversation, the LOWEST id
	// is the active one — anything queued behind a busy conversation was
	// admitted later and has a higher id.
	app.post(
		"/v1/conversations/:id/abort",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx, "write") },
		async (request, reply): Promise<AbortResponse> => {
			const conversation = request.conversation;
			const inspection = await opened.harness.inspect(BACKGROUND_CONTEXT);
			// Lowest live id = oldest admitted = the placed run input over later-
			// queued inbox items. reduce() with a first-element seed is ordering-
			// independent (a future pi-durable inspect() ordering change cannot
			// silently target the wrong submission); empty → undefined.
			const active = inspection.submissions
				.filter((s) => s.conversationId === conversation.id)
				.reduce<(typeof inspection.submissions)[number] | undefined>(
					(min, s) => (min === undefined || s.id < min.id ? s : min),
					undefined,
				);
			if (active === undefined) {
				return await reply
					.code(404)
					.send({ error: "no_active_submission" });
			}
			const result = await opened.harness.abortSubmission(
				active.id,
				BACKGROUND_CONTEXT,
				conversation.id,
			);
			// `not_found` means the submission's record vanished between `inspect`
			// and `abort` — the conversation is no longer busy, so the honest answer
			// is the same as nothing-active.
			if (result === "not_found") {
				return await reply
					.code(404)
					.send({ error: "no_active_submission" });
			}
			// `already_placed`/`settled` are still 200: abort is idempotent and
			// the body reports which state the submission was found in.
			return { result, submissionId: active.id };
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
	// lands.
	app.post(
		"/v1/conversations/:id/compact",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx, "write") },
		async (request, reply): Promise<CompactResponse> => {
			const conversation = request.conversation;
			// Absent body is valid (no instructions); an object may carry
			// ONLY `instructions` — any other key is a fail-loud 400, the
			// configure convention.
			const body: unknown = request.body;
			let instructions: string | undefined;
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
				if (
					record.instructions !== undefined &&
					typeof record.instructions !== "string"
				) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "instructions" });
				}
				instructions =
					record.instructions === undefined || record.instructions === ""
						? undefined
						: record.instructions;
			}
			const taskId = await conversation.compact(
				instructions,
				BACKGROUND_CONTEXT,
			);
			// 202: like submissions, the compaction is admitted, not settled —
			// the task runs asynchronously and its summary lands as a view
			// revision (the SSE stream).
			return await reply.code(202).send({ taskId });
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
