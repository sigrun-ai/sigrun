/**
 * Vetted-address image fetching (UI-blocks U7, spec §11.2 verbatim):
 * the proxy's DNS-rebinding defense. Every hop is ONE `https.request`
 * whose `lookup` option answers with the SINGLE vetted address for
 * that hop — the connection can never re-resolve, so a resolver that
 * answers a public address first and `127.0.0.1` second cannot cause
 * a connection to loopback.
 *
 * Rules (each enforced per hop, redirects included):
 * - https only; `http:` URLs and `http:` redirect targets are refused;
 * - the host is resolved ONCE per hop through `deps.resolve`; every
 *   returned address is checked against the refused ranges — one bad
 *   address refuses the host (no happy-eyeballs fallback into it);
 * - `servername` (SNI) and the `Host` header keep the ORIGINAL host
 *   name, never the resolved address;
 * - redirects are followed BY HAND (no library follow option): at most
 *   3 in total, each target re-resolved and re-checked the same way;
 * - 10 s total timeout for the whole fetch — ABSOLUTE across the
 *   resolve, connect, and header phases of every hop plus the body
 *   read (a socket-inactivity timeout would never fire on a drip);
 * - no agent reuse across hops (`agent: false`): Node's default
 *   keep-alive agent could serve a redirect hop from a pooled socket
 *   whose connection was vetted on the FIRST hop only;
 * - 10 MiB body cap;
 * - the body must sniff as PNG/JPEG/GIF/WebP (Content-Type is never
 *   trusted; SVG and AVIF are refused).
 */

import type { IncomingHttpHeaders } from "node:http";
import * as https from "node:https";
import { isRefusedAddress } from "./ranges.js";
import { isAcceptedImageType, sniffImage, type SniffedImage } from "./sniff.js";

/** The whole-fetch budget: 10 s, spec §11.2. */
export const FETCH_TIMEOUT_MS = 10_000;
/** The response body cap: 10 MiB, spec §11.2. */
export const FETCH_MAX_BYTES = 10 * 1024 * 1024;
/** At most 3 redirects in total, spec §11.2. */
export const FETCH_MAX_REDIRECTS = 3;

/** A fetched image: the accepted sniffed type and the `max-age` hint. */
export interface FetchedImage {
	bytes: Buffer;
	type: SniffedImage;
	/** Cache-Control max-age seconds from the final response, if any. */
	maxAge?: number;
}

/** Injected so tests drive resolution, the clock, and trust. */
export interface FetchDeps {
	/** Resolve a hostname to address literals (the real one is `dns.lookup`). */
	resolve(host: string): Promise<string[]>;
	/** The clock (epoch ms) the deadline reads. */
	now(): number;
	/** Extra CA certificates to trust (tests' self-signed cert). */
	ca?: Buffer;
}

/** Every refusal reason `fetchImage` can fail with. */
export type FetchFailure =
	| "bad-url"
	| "scheme"
	| "resolve"
	| "refused-address"
	| "redirect-scheme"
	| "too-many-redirects"
	| "http-status"
	| "timeout"
	| "too-large"
	| "bad-type"
	| "network";

/** A refusal: the reason plus the message the caller logs. */
export class FetchRefusal extends Error {
	constructor(
		public readonly reason: FetchFailure,
		message: string,
	) {
		super(message);
		this.name = "FetchRefusal";
	}
}

/** Race `p` against the whole-fetch deadline.
 *
 * The deadline must be absolute even in phases a socket-inactivity
 * timeout can never cut: a resolver that hangs, or a server dripping
 * header bytes. Rejects with `timeout` when the deadline passes
 * before `p` settles.
 */
function withDeadline<T>(
	p: Promise<T>,
	deps: FetchDeps,
	deadline: number,
	phase: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const remaining = deadline - deps.now();
		if (remaining <= 0) {
			// Mark `p`'s (possible later) rejection handled: the
			// deadline refusal is the one the caller sees.
			void p.catch(() => {});
			reject(new FetchRefusal("timeout", `deadline reached before ${phase}`));
			return;
		}
		const timer = setTimeout(() => {
			reject(new FetchRefusal("timeout", `deadline reached ${phase}`));
		}, remaining);
		p.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(cause) => {
				clearTimeout(timer);
				reject(cause);
			},
		);
	});
}

/** Resolve and vet one hop's host, or refuse it. */
async function vettedAddress(
	host: string,
	deps: FetchDeps,
): Promise<string> {
	let addresses: string[];
	try {
		addresses = await deps.resolve(host);
	} catch (cause) {
		throw new FetchRefusal("resolve", `resolving ${host}: ${String(cause)}`);
	}
	if (addresses.length === 0) {
		throw new FetchRefusal("resolve", `${host} resolved to no addresses`);
	}
	for (const address of addresses) {
		if (isRefusedAddress(address)) {
			throw new FetchRefusal(
				"refused-address",
				`${host} resolves to refused address ${address}`,
			);
		}
	}
	// The FIRST vetted address is the one the connection uses; the
	// lookup callback never consults the resolver again.
	return addresses[0];
}

/** One `https.request` hop: connect to `address`, keep SNI/Host.
 *
 * The connect+header phase is cut by an ABSOLUTE whole-fetch deadline
 * timer (not `req.setTimeout`, which is socket-inactivity: a
 * header-drip server resets it forever). The timer is cleared the
 * moment headers resolve; the body read has its own deadline timer.
 */
function hop(options: {
	url: URL;
	address: string;
	deps: FetchDeps;
	deadline: number;
}): Promise<{ status: number; headers: IncomingHttpHeaders; stream: NodeJS.ReadableStream }> {
	const { url, address, deps, deadline } = options;
	return new Promise((resolve, reject) => {
		const remaining = deadline - deps.now();
		if (remaining <= 0) {
			reject(new FetchRefusal("timeout", "deadline reached before connecting"));
			return;
		}
		const req = https.request(
			{
				protocol: "https:",
				host: url.hostname,
				port: url.port || 443,
				servername: url.hostname,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				// The rebinding defense: the connection dials the ONE
				// vetted address, never the hostname (and never a second
				// resolution). Node calls `lookup` with `all: true`.
				lookup(_host, opts, callback) {
					const family = address.includes(":") ? 6 : 4;
					if (opts && typeof opts === "object" && "all" in opts && opts.all) {
						callback(null, [{ address, family }]);
					} else {
						callback(null, address, family);
					}
				},
				// No explicit Host header: Node derives it from the
				// ORIGINAL hostname (and the port), never the address the
				// lookup returned.
				ca: deps.ca,
				// NO agent reuse across hops: with the default keep-alive
				// global agent (Node >= 19), a redirect hop to the same
				// host:port could be served by the pooled FIRST-hop
				// socket — whose lookup (and vetted address) is the first
				// hop's, so this hop's vetting would never run.
			agent: false,
			},
			(res) => {
				// Headers are in: the hop's absolute timer comes down; the
				// caller owns the stream (redirect hops drain it, the
				// final hop reads it).
				clearTimeout(timer);
				resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
			},
		);
		let timedOut = false;
		req.on("error", (cause) => {
			if (timedOut) return; // the destroy() below already rejected
			reject(new FetchRefusal("network", `connecting to ${url.hostname}: ${cause.message}`));
		});
		const timer = setTimeout(() => {
			timedOut = true;
			req.destroy();
			reject(new FetchRefusal("timeout", `deadline reached awaiting headers from ${url.hostname}`));
		}, remaining);
		req.end();
	});
}

/** Read a body stream under the deadline and the byte cap. */
function readBody(
	stream: NodeJS.ReadableStream & { destroy?(error?: Error): void },
	deps: FetchDeps,
	deadline: number,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		const fail = (refusal: FetchRefusal): void => {
			stream.destroy?.();
			reject(refusal);
		};
		// The whole-fetch deadline: checked on every read and by a
		// timer, so a drip that stops delivering entirely is cut too.
		const timer = setTimeout(() => {
			fail(new FetchRefusal("timeout", "deadline reached reading body"));
		}, Math.max(0, deadline - deps.now()));
		stream.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > FETCH_MAX_BYTES) {
				clearTimeout(timer);
				fail(new FetchRefusal("too-large", `body over ${FETCH_MAX_BYTES} bytes`));
				return;
			}
			chunks.push(chunk);
			const remaining = deadline - deps.now();
			if (remaining <= 0) {
				clearTimeout(timer);
				fail(new FetchRefusal("timeout", "deadline reached reading body"));
			}
		});
		stream.on("end", () => {
			clearTimeout(timer);
			resolve(Buffer.concat(chunks));
		});
		stream.on("error", (cause) => {
			clearTimeout(timer);
			fail(new FetchRefusal("network", `reading body: ${cause.message}`));
		});
	});
}

/** Parse `Cache-Control: max-age=N` from response headers. */
function maxAgeOf(headers: IncomingHttpHeaders): number | undefined {
	const raw = headers["cache-control"];
	if (raw === undefined) return undefined;
	for (const header of Array.isArray(raw) ? raw : [raw]) {
		for (const directive of header.split(",")) {
			const trimmed = directive.trim();
			if (trimmed.startsWith("max-age=")) {
				const parsed = Number(trimmed.slice("max-age=".length));
				if (Number.isFinite(parsed) && parsed >= 0) return parsed;
			}
		}
	}
	return undefined;
}

/**
 * Fetch `u` as an image: resolve-and-vet every hop, follow at most 3
 * redirects by hand, cap the body, and require the sniffed type.
 */
export async function fetchImage(
	u: string,
	deps: FetchDeps,
): Promise<FetchedImage> {
	const deadline = deps.now() + FETCH_TIMEOUT_MS;

	let current: URL;
	try {
		current = new URL(u);
	} catch {
		throw new FetchRefusal("bad-url", `not a URL: ${u}`);
	}
	if (current.protocol !== "https:") {
		throw new FetchRefusal("scheme", `not https: ${current.protocol}`);
	}

	let redirects = 0;
	// Each loop iteration is one hop: vet, connect, then either take
	// the redirect (draining and looping) or read the body.
	for (;;) {
		// Every hop resolves through `deps.resolve` — including IP
		// literal hosts (the real resolver, `dns.lookup`, passes literals
		// through verbatim, so literals get range-checked like any other
		// answer). Brackets stripped for the resolver and SNI; the Host
		// header keeps Node's own derivation from the URL. The deadline
		// is ABSOLUTE here too: a resolver that hangs is cut at it.
		const bareHost = current.hostname.replace(/^\[|\]$/g, "");
		const address = await withDeadline(
			vettedAddress(bareHost, deps),
			deps,
			deadline,
			`resolving ${bareHost}`,
		);
		const response = await hop({ url: current, address, deps, deadline });

		const status = response.status;
		if (status >= 300 && status < 400 && response.headers.location !== undefined) {
			// Redirect hops count against the same total budget even
			// when refused for scheme or address — the attempt was made.
			if (redirects >= FETCH_MAX_REDIRECTS) {
				void consume(response.stream);
				throw new FetchRefusal(
					"too-many-redirects",
					`over ${FETCH_MAX_REDIRECTS} redirects at ${current.toString()}`,
				);
			}
			redirects += 1;
			let target: URL;
			try {
				target = new URL(response.headers.location, current);
			} catch {
				void consume(response.stream);
				throw new FetchRefusal("bad-url", `redirect target not a URL: ${u}`);
			}
			if (target.protocol !== "https:") {
				void consume(response.stream);
				throw new FetchRefusal(
					"redirect-scheme",
					`redirect to ${target.protocol} refused`,
				);
			}
			// Drain the redirect response so the server sees it consumed
			// and the socket closes cleanly (with `agent: false` there is
			// no pool for it to return to — the drain is hygiene, not reuse).
			void consume(response.stream);
			current = target;
			continue;
		}

		if (status < 200 || status >= 300) {
			void consume(response.stream);
			throw new FetchRefusal("http-status", `status ${status} from ${current.toString()}`);
		}
		const bytes = await readBody(response.stream, deps, deadline);
		const sniffed = sniffImage(bytes);
		if (!isAcceptedImageType(sniffed)) {
			throw new FetchRefusal(
				"bad-type",
				sniffed === undefined
					? `body did not sniff as an accepted image type`
					: `body sniffed as ${sniffed}, which is refused`,
			);
		}
		const maxAge = maxAgeOf(response.headers);
		return { bytes, type: sniffed, ...(maxAge === undefined ? {} : { maxAge }) };
	}
}

/** Best-effort drain of a refused hop's response so the server sees
 * the response consumed and the socket closes cleanly. */
function consume(stream: NodeJS.ReadableStream): Promise<void> {
	return new Promise((resolve) => {
		stream.on("data", () => {});
		stream.on("end", () => resolve());
		stream.on("error", () => resolve());
	});
}
