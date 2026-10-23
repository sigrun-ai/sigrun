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
 *   handler's `ActionResult`, gated by the per-principal access cache
 *   (§6.5): `read` → 403, `none` → 404 `surface_not_found`
 *   (indistinguishable from an unknown id), a miss re-renders before
 *   deciding.
 *
 * Errors: a render/data throw or an invalid tree is
 * `500 surface_failed` (logged here; the response body carries the
 * validation `errors` only when `server.dev` is true, spec §14.2). The
 * extension stays loaded.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { JsonObject } from "@sigrun/shared/blocks";
import type { Principal } from "../auth/principal.js";
import type { ServerContext } from "../context.js";
import { instanceKey } from "../surfaces/instance.js";
import { SurfaceFailedError } from "../surfaces/service.js";

/** The params cap (spec §15): 4 KiB of JSON text. */
export const PARAMS_MAX_BYTES = 4096;

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
	const key =
			def.instanceKey !== undefined
				? def.instanceKey(params)
				: instanceKey(params);
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
		const handler = def.actions?.[body.action];
		if (handler === undefined) {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: "action" });
		}
		try {
			const result = await handler(
				{
					principal: request.principal,
					params,
					key,
					signal: request.raw.signal ?? new AbortController().signal,
				},
				body.payload as never,
			);
			if (result.ok && result.update !== undefined) {
				surfaces.bumpRev(slug, id, key, result.update);
			}
			return await reply.send(result);
		} catch (cause) {
			return await failureReply(reply, slug, id, cause);
		}
	});
}
