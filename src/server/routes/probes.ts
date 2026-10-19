/**
 * The deploy probes (spec §4.4 "distinguishes process-up from
 * harness-ready"): liveness and readiness, both scrape-compatible plain
 * text. Registered before the API routes, matching the unsplit server's
 * registration order.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { aggregateHealth } from "../../harness/health.js";
import type { ServerContext } from "../context.js";

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
 * Readiness: 200 only when the harness is GENUINELY ready. The honest v1
 * derivation, evaluated per request:
 *  1. booted — trivially true while this route answers (the server only
 *     exists after `openHarness` completed); documented, not probed.
 *  2. health not degraded — `health.memory` (the loaded memory
 *     extension's §3 producer, else ok) AND `health.providers` (aggregated
 *     §3 producer statuses). Quarantined extensions do NOT fail readiness:
 *     boot continues by design (spec §3 quarantined-never-aborts), memory
 *     falls back to the no-op default, and no v1 surface hard-depends on a
 *     quarantined package — quarantines surface via `/v1/meta`
 *     `extensions[].status`.
 *  3. a cheap REAL storage read — resolve the reserved root conversation
 *     through the session line (`storage.conversation()` under
 *     `harness.conversation`): one real sqlite record fetch proving the db
 *     file + session answer right now. A closed harness throws here
 *     (assertOpen) — caught, reported as "failed".
 * Not ready ⇒ 503 + a small JSON body naming the failing check (so a
 * `kubectl get endpoints` gap has a story). Ready ⇒ the exposition line,
 * scrape-compatible for the same reason as `/healthz`.
 */
export function registerProbeRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, rootId } = ctx;
	app.get("/healthz", async (_request, reply) => {
		return await reply
			.code(200)
			.type("text/plain; version=0.0.4; charset=utf-8")
			.send("sigrun_liveness 1\n");
	});

	app.get("/readyz", async (_request, reply) => {
		const memory = opened.memoryHealth?.() ?? "ok";
		const providers = aggregateHealth(opened.providerHealth);
		let storage: "ok" | "failed";
		try {
			const conversation = await opened.harness.conversation(
				rootId,
				BACKGROUND_CONTEXT,
			);
			// undefined = storage answered but the root record is gone — not a
			// harness anyone should route traffic to.
			storage = conversation === undefined ? "failed" : "ok";
		} catch {
			storage = "failed";
		}
		if (memory !== "ok" || providers !== "ok" || storage !== "ok") {
			return await reply.code(503).send({
				ready: false,
				checks: { memory, providers, storage },
			});
		}
		return await reply
			.code(200)
			.type("text/plain; version=0.0.4; charset=utf-8")
			.send("sigrun_readiness 1\n");
	});
}
