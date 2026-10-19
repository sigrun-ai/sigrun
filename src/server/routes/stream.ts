/**
 * The SSE view stream route: `GET /v1/conversations/:id/stream`. The
 * conversation resolves through the `loadConversation` pre-handler, so the
 * unknown-id 404 lands as plain JSON BEFORE the handler hijacks the reply —
 * a hijacked stream has no error event. This endpoint is exercised over a
 * REAL socket in tests: it writes raw frames, which `app.inject()` cannot
 * observe (light-my-request settles only on `end()`).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConversation } from "../conversation-handler.js";
import type { ServerContext } from "../context.js";
import { ID_PARAMS_SCHEMA } from "../helpers.js";
import {
	serializeConversationView,
	type ConversationViewWire,
} from "../views.js";

/** Register the SSE view stream route. */
export function registerStreamRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	// SSE view stream (spec §5 "Views + watch frames over SSE"): one
	// Server-Sent Events stream per conversation, hand-rolled over `reply.raw`
	// (no @fastify/sse dependency). Event shape: `event: snapshot` with the
	// wire view on connect, then `event: view` per watch revision — every
	// frame is a FULL immutable ConversationView, so a reconnect's fresh
	// snapshot subsumes any missed frame (the spec's reconnect contract
	// collapses to "fresh snapshot on (re)connect"; see the Appendix C
	// named-verification record). `Last-Event-ID` is therefore accepted and
	// deliberately ignored. Heartbeat: a `: ping` comment every 15s (proxy/
	// LB idle-timeout survival). Lifecycle: exactly one owner (`finish` below)
	// stops the watch and clears the interval on client disconnect or watch
	// termination.
	app.get(
		"/v1/conversations/:id/stream",
		{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) },
		async (request, reply) => {
			const conversation = request.conversation;
			// Acquire the watch BEFORE hijacking: an acquisition failure then
			// lands on Fastify's fail-loud 500 path — a hijacked stream has no
			// error event. `value` is the acquisition revision (the snapshot
			// source); frames published between here and start() are held by the
			// watch's bounded pending delivery, so nothing is lost.
			const watch = await conversation.watch(BACKGROUND_CONTEXT);
			reply.hijack();
			const raw = reply.raw;
			raw.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"connection": "keep-alive",
				"x-accel-buffering": "no",
			});
			raw.flushHeaders();
			// Socket-level write errors after teardown have no consumer (the
			// close path owns teardown); swallow them so a mid-write disconnect
			// cannot crash the process with an unhandled 'error' event.
			raw.on("error", () => {});
			let nextId = 1;
			const send = (event: string, view: ConversationViewWire): void => {
				// Single data line: JSON.stringify escapes newlines in strings.
				raw.write(
					`id: ${nextId++}\nevent: ${event}\ndata: ${JSON.stringify(view)}\n\n`,
				);
			};
			let finished = false;
			const heartbeat = setInterval(() => {
				raw.write(": ping\n\n");
			}, 15_000);
			// The single cleanup owner: client disconnect (response close =
			// socket termination — NOT `request.raw.on("close")`, which on
			// Node 26 fires at request-message completion, i.e. immediately for
			// a bodyless GET) or watch termination (`watch.closed`). The flag
			// makes it exactly-once even though both paths can race.
			const finish = (fromWatchEnd: boolean): void => {
				if (finished) return;
				finished = true;
				clearInterval(heartbeat);
				if (!fromWatchEnd) {
					// stop() is idempotent upstream; fire-and-forget because the
					// stream is ending regardless and a stop() rejection after a
					// dead socket has no consumer to fail loud to.
					void watch.stop().catch(() => {});
				}
				raw.end();
			};
			raw.on("close", () => finish(false));
			// Upstream resolves `closed` with a WatchEnd for every terminal
			// state (failures included); a rejection would be an upstream
			// contract violation — catch it so one stream's anomaly ends that
			// stream instead of taking the process down as an unhandled
			// rejection.
			void watch.closed.then(
				() => finish(true),
				() => finish(true),
			);
			// The client may have disconnected while the watch was being
			// acquired (before the close listener existed): `destroyed` covers
			// that window — stop the just-acquired watch instead of leaking it.
			if (raw.destroyed) {
				finish(false);
				return;
			}
			// Snapshot FIRST (from the acquisition revision), then install the
			// listener — pending frames flow after the snapshot because start
			// never invokes the listener inline.
			send("snapshot", serializeConversationView(watch.value));
			watch.start(async (value) => {
				if (finished) return; // the stream is over; drop the frame
				send("view", serializeConversationView(value));
			});
		},
	);
}
