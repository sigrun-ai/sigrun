/**
 * Workspace file routes: upload (a base64 body materialized into the
 * conversation's upload namespace via the workspace env), the read-only
 * directory listing, and file content (text when strictly valid UTF-8,
 * else base64; size-capped). Every route resolves its conversation
 * through the `loadConversation` pre-handler (404 for an unknown id)
 * and reads the workspace through `conversationEnv` — one seam, so a
 * workspace-service swap moves them all at once.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import { isConfinedPath } from "../content-parts.js";
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

/** Register the upload/listing/content workspace file routes. */
export function registerFileRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, config } = ctx;

	// Uploads: materialize a base64 body into the conversation's upload
	// namespace via the workspace env (spec §5: correct for remote workspaces).
	app.post(
		"/v1/conversations/:id/uploads",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply): Promise<UploadResponse> => {
			const conversation = request.conversation;
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
