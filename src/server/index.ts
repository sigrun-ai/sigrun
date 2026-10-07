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
 * /v1/conversations`, `GET /v1/conversations/:id`, `GET /v1/meta`.
 * Submissions, uploads, files, approvals, configure, abort, and SSE arrive in
 * later slices (T9b–T9e).
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
} from "@earendil-works/pi-durable";
import type { SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { HARNESS_VERSION, SCHEMA_VERSION } from "./schema-fixture.js";
import {
	serializeConversationView,
	type ConversationCreateResponse,
	type ConversationList,
} from "./views.js";

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

	return app;
}
