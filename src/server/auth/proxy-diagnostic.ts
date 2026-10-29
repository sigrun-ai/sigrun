/**
 * The shared proxy-auth rejection diagnostic (proxy-trust C1), extracted
 * from the request pipeline so the onboarding routes can report WHY they
 * rejected a proxy identity with the same line and redaction contract.
 *
 * ONE `warn` per rejected request, naming the socket peer, the request
 * method, a short reason, and — only when Fastify already resolved it —
 * the ROUTE TEMPLATE (`routeOptions.url`, never the raw URL). The line
 * must never carry API tokens, cookies, identity-header VALUES, query
 * strings, or the full request URL; a header NAME appears only where the
 * reason itself is "that configured header was absent/wrong" (its value
 * never does). This is diagnostic logging, not evidence that the
 * configured allowlist is correct.
 *
 * The throttle is per reason: one line per reason per 60 s, with a
 * `(N suppressed)` suffix on the next emitted line for that reason —
 * a flood of identical rejections cannot drown the log, and a DIFFERENT
 * reason always emits immediately.
 */

import type { FastifyRequest } from "fastify";

/** One line per reason per this window; suppressed lines count up. */
const THROTTLE_MS = 60_000;

/** The reason vocabulary (byte-identical to the pipeline's originals). */
export const ProxyRejectReason = {
	UNTRUSTED: "untrusted proxy",
	UNUSABLE: "unusable identity claim",
	UNTRUSTED_IDENTITY_SOURCE: "untrusted identity source",
	OWN_HOST: "own-host peer without shared secret",
	secretReason: (header: string): string =>
		`missing or wrong shared secret (${header} header)`,
	missingHeaderReason: (header: string): string =>
		`missing identity header (${header})`,
} as const;

interface ThrottleEntry {
	lastEmit: number;
	suppressed: number;
}

const throttle = new Map<string, ThrottleEntry>();
let clock: () => number = () => Date.now();

/** Test seam: inject the clock the throttle reads. */
export function setProxyDiagnosticClock(now: () => number): void {
	clock = now;
}

/** Test seam: forget all throttle state (and restore the real clock). */
export function resetProxyDiagnostic(): void {
	throttle.clear();
	clock = () => Date.now();
}

/**
 * Emit one sanitized rejection line, throttled per reason. The line
 * carries no values by construction: it is built from the method, the
 * socket peer, the caller-supplied reason (a fixed string, or one naming
 * a configured header), and the route template.
 */
export function warnProxyRejected(
	request: FastifyRequest,
	reason: string,
): void {
	const now = clock();
	const entry = throttle.get(reason);
	if (entry !== undefined && now - entry.lastEmit < THROTTLE_MS) {
		entry.suppressed += 1;
		return;
	}
	const suppressed = entry?.suppressed ?? 0;
	throttle.set(reason, { lastEmit: now, suppressed: 0 });
	const peer = request.socket.remoteAddress ?? "unknown";
	const route = request.routeOptions.url;
	console.warn(
		`sigrun: proxy auth rejected ${request.method} request from ${peer} (${reason})${route === undefined ? "" : ` on ${route}`}${suppressed > 0 ? ` (${suppressed} suppressed)` : ""}`,
	);
}
