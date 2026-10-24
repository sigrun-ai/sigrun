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
 * Resolution (build-and-webui Task 5, at SERVE time — extension-contributed
 * bundles only exist after the loader runs, so `createServer` threads the
 * registry as the `contributedBundles` parameter):
 *
 * 1. `webui.enabled === false` → no mount, API-only (nothing else resolves
 *    — an invalid selector under a closed gate is not an error).
 * 2. A selector that is a NAME (`^[a-z][a-z0-9_-]*$`) matching a
 *    contributed bundle → that bundle (its name is the reported channel).
 * 3. A selector that is a PATH (contains `/` or `\`, or starts with `.`) →
 *    that directory, cwd-relative; a missing `index.html` is a boot error.
 *    A selector EQUAL to the default (`webui/dist`) keeps the DEFAULT's
 *    semantics — the bootstrap mirror story: a mirrored default must not
 *    flip to cwd-relative resolution.
 * 4. Unset → the built-in default bundle; an absent default is the
 *    supported API-only deploy (no mount, `capabilities.channels` []).
 *
 * An EXPLICIT selector (name or path) that resolves to nothing is a boot
 * error naming it — a misconfigured deploy intended the webui and must not
 * boot API-only silently. A selector that is neither path-shaped nor a
 * valid name (uppercase, spaces, …) is a validation error.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import {
	DEFAULT_WEBUI_BUNDLE,
	type SigrunConfig,
} from "../config.js";

/** The channel id reported in `/v1/meta` `capabilities.channels`. */
export const WEBUI_CHANNEL = "webui";

/**
 * The package root this module ships in (build-and-webui Task 3):
 * `…/<package>/dist/server` (the built module) — `../..` is the package
 * dir, both in the repo tree (`…/src/server` → the repo root, where
 * `webui/dist` is the workspace's vite output) and in an installed
 * package (`…/node_modules/sigrun/dist/server` → the package carrying
 * `webui/dist` in its npm `files`). This is what the DEFAULT bundle
 * anchors to — see {@link webuiBundleDir}.
 */
const PACKAGE_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * Where the bundle directory for a selector lives on disk (build-and-webui
 * Task 3, plan review focus #1). EXPLICIT paths are operator-authored and
 * resolve against the process cwd — the operator's relative path means
 * what they wrote, wherever sigrun was started from. The DEFAULT
 * (`webui/dist`) anchors to the PACKAGE ROOT: an installed `sigrun` CLI run
 * from an arbitrary working directory must find the bundle it ships, not
 * the operator's cwd (an ABSOLUTE selector never reaches the `join` — it
 * takes the `resolve` branch, which passes it through unchanged). A
 * selector UNSET or
 * EQUAL to the default keeps the default's anchor — the classification
 * that pins the bootstrap mirror story (a mirrored `webui/dist` must not
 * read as an explicit cwd-relative selection).
 */
export function webuiBundleDir(config: SigrunConfig): string {
	return config.webui.bundle === undefined ||
		config.webui.bundle === DEFAULT_WEBUI_BUNDLE
		? join(PACKAGE_ROOT, DEFAULT_WEBUI_BUNDLE)
		: resolve(config.webui.bundle);
}

/**
 * A webui bundle contributed by an extension (build-and-webui Task 6
 * collects these into a registry at boot; Task 5 resolves them here).
 * `name` is the selection key; `dir` is the bundle root, resolved by the
 * LOADER at collection time against the extension module's URL (the
 * factory contributes a relative-or-absolute `dir`; the loader pairs the
 * entry with the extension slug and anchors it) — the server only owns
 * the `index.html` existence check, and names `extension` in that error.
 */
export interface ContributedWebuiBundle {
	/** Matches `^[a-z][a-z0-9_-]*$` (the loader validates at collection). */
	readonly name: string;
	/** The bundle root (contains `index.html` + assets), module-anchored. */
	readonly dir: string;
	/** The contributing extension's slug (the loader's attribution). */
	readonly extension: string;
}

/**
 * Two extensions contributed a bundle under the same NAME; the later one
 * won (build-and-webui Task 6). Mirrors the provider-merge collision
 * shape (`ProviderCollision`, src/harness/providers/index.ts):
 * last-registered-wins with a `console.warn` and this retained record —
 * `/v1/meta`'s `collisions.webui` reads it.
 */
export interface WebuiBundleCollision {
	readonly kind: "webui-bundle";
	/** The bundle name that collided. */
	readonly name: string;
	/** Extension slug that previously owned the name. */
	readonly previous: string;
	/** Extension slug whose contribution won (last-registered-wins). */
	readonly contributor: string;
}

/** A resolved webui bundle, ready to serve. */
export interface WebuiBundle {
	/** Absolute path of the bundle root (contains `index.html` + assets). */
	readonly dir: string;
	/** The entry document, read once at resolve time (deploy-time asset). */
	readonly indexHtml: string;
	/**
	 * The channel id this bundle reports in `capabilities.channels`:
	 * {@link WEBUI_CHANNEL} for the built-in default and explicit paths;
	 * a contributed selection reports its own name (so a client can
	 * identify the UI it is talking to).
	 */
	readonly channel: string;
}

/** A name-shaped selector: the contributed-bundle grammar (spec §4.1). */
const BUNDLE_NAME = /^[a-z][a-z0-9_-]*$/;

/** Syntactically a PATH (spec §4.1): contains `/` or `\`, or starts with `.`. */
function isPathSelector(selector: string): boolean {
	return (
		selector.includes("/") ||
		selector.includes("\\") ||
		selector.startsWith(".")
	);
}

/**
 * Read a bundle directory at serve time. `subject` names the selection in
 * the boot error when the directory has no `index.html`.
 */
async function readBundle(
	dir: string,
	channel: string,
	subject: string,
): Promise<WebuiBundle> {
	const indexPath = join(dir, "index.html");
	if (!existsSync(indexPath)) {
		throw new Error(
			`${subject} has no index.html at ${dir} — the configured webui bundle is missing (build it, or unset SIGRUN_WEBUI_BUNDLE / server.webui.bundle for an API-only deploy)`,
		);
	}
	return { dir, indexHtml: await readFile(indexPath, "utf8"), channel };
}

/**
 * Resolve the configured bundle (Task 5's serve-time order: enabled gate →
 * contributed NAME → PATH → default). Returns `undefined` for an absent
 * default-path bundle or a closed gate (the API-only deploys); THROWS on
 * an explicit selector that resolves to nothing and on a selector that is
 * neither path-shaped nor a valid name.
 *
 * `contributedBundles` is the extension-contributed registry (Task 6
 * threads it through `createServer`; an empty registry is the no-extension
 * deploy).
 */
export async function resolveWebuiBundle(
	config: SigrunConfig,
	contributedBundles: readonly ContributedWebuiBundle[] = [],
): Promise<WebuiBundle | undefined> {
	// 1. The gate: `false` is a positively API-only deploy — nothing
	//    mounts and nothing else resolves (not even a bad selector).
	if (!config.webui.enabled) return undefined;
	const selector = config.webui.bundle;
	// 4. Unset — and the default's own value mirrored back through any
	//    selector slot — resolves the built-in default; an absent default
	//    is the supported API-only deploy (bare checkout, no webui build).
	if (selector === undefined || selector === DEFAULT_WEBUI_BUNDLE) {
		const dir = webuiBundleDir(config);
		return existsSync(join(dir, "index.html"))
			? await readBundle(dir, WEBUI_CHANNEL, `webui bundle ${JSON.stringify(selector)}`)
			: undefined;
	}
	// 3. A PATH: cwd-relative (operator intent), missing index.html is a
	//    boot error — today's explicit rule.
	if (isPathSelector(selector)) {
		return await readBundle(
			resolve(selector),
			WEBUI_CHANNEL,
			`webui bundle ${JSON.stringify(selector)}`,
		);
	}
	// 2. A NAME: the contributed registry. Anything else is a selector
	//    grammar error — never guessed at.
	if (!BUNDLE_NAME.test(selector)) {
		throw new Error(
			`webui bundle selector ${JSON.stringify(selector)} is neither a contributed-bundle name (lowercase letters, digits, "-" and "_", starting with a letter) nor a path (contains "/" or "\\", or starts with ".") — fix SIGRUN_WEBUI_BUNDLE / server.webui.bundle`,
		);
	}
	const contributed = contributedBundles.find(
		(bundle) => bundle.name === selector,
	);
	if (contributed === undefined) {
		const available = contributedBundles.map((bundle) => bundle.name);
		throw new Error(
			`webui bundle ${JSON.stringify(selector)} matches no contributed bundle (contributed: ${available.length === 0 ? "none" : available.join(", ")}) — fix SIGRUN_WEBUI_BUNDLE / server.webui.bundle or install the extension that contributes it`,
		);
	}
	return await readBundle(
		contributed.dir,
		contributed.name,
		`webui bundle ${JSON.stringify(selector)} contributed by extension ${JSON.stringify(contributed.extension)}`,
	);
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
		// U7 Task 3 (spec §11.2): the webui's HTML responses carry the
		// one-directive CSP — remote https image sources are already
		// rewritten to the /v1/image proxy at serve time, so img-src
		// stays closed to the server itself plus data: URLs. A single
		// img-src directive restricts images and nothing else: scripts
		// and styles are unaffected. Static ASSETS keep no CSP.
		setHeaders(res, path) {
			if (path.endsWith("/index.html") || path.endsWith("index.html")) {
				res.setHeader("content-security-policy", "img-src 'self' data:");
			}
		},
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
				// U7 Task 3 (spec §11.2): the webui's HTML responses carry
				// the one-directive CSP — remote https image sources are
				// already rewritten to the /v1/image proxy at serve time, so
				// img-src stays closed to the server itself plus data: URLs.
				// A single img-src directive restricts images and nothing
				// else: scripts and styles are unaffected.
				.header("content-security-policy", "img-src 'self' data:")
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
