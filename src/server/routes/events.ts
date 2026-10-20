/**
 * The global events stream route (core hardening W3 Task 4, spec §7.4):
 * `GET /v1/events` — ONE Server-Sent Events stream per client carrying
 * the hub's `HostEventWire` events, framed `event: <type>\ndata: <json>\n\n`
 * with a `: ping` heartbeat every 15s (the /stream heartbeat pattern).
 * No replay: the stream only nudges; a reconnecting client refetches the
 * list (the events carry no transcript state).
 *
 * Filtering (Review Focus 3 — per-event, never a connect-time snapshot):
 * a conversation-scoped event (conversation.* / run.* / interaction.* /
 * ambient.*) is delivered iff `accessOf(principal, meta)` ≠ `"none"` with
 * the SessionMeta RE-SNAPSHOTTED per event — a share makes the NEXT event
 * arrive, an un-share withholds the one after. `providers.changed` reaches
 * every authenticated principal. `job.changed` stays out of scope until
 * W4's job access rule lands (the hub never publishes it yet).
 *
 * The async re-snapshot runs in the route's own side lane (the bus/hub
 * listener contract is no-blocking-work): each stream keeps a per-event
 * serial promise chain, so frames for one connection stay in publish
 * order without ever blocking the hub. A snapshot failure (a retired
 * conversation raced the event) withholds THAT event — the honest
 * read-side posture.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { accessOf } from "@sigrun/shared/access";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ServerContext } from "../context.js";
import { SessionMetaDoc } from "../session-meta.js";
import type { HostEventWire } from "../events/types.js";

/** The heartbeat cadence (the /stream pattern: proxy idle-timeout survival). */
const HEARTBEAT_MS = 15_000;

/** Register the global events stream route. */
export function registerEventRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.get("/v1/events", async (request, reply) => {
		const principal = request.principal;
		const { opened } = ctx;
		reply.hijack();
		const raw = reply.raw;
		raw.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		raw.flushHeaders();
		// Socket-level write errors after teardown have no consumer; swallow
		// them so a mid-write disconnect cannot crash the process.
		raw.on("error", () => {});
		const send = (event: HostEventWire): void => {
			raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		};
		let finished = false;
		const heartbeat = setInterval(() => {
			raw.write(": ping\n\n");
		}, HEARTBEAT_MS);
		/**
		 * Whether THIS principal may see one event (Review Focus 3):
		 * conversation-scoped events re-snapshot the SessionMeta PER EVENT;
		 * providers.changed is broadcast; job.changed is withheld until W4's
		 * job access rule exists.
		 */
		const visible = async (event: HostEventWire): Promise<boolean> => {
			if (event.type === "providers.changed") return true;
			if (event.type === "job.changed") return false;
			let meta;
			try {
				meta = await opened.harness.snapshot(
					SessionMetaDoc,
					event.conversationId as ConversationId,
					BACKGROUND_CONTEXT,
				);
			} catch (error) {
				console.error(
					"events route: SessionMeta snapshot failed:",
					error,
				);
				return false; // a raced read withholds that one event
			}
			return accessOf(principal, meta ?? {}) !== "none";
		};
		// The per-connection side lane: serial promise chain, so frames for
		// one connection stay in publish order while the hub listener itself
		// returns immediately (the no-blocking-work contract).
		let lane: Promise<void> = Promise.resolve();
		const unsubscribe = opened.events.subscribe((event) => {
			lane = lane.then(async () => {
				if (finished) return;
				if (!(await visible(event))) return;
				if (finished) return;
				send(event);
			});
		});
		const finish = (): void => {
			if (finished) return;
			finished = true;
			clearInterval(heartbeat);
			unsubscribe();
			raw.end();
		};
		// Client disconnect: `response` close (socket termination) — NOT
		// `request.raw` close (Node 26 fires it at request-message completion,
		// i.e. immediately for a bodyless GET).
		raw.on("close", finish);
		// A client may have disconnected before the close listener existed.
		if (raw.destroyed) {
			finish();
			return;
		}
	});
}
