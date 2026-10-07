/**
 * The §5 HTTP server foundation (spec §5, Task 9a).
 *
 * `createServer` builds a Fastify app over one `OpenedHarness` — a thin
 * layer: conversation endpoints serialize pi-durable's native
 * `ConversationView` (via `views.ts`), `GET /v1/meta` reports boot facts.
 * The factory registers routes and returns; it never listens (the deploy
 * entry listens; tests use `app.inject()`).
 *
 * Endpoints in THIS slice: `POST /v1/conversations`, `GET
 * /v1/conversations`, `GET /v1/conversations/:id`, `GET /v1/meta` (T9a);
 * `POST .../submissions` (content-part resolution), `POST .../uploads`, `GET
 * .../files`, `GET .../files/content`, `GET /v1/models` (T9b); `POST
 * .../configure`, `POST .../abort` (T9c-i); `GET .../approvals`, `POST
 * .../approvals/:approvalId` (T9c-ii); `GET .../stream` — the SSE view
 * stream (T9d); `GET /v1/meta` real health aggregation (T9e); `GET/PATCH
 * .../meta` — the session-meta sidebar resource (T10).
 *
 * NOTE (T9d): the SSE endpoint is exercised over a REAL socket — it hijacks
 * the reply and writes raw frames, which `app.inject()` cannot observe
 * (light-my-request settles only on `end()`). Deploy listens; the SSE tests
 * listen on an ephemeral loopback port.
 *
 * **Conversation listing gap (v1):** pi-durable's `Harness` has no
 * conversation enumeration (its storage has `scanConversations`, but the
 * harness does not expose it). Until a later slice wires storage-backed
 * enumeration, the server tracks the conversations it can know: the reserved
 * root conversation (ensured at factory time — the root is the spec §5
 * default) plus every id this server created. Conversations created inside
 * pi-durable by tasks/tools do not appear, and a restart forgets non-root
 * creates; both close when a later slice adds durable enumeration.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	ApprovalsDoc,
	ApprovalsPolicyDoc,
	DEFAULT_APPROVAL_POLICY,
	isGated,
} from "sigrun-ext-approvals";
import type {
	Conversation,
	ConversationId,
	ConversationView,
	ModelRef,
	ToolSlot,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { aggregateHealth, type HealthStatus } from "../harness/health.js";
import { HARNESS_VERSION, SCHEMA_VERSION } from "./schema-fixture.js";
import {
	isConfinedPath,
	parseSubmissionInput,
	resolveParts,
} from "./content-parts.js";
import {
	applySessionMetaPatch,
	DEFAULT_SESSION_META,
	SessionMetaDoc,
	validateSessionMetaPatch,
	type SessionMeta,
} from "./session-meta.js";
import {
	serializeConversationView,
	type AbortResponse,
	type ApprovalDecideResponse,
	type ApprovalList,
	type ApprovalSummary,
	type ConversationCreateResponse,
	type ConversationList,
	type ConversationViewWire,
	type ConfigureResponse,
	type FileContentResponse,
	type FileListResponse,
	type ModelEntry,
	type ModelsResponse,
	type SubmissionResponse,
	type UploadResponse,
} from "./views.js";

/** The `thinking` values `configure` accepts (pi-ai `ModelThinkingLevel`). */
const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Integer path params for `/v1/conversations/:id`. */
const ID_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "integer" } },
	required: ["id"],
	additionalProperties: false,
} as const;

/** The `GET /v1/meta` payload (spec §5; the health block is Task 9e). */
interface MetaResponse {
	readonly harnessVersion: string;
	readonly schemaVersion: string;
	readonly extensions: readonly {
		readonly name: string;
		readonly status: string;
		readonly error?: string;
	}[];
	/**
	 * §5 health: pure aggregation over boot-retained §3 producers (spec
	 * §3) — synchronous status reads, never network or storage.
	 */
	readonly health: {
		/** Derived from `config.backup` presence; Task 11 owns "degraded". */
		readonly backup: "configured" | "unconfigured" | "degraded";
		/** The memory extension's §3 producer, else "ok" (no-op default). */
		readonly memory: HealthStatus;
		/** Any contributor's §3 producer degraded → "degraded"; empty → "ok". */
		readonly providers: HealthStatus;
	};
	readonly capabilities: {
		readonly backup: boolean;
		readonly channels: readonly string[];
	};
}

/** Re-brand a route id as a ConversationId (the branded Id type is a number). */
function conversationId(id: number): ConversationId {
	return id as ConversationId;
}

/** The extension name the approvals package contributes (loader-install name). */
const APPROVALS_EXTENSION_NAME = "sigrun.approvals";

/** Whether the approvals package is installed in the harness registry. */
function approvalsInstalled(opened: OpenedHarness): boolean {
	return (
		opened.registry.snapshot().extension(APPROVALS_EXTENSION_NAME) !== undefined
	);
}

/**
 * Read the conversation's LiveDoc tool slots from the view. `view.docs` is an
 * untyped `Record<string, JsonObject>`; the slots are narrowed structurally
 * (fail-soft on any unexpected shape, which upstream schema-drift would
 * surface in the schema fixture first). Absent doc / absent tools → no slots.
 */
function liveToolSlots(view: ConversationView): readonly ToolSlot[] {
	const live = view.docs["pi.live"];
	if (typeof live !== "object" || live === null) return [];
	const tools = (live as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return [];
	const slots: ToolSlot[] = [];
	for (const candidate of tools) {
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			typeof (candidate as { callId?: unknown }).callId === "string" &&
			typeof (candidate as { name?: unknown }).name === "string" &&
			typeof (candidate as { status?: unknown }).status === "string"
		) {
			slots.push(candidate as ToolSlot);
		}
	}
	return slots;
}

/**
 * Join the conversation's LiveDoc tool slots to their `ApprovalsDoc[callId]`
 * records: a slot that is pending/running AND gated (per the policy doc /
 * default policy) is a pending approval. The record's status wins when one
 * exists; a slot live with no record yet (the loader wires no `onPending`
 * sink, so no record exists before the first decide) is `pending` with no
 * arguments. Fail-loud: the caller checks package presence first, so the doc
 * read here always resolves.
 */
async function listPendingApprovals(
	opened: OpenedHarness,
	conversation: Conversation,
): Promise<ApprovalSummary[]> {
	const view = await readView(conversation);
	const slots = liveToolSlots(view).filter(
		(slot) => slot.status === "pending" || slot.status === "running",
	);
	if (slots.length === 0) return [];
	const policy =
		(await opened.harness.snapshot(
			ApprovalsPolicyDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		)) ?? DEFAULT_APPROVAL_POLICY;
	const approvals: ApprovalSummary[] = [];
	for (const slot of slots) {
		if (!isGated(slot.name, policy)) continue;
		const record = await opened.harness.snapshot(
			ApprovalsDoc,
			conversation.id,
			slot.callId,
			BACKGROUND_CONTEXT,
		);
		// A decided record drops from the list (the slot is about to clear); a
		// missing record is a not-yet-recorded pending gate.
		if (record !== undefined && record.status !== "pending") continue;
		approvals.push({
			callId: slot.callId,
			toolName: slot.name,
			status: "pending",
			...(record?.arguments === undefined
				? {}
				: { arguments: record.arguments }),
			...(record?.requestedAt === undefined
				? {}
				: { requestedAt: record.requestedAt }),
		});
	}
	return approvals;
}

/** Read one conversation's current view frame; disposes the state handle. */
async function readView(conversation: Conversation) {
	const state = await conversation.viewState(BACKGROUND_CONTEXT);
	const view = serializeConversationView(state.value);
	await state.dispose();
	return view;
}

/**
 * Build the conversation's workspace `ExecutionEnv` the same way
 * `Harness.buildEnv` does for tool calls (dist/harness/harness.js:133-139):
 * resolve the committed `agent.cwd` and hand it, with the harness as the
 * doc `read` line, to the boot `envBuilder`. The §5 file/upload/submission
 * endpoints resolve through this — one seam, so a the-work-fabric-scrubbed-swap of the
 * workspace service moves them all at once.
 */
async function conversationEnv(
	opened: OpenedHarness,
	conversation: Conversation,
): Promise<ExecutionEnv> {
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	const built = await opened.envBuilder(
		{
			conversationId: conversation.id,
			...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
			read: opened.harness,
		},
		BACKGROUND_CONTEXT,
	);
	// `HarnessOptions.env` types as optional; sigrun always passes one, so a
	// missing env is a boot-invariant violation — fail loud, never null-check.
	if (built === undefined) {
		throw new Error("envBuilder returned no ExecutionEnv");
	}
	return built;
}

/** The upload read cap for `files/content` (binary-safe; 1 MiB). */
const FILE_CONTENT_MAX_BYTES = 1024 * 1024;

/**
 * Decode a base64 body strictly: Node's `Buffer.from(s, "base64")` is
 * LENIENT (invalid characters are skipped, so `"!!!"` decodes to empty), so
 * uploads validate the alphabet and round-trip — invalid base64 is a client
 * error, never a silent partial decode.
 */
function decodeBase64Strict(value: string): Buffer | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length % 4 !== 0) return undefined;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return undefined;
	const bytes = Buffer.from(trimmed, "base64");
	if (bytes.toString("base64") !== trimmed) return undefined;
	return bytes;
}

/**
 * Build the §5 server over one opened harness.
 *
 * Ensures the reserved root conversation exists at factory time (the §5
 * default), so the first list serves it.
 *
 * @param opened the booted harness (from `openHarness`) — the server serves
 * exactly this harness's conversations.
 * @param config parsed sigrun config; the listen entry consumes
 * `config.port` and the meta route derives `health.backup` from
 * `config.backup` presence (Task 11 owns the degraded case). Auth arrives
 * with a later slice.
 */
export async function createServer(
	opened: OpenedHarness,
	config: SigrunConfig,
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	// Conversation ids this server can list: the reserved root (ensured now)
	// plus this server's own creates. See the module docstring for the
	// enumeration gap.
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const rootId = root.id;
	const trackedConversations = new Set<number>([rootId]);

	app.get("/v1/meta", async (): Promise<MetaResponse> => {
		return {
			harnessVersion: HARNESS_VERSION,
			schemaVersion: SCHEMA_VERSION,
			extensions: opened.extensionOutcomes.map((outcome) => ({
				name: outcome.name,
				status: outcome.status,
				...(outcome.error === undefined ? {} : { error: outcome.error }),
			})),
			// §5 health (Task 9e): pure aggregation over boot-retained §3
			// producers — backup from config presence ("configured" iff set;
			// T11 adds degraded), memory from the memory extension's producer
			// ("ok" for the no-op default — quarantines surface via
			// extensions[].status, never double-reported here), providers
			// aggregated across contributors (empty → "ok").
			health: {
				backup: config.backup === undefined ? "unconfigured" : "configured",
				memory: opened.memoryHealth?.() ?? "ok",
				providers: aggregateHealth(opened.providerHealth),
			},
			capabilities: { backup: false, channels: [] },
		};
	});

	app.post(
		"/v1/conversations",
		async (request, reply): Promise<ConversationCreateResponse> => {
			// T9a create takes no fields (model/thinking changes arrive with
			// the configure endpoint, T9c): an absent body is valid, an
			// object with any field is a fail-loud 400.
			const body: unknown = request.body;
			if (
				body !== undefined &&
				(typeof body !== "object" ||
					Object.keys(body as Record<string, unknown>).length > 0)
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const conversation = await opened.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					// A conversation with no agent model cannot generate
					// (no_model): server-created conversations start on the
					// boot default model, like the root conversation.
					agent: { model: opened.defaultModel },
				},
				BACKGROUND_CONTEXT,
			);
			trackedConversations.add(conversation.id);
			const view = await readView(conversation);
			return await reply.code(201).send({ id: conversation.id, view });
		},
	);

	app.get("/v1/conversations", async (): Promise<ConversationList> => {
		const conversations: {
			id: number;
			root: boolean;
			entryCount: number;
		}[] = [];
		for (const id of [...trackedConversations].sort((a, b) => a - b)) {
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			// Unresolvable ids (dropped elsewhere) are skipped, not listed.
			if (conversation === undefined) continue;
			const view = await readView(conversation);
			conversations.push({
				id,
				root: id === rootId,
				entryCount: view.entries.length,
			});
		}
		return { conversations };
	});

	app.get(
		"/v1/conversations/:id",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			return readView(conversation);
		},
	);

	// SSE view stream (T9d, spec §5 "Views + watch frames over SSE"): one
	// Server-Sent Events stream per conversation, hand-rolled over `reply.raw`
	// (no @fastify/sse dependency). Event shape: `event: snapshot` with the
	// wire view on connect, then `event: view` per watch revision — every
	// frame is a FULL immutable ConversationView, so a reconnect's fresh
	// snapshot subsumes any missed frame (the spec's reconnect contract
	// collapses to "fresh snapshot on (re)connect"; see the Appendix C
	// named-verification record). `Last-Event-ID` is therefore accepted and
	// deliberately ignored. Heartbeat: a `: ping` comment every 15s (proxy/
	// LB idle-timeout survival). Lifecycle: exactly one owner (`finish` below)
	// stops the watch and clears the interval on client disconnect or watch
	// termination.
	app.get(
		"/v1/conversations/:id/stream",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				// Before the SSE upgrade: plain JSON 404, the shared pattern.
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Acquire the watch BEFORE hijacking: an acquisition failure then
			// lands on Fastify's fail-loud 500 path — a hijacked stream has no
			// error event. `value` is the acquisition revision (the snapshot
			// source); frames published between here and start() are held by the
			// watch's bounded pending delivery, so nothing is lost.
			const watch = await conversation.watch(BACKGROUND_CONTEXT);
			reply.hijack();
			const raw = reply.raw;
			raw.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"connection": "keep-alive",
				"x-accel-buffering": "no",
			});
			raw.flushHeaders();
			// Socket-level write errors after teardown have no consumer (the
			// close path owns teardown); swallow them so a mid-write disconnect
			// cannot crash the process with an unhandled 'error' event.
			raw.on("error", () => {});
			let nextId = 1;
			const send = (event: string, view: ConversationViewWire): void => {
				// Single data line: JSON.stringify escapes newlines in strings.
				raw.write(
					`id: ${nextId++}\nevent: ${event}\ndata: ${JSON.stringify(view)}\n\n`,
				);
			};
			let finished = false;
			const heartbeat = setInterval(() => {
				raw.write(": ping\n\n");
			}, 15_000);
			// The single cleanup owner: client disconnect (response close =
			// socket termination — NOT `request.raw.on("close")`, which on
			// Node 26 fires at request-message completion, i.e. immediately for
			// a bodyless GET) or watch termination (`watch.closed`). The flag
			// makes it exactly-once even though both paths can race.
			const finish = (fromWatchEnd: boolean): void => {
				if (finished) return;
				finished = true;
				clearInterval(heartbeat);
				if (!fromWatchEnd) {
					// stop() is idempotent upstream; fire-and-forget because the
					// stream is ending regardless and a stop() rejection after a
					// dead socket has no consumer to fail loud to.
					void watch.stop().catch(() => {});
				}
				raw.end();
			};
			raw.on("close", () => finish(false));
			// Upstream resolves `closed` with a WatchEnd for every terminal
			// state (failures included); a rejection would be an upstream
			// contract violation — catch it so one stream's anomaly ends that
			// stream instead of taking the process down as an unhandled
			// rejection.
			void watch.closed.then(
				() => finish(true),
				() => finish(true),
			);
			// The client may have disconnected while the watch was being
			// acquired (before the close listener existed): `destroyed` covers
			// that window — stop the just-acquired watch instead of leaking it.
			if (raw.destroyed) {
				finish(false);
				return;
			}
			// Snapshot FIRST (from the acquisition revision), then install the
			// listener — pending frames flow after the snapshot because start
			// never invokes the listener inline.
			send("snapshot", serializeConversationView(watch.value));
			watch.start(async (value) => {
				if (finished) return; // the stream is over; drop the frame
				send("view", serializeConversationView(value));
			});
		},
	);

	// Submissions: content-part resolution + upstream idempotence (T9b).
	// Conversation resolution is storage-backed (`harness.conversation`), so
	// an id that exists in storage works even when the tracked Set forgot it
	// (restart amnesia — the Set remains listing-only).
	app.post(
		"/v1/conversations/:id/submissions",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<SubmissionResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
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
			const requestId =
				body.requestId === undefined ? undefined : String(body.requestId);
			// Resolve path-parts to inline content NOW, against the live
			// workspace (Review Focus #1: missing paths become explicit error
			// parts; other workspace failures throw → Fastify 500, fail-loud).
			const env = await conversationEnv(opened, conversation);
			const content = await resolveParts(
				parsed.parts,
				env,
				BACKGROUND_CONTEXT,
			);
			const submission = await conversation.submit(
				{
					type: "input",
					content,
					...(requestId === undefined ? {} : { requestId }),
				},
				BACKGROUND_CONTEXT,
			);
			// v1 waits for settlement server-side (the watch stream is T9d);
			// `wait()` resolves with the settled record either way.
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			return await reply.code(202).send(settled);
		},
	);

	// Configure: change the conversation's model and/or thinking level (T9c-i).
	// v1 accepts EXACTLY `model` + `thinking` — any other key is a fail-loud
	// 400 (the agent's other knobs are not wire surface yet).
	app.post(
		"/v1/conversations/:id/configure",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<ConfigureResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
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
			await conversation.configure(
				{
					...(parsedModel === undefined ? {} : { model: parsedModel }),
					...(thinking === undefined
						? {}
						: { thinkingLevel: thinking as ModelThinkingLevel }),
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

	// Abort: withdraw/settle the conversation's active submission (T9c-i).
	// `inspect()` is the read-only union of placed run inputs and queued inbox
	// items (all conversations); filtered to this conversation, the LOWEST id
	// is the active one — anything queued behind a busy conversation was
	// admitted later and has a higher id.
	app.post(
		"/v1/conversations/:id/abort",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<AbortResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
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
			// Auto-deny pending approvals BEFORE aborting (spec: abort auto-denies
			// pending approvals) so the cancelled gate hook unwinds onto an
			// already-denied durable record. Only when the package is installed.
			if (approvalsInstalled(opened)) {
				const pending = await listPendingApprovals(opened, conversation);
				for (const approval of pending) {
					await conversation.commit(async (tx) => {
						const draft = await tx.doc(
							ApprovalsDoc,
							conversation.id,
							approval.callId,
							approval.callId,
						);
						if (draft.status !== "pending") return; // first decision wins
						draft.status = "deny";
						draft.reason = "aborted";
						draft.decidedAt = Date.now();
					}, BACKGROUND_CONTEXT);
				}
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

	// Session meta: the conversation-scoped sidebar resource (T10, spec §5).
	// GET serves the doc — or the defaults when it was never written; a read
	// NEVER materializes the doc (defaults are free; a write-per-read would
	// churn a doc revision on every sidebar poll). PATCH merges per the spec
	// table (null clears, draft sub-merges, tagged replaces wholesale) inside
	// ONE commit callback — the read-modify-write pattern keeps concurrent
	// patches from losing each other's fields (the mutation line serializes
	// commits, mirroring the T9c-ii decide pattern).
	app.get(
		"/v1/conversations/:id/meta",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<SessionMeta> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Absent doc → DEFAULT_SESSION_META: served, not written.
			return (
				(await opened.harness.snapshot(
					SessionMetaDoc,
					conversation.id,
					BACKGROUND_CONTEXT,
				)) ?? DEFAULT_SESSION_META
			);
		},
	);

	app.patch(
		"/v1/conversations/:id/meta",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<SessionMeta> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Validate FIRST — a rejected patch never touches the doc.
			const validated = validateSessionMetaPatch(request.body);
			if ("error" in validated) {
				return await reply.code(400).send(validated);
			}
			// Read-modify-write inside ONE commit: tx.doc materializes the doc
			// (initial()) when absent, the patch mutates the tracked draft, and the
			// return value — a plain projection, since the draft handle dies at
			// callback return — is exactly what the commit stores.
			return await conversation.commit(async (tx) => {
				const draft = await tx.doc(SessionMetaDoc, conversation.id);
				applySessionMetaPatch(draft, validated);
				return {
					pinned: draft.pinned,
					tagged: [...draft.tagged],
					archived: draft.archived,
					source: draft.source,
					draft: {
						text: draft.draft.text,
						attachments: [...draft.draft.attachments],
					},
					...(draft.owner === undefined ? {} : { owner: draft.owner }),
				};
			}, BACKGROUND_CONTEXT);
		},
	);

	// Approvals: list pending gated calls (T9c-ii). The locked design joins
	// the conversation's LiveDoc tool slots (the enumerable pending/running
	// gated calls) to each callId's `ApprovalsDoc[callId]` record (the
	// approval status). Empty list when the package is absent.
	app.get(
		"/v1/conversations/:id/approvals",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<ApprovalList> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			if (!approvalsInstalled(opened)) {
				return { approvals: [] };
			}
			return { approvals: await listPendingApprovals(opened, conversation) };
		},
	);

	// Approvals: decide a pending approval (T9c-ii). approvalId IS the gated
	// tool call id; the decision commits to `ApprovalsDoc[callId]` exactly as
	// the package's `decide()` does (first decision wins). 404 when the
	// approval is unknown / not pending; 503 when the package is absent.
	app.post(
		"/v1/conversations/:id/approvals/:approvalId",
		async (request, reply): Promise<ApprovalDecideResponse> => {
			const { id, approvalId } = request.params as {
				id: number;
				approvalId: string;
			};
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			if (!approvalsInstalled(opened)) {
				return await reply
					.code(503)
					.send({ error: "approvals_unavailable" });
			}
			const body = request.body as Record<string, unknown> | undefined;
			const decision = body?.decision;
			const reason = body?.reason;
			if (decision !== "allow" && decision !== "deny") {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			if (reason !== undefined && typeof reason !== "string") {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// The callId must be a currently-gated (pending) call in this
			// conversation — otherwise the approval is unknown / not pending.
			const pending = await listPendingApprovals(opened, conversation);
			if (!pending.some((a) => a.callId === approvalId)) {
				return await reply
					.code(404)
					.send({ error: "approval_not_pending" });
			}
			// Commit the decision (first decision wins). This also records the
			// pending approval durably when the loader wired no `onPending` sink.
			// The guard runs INSIDE the commit, so a concurrent decide that
			// landed between the pre-check above and this commit still wins —
			// and the loser gets an honest 404.
			const applied = await conversation.commit(async (tx) => {
				const draft = await tx.doc(
					ApprovalsDoc,
					conversation.id,
					approvalId,
					approvalId,
				);
				if (draft.status !== "pending") return false; // first decision wins
				draft.status = decision;
				if (reason !== undefined) draft.reason = reason;
				draft.decidedAt = Date.now();
				return true;
			}, BACKGROUND_CONTEXT);
			if (!applied) {
				return await reply
					.code(404)
					.send({ error: "approval_not_pending" });
			}
			return { callId: approvalId, status: decision };
		},
	);

	// Uploads: materialize a base64 body into the conversation's upload
	// namespace via the workspace env (spec §5: correct for remote workspaces).
	app.post(
		"/v1/conversations/:id/uploads",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<UploadResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const body = request.body as Record<string, unknown> | undefined;
			const name = body?.name;
			const contentBase64 = body?.contentBase64;
			if (
				body === undefined ||
				typeof name !== "string" ||
				name.length === 0 ||
				name.includes("/") ||
				name.includes("\\") ||
				name === "." ||
				name === ".." ||
				typeof contentBase64 !== "string"
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			let bytes: Buffer | undefined;
			try {
				bytes = decodeBase64Strict(contentBase64);
			} catch {
				bytes = undefined;
			}
			if (bytes === undefined) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// v1 namespaces uploads per conversation: workspaces are static and
			// shared in v1, so un-namespaced names would clobber across
				// conversations. The returned path is exactly what a content part
			// takes.
			const path = `uploads/${conversation.id}/${name}`;
			const env = await conversationEnv(opened, conversation);
			const written = await env.writeFile(
				path,
				new Uint8Array(bytes),
				BACKGROUND_CONTEXT,
			);
			if (!written.ok) {
				// A failed upload is a server-side fault: fail loud.
				throw written.error;
			}
			return await reply.code(201).send({ path });
		},
	);

	// Files: read-only workspace listing through the conversation env.
	app.get(
		"/v1/conversations/:id/files",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<FileListResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const query = request.query as { path?: string };
			const path = query.path ?? ".";
			if (!isConfinedPath(path)) {
				return await reply.code(400).send({ error: "invalid_path" });
			}
			const env = await conversationEnv(opened, conversation);
			const listed = await env.listDir(path, BACKGROUND_CONTEXT);
			if (!listed.ok) {
				if (listed.error.code === "not_found") {
					return await reply.code(404).send({ error: "not_found" });
				}
				throw listed.error;
			}
			return { entries: listed.value };
		},
	);

	// Files content: text when strictly valid UTF-8, else base64; size-capped.
	app.get(
		"/v1/conversations/:id/files/content",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<FileContentResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const query = request.query as { path?: string };
			const path = query.path ?? "";
			if (!isConfinedPath(path)) {
				return await reply.code(400).send({ error: "invalid_path" });
			}
			if (path.length === 0 || path === ".") {
				return await reply.code(400).send({ error: "invalid_path" });
			}
			const env = await conversationEnv(opened, conversation);
			const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
			if (!info.ok) {
				if (info.error.code === "not_found") {
					return await reply.code(404).send({ error: "not_found" });
				}
				throw info.error;
			}
			if (info.value.size > FILE_CONTENT_MAX_BYTES) {
				return await reply
					.code(413)
					.send({
							error: "file_too_large",
						maxBytes: FILE_CONTENT_MAX_BYTES,
					});
			}
			const read = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
			if (!read.ok) {
				if (read.error.code === "not_found") {
					return await reply.code(404).send({ error: "not_found" });
				}
				throw read.error;
			}
			const bytes = read.value;
			// Text when strictly valid UTF-8, else base64 — the same rule as
			// file-part inlining, applied at the read boundary.
			try {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				return { encoding: "text", content: text, size: bytes.length };
			} catch {
				return {
					encoding: "base64",
					content: Buffer.from(bytes).toString("base64"),
					size: bytes.length,
				};
			}
		},
	);

	// Models: the merged chat-model catalog as picker entries (no provider
	// internals — baseUrl/headers/auth stay server-side).
	app.get("/v1/models", async (): Promise<ModelsResponse> => {
		const models: ModelEntry[] = opened.models.getModels().map((model) => ({
			id: `${model.provider}/${model.id}`,
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: model.input,
			// Project the four rate fields explicitly (ModelCostRates); `tiers` is
			// dropped for v1 (the picker doesn't use them) — no unsound cast.
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
		}));
		return { models };
	});

	return app;
}
