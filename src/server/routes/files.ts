/**
 * Workspace file routes: upload — the raw §6.2 PUT (octet-stream bytes,
 * `server.maxUploadBytes`-limited) plus the base64 POST it replaces in
 * one release — the read-only directory listing, and file content (text
 * when strictly valid UTF-8, else base64; size-capped). Every route
 * resolves its conversation through the `loadConversation` pre-handler
 * (404 for an unknown id) and reads the workspace through
 * `conversationEnv` — one seam, so a workspace-service swap moves them
 * all at once.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import { isConfinedPath } from "../content-parts.js";
import { base64BodyLimit } from "../../config.js";
import {
	ID_PARAMS_SCHEMA,
	FILE_CONTENT_MAX_BYTES,
	conversationEnv,
	decodeBase64Strict,
} from "../helpers.js";
import type {
	FileContentResponse,
	FileListResponse,
	UploadResponse,
} from "../views.js";

/**
 * The one upload-name rule, shared by the base64 POST body's `name` and
 * the raw PUT's `:name` param: no `/` or `\\`, not `.` or `..`, non-empty.
 * The PUT checks it AFTER Fastify decodes the percent-encoded param
 * (`..%2Fx` arrives as `../x`, `%2e%2e` as `..`) — the check runs on the
 * decoded value, never the raw path text.
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

/** The `:id` + `:name` params of the raw upload route. */
const UPLOAD_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "integer" }, name: { type: "string" } },
	required: ["id", "name"],
	additionalProperties: false,
} as const;

/** Register the upload/listing/content workspace file routes. */
export function registerFileRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, config } = ctx;

	// Raw octet-stream bodies (the upload PUT route below): parse as a
	// buffer, no interpretation. Registered once on the app — the route's
	// own `bodyLimit` carries the knob.
	app.addContentTypeParser(
		"application/octet-stream",
		{ parseAs: "buffer" },
		(_request, body, done) => done(null, body),
	);

	// Uploads (raw): the §6.2 route phone photos need — the body is the
	// file's bytes, the name rides the param, and the route's `bodyLimit`
	// is the `server.maxUploadBytes` knob verbatim (no base64 inflation).
	// An absent content-type defaults to `application/octet-stream` via the
	// route-scoped onRequest below (Fastify would otherwise 415 an untyped
	// non-empty body); the default applies ONLY to this route.
	app.put(
		"/v1/conversations/:id/uploads/:name",
		{
			schema: { params: UPLOAD_PARAMS_SCHEMA },
			// Uploads mutate the conversation: write access (spec §6.2).
			preHandler: loadConversation(ctx, "write"),
			bodyLimit: config.maxUploadBytes,
			onRequest: async (request) => {
				if (request.headers["content-type"] === undefined) {
					request.headers["content-type"] = "application/octet-stream";
				}
			},
		},
		async (request, reply): Promise<UploadResponse> => {
			const conversation = request.conversation;
			const { name } = request.params as { name: string };
			if (!validUploadName(name)) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// Fastify hands the parsed buffer (or nothing for a truly empty
			// body — an empty file is a valid upload).
			const bytes =
				request.body === undefined
					? new Uint8Array(0)
					: new Uint8Array(request.body as Buffer);
			// Same namespace as the base64 route: v1 namespaces uploads per
			// conversation, and the returned path is exactly what a content
			// part takes.
			const path = `uploads/${conversation.id}/${name}`;
			const env = await conversationEnv(opened, conversation);
			const written = await env.writeFile(path, bytes, BACKGROUND_CONTEXT);
			if (!written.ok) {
				// A failed upload is a server-side fault: fail loud.
				throw written.error;
			}
			return await reply.code(201).send({ path });
		},
	);

	// Uploads (base64, one more release): materialize a base64 body into
	// the conversation's upload namespace via the workspace env (spec §5:
	// correct for remote workspaces). The `bodyLimit` is the knob-derived
	// ceiling — the base64 inflation of the capped content plus the JSON
	// wrapper (spec §6.2).
	app.post(
		"/v1/conversations/:id/uploads",
		{
			schema: { params: ID_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx, "write"),
			bodyLimit: base64BodyLimit(config.maxUploadBytes),
		},
		async (request, reply): Promise<UploadResponse> => {
			const conversation = request.conversation;
			const body = request.body as Record<string, unknown> | undefined;
			const name = body?.name;
			const contentBase64 = body?.contentBase64;
			if (
				body === undefined ||
				typeof name !== "string" ||
				!validUploadName(name) ||
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
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply): Promise<FileListResponse> => {
			const conversation = request.conversation;
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
			// pi-durable's listDir returns ABSOLUTE paths (resolve(cwd, name)),
			// but the §5 files/content endpoint requires workspace-RELATIVE
			// paths (isConfinedPath rejects absolute). Relativize each entry
			// against the workspace root so the tree's paths feed back into the
			// content endpoint (a listed file can be read).
			const workspaceRoot = config.workspace.path;
			const entries = listed.value.map((entry) => ({
				...entry,
				path: entry.path.startsWith(`${workspaceRoot}/`)
					? entry.path.slice(workspaceRoot.length + 1)
					: entry.path,
			}));
			return { entries };
		},
	);

	// Files content: text when strictly valid UTF-8, else base64; size-capped.
	app.get(
		"/v1/conversations/:id/files/content",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply): Promise<FileContentResponse> => {
			const conversation = request.conversation;
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
}
