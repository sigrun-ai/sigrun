/**
 * Conversation lifecycle routes: create, list, get, fork, export, import,
 * and the session-meta sidebar resource — plus the JSONL body parser the
 * import route reads its raw text through. Every `:id` route resolves its
 * conversation through the `loadConversation` pre-handler (404 for an
 * unknown id, before any body validation); the no-`id` routes (create,
 * list, import) take no pre-handler.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor, EntryDraft } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { accessPrincipalOf } from "../auth/access-principal.js";
import {
	ConversationOpError,
	createConversationOp,
	forkOp,
	listConversationsOp,
	patchMetaOp,
	readMetaOp,
	type ListConversationsFilters,
} from "../conversation-ops.js";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import {
	ID_PARAMS_SCHEMA,
	readView,
	stampSessionOwner,
	storeAgentChange,
} from "../helpers.js";
import type { SessionMeta } from "../session-meta.js";
import {
	JSONL_CONTENT_TYPE,
	type ConversationCreateResponse,
	type ConversationImportResponse,
	type ConversationList,
} from "../views.js";
import { base64BodyLimit } from "../../config.js";

/** Register the conversation lifecycle + session-meta routes. */
export function registerConversationRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;
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
			// The shared create op (W5 Task 5): the SAME code path the
			// extension host bridge drives — ownerless ownership, the boot
			// default model + store agent settings, and the identity seam's
			// owner stamp. The source is the HTTP-create label ("user").
			const created = await createConversationOp(ctx, {
				...(request.principal.user === undefined
					? {}
					: { owner: request.principal.user }),
				source: "user",
			});
			return await reply.code(201).send(created);
		},
	);

	app.get("/v1/conversations", async (request, reply): Promise<ConversationList> => {
		// Durable enumeration: the storage scan is authoritative —
		// conversations this process never created (before a restart, in
		// another process, or by tasks/tools inside pi-durable) all list.
		// §5.9: the list is PER-CALLER — conversations the caller may not
		// see (accessOf "none") are filtered out entirely (hidden is absent
		// from lists, not just 404s), and every served row carries the
		// caller's resolved access.
		//
		// The shared list op (W5 Task 5): the SAME code path the extension
		// host bridge drives — lean by construction (spec §7.2 / W3 Task 2:
		// scan record + SessionMetaDoc snapshot alone, no per-row view
		// read, so a sidebar poll never re-reads transcripts).
		//
		// Query filters: `archived=true|false` (absent = all) and
		// `mine=true` (owner === the caller). Strict booleans — anything
		// else is a fail-loud 400, the same posture as body validation.
		const query = request.query as Record<string, unknown>;
		for (const field of ["archived", "mine"] as const) {
			const value = query[field];
			if (
				value !== undefined &&
				value !== "true" &&
				value !== "false"
			) {
				return await reply.code(400).send({ error: "invalid_field", field });
			}
		}
		const filters: ListConversationsFilters = {
			...(query.archived === undefined
				? {}
				: { archivedOnly: query.archived === "true" }),
			...(query.mine === "true" ? { mine: true } : {}),
		};
		const conversations = await listConversationsOp(
			ctx,
			accessPrincipalOf(request.principal, opened.identity.users),
			filters,
		);
		return { conversations };
	});

	app.get(
		"/v1/conversations/:id",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request) => {
			const conversation = request.conversation;
			return readView(conversation);
		},
	);

	// Fork: a history fork at one visible entry (spec §5 session
	// management). The shared fork op (gateway C4a) is the SAME code path
	// the host bridge drives — `at` validation against the parent history,
	// the empty_conversation guard, the agent-model inherit, and the fork
	// meta commit (owner reset + "<source> (fork)" autoName +
	// lastActivityAt) live in the op; this route owns the body shape and
	// the 201. The response is the create shape: `{id, view}`.
	app.post(
		"/v1/conversations/:id/fork",
		{
			schema: { params: ID_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx, "write"),
		},
		async (
			request,
			reply,
		): Promise<ConversationCreateResponse> => {
			// Absent body is valid (`at` defaults to the newest entry); the
			// object may carry ONLY `at` — the compact/configure convention.
			const body: unknown = request.body;
			let at: unknown;
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
				at = record.at;
				if (at !== undefined && typeof at !== "number") {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "at" });
				}
			}
			try {
				// The route passes the principal's user as the fork's owner (the
				// host passes its own opts.owner; undefined = the key removed).
				const forked = await forkOp(ctx, request.conversation, {
					...(at === undefined ? {} : { at }),
					...(request.principal.user === undefined
						? {}
						: { owner: request.principal.user }),
				});
				return await reply.code(201).send(forked);
			} catch (error) {
				if (error instanceof ConversationOpError) {
					return await reply.code(error.status).send(error.body);
				}
				throw error;
			}
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
		// Same knob-derived ceiling as the base64 upload route (spec §6.2):
		// the JSONL text may be as large as the knob-derived body without
		// hitting Fastify's 1 MiB default.
		{ bodyLimit: base64BodyLimit(ctx.config.maxUploadBytes) },
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
			await stampSessionOwner(conversation, request.principal.user, opened);
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
		async (request): Promise<SessionMeta> => {
			const conversation = request.conversation;
			// The shared read op (W5 Task 5): absent doc → defaults, served
			// (never written — a read that wrote would churn a doc revision
			// on every sidebar poll).
			return await readMetaOp(opened, conversation.id);
		},
	);

	app.patch(
		"/v1/conversations/:id/meta",
		{
			schema: { params: ID_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx, "write"),
		},
		async (request, reply): Promise<SessionMeta> => {
			// The shared patch op (gateway C4a) is the SAME code path the
			// host bridge drives — validate-first, the owner-or-superuser
			// sharing gate (the route passes its principal; the host passes
			// none, trusted), the one-commit merge, and the post-commit
			// snapshot response all live in the op. This route owns the HTTP
			// mapping only.
			try {
				return await patchMetaOp(ctx, request.conversation, request.body, {
					principal: request.principal,
				});
			} catch (error) {
				if (error instanceof ConversationOpError) {
					return await reply.code(error.status).send(error.body);
				}
				throw error;
			}
		},
	);
}
