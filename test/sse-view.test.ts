/**
 * Task 9d: SSE view stream + steer field (spec §5 "Views + watch frames over
 * SSE").
 *
 * `GET /v1/conversations/:id/stream` serves Server-Sent Events over the raw
 * hijacked reply: `event: snapshot` with the wire view on connect, then
 * `event: view` per watch revision, a `: ping` heartbeat every 15s, and
 * exactly-one-owner cleanup (stop the watch + clear the interval) on client
 * disconnect or watch termination. Each wire view carries the derived
 * `steer: { busy, queued }` field (submit-while-busy queue semantics).
 *
 * Test transport is a REAL loopback socket, not `app.inject()`: a hijacked
 * reply never resolves light-my-request's response promise (it only settles
 * on `end()`), so incremental SSE frames are unreachable through inject.
 * `app.listen({ port: 0, host: "127.0.0.1" })` + Node's `http` client keep
 * the suite hermetic (loopback only, no external network). Every test
 * destroys its connection before ending — a leaked interval or watch would
 * hang the vitest worker (the suite exiting cleanly IS the no-leak test).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	ConversationWatch,
} from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/**
 * One parsed SSE frame. Comment lines (`: ping`) are not events — the
 * heartbeat exists for proxies, not clients.
 */
interface SseEvent {
	readonly id: number;
	readonly event: string;
	readonly data: string;
}

/** A released gate (a deferred promise the test controls). */
interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}

/** A manual gate: the faux response factory awaits it before answering. */
function makeGate(): Gate {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release: () => release() };
}

/** One hermetic SSE server: harness + faux provider + real loopback port. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The loopback port the app listens on. */
	port: number;
	/**
	 * Every watch the server acquired, captured by a Proxy over the
	 * harness's conversation handles — lets tests assert the disconnect
	 * cleanup really stopped the watch (`handle.closed` → `{reason:
	 * "stopped"}`). The Proxy passes every property through untouched
	 * except `watch`.
	 */
	watches: ConversationWatch[];
}

/** Boot a hermetic server with a gated first response (a holdable run). */
async function bootServer(options?: { gate?: Gate }): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sse-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([
		async () => {
			// Hold the generation open until the test releases the gate: the
			// busy frame (pi.live.run present) must be observable mid-run.
			if (options?.gate !== undefined) await options.gate.promise;
			return fauxAssistantMessage("gated answer");
		},
		fauxAssistantMessage("second answer"),
	]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	// Capture every WatchHandle the server acquires (see TestServer.watches).
	const watches: ConversationWatch[] = [];
	const resolveConversation = opened.harness.conversation.bind(
		opened.harness,
	);
	const spied = opened.harness as {
		conversation: (
			id: ConversationId,
			context: Context,
		) => Promise<Conversation | undefined>;
	};
	spied.conversation = async (id, context) => {
		const conversation = await resolveConversation(id, context);
		if (conversation === undefined) return undefined;
		return new Proxy(conversation, {
			get(target, property) {
				if (property === "watch") {
					return async (watchContext: Context) => {
						const handle = await target.watch(watchContext);
						watches.push(handle);
						return handle;
					};
				}
				// Conversation handles carry ES private fields: every method must
				// run with `this` bound to the REAL instance, or private-member
				// reads throw on the proxy. Functions bind; plain fields pass.
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	await app.listen({ port: 0, host: "127.0.0.1" });
	const port = (app.server.address() as { port: number }).port;
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, port, watches };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * One open SSE connection: parses frames incrementally and can wait for an
 * event matching a predicate. `destroy()` closes the client socket — the
 * route's cleanup path (it must stop the watch; a leaked interval would
 * hang the worker).
 */
class SseConnection {
	private readonly request: http.ClientRequest;
	private readonly response: Promise<http.IncomingMessage>;
	private readonly events: SseEvent[] = [];
	private buffer = "";
	private readonly dataWaiters: Array<() => void> = [];

	constructor(port: number, path: string) {
		this.request = http.get({
			host: "127.0.0.1",
			port,
			path,
			// No agent: the socket's lifecycle is this request's alone.
			agent: false,
		});
		// A client-side socket error must not crash the worker mid-test.
		this.request.on("error", () => {});
		this.response = new Promise((resolve, reject) => {
			this.request.on("response", (incoming) => resolve(incoming));
			this.request.on("error", (error) => reject(error));
		});
		void this.response.then((incoming) => {
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => {
				this.buffer += chunk;
				this.drain();
			});
			incoming.on("error", () => {});
		});
	}

	/** The status + headers, once the server has flushed them. */
	async statusAndHeaders(): Promise<{
		status: number;
		headers: http.IncomingHttpHeaders;
	}> {
		const incoming = await this.response;
		return { status: incoming.statusCode ?? 0, headers: incoming.headers };
	}

	/** Parse every complete `\n\n`-terminated frame in the buffer. */
	private drain(): void {
		for (;;) {
			const boundary = this.buffer.indexOf("\n\n");
			if (boundary === -1) return;
			const frame = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			let id = 0;
			let event = "";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith(":")) continue; // heartbeat comment
				if (line.startsWith("id:")) id = Number(line.slice(3).trim());
				else if (line.startsWith("event:"))
					event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			this.events.push({ id, event, data });
			for (const wake of this.dataWaiters.splice(0)) wake();
		}
	}

	/**
	 * Await the first event matching `predicate` (already-parsed events
	 * first). Rejects after `timeoutMs` — the timer is always cleared so no
	 * waiter leaks.
	 */
	async waitFor(
		predicate: (event: SseEvent) => boolean,
		timeoutMs = 5_000,
	): Promise<SseEvent> {
		const found = this.events.find(predicate);
		if (found !== undefined) return found;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`timed out after ${timeoutMs}ms; events so far: ${JSON.stringify(
							this.events.map((event) => ({
								event: event.event,
								id: event.id,
							})),
						)}`,
					),
				);
			}, timeoutMs);
			const attempt = () => {
				const match = this.events.find(predicate);
				if (match === undefined) {
					this.dataWaiters.push(attempt);
					return;
				}
				clearTimeout(timer);
				resolve(match);
			};
			this.dataWaiters.push(attempt);
			this.drain();
		});
	}

	/** The parsed events so far (for post-hoc wire assertions). */
	eventsSoFar(): readonly SseEvent[] {
		return [...this.events];
	}

	/** Close the client socket (the server-side cleanup path). */
	destroy(): void {
		this.request.destroy();
	}
}

/** Parse a frame's data payload as the wire view (view + steer). */
function wireOf(event: SseEvent): {
	conversation: { id: number };
	entries: { kind: string }[];
	docs: Record<string, unknown>;
	steer: { busy: boolean; queued: number };
} {
	return JSON.parse(event.data);
}

async function rootOf(server: TestServer): Promise<Conversation> {
	return server.opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: server.opened.defaultModel },
	});
}

describe("GET /v1/conversations/:id/stream", () => {
	test("404s (JSON) for an unknown conversation id, before SSE", async () => {
		const server = await bootServer();
		const response = await server.app.inject({
			method: "GET",
			url: "/v1/conversations/999999/stream",
		});
		// The 404 mirrors the conversation-resolution pattern: plain JSON
		// error, never an SSE stream.
		expect(response.statusCode).toBe(404);
		expect(response.headers["content-type"]).toContain("application/json");
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});

	test("serves the hand-rolled SSE header set", async () => {
		const server = await bootServer();
		const root = await rootOf(server);
		const connection = new SseConnection(
			server.port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			const { status, headers } = await connection.statusAndHeaders();
			expect(status).toBe(200);
			expect(headers["content-type"]).toBe("text/event-stream");
			expect(headers["cache-control"]).toBe("no-cache");
			expect(headers["connection"]).toBe("keep-alive");
			expect(headers["x-accel-buffering"]).toBe("no");
			// Headers flush without waiting for the first event.
			const snapshot = await connection.waitFor(
				(event) => event.event === "snapshot",
			);
			expect(snapshot.id).toBe(1);
		} finally {
			connection.destroy();
		}
	});

	test("the first frame is a snapshot of the idle wire view (steer idle)", async () => {
		const server = await bootServer();
		const root = await rootOf(server);
		const connection = new SseConnection(
			server.port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			const snapshot = await connection.waitFor(
				(event) => event.event === "snapshot",
			);
			const view = wireOf(snapshot);
			expect(view.conversation).toEqual({ id: root.id });
			expect(view.steer).toEqual({ busy: false, queued: 0 });
		} finally {
			connection.destroy();
		}
	});

	test("view events arrive per revision: busy mid-run, settled after", async () => {
		const gate = makeGate();
		const server = await bootServer({ gate });
		const root = await rootOf(server);
		const connection = new SseConnection(
			server.port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			await connection.waitFor((event) => event.event === "snapshot");
			// Submit through the endpoint WITHOUT awaiting settlement — the
			// frames must arrive while the (gated) run is in flight.
			const settled = fetch(
				`http://127.0.0.1:${server.port}/v1/conversations/${root.id}/submissions`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ input: "while connected" }),
				},
			).then(async (response) => {
				expect(response.status).toBe(202);
				return (await response.json()) as { status: string };
			});
			// Mid-run frame: the run control is live (pi.live.run present).
			const busyFrame = await connection.waitFor(
				(event) => event.event === "view" && wireOf(event).steer.busy,
			);
			const busyView = wireOf(busyFrame);
			expect(busyView.steer).toEqual({ busy: true, queued: 0 });
			expect(busyView.conversation).toEqual({ id: root.id });
			gate.release();
			const settledFrame = await connection.waitFor(
				(event) =>
					event.event === "view" &&
					!wireOf(event).steer.busy &&
					wireOf(event).entries.some(
						(entry) => entry.kind === "pi.assistant",
					),
			);
			expect(wireOf(settledFrame).conversation).toEqual({ id: root.id });
			expect((await settled).status).toBe("done");
		} finally {
			connection.destroy();
		}
	});

	test("a steer-queued input shows queued > 0 while the run holds", async () => {
		const gate = makeGate();
		const server = await bootServer({ gate });
		const root = await rootOf(server);
		const connection = new SseConnection(
			server.port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			await connection.waitFor((event) => event.event === "snapshot");
			// First submission: gated, so the conversation stays busy.
			const first = submit(server, root.id, "first, gated");
			await connection.waitFor(
				(event) => event.event === "view" && wireOf(event).steer.busy,
			);
			// Second submission: submit-while-busy queues in pi.inbox.
			const second = submit(server, root.id, "second, queued");
			const queuedFrame = await connection.waitFor(
				(event) =>
					event.event === "view" &&
					wireOf(event).steer.busy &&
					wireOf(event).steer.queued > 0,
			);
			expect(wireOf(queuedFrame).steer).toEqual({ busy: true, queued: 1 });
			gate.release();
			// Both settle: the queued input is placed after the first run
			// (the second faux response serves it).
			expect(await first).toBe(202);
			expect(await second).toBe(202);
		} finally {
			connection.destroy();
		}
	});

	test("a reconnect gets a fresh snapshot (full revisions, no replay)", async () => {
		// The spec's reconnect contract collapses to "fresh snapshot on
		// (re)connect" because every frame is a FULL ConversationView — see
		// the Appendix C named-verification record in the spec.
		const server = await bootServer();
		const root = await rootOf(server);
		const first = new SseConnection(
			server.port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			const firstSnapshot = await first.waitFor(
				(event) => event.event === "snapshot",
			);
			// A committed change between connections — the second connection's
			// snapshot must reflect it, with no replay mechanism needed.
			await root.configure(
				{ model: { provider: "faux", modelId: "m" }, thinkingLevel: "high" },
				BACKGROUND_CONTEXT,
			);
			const second = new SseConnection(
				server.port,
				`/v1/conversations/${root.id}/stream`,
			);
			try {
				const secondSnapshot = await second.waitFor(
					(event) => event.event === "snapshot",
				);
				// Per-connection id counter restarts at 1.
				expect(secondSnapshot.id).toBe(1);
				expect(wireOf(secondSnapshot).docs["pi.agent"]).toEqual({
					model: { provider: "faux", modelId: "m" },
					thinkingLevel: "high",
				});
				expect(firstSnapshot.id).toBe(1);
			} finally {
				second.destroy();
			}
		} finally {
			first.destroy();
		}
	});

	test("disconnect stops the watch; a second connection still streams", async () => {
		const server = await bootServer();
		const root = await rootOf(server);
		const first = new SseConnection(
			server.port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			await first.waitFor((event) => event.event === "snapshot");
			first.destroy();
			// The captured WatchHandle for connection 1 must terminate: the
			// server's cleanup ran stop() (single owner, exactly once).
			const watch = server.watches[0];
			expect(watch).toBeDefined();
			await expect(watch.closed).resolves.toEqual({ reason: "stopped" });
			// The mount is still healthy: a second connection receives frames.
			const second = new SseConnection(
				server.port,
				`/v1/conversations/${root.id}/stream`,
			);
			try {
				await second.waitFor((event) => event.event === "snapshot");
				await root.configure({ thinkingLevel: "low" }, BACKGROUND_CONTEXT);
				await second.waitFor((event) => event.event === "view");
			} finally {
				second.destroy();
			}
			const secondWatch = server.watches[1];
			expect(secondWatch).toBeDefined();
			await expect(secondWatch.closed).resolves.toMatchObject({
				reason: "stopped",
			});
		} finally {
			first.destroy();
		}
	});

	test("event ids increase monotonically within a connection", async () => {
		const gate = makeGate();
		const server = await bootServer({ gate });
		const root = await rootOf(server);
		const connection = new SseConnection(
			server.port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			await connection.waitFor((event) => event.event === "snapshot");
			void submit(server, root.id, "ids");
			await connection.waitFor(
				(event) => event.event === "view" && wireOf(event).steer.busy,
			);
			gate.release();
			await connection.waitFor(
				(event) => event.event === "view" && !wireOf(event).steer.busy,
			);
			const ids = connection.eventsSoFar().map((event) => event.id);
			// At least snapshot + busy + settled.
			expect(ids.length).toBeGreaterThanOrEqual(3);
			for (let index = 1; index < ids.length; index++) {
				expect(ids[index]).toBeGreaterThan(ids[index - 1]);
			}
		} finally {
			connection.destroy();
		}
	});
});

function submit(server: TestServer, conversationId: number, input: string) {
	return fetch(
		`http://127.0.0.1:${server.port}/v1/conversations/${conversationId}/submissions`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input }),
		},
	).then((response) => response.status);
}
