/**
 * Extension asset routes (UI-blocks U3 Task 3, spec §11.1/§7.2):
 * `GET /v1/ext/<slug>/assets/<path>` serves files from the package's
 * declared `sigrun.assets` directory to every signed-in user (assets
 * are public to signed-in users, §11.1). The Content-Type is sniffed
 * from the bytes (never the filename) and every response carries
 * `X-Content-Type-Options: nosniff`.
 *
 * Containment: the requested path resolves against the assets dir and
 * BOTH the dir and the target are `realpath`ed — a `..` segment or a
 * symlink out of the dir answers 404, indistinguishable from a missing
 * file. A package with no declared `sigrun.assets` answers 404 for
 * every asset request.
 */

import { open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { sniffMime } from "../surfaces/mime.js";

/** One read's chunk size for the sniff buffer + small files. */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Resolve one requested asset path inside the package's assets dir:
 * the realpath'd absolute file, or `undefined` when the request escapes
 * the dir (a `..` segment or a symlink out) or the file is missing.
 */
async function resolveContained(
	assetsDir: string,
	path: string,
): Promise<string | undefined> {
	let realDir: string;
	try {
		realDir = await realpath(assetsDir);
	} catch {
		return undefined; // the declared dir doesn't exist
	}
	const candidate = join(realDir, path);
	let realFile: string;
	try {
		realFile = await realpath(candidate);
	} catch {
		return undefined; // missing file (or a dangling symlink)
	}
			const rel = relative(realDir, realFile);
	if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) {
		return undefined;
	}
	return realFile;
}

/** Register the asset route over the shared context's bindings. */
export function registerExtAssetRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.get<{ Params: { slug: string; "*": string } }>(
		"/v1/ext/:slug/assets/*",
		async (request, reply) => {
			const { slug } = request.params;
			const path = request.params["*"];
			const binding = ctx.opened.extensionSurfaces.find(
				(entry) => entry.extension === slug,
			);
			// Unknown slug, or a package with no declared assets dir: 404.
			if (binding?.assetsDir === undefined) {
				return await reply.code(404).send({ error: "asset_not_found" });
			}
			const file = await resolveContained(binding.assetsDir, path);
			if (file === undefined) {
				return await reply.code(404).send({ error: "asset_not_found" });
			}
			const handle = await open(file, "r");
			try {
				const stat = await handle.stat();
				if (!stat.isFile()) {
					return await reply.code(404).send({ error: "asset_not_found" });
				}
				const bytes = Buffer.alloc(stat.size);
				let offset = 0;
				while (offset < bytes.byteLength) {
					const { bytesRead } = await handle.read(
						bytes,
						offset,
						Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset),
						offset,
					);
					if (bytesRead === 0) break;
					offset += bytesRead;
				}
				return await reply
					.header("content-type", sniffMime(new Uint8Array(bytes)))
					.header("x-content-type-options", "nosniff")
					.send(bytes);
			} finally {
				await handle.close();
			}
		},
	);
}
