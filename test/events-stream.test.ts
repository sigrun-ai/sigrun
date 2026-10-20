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
					body: { text: "proceed?" },
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
				{ text: "yes" },
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
					body: { line: { text: "watching" } },
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
});

// ---------------------------------------------------------------------------
// Scoping (token method; bob owns, dave observes) — Review Focus 3
// ---------------------------------------------------------------------------

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
