/**
 * Conversation lifecycle routes: create, list, get, fork, export, import,
 * and the session-meta sidebar resource — plus the JSONL body parser the
 * import route reads its raw text through. Every `:id` route resolves its
 * conversation through the `loadConversation` pre-handler (404 for an
 * unknown id, before any body validation); the no-`id` routes (create,
 * list, import) take no pre-handler.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor, EntryDraft, EntryId } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import {
	ID_PARAMS_SCHEMA,
	SCAN_PAGE_SIZE,
	readView,
	stampSessionOwner,
	storeAgentChange,
} from "../helpers.js";
import {
	applySessionMetaPatch,
	DEFAULT_SESSION_META,
	SessionMetaDoc,
	validateSessionMetaPatch,
	type SessionMeta,
} from "../session-meta.js";
import {
	JSONL_CONTENT_TYPE,
	type ConversationCreateResponse,
	type ConversationImportResponse,
	type ConversationList,
	type ConversationSummary,
} from "../views.js";

/** Register the conversation lifecycle + session-meta routes. */
export function registerConversationRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, rootId } = ctx;
	app.post(
		"/v1/conversations",
		async (request, reply): Promise<ConversationCreateResponse> => {
			// Create takes no fields (model/thinking changes arrive with
			// the configure endpoint): an absent body is valid, an
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
					// boot default model, like the root conversation, and
					// carry the store's defaultTools/perModelThinking —
					// re-read per create, so PATCHes reach new
					// conversations without a restart.
					agent: storeAgentChange(opened, opened.defaultModel),
				},
				BACKGROUND_CONTEXT,
			);
			// The identity seam: stamp the caller as owner when the request
			// carried one (naive mode — no header, no write).
			await stampSessionOwner(conversation, request.sigrunUser);
			const view = await readView(conversation);
			return await reply.code(201).send({ id: conversation.id, view });
		},
	);

	app.get("/v1/conversations", async (): Promise<ConversationList> => {
		// Durable enumeration: the storage scan is authoritative —
		// conversations this process never created (before a restart, in
		// another process, or by tasks/tools inside pi-durable) all list.
		// `scanConversations` pages ascending by id (creation order); this
		// route is unpaginated v1, so one page at a generous limit covers a
		// deployment-scale set, and the loop below walks the continuation
		// cursor to completion so nothing truncates silently.
		const conversations: ConversationSummary[] = [];
		let cursor: Cursor | undefined = undefined;
		do {
			const page = await opened.storage.scanConversations(
				{ order: "ascending" },
			SCAN_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
			);
			for (const record of page.items) {
				const conversation = await opened.harness.conversation(
					record.id,
					BACKGROUND_CONTEXT,
				);
				// Unresolvable ids (dropped elsewhere) are skipped, not listed.
				if (conversation === undefined) continue;
				const view = await readView(conversation);
				// The session-meta owner rides the summary when stamped
				// (defaults serve nothing — no owner key when unset), and so
				// do the sidebar fields: the display name (user name over
				// auto name), the activity stamp, and the archive/pin flags —
				// one request, no per-row meta fetch.
				const meta = await opened.harness.snapshot(
					SessionMetaDoc,
					conversation.id,
					BACKGROUND_CONTEXT,
				);
				const name = meta?.name ?? meta?.autoName;
				conversations.push({
					id: conversation.id,
					root: conversation.id === rootId,
					entryCount: view.entries.length,
					...(meta?.owner === undefined ? {} : { owner: meta.owner }),
					...(name === undefined ? {} : { name }),
					...(meta?.lastActivityAt === undefined
						? {}
						: { lastActivityAt: meta.lastActivityAt }),
					// Fork lineage from the durable record (the scan page item);
					// a root or plainly created conversation has none.
					...(record.parent === undefined
						? {}
						: {
								parent: {
									id: record.parent.conversationId,
									at: record.parent.at,
								},
							}),
					archived: meta?.archived ?? false,
					pinned: meta?.pinned ?? false,
				});
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return { conversations };
	});

	app.get(
		"/v1/conversations/:id",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply) => {
			const conversation = request.conversation;
			return readView(conversation);
		},
	);

	// Fork: a history fork at one visible entry (spec §5 session
	// management). `at` is the LAST entry id the fork keeps; absent = the
	// newest entry (resolved through the entries query — never 0, which is
	// not a real entry id). The fork inherits the parent's agent model and
	// the same ownerless ownership the create route uses; the response is
	// the create shape: 201 `{id, view}`.
	app.post(
		"/v1/conversations/:id/fork",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (
			request,
			reply,
		): Promise<ConversationCreateResponse> => {
			const conversation = request.conversation;
			// Absent body is valid (`at` defaults to the newest entry); the
			// object may carry ONLY `at` — the compact/configure convention.
			const body: unknown = request.body;
			let at: number | undefined;
			if (body !== undefined && body !== null) {
				if (typeof body !== "object" || Array.isArray(body)) {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				const record = body as Record<string, unknown>;
				const unknownKey = Object.keys(record).find((key) => key !== "at");
				if (unknownKey !== undefined) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: unknownKey });
				}
				if (
					record.at !== undefined &&
					typeof record.at !== "number"
				) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "at" });
				}
				at = record.at;
			}
			if (at === undefined) {
				// The entries query is newest-first: the first item of the first
				// page is the newest entry. An empty page means there is nothing
				// to fork — the parent conversation has no history at all.
				const page = await conversation.entries(
					{},
					1,
					undefined,
					BACKGROUND_CONTEXT,
				);
				if (page.items.length === 0) {
					return await reply.code(400).send({ error: "empty_conversation" });
				}
				at = page.items[0].id;
			} else {
				// Validate `at` against the parent's own history: `fork()` accepts
				// any EntryId, but an id this conversation never had is a client
				// error, not a silent empty fork.
				const page = await conversation.entries(
					{ maxEntryId: at as EntryId },
					1,
					undefined,
					BACKGROUND_CONTEXT,
				);
				const newest = page.items[0];
				if (newest === undefined || newest.id !== at) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "at" });
				}
			}
			// The fork inherits the parent's agent model — read the resolved
			// agent, fall back to the boot default like create.
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			const fork = await conversation.fork(
				at as EntryId,
				{
					ownership: { kind: "ownerless" },
					agent: { model: agent.model ?? opened.defaultModel },
				},
				BACKGROUND_CONTEXT,
			);
			// The fork's sidebar identity: the copied meta doc
			// carries the source's name/autoName and the namer's attempt count;
			// ONE commit drops all three (a fork is a new conversation, not the
			// source's name — and it starts naming-fresh: inheriting an exhausted
			// attempt count would make the fork forever unnameable), re-seeds
			// it with "<source display name> (fork)"
			// as its AUTO name when the source had one, and stamps activity so
			// the fresh fork sorts where it happened.
			const sourceMeta = await opened.harness.snapshot(
				SessionMetaDoc,
				conversation.id,
				BACKGROUND_CONTEXT,
			);
			const sourceName = sourceMeta?.name ?? sourceMeta?.autoName;
			await fork.commit(async (tx) => {
				const draft = await tx.doc(SessionMetaDoc, fork.id);
				delete draft.name;
				delete draft.autoName;
				delete draft.autoNameAttempts;
				if (sourceName !== undefined) draft.autoName = `${sourceName} (fork)`;
				draft.lastActivityAt = opened.now().toISOString();
			}, BACKGROUND_CONTEXT);
			// The fork's identity is the CALLER's, not the source's: the doc
			// copied the parent's owner ("current" fork semantics), the stamp
			// overwrites it; no header → the copy stands.
			await stampSessionOwner(fork, request.sigrunUser);
			const view = await readView(fork);
			return await reply.code(201).send({ id: fork.id, view });
		},
	);

	// Export: the conversation's history as JSONL — pi's portable
	// format. One entry JSON object per line (the same per-entry
	// serialization the view serves), OLDEST-first (the reverse of the
	// newest-first entries query), so an import replays the transcript in
	// order. All history pages, not just the active view.
	app.get(
		"/v1/conversations/:id/export",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply) => {
			const conversation = request.conversation;
			const lines: string[] = [];
			let cursor: Cursor | undefined;
			// Newest-first pages accumulate reversed; emit oldest-first.
			const collected: unknown[] = [];
			do {
				const page = await conversation.entries(
					{},
					200,
					cursor,
					BACKGROUND_CONTEXT,
				);
				collected.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			for (let i = collected.length - 1; i >= 0; i--) {
				lines.push(JSON.stringify(collected[i]));
			}
			return await reply
				.header("content-type", JSONL_CONTENT_TYPE)
				.send(lines.join("\n") + "\n");
		},
	);

	// Import: create a new conversation from JSONL. The body is
	// the RAW JSONL text (the export format, round-tripped); parse line by
	// line, create the conversation the create-route way, then append each
	// parsed entry IN ORDER (oldest-first) inside one commit — fresh entry
	// ids are assigned by storage (`EntryDraft` carries no id).
	app.post(
		"/v1/conversations/import",
		async (
			request,
			reply,
		): Promise<ConversationImportResponse> => {
			const raw = request.body;
			if (typeof raw !== "string") {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const textLines = raw.split("\n");
			// A trailing newline is the export terminator, not an empty line.
			const lines =
				textLines[textLines.length - 1] === ""
					? textLines.slice(0, -1)
					: textLines;
			if (lines.length === 0) {
					return await reply.code(400).send({ error: "invalid_body" });
			}
			const drafts: EntryDraft[] = [];
			for (const [index, line] of lines.entries()) {
				if (line.trim() === "") {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					return await reply
						.code(400)
						.send({ error: "invalid_body", line: index + 1 });
				}
				if (typeof parsed !== "object" || parsed === null) {
					return await reply
						.code(400)
						.send({ error: "invalid_body", line: index + 1 });
			}
				const record = parsed as Record<string, unknown>;
				// An entry line carries `kind` plus the optional model/data/
				// edits payloads — the EntryDraft shape. Stale identity fields
				// (id/conversationId/byTaskId) are dropped: storage assigns
				// fresh ones. A stale `head` EntryId would point at the OLD
				// numbering — drop it too; the default active-context pointer
				// starts at the newest appended entry.
				const draft: EntryDraft = {
					kind: String(record.kind),
					...(Array.isArray(record.model)
						? { model: record.model as EntryDraft["model"] }
						: {}),
					...("data" in record
						? { data: record.data as EntryDraft["data"] }
						: {}),
					...(Array.isArray(record.edits)
						? { edits: record.edits as EntryDraft["edits"] }
						: {}),
			};
				if (draft.kind === "") {
					return await reply
						.code(400)
						.send({ error: "invalid_body", line: index + 1 });
				}
				drafts.push(draft);
			}
			const conversation = await opened.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: storeAgentChange(opened, opened.defaultModel),
				},
				BACKGROUND_CONTEXT,
			);
			// One commit appends every entry in order; the conversation's own
			// commit binds the transaction to this conversation.
			await conversation.commit(async (tx) => {
				for (const draft of drafts) {
					await tx.appendEntry(conversation.id, draft);
				}
			}, BACKGROUND_CONTEXT);
			// The imported conversation is the IMPORTER's, not the source's
			// (the JSONL never carries meta — the stamp is the only owner).
			await stampSessionOwner(conversation, request.sigrunUser);
			const view = await readView(conversation);
			return await reply.code(201).send({ id: conversation.id, view });
		},
	);

	// JSONL bodies (the import route above): raw text, never JSON-parsed —
	// the route itself parses line by line so a bad line is a 400
	// invalid_body, not Fastify's 415 Unsupported Media Type. Content-type-
	// only: onRequest hooks (deploy auth etc.) keep their hook semantics.
	for (const type of [JSONL_CONTENT_TYPE, "text/plain"]) {
		app.addContentTypeParser(
			type,
			{ parseAs: "string" },
			(_request, body, done) => done(null, body),
		);
	}

	// Session meta: the conversation-scoped sidebar resource (spec §5).
	// GET serves the doc — or the defaults when it was never written; a read
	// NEVER materializes the doc (defaults are free; a write-per-read would
	// churn a doc revision on every sidebar poll). PATCH merges per the spec
	// table (null clears, draft sub-merges, tagged replaces wholesale) inside
	// ONE commit callback — the read-modify-write pattern keeps concurrent
	// patches from losing each other's fields (the mutation line serializes
	// commits, mirroring the decide pattern).
	app.get(
		"/v1/conversations/:id/meta",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply): Promise<SessionMeta> => {
			const conversation = request.conversation;
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
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply): Promise<SessionMeta> => {
			const conversation = request.conversation;
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
					...(draft.name === undefined ? {} : { name: draft.name }),
					// The server-owned trio rides the projection when present —
					// a patch must never lose them from the served doc.
					...(draft.autoName === undefined
						? {}
						: { autoName: draft.autoName }),
					...(draft.autoNameAttempts === undefined
						? {}
						: { autoNameAttempts: draft.autoNameAttempts }),
					...(draft.lastActivityAt === undefined
						? {}
						: { lastActivityAt: draft.lastActivityAt }),
				};
			}, BACKGROUND_CONTEXT);
		},
	);
}
