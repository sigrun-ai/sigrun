/**
 * Extension surface routes (UI-blocks U3 Task 2, spec §7.2): the render
 * and data GETs plus the actions POST, mounted at core's reserved
 * `surfaces/` prefix under `/v1/ext/<slug>/`, behind the W1 auth
 * pipeline like every `/v1` route.
 *
 * - `GET /v1/ext/<slug>/surfaces/<id>?params=<json>` → `{tree, data,
 *   rev, treeRev, access}`; `params` is a JSON object capped at 4 KiB
 *   (spec §15) — anything else is `400 invalid_field params`.
 * - `GET …/data?params=<json>&since=<rev>` → `{rev, treeRev, data}` or
 *   `{rev, treeRev, ops}` when the server holds the ops since `since`
 *   (sharedData surfaces, §7.3).
 * - `POST …/actions` `{action, payload, actionId, params}` → the
 *   handler's `ActionResult` wrapped per §6.3 (an accept carries the
 *   assigned `rev`, plus the `ops` echoed back when it came with an
 *   `update`), deduped per actionId per instance (10-minute window),
 *   rate-limited per principal per surface (20/s burst 40 → 429), and
 *   timed out at 10 s (`{ok:false, error:{message:"timed out"}}`).
 *   Access (§6.5) gates BEFORE the handler runs: `read` → 403, `none`
 *   → 404 `surface_not_found` (indistinguishable from an unknown id).
 * - `PUT …/uploads/<field>/<name>?params` → raw octet-stream body,
 *   capped at the field's `maxBytes` (clamped by
 *   `server.maxUploadBytes`) — over the cap is a 413 answered from the
 *   FIRST chunks, without buffering the rest (the parser destroys the
 *   request stream, so the socket never sees the remainder). The
 *   `onUpload` handler receives `{field, name, mime, bytes}` with the
 *   MIME sniffed from the bytes (never the client name).
 *
 * Errors: a render/data throw or an invalid tree is
 * `500 surface_failed` (logged here; the response body carries the
 * validation `errors` only when `server.dev` is true, spec §14.2). The
 * extension stays loaded.
 */

import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";
import type { Principal } from "../auth/principal.js";
import type { ServerContext } from "../context.js";
import { instanceKey } from "../surfaces/instance.js";
import {
	ActionRateLimitedError,
	SurfaceFailedError,
	UnknownActionError,
} from "../surfaces/service.js";
import { applyChatAction, chatActionStartsTurn, readChatBlock, resolveChatHandlers } from "../blocks/chat-surfaces.js";
import { answerBlock } from "../blocks/answers.js";
import { accessOf } from "@sigrun/shared/access";
import { accessPrincipalOf } from "../auth/access-principal.js";
import { SessionMetaDoc } from "../session-meta.js";
import { conversationId as brandConversationId } from "../helpers.js";

/**
 * The one upload-name rule, shared with core's conversation upload
 * route (files.ts §6.2 — kept in sync by hand): no `/` or `\\`, not
 * `.` or `..`, non-empty. Fastify has already percent-DECODED the
 * `:name` param, so `%2e%2e` arrives as `..` and is rejected.
 */
function validUploadName(name: string): boolean {
	return (
		name.length > 0 &&
		!name.includes("/") &&
		!name.includes("\\") &&
		name !== "." &&
		name !== ".."
	);
}

/** The params cap (spec §15): 4 KiB of JSON text. */
export const PARAMS_MAX_BYTES = 4096;

/** The upload preParsing hook's per-request handoff to the handler. */
interface UploadGate {
	readonly cap: number;
	readonly key: string;
	readonly params: JsonObject;
	/** Set when the stream-side cap tripped (a truncated body). */
	tripped: boolean;
}

/** The per-request gate record (preParsing → handler). */
type UploadCaps = WeakMap<FastifyRequest, UploadGate>;

/** The not-found body — shared by unknown ids and `access: "none"`. */
const NOT_FOUND = { error: "surface_not_found" } as const;

/**
 * Parse the `?params=` query value: absent → `{}`; present must decode
 * as a JSON OBJECT within the 4 KiB cap. Returns the object or the
 * error body (`invalid_field params`).
 */
function parseParams(
	raw: unknown,
): { ok: true; params: JsonObject } | { ok: false } {
	if (raw === undefined) return { ok: true, params: {} };
	if (typeof raw !== "string") return { ok: false };
	if (Buffer.byteLength(raw, "utf8") > PARAMS_MAX_BYTES) return { ok: false };
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		return { ok: false };
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
		return { ok: false };
	}
	return { ok: true, params: decoded as JsonObject };
}

/** Parse `?since=`: absent → undefined; a non-negative integer else. */
function parseSince(raw: unknown): number | undefined | null {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
	return Number.parseInt(raw, 10);
}

/** Register the surface routes over the shared context's service. */
export function registerSurfaceRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { surfaces } = ctx;
	const uploadCaps: UploadCaps = new WeakMap();

	/** The shared failure mapping (logged; errors only under server.dev). */
	const failureReply = async (
		reply: FastifyReply,
		slug: string,
		id: string,
		cause: unknown,
	): Promise<FastifyReply> => {
		const failed =
			cause instanceof SurfaceFailedError
				? cause
				: new SurfaceFailedError(
						cause instanceof Error ? cause.message : String(cause),
					);
		console.warn(
			`surface failed: ${slug}/${id}: ${failed.message}${
				failed.errors === undefined
					? ""
					: ` (${failed.errors.map((e) => `${e.path}: ${e.message}`).join("; ")})`
			}`,
		);
		return reply.code(500).send({
			error: "surface_failed",
			...(ctx.config.dev && failed.errors !== undefined
				? { errors: failed.errors }
				: {}),
		});
	};

	app.get<{ Params: { slug: string; id: string }; Querystring: { params?: string } }>(
		"/v1/ext/:slug/surfaces/:id",
		async (request, reply) => {
			const { slug, id } = request.params;
			const parsed = parseParams(request.query.params);
			if (!parsed.ok) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "params" });
			}
			try {
				const result = await surfaces.render(
					request.params.slug,
					id,
					parsed.params,
					request.principal,
					request.headers["x-sigrun-stream"] as string | undefined,
				);
				if (result === undefined) {
					return await reply.code(404).send(NOT_FOUND);
				}
				return await reply.send(result);
			} catch (cause) {
				return await failureReply(reply, slug, id, cause);
			}
		},
	);

	app.get<{
		Params: { slug: string; id: string };
		Querystring: { params?: string; since?: string };
	}>("/v1/ext/:slug/surfaces/:id/data", async (request, reply) => {
		const { slug, id } = request.params;
		const parsed = parseParams(request.query.params);
		if (!parsed.ok) {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: "params" });
		}
		const since = parseSince(request.query.since);
		if (since === null) {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: "since" });
		}
		try {
			const result = await surfaces.data(
				slug,
				id,
				parsed.params,
				request.principal,
				since,
				request.headers["x-sigrun-stream"] as string | undefined,
			);
			if (result === undefined) {
				return await reply.code(404).send(NOT_FOUND);
			}
			return await reply.send(result);
		} catch (cause) {
			return await failureReply(reply, slug, id, cause);
		}
	});

	app.post<{
		Params: { slug: string; id: string };
		Body: {
			action?: unknown;
			payload?: unknown;
			actionId?: unknown;
			params?: unknown;
		};
	}>("/v1/ext/:slug/surfaces/:id/actions", async (request, reply) => {
		const { slug, id } = request.params;
		const body = request.body ?? {};
		if (typeof body.action !== "string") {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: "action" });
		}
		let params: JsonObject = {};
		if (body.params !== undefined) {
			const encoded = JSON.stringify(body.params);
			if (
				typeof body.params !== "object" ||
				body.params === null ||
				Array.isArray(body.params) ||
				Buffer.byteLength(encoded, "utf8") > PARAMS_MAX_BYTES
			) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "params" });
			}
			params = body.params as JsonObject;
		}
		// The §6.5 access gate: cache or re-render decides BEFORE the
		// handler runs. A located-check first keeps unknown slugs/ids on
		// the same 404 body without a render; a throwing extension
		// `instanceKey` is a 500 (the extension-fault path). The service's
		// locate covers the settings surfaces too (spec §13.4).
		let key: string;
		try {
			const probe = surfaces.instanceKeyFor(slug, id, params);
			if (probe === undefined) {
				return await reply.code(404).send(NOT_FOUND);
			}
			key = probe;
		} catch (cause) {
			return await failureReply(reply, slug, id, cause);
		}
		let access: string;
		try {
			access = await surfaces.accessFor(
				slug,
				id,
				key,
				params,
				request.principal as Principal,
			);
		} catch (cause) {
			return await failureReply(reply, slug, id, cause);
		}
		if (access === "none") {
			return await reply.code(404).send(NOT_FOUND);
		}
		if (access === "read") {
			return await reply.code(403).send({ error: "forbidden" });
		}
		try {
			const result = await surfaces.act(
				slug,
				id,
				key,
				params,
				request.principal,
				body.action,
				body.payload,
				typeof body.actionId === "string" ? body.actionId : undefined,
				request.signal,
			);
			return await reply.send(result);
		} catch (cause) {
			if (cause instanceof UnknownActionError) {
				return await reply.code(400).send({ error: "unknown_action" });
			}
			if (cause instanceof ActionRateLimitedError) {
				return await reply.code(429).send({ error: "rate_limited" });
			}
			return await failureReply(reply, slug, id, cause);
		}
	});

	/**
	 * The upload route (spec §7.2). The gate + cap resolution run in
	 * `preParsing` — AFTER the headers, BEFORE the body is read. The cap
	 * is enforced by the route itself, not Fastify's bodyLimit: the hook
	 * wraps the payload in a PassThrough counter that forwards chunks up
	 * to the resolved field cap (`maxBytes` from the last rendered tree,
	 * clamped by `server.maxUploadBytes`); the first over-cap chunk sends
	 * `413 {error:"too_large", maxBytes}` DIRECTLY from the hook and
	 * then destroys the request socket (the reply is sent first —
	 * destroying the socket before the reply lands makes Node drop the
	 * response), so the sender's remaining bytes are never written
	 * (Review Focus 5). The handler itself only validates the name and
	 * dispatches to `onUpload`.
	 */
	app.put<{
		Params: { slug: string; id: string; field: string; name: string };
		Querystring: { params?: string };
	}>(
		"/v1/ext/:slug/surfaces/:id/uploads/:field/:name",
		{
			// Untyped non-empty bodies would 415 (files.ts' identical
			// default): uploads arrive raw.
			onRequest: async (request) => {
				if (request.headers["content-type"] === undefined) {
					request.headers["content-type"] = "application/octet-stream";
				}
			},
			preParsing: async (request, reply, payload) => {
				const { slug, id, field } = request.params;
				const parsed = parseParams(request.query.params);
				if (!parsed.ok) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "params" });
				}
			let key: string;
			try {
				const probe = surfaces.instanceKeyFor(slug, id, parsed.params);
				if (probe === undefined) {
					return await reply.code(404).send(NOT_FOUND);
				}
				key = probe;
			} catch (cause) {
				return await failureReply(reply, slug, id, cause);
			}
				// The §6.5 access gate, BEFORE the body is consumed.
				let access: string;
				try {
					access = await surfaces.accessFor(
						slug,
						id,
						key,
						parsed.params,
						request.principal as Principal,
					);
				} catch (cause) {
					return await failureReply(reply, slug, id, cause);
				}
				if (access === "none") {
					return await reply.code(404).send(NOT_FOUND);
				}
				if (access === "read") {
					return await reply.code(403).send({ error: "forbidden" });
				}
				// The cap: the field's declared maxBytes (from the last
				// rendered tree) clamped by server.maxUploadBytes. An
				// instance that was never rendered has no recorded caps —
				// re-render to fill them. Unknown field → 400.
				let cap = surfaces.uploadCapBytes(slug, id, key, field);
				if (cap === undefined) {
					try {
						await surfaces.render(
							slug,
							id,
							parsed.params,
							request.principal,
						);
					} catch (cause) {
						return await failureReply(reply, slug, id, cause);
					}
					cap = surfaces.uploadCapBytes(slug, id, key, field);
				}
				if (cap === undefined) {
					return await reply.code(400).send({ error: "unknown_field" });
				}
				// A declared content-length already over the cap: answer
				// 413 without touching the body (Fastify never reads it;
				// the connection-close header drops the socket).
				const declared = Number(request.headers["content-length"]);
				if (Number.isFinite(declared) && declared > cap) {
					reply.header("connection", "close");
					return await reply
						.code(413)
						.send({ error: "too_large", maxBytes: cap });
				}
				uploadCaps.set(request, { cap, key, params: parsed.params, tripped: false });
				// The chunked cut-off (Review Focus 5): wrap the payload in a
				// counter whose first over-cap chunk destroys the request
				// socket (the client's remaining chunks are never written) and
				// sends the 413 DIRECTLY — answering from the hook, not the
				// handler, because the handler only runs after the (destroyed)
				// body finishes. The handler's `gate.tripped` check below
				// stays as the in-process belt (an inject path never trips the
				// stream).
				const gate = uploadCaps.get(request);
				if (gate === undefined) {
					return payload;
				}
				let received = 0;
				const capped = new PassThrough();
				payload.on("data", (chunk: Buffer) => {
					if (gate.tripped) return;
					received += chunk.byteLength;
					if (received > gate.cap) {
						gate.tripped = true;
						// The reply first, then the socket: destroying the
						// request stream before the reply lands makes Node drop
						// the response entirely.
						void reply
							.code(413)
							.send({ error: "too_large", maxBytes: gate.cap });
						// Destroy the counter too: the parser keeps buffering the
						// already-forwarded prefix while it believes the stream is
						// still live.
						setImmediate(() => {
							payload.destroy();
							capped.destroy();
						});
						return;
					}
					capped.write(chunk);
				});
				payload.on("end", () => capped.end());
				payload.on("error", () => capped.end());
				return capped;
			},
		},
		async (request, reply) => {
			const { slug, id, field, name } = request.params;
			const gate = uploadCaps.get(request);
			uploadCaps.delete(request);
			if (gate === undefined) {
				// unreachable (the preParsing hook short-circuits every
				// failure); defend anyway.
				return await reply.code(404).send(NOT_FOUND);
			}
			// The one upload-name rule, shared with core's conversation
			// uploads (files.ts §6.2): no separators, not `.`/`..`, on the
			// DECODED param.
			if (!validUploadName(name)) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const binding = ctx.opened.extensionSurfaces.find(
				(entry) => entry.extension === slug,
			);
			const def = binding?.defs.find((entry) => entry.id === id);
			if (def === undefined) {
				return await reply.code(404).send(NOT_FOUND);
			}
			const bytes =
				request.body === undefined
					? new Uint8Array(0)
					: new Uint8Array(request.body as Buffer);
			// The stream-side cap tripped (a chunked body cut off mid-way):
			// the body never arrived intact — answer the 413.
			if (gate.tripped) {
				return await reply
					.code(413)
					.send({ error: "too_large", maxBytes: gate.cap });
			}
			try {
				const result = await surfaces.upload(
					slug,
					id,
					gate.key,
					gate.params,
					request.principal,
					field,
					name,
					bytes,
					request.signal,
				);
				return await reply.send(result);
			} catch (cause) {
				if (cause instanceof UnknownActionError) {
					return await reply.code(400).send({ error: "unknown_action" });
				}
				return await failureReply(reply, slug, id, cause);
			}
		},
	);

	// ── Chat block surfaces (UI-blocks U5 Task 2, spec §8.2) ──────────────
	// A chat block reuses this machinery with CORE as the handler: the
	// address is (conversationId, entryId), access is the CONVERSATION's
	// (write edits; read sees; hidden is 404 — indistinguishable from an
	// unknown conversation), and ops are kept/returned like sharedData
	// (chat data is the same for everyone who can see the conversation).

	/** One conversation's access for the caller (§5.9; the pre-handler's
	 *  same resolution, inlined because the routes below own the body). */
	const conversationAccess = async (
		id: number,
		principal: Principal,
	): Promise<"none" | "read" | "write" | undefined> => {
		const conversation = await ctx.opened.harness.conversation(
				brandConversationId(id),
				BACKGROUND_CONTEXT,
		);
		if (conversation === undefined) return undefined;
		const meta = await ctx.opened.harness.snapshot(
				SessionMetaDoc,
				conversation.id,
				BACKGROUND_CONTEXT,
		);
		return accessOf(
				accessPrincipalOf(principal, ctx.opened.identity.users),
				meta ?? {},
		);
	};

	/** The chat-block route params: one integer id + one entryId. */
	const BLOCK_PARAMS_SCHEMA = {
		type: "object",
		properties: { id: { type: "integer" }, entryId: { type: "string", pattern: "^[0-9]+$" } },
		required: ["id", "entryId"],
		additionalProperties: false,
	} as const;

	app.get<{ Params: { id: number; entryId: string } }>(
		"/v1/conversations/:id/blocks/:entryId",
		{ schema: { params: BLOCK_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id, entryId } = request.params;
			const access = await conversationAccess(id, request.principal);
			if (access === undefined || access === "none") {
				return await reply.code(404).send({ error: "conversation_not_found" });
			}
			const block = await readChatBlock(
				ctx.opened.harness,
				id,
				entryId,
			);
			if (block === undefined) {
				return await reply.code(404).send({ error: "block_not_found" });
			}
			return await reply.send({
				tree: block.tree,
				data: block.state.data,
				rev: block.state.rev,
				treeRev: 0,
				access,
			});
		},
	);

	app.get<{
		Params: { id: number; entryId: string };
		Querystring: { since?: string };
	}>(
		"/v1/conversations/:id/blocks/:entryId/data",
		{ schema: { params: BLOCK_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id, entryId } = request.params;
			const access = await conversationAccess(id, request.principal);
			if (access === undefined || access === "none") {
				return await reply.code(404).send({ error: "conversation_not_found" });
			}
			const block = await readChatBlock(
				ctx.opened.harness,
				id,
				entryId,
			);
			if (block === undefined) {
				return await reply.code(404).send({ error: "block_not_found" });
			}
			const since = parseSince(request.query.since);
			if (since === null) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "since" });
			}
			// The sharedData answer (§7.3): ops since `since` while the kept
			// window still covers it AND the in-memory rev matches the durable
			// one just read; anything else is the full data.
			const delta =
				since === undefined
					? undefined
					: ctx.surfaces.chatOpsSince(
							{ conversationId: id, entryId },
						since,
						block.state.rev,
					);
			if (delta !== undefined) {
				return await reply.send({ rev: delta.rev, treeRev: 0, ops: delta.ops });
			}
			return await reply.send({
				rev: block.state.rev,
				treeRev: 0,
				data: block.state.data,
			});
		},
	);

	app.post<{
		Params: { id: number; entryId: string };
		Body: { action?: unknown; payload?: unknown; actionId?: unknown };
	}>(
		"/v1/conversations/:id/blocks/:entryId/actions",
		{ schema: { params: BLOCK_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id, entryId } = request.params;
			const body = request.body ?? {};
			if (typeof body.action !== "string") {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "action" });
			}
			const actionId =
				typeof body.actionId === "string" ? body.actionId : undefined;
			// The conversation's access gates BEFORE anything runs (§6.5/
			// §8.2): hidden is the conversation 404, read is 403.
			const access = await conversationAccess(id, request.principal);
			if (access === undefined || access === "none") {
				return await reply.code(404).send({ error: "conversation_not_found" });
			}
			if (access === "read") {
				return await reply.code(403).send({ error: "forbidden" });
			}
			// An unknown entry id: the same 404 as the GETs (§8.2 mirrors
			// §7.2's not-found posture).
			const block = await readChatBlock(
				ctx.opened.harness,
				id,
				entryId,
			);
			if (block === undefined) {
				return await reply.code(404).send({ error: "block_not_found" });
			}
			// U3's action gates, over the chat address: rate limit then dedup
			// (the ordering the ext route chose — a replayed actionId still
			// costs a token).
			const address = { conversationId: id, entryId } as const;
			if (!ctx.surfaces.chatTakeToken(address, request.principal.user ?? "")) {
				return await reply.code(429).send({ error: "rate_limited" });
			}
			const fingerprint = JSON.stringify({ action: body.action, payload: body.payload });
			if (actionId !== undefined) {
				const hit = ctx.surfaces.chatDedupCheck(actionId, address, fingerprint);
				if (hit !== undefined && hit !== null) return await reply.send(hit);
			}
		// A handler name no node in the tree declares is unknown
			// (validateTree's handlers-set check, applied at route time:
			// chat names are free labels).
			if (!resolveChatHandlers(block.tree).has(body.action)) {
				return await reply.code(400).send({ error: "unknown_action" });
			}
			// The answer path (§8.4): a turn action submits a user message
			// through `submitOp` for the acting user — the fold and the
			// `notedThrough` advance happen inside `answerBlock`. The §6.3
			// response wraps no ops (the surface's data is unchanged by the
			// answer itself; the channel already applied the optimistic edits
			// that produced the payload).
			if (chatActionStartsTurn(block.tree, body.action)) {
				const answerPayload = (body.payload ?? null) as JsonValue;
				const wrapped = { ok: true as const, rev: block.state.rev };
				await answerBlock(
						ctx,
						id,
						entryId,
						body.action,
						answerPayload,
						actionId,
				);
				if (actionId !== undefined) {
						ctx.surfaces.chatDedupRecord(actionId, address, fingerprint, wrapped);
				}
				return await reply.send(wrapped);
			}
			const outcome = await applyChatAction(
				ctx.opened.harness,
				id,
				entryId,
				request.principal.user ?? "",
				body.action,
				(body.payload ?? null) as JsonValue,
			);
			if (outcome === undefined) {
				return await reply.code(404).send({ error: "block_not_found" });
			}
			if (!outcome.ok) {
				return await reply.send(outcome);
			}
			// Record the ops (sharedData semantics: the kept window) and the
			// dedup entry, then answer the §6.3 accept-with-ops shape.
			const wrapped = {
				ok: true as const,
				rev: outcome.rev,
				ops: outcome.ops,
			};
			ctx.surfaces.announceChatRev(address, outcome.rev, {
				ops: outcome.ops as unknown[],
			});
			if (actionId !== undefined) {
				ctx.surfaces.chatDedupRecord(actionId, address, fingerprint, wrapped);
			}
			return await reply.send(wrapped);
		},
	);
}
