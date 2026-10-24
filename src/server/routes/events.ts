/**
 * The global events stream route (core hardening W3 Task 4, spec §7.4):
 * `GET /v1/events` — ONE Server-Sent Events stream per client carrying
 * the hub's `HostEventWire` events, framed `event: <type>\ndata: <json>\n\n`
 * with a `: ping` heartbeat every 15s (the /stream heartbeat pattern).
 * No replay: the stream only nudges; a reconnecting client refetches the
 * list (the events carry no transcript state).
 *
 * Filtering (Review Focus 3 — per-event, never a connect-time snapshot):
 * the visibility decision is an EXHAUSTIVE per-type switch (hardening
 * review Task 4): a conversation-scoped event (conversation.* / run.* /
 * interaction.* / ambient.*) is delivered iff `accessOf(principal, meta)`
 * ≠ `"none"` with the SessionMeta RE-SNAPSHOTTED per event — a share
 * makes the NEXT event arrive, an un-share withholds the one after.
 * `providers.changed` reaches every authenticated principal. `job.changed`
 * (W4 Task 4) resolves `accessOf` against the EVENT's own owner/sharing
 * (the hub's copy is access-neutral) and is delivered with the caller's
 * `access` ADDED to the job row — a hidden job's event is withheld
 * entirely, no extra read. `taskSettled` is never delivered. Any type the
 * switch does not know is NEVER delivered (deny by construction — the
 * old fall-through snapshotted a missing conversationId and broadcast
 * the ownerless result).
 *
 * The async re-snapshot runs in the route's own side lane (the bus/hub
 * listener contract is no-blocking-work): each stream keeps a per-event
 * serial promise chain, so frames for one connection stay in publish
 * order without ever blocking the hub. A snapshot failure (a retired
 * conversation raced the event) withholds THAT event — the honest
 * read-side posture.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { accessOf } from "@sigrun/shared/access";
import type { JobWire } from "@sigrun/shared/jobs";
import type { ConversationId } from "@earendil-works/pi-durable";
import { accessPrincipalOf } from "../auth/access-principal.js";
import type { ServerContext } from "../context.js";
import { SessionMetaDoc } from "../session-meta.js";
import type { HostEventWire } from "../events/types.js";
import type { SurfaceChangedInternal } from "../surfaces/service.js";

/** The heartbeat cadence (the /stream pattern: proxy idle-timeout survival). */
const HEARTBEAT_MS = 15_000;

/** Register the global events stream route. */
export function registerEventRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.get("/v1/events", async (request, reply) => {
		const { opened } = ctx;
		const { principal } = request;
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
		// The W3 amendment (spec §7.3): the FIRST frame names this
		// connection — `event: hello` / `data: {"streamId": "<uuid>"}`,
		// written BEFORE the hub subscription. Channels send the id as
		// `X-Sigrun-Stream` on surface/data fetches (the watcher registry's
		// entry); after a reconnect (a NEW streamId) they re-fetch every
		// visible surface, which re-registers the entries. The hello is a
		// CONNECTION-LOCAL frame (channels ignore unknown event types), so
		// it is deliberately NOT a HostEventWire member — the exhaustive
		// visibility switch covers only principal-facing hub events.
		const streamId = randomUUID();
		send({ type: "hello", streamId } as unknown as HostEventWire); // SAFETY: hello is a connection-local frame, not a hub event — the wire writer is typed on HostEventWire only because every OTHER frame is one.
		let finished = false;
		const heartbeat = setInterval(() => {
			raw.write(": ping\n\n");
		}, HEARTBEAT_MS);
		/**
		 * Whether THIS principal may see one event (Review Focus 3): an
		 * EXHAUSTIVE switch over the HostEventWire members — a new member
		 * added without a case fails the typecheck (Review Focus 4;
		 * test/events-exhaustive.typecheck.ts mirrors this dispatch) and
		 * never falls through to the old ownerless-snapshot broadcast
		 * (accessOf(principal, {}) === "write")). Conversation-scoped
		 * events re-snapshot the SessionMeta PER EVENT; providers.changed is
		 * broadcast; job.changed (W4 Task 4) resolves against the event's own
		 * owner/sharing and, when visible, ENRICHES the row with the caller's
		 * `access` (the hub's copy is access-neutral by contract — the stream
		 * adds it per principal); taskSettled is host machinery (never
		 * principal-facing).
		 */
		const visible = async (
			event: HostEventWire,
			): Promise<HostEventWire | undefined> => {
				// Like SessionMeta, stored groups are current PER EVENT: group
				// changes affect the next event on an existing connection.
				const accessPrincipal = accessPrincipalOf(
					principal,
					opened.identity.users,
				);
				switch (event.type) {
				// Conversation-scoped: SessionMeta access, re-snapshotted per
				// event (share → the NEXT event arrives; un-share withholds the
				// one after).
				case "conversation.created":
				case "conversation.changed":
				case "run.admitted":
				case "run.settled":
				case "interaction.pending":
				case "interaction.settled":
				case "ambient.changed": {
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
						return undefined; // a raced read withholds that one event
					}
					return accessOf(accessPrincipal, meta ?? {}) !== "none" ? event : undefined;
				}
				// Broadcast: every authenticated principal.
				case "providers.changed":
					return event;
				// The event's own owner/sharing decides; the delivered row
					// carries the caller's access (the wire adds what the hub's
					// access-neutral copy omits).
				case "job.changed": {
					const access = accessOf(accessPrincipal, {
						...(event.job.owner === undefined
							? {}
							: { owner: event.job.owner }),
						...(event.job.sharing === undefined
							? {}
							: { sharing: event.job.sharing }),
					});
					if (access === "none") return undefined;
					const enriched: JobWire = { ...event.job, access };
					return { ...event, job: enriched };
				}
				// Host machinery (the jobs observer's input), never a
				// principal-facing wire event.
				case "taskSettled":
					return undefined;
				// UI-blocks U4 (spec §13.2): settings changes are OPERATOR
				// surface — delivered to ADMINS only, both scopes (a
				// server-scope PATCH and an extension's settings PUT alike;
				// the admin gate is the same one the writes carry).
				case "settings.changed":
					return request.principal.admin ? event : undefined;
				// UI-blocks U3 Task 4 (spec §7.3): delivered to a watching
				// stream ONLY. The hub copy is the service's internal event
				// (SurfaceChangedInternal) which carries the resolved stream
				// list — the service computed it off the PLAIN key at publish
				// time (the registry can never reverse the wire's hashed `k`).
				// The DELIVERED frame is the wire shape (the internal field
				// stripped — the stream list is routing metadata, never wire).
				case "surface.changed": {
					// SAFETY: the hub carries the service's internal event (the
					// wire shape plus the publish-time stream list); every
					// surface.changed the hub sees comes from bumpRev, which
					// always attaches `streams`.
					const internal = event as unknown as SurfaceChangedInternal;
					if (!internal.streams.includes(streamId)) return undefined;
					return {
						type: "surface.changed",
						slug: event.slug,
						id: event.id,
						k: event.k,
						rev: event.rev,
						treeRev: event.treeRev,
					};
				}
				// An unknown member is NEVER delivered — deny by construction,
				// not by enumerating the leak shapes. The satisfies check keeps
				// this arm exhaustive: a new HostEventWire member without a
				// case fails the typecheck here (and in the mirror file).
				default:
					event satisfies never;
					return undefined;
			}
		};
		// The per-connection side lane: serial promise chain, so frames for
		// one connection stay in publish order while the hub listener itself
		// returns immediately (the no-blocking-work contract).
		let lane: Promise<void> = Promise.resolve();
		const unsubscribe = opened.events.subscribe((event) => {
			lane = lane.then(async () => {
				if (finished) return;
				const deliverable = await visible(event);
				if (deliverable === undefined || finished) return;
				send(deliverable);
			});
		});
		const finish = (): void => {
			if (finished) return;
			finished = true;
			clearInterval(heartbeat);
			unsubscribe();
			// The watcher registry's stream-close rule (spec §7.3): every
			// entry this stream held drops with it.
			ctx.surfaces.watcherRegistry.dropStream(streamId);
			raw.end();
		};
		// Client disconnect: `response` close (socket termination) — NOT
		// `request.raw` close (Node 26 fires it at request-message completion,
		// i.e. immediately for a bodyless GET).
		raw.on("close", finish);
		// Server shutdown terminates this stream through the registry (the
		// ctrl+c fix): fastify's drain would otherwise wait on this
		// never-ending request while any webui tab holds it open.
		const deregister = ctx.sse.register({ end: finish });
		raw.on("close", deregister);
		// A client may have disconnected before the close listener existed.
		if (raw.destroyed) {
			finish();
			deregister();
			return;
		}
	});
}
