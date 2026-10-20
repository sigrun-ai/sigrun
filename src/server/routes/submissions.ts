/**
 * Submission lifecycle routes: submit (content-part resolution + the §7.1
 * async admit shape — 202 at admission, optional `waitMs`, status route),
 * configure (model/thinking change), abort (withdraw the active
 * submission), and compact (manual compaction).
 * Every route resolves its conversation through the `loadConversation`
 * pre-handler (404 for an unknown id) before touching the body.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	InputSubmissionDraft,
	ModelRef,
	Submission,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { FastifyInstance } from "fastify";
import type { SigrunHost } from "../../extension.js";
import { touchActivity } from "../../harness/activity.js";
import { UnservedModelError } from "../../harness/providers/index.js";
import { resolveServedModelRefreshing } from "../../harness/providers/refresh.js";
import { parseSubmissionInput, resolveParts } from "../content-parts.js";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import {
	ID_PARAMS_SCHEMA,
	THINKING_LEVELS,
	WHEN_BUSY_MODES,
	conversationEnv,
	submissionId,
	type WhenBusyMode,
} from "../helpers.js";
import type {
	AbortResponse,
	CompactResponse,
	ConfigureResponse,
	SubmissionResponse,
} from "../views.js";

/** The §7.1 ceiling for `?waitMs` — a positive integer at most this. */
const WAIT_MS_MAX = 60_000;

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

/**
 * Race `submission.wait` against a `waitMs` timer (§7.1): the wait winning
 * returns the settled record; the timer winning returns whichever record is
 * CURRENT (mid-run). The losing wait's eventual rejection is never left
 * unhandled.
 */
async function waitForSubmission(
	submission: Submission,
	waitMs: number,
): Promise<SubmissionRecord> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<true>((resolve) => {
			timer = setTimeout(() => resolve(true), waitMs);
		});
		const wait = submission.wait(BACKGROUND_CONTEXT);
		const winner = await Promise.race([wait, timeout]);
		if (winner !== true) {
			return winner;
		}
		// The timer won: hand back the CURRENT record; a late rejection of
		// the abandoned wait must not surface as unhandled.
		void wait.catch(() => undefined);
		return await submission.status(BACKGROUND_CONTEXT);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Register the submission/configure/abort/compact routes. */
export function registerSubmissionRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;
	// Submissions: content-part resolution + upstream idempotence;
	// `whenBusy` pass-through.
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
			const parsed = parseSubmissionInput(body.input);
			if (!parsed.ok) {
				return await reply.code(400).send({ error: "invalid_input" });
			}
			// Spec §2/§3 binding contract: a conversation
			// pinned to an unserved model fails explicitly AT SUBMIT — 4xx with
			// the available ids — never a silent fallback, and never a settled
			// no_model run surfaced only later. Resolution goes through the
			// refresh-on-miss wrapper: ONE bounded refresh of the named
			// provider + re-resolve on the miss, so a
			// model gained upstream since the last interval tick is
			// immediately usable; still absent → the UnservedModelError
			// carrying the catalog maps to 400. The auto-namer's resolution
			// deliberately stays on bare `requireServedModel` (background
			// lane — no refresh there).
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			try {
				if (agent.model !== undefined) {
					await resolveServedModelRefreshing(opened.models, agent.model);
				}
			} catch (error) {
				if (error instanceof UnservedModelError) {
					return await reply.code(400).send({
						error: "unserved_model",
						model: `${error.ref.provider}/${error.ref.modelId}`,
						available: error.available,
					});
				}
				throw error;
			}
			// `waitMs` (§7.1) is the opt-in bounded settlement wait for
			// scripts — a positive integer ≤ 60 000; anything else is a
			// fail-loud client error BEFORE anything is admitted.
			const waitMsRaw = (
				request.query as Record<string, unknown> | undefined
			)?.waitMs;
			let waitMs: number | undefined;
			if (waitMsRaw !== undefined) {
				const parsedWait =
					typeof waitMsRaw === "number" ? waitMsRaw : Number(waitMsRaw);
				if (
					!Number.isInteger(parsedWait) ||
					parsedWait <= 0 ||
					parsedWait > WAIT_MS_MAX
				) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "waitMs" });
				}
				waitMs = parsedWait;
			}
			const requestId =
				body.requestId === undefined ? undefined : String(body.requestId);
			// `whenBusy` is the steer affordance (spec §7 item 3) — validate
			// it against pi-durable's union and pass it through; unknown values
			// are a client error, never a silent default.
			const whenBusy = body.whenBusy;
			if (
				whenBusy !== undefined &&
				(typeof whenBusy !== "string" || !WHEN_BUSY_MODES.includes(whenBusy))
			) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "whenBusy" });
			}
			// Resolve path-parts to inline content NOW, against the live
			// workspace: missing paths become explicit error parts; other
			// workspace failures throw → Fastify 500, fail-loud.
			const env = await conversationEnv(opened, conversation);
			const content = await resolveParts(
				parsed.parts,
				env,
				BACKGROUND_CONTEXT,
			);
			const draft: InputSubmissionDraft = {
				type: "input",
				content,
				...(requestId === undefined ? {} : { requestId }),
				...(whenBusy === undefined
					? {}
					: { whenBusy: whenBusy as WhenBusyMode }),
			};
			// The submit pass-through is retired (§6.7): the memory seam's
			// runSettled owns capture, so submissions admit directly.
			const submission = await conversation.submit(
				draft,
				BACKGROUND_CONTEXT,
			);
			// Admission stamps activity: the sidebar's activity
			// sort must move the moment a prompt lands — before the run settles.
			await touchActivity(
				opened.harness,
				conversation.id,
				opened.now,
				BACKGROUND_CONTEXT,
			);
			// §7.1: 202 AT ADMISSION — the record as it stands the moment the
			// submission is admitted (queued or placed). `?waitMs` opts into
			// the bounded settlement race; the status route polls the record.
			const record =
				waitMs === undefined
					? await submission.status(BACKGROUND_CONTEXT)
					: await waitForSubmission(submission, waitMs);
			return await reply.code(202).send({ submission: record });
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
