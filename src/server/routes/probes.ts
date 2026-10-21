/**
 * The deploy probes (spec §4.4 "distinguishes process-up from
 * harness-ready"): liveness and readiness, both scrape-compatible plain
 * text. Registered before the API routes, matching the unsplit server's
 * registration order.
 */

import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { checkStorage } from "../readiness.js";

/**
 * Register `GET /healthz` + `GET /readyz`.
 *
 * Liveness: 200 ALWAYS once listening — no aggregation, no storage; the
 * dead-simple "the event loop answers" signal. The body is a single
 * Prometheus-exposition gauge line so the endpoint is scrape-compatible
 * (`/v1/meta` is JSON and cannot be scraped). A degraded-but-alive process
 * must NOT fail liveness — the kubelet would restart a process that is
 * merely degraded.
 *
 * Readiness: 200 only when the harness is GENUINELY ready — and in W2
 * (§6.1) that is STORAGE-ONLY: boot complete + a real storage read.
 * Provider and memory health do NOT gate readiness — a degraded upstream
 * is never a Service outage (no endpoint gap, no pod eviction); they stay
 * visible in `/v1/meta`, `/v1/providers` (W1), and `/metrics` (W2 Task 8).
 * The derivation, evaluated per request:
 *  1. booted — trivially true while this route answers (the server only
 *     exists after `openHarness` completed); documented, not probed.
 *  2. `checkStorage` (core-hardening Task 5) — a cheap REAL storage read
 *     resolving the reserved root conversation through the session line.
 *     The SAME call feeds `/metrics`'s `sigrun_ready` gauge, so the k8s
 *     probe and the alert signal cannot disagree.
 * Not ready ⇒ 503 + `{ ready: false, checks: { storage: "failed" } }` (so
 * a `kubectl get endpoints` gap has a story). Ready ⇒ the exposition
 * line, scrape-compatible for the same reason as `/healthz`.
 */
export function registerProbeRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.get("/healthz", async (_request, reply) => {
		return await reply
			.code(200)
			.type("text/plain; version=0.0.4; charset=utf-8")
			.send("sigrun_liveness 1\n");
	});

	app.get("/readyz", async (_request, reply) => {
		if ((await checkStorage(ctx)) !== "ok") {
			return await reply.code(503).send({
				ready: false,
			checks: { storage: "failed" as const },
			});
		}
		return await reply
			.code(200)
			.type("text/plain; version=0.0.4; charset=utf-8")
			.send("sigrun_readiness 1\n");
	});
}
