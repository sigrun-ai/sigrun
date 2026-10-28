/**
 * The image-proxy routes (UI-blocks U7 Task 3, spec §11.2):
 *
 * - `GET /v1/image?u=<url>&e=<expiry>&s=<sig>[&as=png]` — the SIGNED
 *   form: the signature (Task 1's HMAC over the exact bytes `u + "\n" +
 *   e`) gates arbitrary-URL fetching. Rejections are 403 with a
 *   distinguishable error: `malformed_expiry` (a non-numeric `e`),
 *   `bad_signature` (the HMAC doesn't match), `expired` (it matches but
 *   `now > e`). The verified `u` string is fetched VERBATIM — never
 *   re-parsed or re-encoded between verify and fetch.
 * - `GET /v1/image?src=<asset:slug/path | data:…>[&as=png]` — the
 *   already-validated form (no signature): assets pass the §11.1
 *   realpath containment check (an escape or a missing file is 404,
 *   indistinguishable) and data URLs the §11.1 type and 192 KiB size
 *   checks.
 * - `POST /v1/image?as=png` — a `data:` source too long for a URL is
 *   POSTed as the raw text body; the route's `bodyLimit` is the §11.1
 *   192 KiB rule (an over-limit body is Fastify's 413 `too_large`).
 *
 * Fetches go through the on-disk LRU cache: a hit fresher than its
 * clamped max-age re-serves without an upstream call; an older hit
 * revalidates, and a refusal is never replaced by stale bytes.
 * Concurrent requests for one URL share ONE in-flight upstream fetch
 * (Review Focus 4). Failures are never cached. Responses carry the
 * sniffed Content-Type, `X-Content-Type-Options: nosniff`, and
 * `Cache-Control: private, max-age=<upstream hint clamped to 1 h–7 d>`.
 */

import { open, realpath } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { relative, sep } from "node:path";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../context.js";
import { ImageCache } from "../images/cache.js";
import { toPng } from "../images/convert.js";
import {
	FetchRefusal,
	fetchImage,
	type FetchDeps,
} from "../images/fetch.js";
import { verify } from "../images/sign.js";
import { isAcceptedImageType, sniffImage, type SniffedImage } from "../images/sniff.js";

/** The Cache-Control clamp (spec §11.2): between 1 hour and 7 days. */
const MAX_AGE_MIN_SECONDS = 3600;
const MAX_AGE_MAX_SECONDS = 7 * 24 * 3600;

/** The §11.1 data-URL cap: 192 KiB of base64 text (the POST bodyLimit). */
const DATA_URL_MAX_CHARS = 192 * 1024;

/** MIME types by sniffed image type. */
const MIME: Record<SniffedImage, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** The real fetch deps: dns.lookup + the wall clock. */
function defaultFetchDeps(): FetchDeps {
	return {
		resolve: async (host) => {
			const addresses = await dnsLookup(host, { all: true, verbatim: true });
			return addresses.map((entry) => entry.address);
		},
		now: Date.now,
	};
}

/** One resolved image body, ready to serve and (signed form) cache. */
interface ResolvedImage {
	readonly bytes: Buffer;
	readonly type: SniffedImage;
	/** Upstream max-age seconds (signed form only), for the clamp. */
	readonly maxAge?: number;
}

/** Resolve one requested asset path inside the package's assets dir
 *  (the ext-assets.ts rule, spec §11.1): realpath BOTH sides; an escape
 *  or a missing file is `undefined` (the route answers 404). */
async function resolveContained(
	assetsDir: string,
	path: string,
): Promise<string | undefined> {
	let realDir: string;
	try {
		realDir = await realpath(assetsDir);
	} catch {
		return undefined;
	}
	const candidate = join(realDir, path);
	let realFile: string;
	try {
		realFile = await realpath(candidate);
	} catch {
		return undefined;
	}
	const rel = relative(realDir, realFile);
	if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) {
		return undefined;
	}
	return realFile;
}

/** Read a whole (small, cache-bounded) file. */
async function readAll(file: string): Promise<Buffer> {
	const handle = await open(file, "r");
	try {
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

/** Decode a §11.1 data URL (`data:image/png|jpeg|gif|webp;base64,…`). */
function decodeDataUrl(src: string): Buffer | undefined {
	const match = /^data:image\/(png|jpeg|gif|webp);base64,(.*)$/s.exec(src);
	if (match === null) return undefined;
	return Buffer.from(match[2] ?? "", "base64");
}

/** Clamp the upstream max-age hint into the 1 h–7 d band. */
function clampedMaxAge(maxAge: number | undefined): number {
	if (maxAge === undefined) return MAX_AGE_MIN_SECONDS;
	return Math.min(MAX_AGE_MAX_SECONDS, Math.max(MAX_AGE_MIN_SECONDS, maxAge));
}

/**
 * Register the image-proxy routes. `ctx` carries the shared cache and
 * the (test-injectable) fetch deps on `ctx.imageProxy`, populated by
 * `createServer`.
 */
export function registerImageRoutes(app: FastifyInstance, ctx: ServerContext): void {
	const { cache, deps, key } = ctx.imageProxy;

	/** In-flight upstream fetches (Review Focus 4): concurrent requests
	 *  for one (url, variant) share ONE fetch + ONE cache write. */
	const inflight = new Map<string, Promise<ResolvedImage>>();

	/** Fetch one URL through the cache, sharing in-flight work. */
	async function fetchThroughCache(
		u: string,
		variant: "orig" | "png",
	): Promise<ResolvedImage> {
		const now = deps.now();
		const hit = await cache.get(u, variant, now);
		if (hit !== undefined && now - hit.addedAt < hit.maxAge * 1000) {
			const chunks: Buffer[] = [];
			for await (const chunk of hit.stream) chunks.push(chunk as Buffer);
			return { bytes: Buffer.concat(chunks), type: hit.type, maxAge: hit.maxAge };
		}
		// A stale hit is never served: close its pin and revalidate.
		if (hit !== undefined) hit.stream.destroy();
		const inflightKey = `${variant}${u}`;
		const existing = inflight.get(inflightKey);
		if (existing !== undefined) return await existing;
		const work = (async (): Promise<ResolvedImage> => {
			const fetched = await fetchImage(u, deps);
			// Cache the original variant first — `as=png` requests cache
			// BOTH variants (the conversion reads the fetched bytes). The
			// clamped hint is BOTH the response header and the cache TTL.
			const maxAge = clampedMaxAge(fetched.maxAge);
			await cache.put(u, "orig", fetched.type, fetched.bytes, deps.now(), maxAge);
			if (variant === "png") {
				const converted = await toPng(fetched.bytes);
				await cache.put(u, "png", "png", converted, deps.now(), maxAge);
				return {
					bytes: converted,
					type: "png",
					...(fetched.maxAge === undefined ? {} : { maxAge: fetched.maxAge }),
				};
			}
			return fetched;
		})();
		inflight.set(inflightKey, work);
		try {
			return await work;
		} finally {
			inflight.delete(inflightKey);
		}
	}

	/** Serve one resolved image. */
	async function sendImage(
		reply: FastifyReply,
		image: ResolvedImage,
	): Promise<FastifyReply> {
		return await reply
			.header("content-type", MIME[image.type])
			.header("x-content-type-options", "nosniff")
			.header(
				"cache-control",
				`private, max-age=${clampedMaxAge(image.maxAge)}`,
			)
			.send(image.bytes);
	}

	/** Resolve the `src=` form (asset or data URL, both already
	 *  validated by §11.1's own rules — nothing to sign). */
	async function resolveSource(src: string): Promise<ResolvedImage | undefined | "bad"> {
		if (src.startsWith("asset:")) {
			const rest = src.slice("asset:".length);
			const slash = rest.indexOf("/");
			if (slash <= 0) return "bad";
			const slug = rest.slice(0, slash);
			const path = rest.slice(slash + 1);
			const binding = ctx.opened.extensionSurfaces.find(
				(entry) => entry.extension === slug,
			);
			if (binding?.assetsDir === undefined) return undefined;
			const file = await resolveContained(binding.assetsDir, path);
			if (file === undefined) return undefined;
			const bytes = await readAll(file);
			const sniffed = sniffImage(bytes);
			if (!isAcceptedImageType(sniffed)) return undefined;
			return { bytes, type: sniffed };
		}
		if (src.startsWith("data:")) {
			if (src.length > DATA_URL_MAX_CHARS) return undefined;
			const bytes = decodeDataUrl(src);
			if (bytes === undefined) return "bad";
			const sniffed = sniffImage(bytes);
			if (!isAcceptedImageType(sniffed)) return undefined;
			return { bytes, type: sniffed };
		}
		return "bad";
	}

	app.get<{
		Querystring: { u?: string; e?: string; s?: string; src?: string; as?: string };
	}>("/v1/image", async (request, reply) => {
		const { u, e, s, src, as } = request.query;
		const wantPng = as === "png";

		// The src form: no signature (assets and data URLs carry their
		// own §11.1 validation).
		if (src !== undefined) {
			const resolved = await resolveSource(src);
			if (resolved === "bad") {
				return await reply.code(400).send({ error: "bad_source" });
			}
			if (resolved === undefined) {
				// Containment misses and over-long data URLs are 404/413 —
				// indistinguishable from a missing asset / a too-large body.
				if (src.startsWith("data:") && src.length > DATA_URL_MAX_CHARS) {
					return await reply.code(413).send({
						error: "too_large",
						maxBytes: DATA_URL_MAX_CHARS,
					});
				}
				return await reply.code(404).send({ error: "asset_not_found" });
			}
			const image = wantPng
				? { bytes: await toPng(resolved.bytes), type: "png" as const }
				: resolved;
			return await sendImage(reply, image);
		}

		// The signed form.
		if (u === undefined || e === undefined || s === undefined) {
			return await reply.code(400).send({ error: "bad_signature" });
		}
		if (!/^\d+$/.test(e)) {
			return await reply.code(403).send({ error: "malformed_expiry" });
		}
		// Split the verify so the expired case names its own error: a
		// signature that MATCHES but whose expiry passed is `expired`;
		// a mismatch is `bad_signature`.
		if (!verify(key, u, e, s, Number(e))) {
			return await reply.code(403).send({ error: "bad_signature" });
		}
		if (Date.now() > Number(e)) {
			return await reply.code(403).send({ error: "expired" });
		}
		try {
			const image = await fetchThroughCache(u, wantPng ? "png" : "orig");
			return await sendImage(reply, image);
		} catch (cause) {
			if (cause instanceof FetchRefusal) {
				return await reply
					.code(502)
					.send({ error: cause.reason, message: cause.message });
			}
			throw cause;
		}
	});

	// The long-data-URL form: a `data:` source too long for a URL is
	// POSTed as the raw body. `bodyLimit` is the §11.1 192 KiB rule; the
	// server's one error handler turns an over-limit body into 413
	// `too_large`. The `text/plain` string parser is already registered
	// app-wide by the conversations route module (the JSONL import's
	// raw-text parser).
	app.post<{
		Querystring: { as?: string };
		Body: string;
	}>(
		"/v1/image",
		{ bodyLimit: DATA_URL_MAX_CHARS },
		async (request, reply) => {
			const src = typeof request.body === "string" ? request.body : "";
			const resolved = await resolveSource(src);
			if (resolved === "bad" || resolved === undefined) {
				return await reply.code(400).send({ error: "bad_source" });
			}
			const image =
				request.query.as === "png"
					? { bytes: await toPng(resolved.bytes), type: "png" as const }
					: resolved;
			return await sendImage(reply, image);
		},
	);
}
