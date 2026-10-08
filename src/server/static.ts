/**
 * The webui channel-bundle serving seam (Task 20, spec §4.1/§6).
 *
 * The M2 webui is a CHANNEL BUNDLE: deploy-time static assets (the vite build
 * of the `webui/` workspace package), never a runtime extension, never
 * quarantined. This module resolves the bundle from config and, when present,
 * mounts it at `/` via `@fastify/static` with an SPA fallback:
 *
 * - `GET /` and asset paths serve from the bundle root (fastify-static's
 *   default index behavior);
 * - unknown GETs outside `/v1` serve the bundle's `index.html` so
 *   client-side-route deep links work (the standard SPA fallback) — the
 *   index document is read ONCE at resolve time (a channel bundle is a
 *   deploy-time asset; a redeploy restarts the process, so there is no
 *   per-request fs read and no stale-content window);
 * - `/v1/*` unknowns (and non-GET unknowns) keep Fastify's default-shape 404
 *   JSON, so the API error surface is identical with or without a bundle.
 *
 * Presence policy (documented in the task-20 report): an ABSENT default-path
 * bundle is a supported API-only deploy (no mount, `capabilities.channels`
 * []); an EXPLICIT `SIGRUN_WEBUI_BUNDLE` whose directory has no `index.html`
 * is a boot error — a misconfigured deploy intended the webui and must not
 * boot API-only silently.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { SigrunConfig } from "../config.js";

/** The channel id reported in `/v1/meta` `capabilities.channels`. */
export const WEBUI_CHANNEL = "webui";

/** A resolved webui bundle, ready to serve. */
export interface WebuiBundle {
	/** Absolute path of the bundle root (contains `index.html` + assets). */
	readonly dir: string;
	/** The entry document, read once at resolve time (deploy-time asset). */
	readonly indexHtml: string;
}

/**
 * Resolve the configured bundle. Returns `undefined` for an absent
 * default-path bundle (API-only deploy); throws when an explicit
 * `SIGRUN_WEBUI_BUNDLE` has no `index.html`.
 */
export async function resolveWebuiBundle(
	config: SigrunConfig,
): Promise<WebuiBundle | undefined> {
	const dir = resolve(config.webuiBundle);
	const indexPath = join(dir, "index.html");
	if (!existsSync(indexPath)) {
		if (config.webuiBundleExplicit) {
			throw new Error(
				`SIGRUN_WEBUI_BUNDLE=${config.webuiBundle} has no index.html — the configured webui bundle is missing (build it, or unset SIGRUN_WEBUI_BUNDLE for an API-only deploy)`,
			);
		}
		return undefined;
	}
	return { dir, indexHtml: await readFile(indexPath, "utf8") };
}

/**
 * Mount the bundle at `/` and install the SPA fallback as the
 * not-found handler. Explicit `/v1/*` (and probe) routes win over the static
 * wildcard in Fastify's radix tree, so registration order against the API
 * routes does not matter.
 */
export async function serveWebuiBundle(
	app: FastifyInstance,
	bundle: WebuiBundle,
): Promise<void> {
	await app.register(fastifyStatic, {
		root: bundle.dir,
		prefix: "/",
	});
	app.setNotFoundHandler(async (request, reply) => {
		const path = (request.raw.url ?? "/").split("?")[0] ?? "/";
		if (
			request.method === "GET" &&
			path !== "/v1" &&
			!path.startsWith("/v1/")
		) {
			return await reply
				.code(200)
				.type("text/html; charset=utf-8")
				.send(bundle.indexHtml);
		}
		// Fastify's default 404 body shape, restated so the API error surface
		// is byte-identical whether or not a bundle is mounted.
		return await reply.code(404).send({
			message: `Route ${request.method}:${path} not found`,
			error: "Not Found",
			statusCode: 404,
		});
	});
}
