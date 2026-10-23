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
import type { JsonObject } from "@sigrun/shared/blocks";
import type { Principal } from "../auth/principal.js";
import type { ServerContext } from "../context.js";
import { instanceKey } from "../surfaces/instance.js";
import {
	ActionRateLimitedError,
	SurfaceFailedError,
	UnknownActionError,
} from "../surfaces/service.js";

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
		// the same 404 body without a render.
		const binding = ctx.opened.extensionSurfaces.find(
			(entry) => entry.extension === slug,
		);
		const def = binding?.defs.find((entry) => entry.id === id);
		if (def === undefined) {
			return await reply.code(404).send(NOT_FOUND);
		}
		// A throwing `instanceKey` is an extension fault: 500
		// surface_failed, the extension stays loaded (deferred minor from
		// Task 2 — this ran outside the try before).
		let key: string;
		try {
			key =
				def.instanceKey !== undefined
					? def.instanceKey(params)
					: instanceKey(params);
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
	 * `preParsing` — AFTER the headers, BEFORE the body is read — and
	 * the resolved field cap (`maxBytes` from the last rendered tree,
	 * clamped by `server.maxUploadBytes`) stamps
	 * `request.routeOptions.bodyLimit` (Fastify reads it at parse time),
	 * so the octet-stream parser enforces the cap MID-STREAM: an
	 * over-cap chunked body trips FST_ERR_CTP_BODY_TOO_LARGE at the cap
	 * byte, destroying the socket before the sender's end is written
	 * (Review Focus 5), and the app's error handler answers the shared
	 * `413 {error:"too_large", maxBytes}`. The handler itself only
	 * validates the name and dispatches to `onUpload`.
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
				const binding = ctx.opened.extensionSurfaces.find(
					(entry) => entry.extension === slug,
				);
				const def = binding?.defs.find((entry) => entry.id === id);
				if (def === undefined) {
					return await reply.code(404).send(NOT_FOUND);
				}
				let key: string;
				try {
					key =
						def.instanceKey !== undefined
							? def.instanceKey(parsed.params)
							: instanceKey(parsed.params);
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
						setImmediate(() => {
							payload.destroy();
							capped.end();
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
}
