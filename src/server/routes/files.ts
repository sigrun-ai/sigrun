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
	ConversationOpError,
	readFileMetaOp,
	uploadOp,
	validUploadName,
} from "../conversation-ops.js";
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

/** The raw read's streaming chunk size (1 MiB): bounds reader memory. */
const RAW_READ_CHUNK_BYTES = 1024 * 1024;

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
			// The route pre-validates to keep its exact wire body
			// (`invalid_body`); the shared op's own `invalid_field` check is
			// unreachable here by construction (the gateway C4b ruling: the op
			// is the one validator, the routes keep byte-identical responses).
			if (!validUploadName(name)) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// Fastify hands the parsed buffer (or nothing for a truly empty
			// body — an empty file is a valid upload).
			const bytes =
				request.body === undefined
					? new Uint8Array(0)
					: new Uint8Array(request.body as Buffer);
			const { path } = await uploadOp(ctx, conversation, { name, bytes });
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
			// The shared op owns the pathing + write (same namespace as the
			// raw route: `uploads/<conversationId>/<name>`, exactly what a
			// content part takes).
			const { path } = await uploadOp(ctx, conversation, {
				name,
				bytes: new Uint8Array(bytes),
			});
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
				return await reply.code(413).send({
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

	// Files raw (spec §7.8, core hardening W3 Task 7): the bounded raw
	// read the workspace file surface serves when a file is bigger (or
	// binary-er) than files/content's 1 MiB text/base64 cap — phone photos
	// a client wants to RENDER, export blobs, whatever the agent wrote.
	// Semantics: `isConfinedPath` (the content route's rule — `../x` and
	// absolute paths are 400 `invalid_path`); a directory is 400
	// `invalid_path` (Review Focus 5: rejected explicitly, never streamed);
	// over `server.maxFileReadBytes` is 413 `file_too_large` + `maxBytes`;
	// otherwise CHUNKS from `env.openBinaryReader` (never `readBinaryFile`
	// — the whole point is not buffering the file in memory) stream into
	// `reply.raw` with the extension-derived `content-type` and an exact
	// `content-length`. The symlink policy is unchanged from
	// files/content: the default (follows-symlinks) reader.
	app.get(
		"/v1/conversations/:id/files/raw",
		{
			schema: { params: ID_PARAMS_SCHEMA },
			preHandler: loadConversation(ctx),
		},
		async (request, reply) => {
			const conversation = request.conversation;
			const query = request.query as { path?: string };
			const path = query.path ?? "";
			// The shared raw-read pre-checks (gateway C4b): confinement,
			// not_found, directory, and the cap — the SAME vocabulary this
			// route served inline; only the cap's BODY differs (the route's
			// `file_too_large` + `maxBytes`, not the op's `too_large`), mapped
			// here so the wire stays byte-identical.
			let meta: Awaited<ReturnType<typeof readFileMetaOp>>;
			try {
				meta = await readFileMetaOp(ctx, conversation, path);
			} catch (error) {
				if (error instanceof ConversationOpError) {
					if (error.status === 413 && error.body.error === "too_large") {
						return await reply.code(413).send({
							error: "file_too_large",
							maxBytes: config.maxFileReadBytes,
						});
					}
					return await reply.code(error.status).send(error.body);
				}
				throw error;
			}
			const readerOpened = await meta.env.openBinaryReader(
				path,
				undefined,
				BACKGROUND_CONTEXT,
			);
			if (!readerOpened.ok) {
				if (readerOpened.error.code === "not_found") {
					return await reply.code(404).send({ error: "not_found" });
				}
					throw readerOpened.error;
			}
			const reader = readerOpened.value;
			// Hijack BEFORE the first write: every reply.send above ran on the
			// normal path, but from here the response is raw bytes the JSON
			// layer must not touch. All headers are known by now (size is).
			reply.hijack();
			const raw = reply.raw;
			raw.on("error", () => {});
			try {
				raw.writeHead(200, {
					"content-type": meta.mime,
					"content-length": String(meta.size),
				});
				for (let offset = 0; offset < meta.size; offset += RAW_READ_CHUNK_BYTES) {
					const chunk = await reader.read(
					offset,
						Math.min(RAW_READ_CHUNK_BYTES, meta.size - offset),
						BACKGROUND_CONTEXT,
					);
					if (!chunk.ok) throw chunk.error;
					raw.write(Buffer.from(chunk.value));
			}
				raw.end();
			} catch (error) {
				// The raw 'error' handler above already swallows socket teardown;
			// anything reaching THIS catch is a read-side failure mid-stream
				// (headers already sent — the log is the honest record, the
				// destroy the honest wire signal).
				console.warn(
					`sigrun: files/raw ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
				raw.destroy();
			} finally {
				await reader.close(BACKGROUND_CONTEXT).catch(() => {});
			}
		},
	);
}
