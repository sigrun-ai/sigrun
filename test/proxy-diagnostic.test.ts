/**
 * The shared, throttled proxy-rejection diagnostic (proxy-trust C1).
 *
 * The line format and redaction contract are byte-identical to the
 * pipeline's original private `warnProxyRejected`: one warn per rejected
 * request naming the socket peer, the method, a short reason, and only
 * the ROUTE TEMPLATE — never tokens, cookies, identity-header VALUES,
 * query strings, or the full URL. The throttle is per reason: one line
 * per reason per 60 s, with a `(N suppressed)` suffix on the next
 * emitted line for that reason.
 */

import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	ProxyRejectReason,
	resetProxyDiagnostic,
	setProxyDiagnosticClock,
	warnProxyRejected,
} from "../src/server/auth/proxy-diagnostic.js";

/** The minimal request shape the diagnostic reads (no values log). */
function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
	return {
		method: "GET",
		url: "/v1/x?q=1",
		headers,
		socket: { remoteAddress: "10.42.3.4" },
		routeOptions: { url: "/v1/x" },
	} as unknown as FastifyRequest;
}

describe("proxy-rejection diagnostic throttle", () => {
	let now: number;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		now = 0;
		resetProxyDiagnostic();
		setProxyDiagnosticClock(() => now);
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		setProxyDiagnosticClock(() => Date.now());
		resetProxyDiagnostic();
	});

	test("one line per reason per 60 s; the next line carries (N suppressed)", () => {
		warnProxyRejected(fakeRequest(), ProxyRejectReason.UNTRUSTED);
		now = 1000;
		warnProxyRejected(fakeRequest(), ProxyRejectReason.UNTRUSTED);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]!.join(" ")).toBe(
			"sigrun: proxy auth rejected GET request from 10.42.3.4 (untrusted proxy) on /v1/x",
		);
		now = 60_000;
		warnProxyRejected(fakeRequest(), ProxyRejectReason.UNTRUSTED);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[1]!.join(" ")).toBe(
			"sigrun: proxy auth rejected GET request from 10.42.3.4 (untrusted proxy) (1 suppressed) on /v1/x",
		);
	});

	test("reasons throttle independently", () => {
		for (let i = 0; i < 100; i++) {
			now = i * 100;
			warnProxyRejected(fakeRequest(), ProxyRejectReason.UNTRUSTED);
		}
		expect(warn).toHaveBeenCalledTimes(1);
		// A different reason is NOT throttled by another reason's flood.
		warnProxyRejected(
			fakeRequest(),
			ProxyRejectReason.missingHeaderReason("remote-user"),
		);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[1]!.join(" ")).toContain(
			"missing identity header (remote-user)",
		);
	});

	test("no values: header values, cookies, and the query string never log", () => {
		warnProxyRejected(
			fakeRequest({ "remote-user": "secretvalue", cookie: "c=1" }),
			ProxyRejectReason.UNTRUSTED,
		);
		const line = warn.mock.calls[0]!.join(" ");
		expect(line).not.toContain("secretvalue");
		expect(line).not.toContain("c=1");
		expect(line).not.toContain("q=1");
	});

	test("secretReason names the configured header, verbatim format", () => {
		expect(ProxyRejectReason.secretReason("x-sigrun-proxy-secret")).toBe(
			"missing or wrong shared secret (x-sigrun-proxy-secret header)",
		);
	});
});
