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
 * .../configure`, `POST .../abort` (T9c-i). Approvals and SSE arrive in
 * later slices (T9c-ii, T9d–T9e).
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
import type {
	Conversation,
	ConversationId,
	ModelRef,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { HARNESS_VERSION, SCHEMA_VERSION } from "./schema-fixture.js";
import {
	isConfinedPath,
	parseSubmissionInput,
	resolveParts,
} from "./content-parts.js";
import {
	serializeConversationView,
	type AbortResponse,
	type ConversationCreateResponse,
	type ConversationList,
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

/** The static `GET /v1/meta` payload (health aggregation lands in T9e). */
interface MetaResponse {
	readonly harnessVersion: string;
	readonly schemaVersion: string;
	readonly extensions: readonly {
		readonly name: string;
		readonly status: string;
		readonly error?: string;
	}[];
	readonly health: {
		readonly backup: string;
		readonly memory: string;
		readonly providers: string;
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
 * @param _config parsed sigrun config; the foundation routes read nothing
 * from it yet (the listen entry consumes `config.port`; auth/backup health
 * arrive with later slices) — the parameter fixes the factory signature now.
 */
export async function createServer(
	opened: OpenedHarness,
	_config: SigrunConfig,
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
			// Static healthy shape (T9e replaces this with real aggregation).
			health: { backup: "unconfigured", memory: "ok", providers: "ok" },
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
