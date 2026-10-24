/**
 * Core hardening W3 Task 4 (spec §7.4): the global events stream,
 * `GET /v1/events`.
 *
 * ONE SSE stream per client carrying the hub's host events —
 * `conversation.created` / `conversation.changed` (SessionMeta summary
 * diffs) / `run.admitted` / `run.settled` / `interaction.pending` /
 * `interaction.settled` / `ambient.changed` / `providers.changed` —
 * framed `event: <type>\ndata: <json>\n\n` with a `: ping` heartbeat.
 * No replay: the stream nudges; clients refetch.
 *
 * Filtering (Review Focus 3): conversation-scoped events are delivered
 * iff `accessOf(principal, meta)` ≠ "none" with the SessionMeta
 * RE-SNAPSHOTTED per event — share → the next event arrives; un-share →
 * the following one is withheld. `providers.changed` broadcasts to every
 * authenticated principal.
 *
 * Test transport is a REAL loopback socket (a hijacked reply never
 * settles under light-my-request — see sse-view.test.ts). The basic-flow
 * suite runs claimed+none (seededIdentity); the scoping suite mints
 * tokens for two directory users (bob/dave) as sharing.test.ts does.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { askTree, lineTree } from "./helpers/trees.js";
import type { HostEventWire } from "@sigrun/shared/views";

/** The fixture-seam entry (seeds interactions + ambient through the host). */
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	port: number;
}

async function bootServer(options?: {
	auth?: "none" | "token";
	extensions?: boolean;
	extraUsers?: readonly string[];
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-events-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_AUTH: options?.auth ?? "none",
	};
	const config = loadConfig(env);
	const identity = await seededIdentity(dir);
	for (const user of options?.extraUsers ?? []) {
		await identity.users.add({ user, admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
		identity,
		settingsDir: dir,
		...(options?.extensions === false
			? {}
			: { extensionSpecifiers: [SEAM_SPECIFIER] }),
	});
	const app = await createServer(opened, config, [], {
		listenHost: "127.0.0.1",
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("listen did not bind a port");
	}
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, config, port: address.port };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Mint a token for `user` (the token method's credential). */
async function mint(opened: OpenedHarness, user: string): Promise<string> {
	const { token } = await opened.identity.tokens.create("test", user);
	return token;
}

/** One parsed host-event frame (comments like `: ping` never surface). */
interface HostFrame {
	readonly event: string;
	readonly data: HostEventWire;
}

/**
 * One open /v1/events connection: incremental frame parser + a predicate
 * waiter. `destroy()` closes the client socket.
 */
class EventsConnection {
	private readonly request: http.ClientRequest;
	private readonly events: HostFrame[] = [];
	private buffer = "";
	private readonly dataWaiters: Array<() => void> = [];
	private status = 0;
	private transportError = "";
	/** Resolves when the response headers arrived (subscription live). */
	private readonly connected: Promise<void>;

	constructor(port: number, headers: Record<string, string> = {}) {
		this.request = http.get({
			host: "127.0.0.1",
			port,
			path: "/v1/events",
			headers,
			agent: false,
		});
		this.request.on("error", (error) => {
			this.transportError = String(error);
		});
		let readyResolve: () => void = () => {};
		this.connected = new Promise<void>((resolve) => {
			readyResolve = resolve;
		});
		this.request.on("response", (incoming) => {
			this.status = incoming.statusCode ?? 0;
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => {
				this.buffer += chunk;
				this.drain();
			});
			incoming.on("error", () => {});
			readyResolve();
		});
	}

	private drain(): void {
		for (;;) {
			const boundary = this.buffer.indexOf("\n\n");
			if (boundary === -1) return;
			const frame = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			let event = "";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith(":")) continue;
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			if (data === "") continue;
			this.events.push({
				event,
				data: JSON.parse(data) as HostEventWire,
			});
			for (const wake of this.dataWaiters.splice(0)) wake();
		}
	}

	/** Resolves once the subscription is live (headers flushed). */
	async ready(): Promise<void> {
		await this.connected;
	}

	/** Every parsed frame, one per line (debug on failure). */
	describe(): string {
		return this.events
			.map((frame) => `${frame.event} ${JSON.stringify(frame.data)}`)
			.join(" | ");
	}

	async waitFor(
		predicate: (frame: HostFrame) => boolean,
		timeoutMs = 15_000,
	): Promise<HostFrame> {
		await this.connected;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find(predicate);
			if (found !== undefined) return found;
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error(
					`timed out after ${timeoutMs}ms; status=${this.status} transportError=${this.transportError} events so far: ${JSON.stringify(
						this.events.map((frame) => frame.event),
					)}`,
				);
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, remaining);
				this.dataWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	eventsSoFar(): readonly HostFrame[] {
		return [...this.events];
	}

	destroy(): void {
		this.request.destroy();
	}
}

function seamHost(opened: OpenedHarness): SeamHost {
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("fixture-seam host not loaded");
	return host;
}

/** Create a conversation; returns its id. */
async function createConversation(port: number): Promise<number> {
	const response = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	expect(response.status).toBe(201);
	const body = (await response.json()) as { id: number };
	return body.id;
}

// ---------------------------------------------------------------------------
// The basic flow (claimed + none auth)
// ---------------------------------------------------------------------------

describe("GET /v1/events (W3 Task 4)", () => {
	test("conversation.created arrives when a conversation is created", { timeout: 20_000 }, async () => {
		const { port } = await bootServer();
		const stream = new EventsConnection(port);
		try {
			await stream.ready();
			const id = await createConversation(port);
			const frame = await stream.waitFor(
				(f) =>
					f.event === "conversation.created" &&
					f.data.type === "conversation.created" &&
					f.data.conversationId === id,
			);
			expect(frame.event).toBe("conversation.created");
		} finally {
			stream.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	test("PATCH meta name emits conversation.changed with fields.name", { timeout: 20_000 }, async () => {
		const { port } = await bootServer();
		const stream = new EventsConnection(port);
		try {
			await stream.ready();
			const id = await createConversation(port);
			await stream.waitFor((f) => f.event === "conversation.created");
			const response = await fetch(
				`http://127.0.0.1:${port}/v1/conversations/${id}/meta`,
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "harbor lights" }),
				},
			);
			if (response.status !== 200) {
				throw new Error(
					`PATCH failed: ${response.status} ${await response.text()}`,
				);
			}
			const frame = await stream
				.waitFor(
					(f) =>
						f.event === "conversation.changed" &&
						f.data.type === "conversation.changed" &&
						f.data.conversationId === id,
				)
				.catch((error: unknown) => {
					throw new Error(
						`${(error as Error).message}; frames: ${stream.describe()}`,
					);
				});
			expect(frame.data.type).toBe("conversation.changed");
			if (frame.data.type === "conversation.changed") {
				expect(frame.data.fields.name).toBe("harbor lights");
			}
		} finally {
			stream.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	test("a submission emits run.admitted then run.settled answered", { timeout: 20_000 }, async () => {
		const { port } = await bootServer();
		const stream = new EventsConnection(port);
		try {
			await stream.ready();
			const id = await createConversation(port);
			await stream.waitFor((f) => f.event === "conversation.created");
			const response = await fetch(
				`http://127.0.0.1:${port}/v1/conversations/${id}/submissions`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ input: "hello" }),
				},
			);
			expect(response.status).toBe(202);
			let admitted: HostFrame;
			let settled: HostFrame;
			// The run's frames must land; on a miss, dump everything the
			// stream DID receive (the failure mode under investigation).
			try {
				admitted = await stream.waitFor(
					(f) =>
						f.event === "run.admitted" &&
						f.data.type === "run.admitted" &&
						f.data.conversationId === id,
				);
				settled = await stream.waitFor(
					(f) =>
						f.event === "run.settled" &&
						f.data.type === "run.settled" &&
						f.data.conversationId === id,
					15_000,
				);
			} catch (error) {
				throw new Error(
					`${(error as Error).message}; frames: ${stream.describe()}`,
				);
			}
			if (admitted.data.type === "run.admitted") {
				expect(typeof admitted.data.submissionId).toBe("number");
			}
			if (settled.data.type === "run.settled") {
				expect(settled.data.outcome).toBe("answered");
			}
		} finally {
			stream.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	test("seeding + answering an interaction emits interaction.pending then interaction.settled", { timeout: 20_000 }, async () => {
		const { opened, port } = await bootServer();
		const stream = new EventsConnection(port);
		try {
			await stream.ready();
			const id = await createConversation(port);
			await stream.waitFor(
				(f) =>
					f.event === "conversation.created" &&
					f.data.type === "conversation.created" &&
					f.data.conversationId === id,
			);
			const host = seamHost(opened);
			await host.seedInteraction(
				id as never,
				{
					kind: "fixture.ask",
					callId: "call-1",
					status: "pending",
					createdAt: Date.now(),
					body: askTree(),
				},
				BACKGROUND_CONTEXT,
			);
			const pending = await stream.waitFor(
				(f) =>
					f.event === "interaction.pending" &&
					f.data.type === "interaction.pending" &&
					f.data.callId === "call-1",
			);
			if (pending.data.type === "interaction.pending") {
				expect(pending.data.kind).toBe("fixture.ask");
				expect(pending.data.conversationId).toBe(id);
			}
			await host.answerInteraction(
				id as never,
				"call-1",
				{ values: { decision: "allow" } },
				BACKGROUND_CONTEXT,
			);
			const settled = await stream.waitFor(
				(f) =>
					f.event === "interaction.settled" &&
					f.data.type === "interaction.settled" &&
					f.data.callId === "call-1",
			);
			if (settled.data.type === "interaction.settled") {
				expect(settled.data.kind).toBe("fixture.ask");
			}
		} finally {
			stream.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	test("a skipped settle emits interaction.settled (terminal set shared with interactions.ts)", { timeout: 20_000 }, async () => {
		const { opened, port } = await bootServer();
		const stream = new EventsConnection(port);
		try {
			await stream.ready();
			const id = await createConversation(port);
			await stream.waitFor(
				(f) =>
					f.event === "conversation.created" &&
					f.data.type === "conversation.created" &&
					f.data.conversationId === id,
			);
			const host = seamHost(opened);
			await host.seedInteraction(
				id as never,
				{
					kind: "fixture.ask",
					callId: "call-skip",
					status: "pending",
					createdAt: Date.now(),
					body: askTree(),
				},
				BACKGROUND_CONTEXT,
			);
			await stream.waitFor(
				(f) =>
					f.event === "interaction.pending" &&
					f.data.type === "interaction.pending" &&
					f.data.callId === "call-skip",
			);
			// "skipped" is a terminal status: the wire event must be
			// interaction.settled, NOT a second pending (fix round 1).
			await host.settleInteraction(
				id as never,
				"call-skip",
				"skipped",
				BACKGROUND_CONTEXT,
			);
			const settled = await stream.waitFor(
				(f) =>
					f.event === "interaction.settled" &&
					f.data.type === "interaction.settled" &&
					f.data.callId === "call-skip",
			);
			expect(settled.data.type).toBe("interaction.settled");
		} finally {
			stream.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	test("an ambient write emits ambient.changed with the slot key", { timeout: 20_000 }, async () => {
		const { opened, port } = await bootServer();
		const stream = new EventsConnection(port);
		try {
			await stream.ready();
			const id = await createConversation(port);
			await stream.waitFor(
				(f) =>
					f.event === "conversation.created" &&
					f.data.type === "conversation.created" &&
					f.data.conversationId === id,
			);
			const host = seamHost(opened);
			await host.setAmbient(
				id as never,
				{
					key: "fixture.panel",
					place: "status",
					body: lineTree("watching"),
				},
				BACKGROUND_CONTEXT,
			);
			const frame = await stream.waitFor(
				(f) =>
					f.event === "ambient.changed" &&
					f.data.type === "ambient.changed" &&
					f.data.key === "fixture.panel",
			);
			if (frame.data.type === "ambient.changed") {
				expect(frame.data.conversationId).toBe(id);
			}
		} finally {
			stream.destroy();
			// The heartbeat interval's teardown rides the client disconnect;
			// give the close event a tick so the suite's worker exits clean.
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	test("providers.changed publishes through the hub and reaches a stream", { timeout: 20_000 }, async () => {
		const { opened, port } = await bootServer();
		const stream = new EventsConnection(port);
		try {
			// The publish must land AFTER the subscription is live.
			await stream.ready();
			opened.events.publish({
				type: "providers.changed",
				provider: "faux",
				status: "degraded",
			});
			const frame = await stream.waitFor(
				(f) =>
					f.event === "providers.changed" &&
					f.data.type === "providers.changed" &&
					f.data.provider === "faux",
			);
			if (frame.data.type === "providers.changed") {
				expect(frame.data.status).toBe("degraded");
			}
		} finally {
			stream.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	test("job.changed arrives after create and run-now, with access added per principal", { timeout: 20_000 }, async () => {
		// W4 Task 4 (§8.4/§7.4): every job-record change fans out through the
		// hub as `job.changed` carrying the JobWire summary; the stream
		// computes `access` per principal before delivery. Under auth "none"
		// the naive principal is the superuser and the created job is
		// ownerless → household write.
		const { opened, port } = await bootServer({ auth: "none", extensions: false });
		// Fix round 1 pin: subscribe the HUB directly (in-process, pre-SSE)
		// — the hub's own copy must be ACCESS-NEUTRAL (no fabricated
		// `access` key for future non-SSE subscribers); the stream adds it.
		const hubFrames: HostEventWire[] = [];
		const offHub = opened.events.subscribe((event) => {
			if (event.type === "job.changed") hubFrames.push(event);
		});
		const stream = new EventsConnection(port);
		try {
			await stream.ready();
			const create = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "nightly",
					schedule: { every: "3600s" },
					action: { kind: "prompt", prompt: "hi", conversation: "new" },
				}),
			});
			expect(create.status).toBe(201);
			const { job } = (await create.json()) as { job: { id: string } };
			const created = await stream.waitFor(
				(f) =>
					f.event === "job.changed" &&
					f.data.type === "job.changed" &&
					f.data.job.id === job.id,
			);
			if (created.data.type === "job.changed") {
				// The hub's copy is access-neutral; the stream adds the
				// per-principal access before delivery (W4 Task 4).
				expect((created.data.job as unknown as { access: string }).access).toBe(
					"write",
				);
			}
			// Run-now patches the record's lastRun — a second job.changed
			// lands carrying it.
			const run = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.id}/run`, {
				method: "POST",
			});
			expect(run.status).toBe(200);
			const fired = await stream.waitFor(
				(f) =>
					f.event === "job.changed" &&
					f.data.type === "job.changed" &&
					f.data.job.id === job.id &&
					f.data.job.lastRun?.manual === true,
			);
			expect(fired.event).toBe("job.changed");
			// The hub-side copies never carried `access` (any value would be a
		// fabrication — only the stream may stamp it per principal).
			expect(hubFrames.length).toBeGreaterThan(0);
			for (const frame of hubFrames) {
				if (frame.type === "job.changed") {
					expect("access" in frame.job).toBe(false);
				}
			}
		} finally {
			offHub();
			stream.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});
});

// ---------------------------------------------------------------------------
// Scoping (token method; bob owns, dave observes) — Review Focus 3
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unknown event types are never delivered (exhaustive visibility —
// hardening review Task 4, Review Focus 4)
// ---------------------------------------------------------------------------

describe("GET /v1/events unknown event types", () => {
	test("an unhandled event type reaches no stream while providers.changed still does", { timeout: 20_000 }, async () => {
		const { opened, port } = await bootServer({
			auth: "token",
			extensions: false,
			extraUsers: ["alice", "bob"],
		});
		const aliceToken = await mint(opened, "alice");
		const bobToken = await mint(opened, "bob");
		const alice = new EventsConnection(port, {
			authorization: `Bearer ${aliceToken}`,
		});
		const bob = new EventsConnection(port, {
			authorization: `Bearer ${bobToken}`,
		});
		try {
			await alice.ready();
			await bob.ready();
			// Hub events of a type no route branch knows (cast through
			// unknown: nothing emits such an event today; the ui-blocks work
			// will). Two shapes: one with NO conversationId (the old path
			// threw inside snapshot), one with a conversationId that has no
			// SessionMeta (the old path hit accessOf(principal, {}) ===
			// "write" on the ownerless fallback and broadcast it).
			const unknowns: HostEventWire[] = [
				{
					type: "unhandled.futureEvent",
					note: "no conversation id",
				} as unknown as HostEventWire,
				{
					type: "unhandled.futureEvent",
					conversationId: 424242,
					note: "conversation with no meta",
				} as unknown as HostEventWire,
			];
			for (const unknown of unknowns) opened.events.publish(unknown);
			// The follow-up broadcast proves both streams are alive: it lands
			// on the same serial side lane AFTER the unknown event, so its
			// arrival means the unknown event was already decided.
			opened.events.publish({
				type: "providers.changed",
				provider: "faux",
				status: "ready",
			});
			for (const stream of [alice, bob]) {
				await stream.waitFor(
					(f) =>
						f.event === "providers.changed" &&
						f.data.type === "providers.changed",
				);
			}
			// The unknown events' lane decisions are settled (providers.changed
			// arrived after them); 200ms covers any lingering async work.
			await new Promise((resolve) => setTimeout(resolve, 200));
			for (const stream of [alice, bob]) {
				expect(
					stream.eventsSoFar().filter(
						(f) => f.event === "unhandled.futureEvent",
					),
				).toEqual([]);
			}
		} finally {
			alice.destroy();
			bob.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});
});

describe("GET /v1/events per-event scoping", () => {
	test("share → delivered; un-share → withheld (per-event re-snapshot)", { timeout: 20_000 }, async () => {
		const { opened, port } = await bootServer({
			auth: "token",
			extensions: false,
			extraUsers: ["bob", "dave"],
		});
		const bobToken = await mint(opened, "bob");
		const daveToken = await mint(opened, "dave");
		// Bob creates a private conversation.
		const create = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${bobToken}`,
			},
			body: "{}",
		});
		expect(create.status).toBe(201);
		const { id } = (await create.json()) as { id: number };
		// Dave's stream must NOT see bob's private conversation events.
		const dave = new EventsConnection(port, {
			authorization: `Bearer ${daveToken}`,
		});
		try {
			await dave.ready();
			const patch = async (body: Record<string, unknown>) => {
				const response = await fetch(
					`http://127.0.0.1:${port}/v1/conversations/${id}/meta`,
					{
						method: "PATCH",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${bobToken}`,
						},
						body: JSON.stringify(body),
					},
				);
				expect(response.status).toBe(200);
			};
			await patch({ name: "private one" });
			// The withheld event: give the frame a moment to (not) arrive.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(
				dave.eventsSoFar().filter((f) => f.event === "conversation.changed"),
			).toEqual([]);
			// Share household-read: the NEXT change reaches dave.
			await patch({ sharing: { scope: "household", level: "read" } });
			const shared = await dave.waitFor(
				(f) =>
					f.event === "conversation.changed" &&
					f.data.type === "conversation.changed" &&
					f.data.conversationId === id,
			);
			expect(shared.data.type).toBe("conversation.changed");
			// Un-share: the following change does NOT arrive.
			await patch({ sharing: { scope: "private" } });
			await new Promise((resolve) => setTimeout(resolve, 300));
			const changes = dave
				.eventsSoFar()
				.filter((f) => f.event === "conversation.changed");
			// Exactly one delivered change (the share commit's own diff) —
			// the un-share commit's change was withheld.
			expect(changes.length).toBe(1);
		} finally {
			dave.destroy();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});
});

// ---------------------------------------------------------------------------
// The ctrl+c regression (2026-10-22): a held-open SSE stream must never
// hang app.close() — hijacked event streams never end on their own, so the
// SseRegistry ends them before the drain. Verified at the app level (the
// real shutdown path's ordering: sse.endAll() before app.close()).
// ---------------------------------------------------------------------------

test("a held-open events stream does not hang app.close", async () => {
	const { app, port, opened } = await bootServer({ auth: "token", extraUsers: ["holder"] });
	const token = await mint(opened, "holder");
	// Open a REAL authed events stream and hold it (a browser tab).
	const controller = new AbortController();
	const held = fetch(`http://127.0.0.1:${port}/v1/events`, {
		headers: { authorization: `Bearer ${token}` },
		signal: controller.signal,
	});
	// Give the response headers a moment to land, then hold the body open.
	const response = await held;
	expect(response.status).toBe(200);
	// The shutdown ordering under test: endAll FIRST, then close — with a
	// 5s ceiling (the pre-fix behavior hung forever; the test fails loudly
	// on regression rather than timing the suite out).
	app.sse.endAll();
	await Promise.race([
		app.close(),
		new Promise((_resolve, reject) =>
			setTimeout(
				() => reject(new Error("app.close() hung on the held SSE stream")),
				5_000,
			),
		),
	]);
	controller.abort();
});
