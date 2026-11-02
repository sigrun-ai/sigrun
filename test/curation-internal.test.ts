/**
 * Task A2 (curator P5): internal runs — conversations created for curator
 * work are invisible on every owner-keyed path.
 *
 * The marker is a server-owned `SessionMeta.internal: true` written in the
 * creating commit (`markInternal`, which also stamps the curated user as
 * `owner`). Every path a user could observe a conversation through must
 * skip internal ones: the HTTP listing (even for the superuser), the host
 * bridge's `conversations.list`, the `:id` route loader (404 on every
 * route, superuser included), the auto-namer, the run.settled notifier,
 * extension `runSettled` delivery, the idle clock, and the per-principal
 * SSE event stream.
 *
 * Gates pinned here (one per brief line):
 * - hidden from `GET /v1/conversations` even for the superuser;
 * - hidden from `host.conversations.list({owner: "alice"})`;
 * - never auto-named;
 * - no `run.settled` notification (the fixture-notifier records nothing);
 * - no extension `runSettled` delivery (fixture-memory-events records
 *   nothing);
 * - does not stamp the idle clock (a `sweepIdle` past the threshold fires
 *   nothing for it — the internal admission never armed the clock);
 * - every `:id` route answers 404, superuser included (meta, export,
 *   files, stream);
 * - the owner's event stream carries no events for it;
 * - `PATCH …/meta` carrying `internal` is a 400 `invalid_field` (the
 *   strict validator keeps rejecting server-owned keys).
 *
 * Hermetic pattern (curation-attribution.test.ts): faux provider + tmp
 * workspace + `app.inject()`; the idle/events gates boot their own
 * servers with the fixtures they need. The events-stream gate needs a
 * REAL loopback socket (a hijacked SSE reply never settles under
 * light-my-request — see events-stream.test.ts).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { markInternal } from "../src/curation/internal.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { HostEventWire } from "@sigrun/shared/views";

/** The fixture-memory-events entry (runSettled + lifecycle recorder). */
const MEMORY_EVENTS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory-events", "index.js"),
).href;

/** The fixture-notifier entry (records every delivered notification). */
const NOTIFIER_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notifier", "index.js"),
).href;

/** The fixture module's exports (the events record + its reset). */
type FixtureModule = {
	readonly events: readonly {
		conversationId: number;
	}[];
	readonly lifecycle: readonly { readonly handler: string }[];
	readonly resetEvents: () => void;
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(MEMORY_EVENTS_SPECIFIER)) as unknown as FixtureModule;
}

/** The recorder's shared array (globalThis — see notifications.test.ts).
 * MUST be initialized here before the fixture records (the fixture reads
 * `globalThis.__fixtureNotifierEvents ?? localEvents` — an unset key
 * would leave the test reading a throwaway array). */
function notifierEvents(): { type: string; conversationId?: number }[] {
	return (((globalThis as { __fixtureNotifierEvents?: [] })
		.__fixtureNotifierEvents ??= []));
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

/** One hermetic server: harness + faux provider + Fastify app (+ port). */
interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly config: SigrunConfig;
	readonly faux: ReturnType<typeof fauxProvider>;
	/** The loopback port (0 = never listened — inject-only servers). */
	readonly port: number;
	readonly dir: string;
}

/** Boot one hermetic server in a tmpdir; registers cleanup. */
async function bootServer(options?: {
	readonly responses?: readonly AssistantMessage[];
	/** The boot event-bus seam (the idle gate shrinks the threshold). */
	readonly eventBus?: { idleThresholdMs?: number; idleSweepMs?: number };
	/** Extension specifiers to install (the fixture recorders). */
	readonly extensionSpecifiers?: readonly string[];
	/** Listen on a loopback port (the SSE-stream gate's real socket). */
	readonly listen?: boolean;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-internal-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...(options?.responses ?? [])]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
	});
	// Naming stays ON (the auto-name gate asserts the namer skipped) — but
	// scripted boots never script a naming answer, so the namer must never
	// fire for the internal conversation in the first place (the gate).
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			namingModel: "faux/m",
			...(options?.eventBus === undefined ? {} : {}),
		}),
	);
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
		eventBus: options?.eventBus,
		...(options?.extensionSpecifiers === undefined
			? {}
			: { extensionSpecifiers: options.extensionSpecifiers }),
	});
	const app = await createServer(opened, config);
	let port = 0;
	if (options?.listen === true) {
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (address === null || typeof address === "string") {
			throw new Error("listen did not bind a port");
		}
		port = address.port;
	}
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, config, faux, port, dir };
}

const cleanups: Array<() => Promise<void>> = [];
// The suite boots ~8 hermetic servers; their closes (each waits on the
// harness close) exceed the default 10s hook budget under full-suite load.
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
}, 120_000);

/**
 * Create one INTERNAL conversation owned by `alice` — the P6 producer's
 * exact shape: `harness.createConversation` with `init` marking the doc in
 * the creating commit.
 */
async function createInternal(
	opened: OpenedHarness,
	owner = "alice",
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: opened.defaultModel },
			init: async (tx, id) => {
				await markInternal(tx, id, owner);
			},
		},
		BACKGROUND_CONTEXT,
	);
	return conversation.id as number;
}

/** Create one ORDINARY conversation over HTTP as `user`; returns its id. */
async function createOrdinary(
	app: FastifyInstance,
	user: string | undefined,
): Promise<number> {
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: user === undefined ? {} : { "x-sigrun-user": user },
	});
	expect(response.statusCode).toBe(201);
	return response.json().id;
}

/**
 * Run one faux turn inside a conversation through the harness (the §7.1
 * bounded wait — the internal conversation's own turn).
 */
async function runOneTurn(
	opened: OpenedHarness,
	conversationId: number,
): Promise<void> {
	const conversation = await opened.harness.conversation(
		conversationId as never,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
	const submission = await conversation!.submit(
		{ type: "input", content: "internal review instruction" },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	expect(record.status).toBe("done");
}

/** The session-meta snapshot of one conversation (undefined = absent doc). */
async function metaOf(
	opened: OpenedHarness,
	id: number,
): Promise<Record<string, unknown> | undefined> {
	return (await opened.harness.snapshot(
		SessionMetaDoc,
		id as never,
		BACKGROUND_CONTEXT,
	)) as unknown as Record<string, unknown> | undefined;
}

/** One parsed SSE frame from a loopback /v1/events connection. */
interface HostFrame {
	readonly event: string;
	readonly data: HostEventWire;
}

/** Collect every frame a loopback /v1/events connection sees (best-effort). */
class EventsConnection {
	private readonly events: HostFrame[] = [];
	private buffer = "";
	#request: http.ClientRequest | undefined;

	constructor(
		private readonly port: number,
		private readonly headers: Record<string, string>,
	) {}

	/** Open the stream and resolve once headers arrived (subscription live). */
	open(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = http.get({
				host: "127.0.0.1",
				port: this.port,
				path: "/v1/events",
				headers: this.headers,
				agent: false,
			});
			this.#request = request;
			request.on("error", (error) => reject(error));
			request.on("response", (incoming) => {
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk: string) => {
					this.buffer += chunk;
					this.drain();
				});
				incoming.on("error", () => {});
				resolve();
			});
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
		}
	}

	/** Every frame naming one conversation (any `conversationId` field). */
	forConversation(id: number): readonly HostFrame[] {
		return this.events.filter((frame) => {
			const data = frame.data as { conversationId?: number };
			return data?.conversationId === id;
		});
	}

	/** Every frame seen so far (named-event probes). */
	all(): readonly HostFrame[] {
		return [...this.events];
	}

	/** Await one named event type (the control: the stream works). */
	async waitFor(
		predicate: (frame: HostFrame) => boolean,
		timeoutMs = 10_000,
	): Promise<HostFrame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find(predicate);
			if (found !== undefined) return found;
			if (Date.now() > deadline) {
				throw new Error(
					`timed out; frames so far: ${JSON.stringify(
						this.events.map((frame) => frame.event),
					)}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	/** Destroy the client socket — the SSE request otherwise never ends and
	 * `app.close()` waits on it forever (the notifications.test.ts lesson). */
	close(): void {
		this.#request?.destroy();
	}
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

describe("internal conversations (curator P5)", () => {
	test("hidden from GET /v1/conversations even for the superuser", { timeout: 20_000 }, async () => {
		const server = await bootServer();
		const id = await createInternal(server.opened);
		// The superuser is the naive no-header caller under auth "none".
		const listed = await server.app.inject({
			method: "GET",
			url: "/v1/conversations",
		});
		expect(listed.statusCode).toBe(200);
		const rows = listed.json().conversations as { id: number }[];
		expect(rows.some((row) => row.id === id)).toBe(false);
		// The control: an ordinary conversation IS listed (the filter is
		// the marker, not a broken listing).
		const ordinary = await createOrdinary(server.app, "alice");
		const relisted = await server.app.inject({
			method: "GET",
			url: "/v1/conversations",
		});
		const ids = (relisted.json().conversations as { id: number }[]).map(
			(row) => row.id,
		);
		expect(ids).not.toContain(id);
		expect(ids).toContain(ordinary);
	});

	test("hidden from host.conversations.list({owner: \"alice\"})", { timeout: 20_000 }, async () => {
		const server = await bootServer();
		const id = await createInternal(server.opened, "alice");
		const rows = await server.app.hostBridge.conversations.list({
			owner: "alice",
		});
		expect(rows.some((row) => row.id === id)).toBe(false);
		// The bridge's unfiltered list (the superuser shape) skips it too.
		const all = await server.app.hostBridge.conversations.list({});
		expect(all.some((row) => row.id === id)).toBe(false);
	});

	test("never auto-named", { timeout: 20_000 }, async () => {
		const server = await bootServer({
			responses: [fauxAssistantMessage("the internal answer")],
		});
		const id = await createInternal(server.opened);
		await runOneTurn(server.opened, id);
		// The settle-driven namer runs on the boot-scheduled drain; pump it
		// deterministically and wait out the background naming chain.
		await server.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		await server.opened.autoNamer.idle();
		const meta = await metaOf(server.opened, id);
		expect(meta?.autoName).toBeUndefined();
		expect(meta?.autoNameAttempts).toBeUndefined();
		// The naming model consumed nothing: the namer never fired.
		expect(server.faux.getPendingResponseCount()).toBe(0);
	});

	test("no run.settled notification", { timeout: 20_000 }, async () => {
		const server = await bootServer({
			// Two turns: the internal run (the gate) + the ordinary control run.
			responses: [
				fauxAssistantMessage("the internal answer"),
				fauxAssistantMessage("the ordinary answer"),
			],
			extensionSpecifiers: [NOTIFIER_SPECIFIER],
		});
		notifierEvents().length = 0;
		const id = await createInternal(server.opened);
		await runOneTurn(server.opened, id);
		await server.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		// The run.settled delivery is fire-and-forget on the side lane;
		// one macrotask suffices for the bounded call to have run.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const settled = notifierEvents().filter(
			(event) =>
				event.type === "run.settled" && event.conversationId === id,
		);
		expect(settled).toHaveLength(0);
		// The control: an ordinary run of the same shape DOES notify (the
		// gate is the marker, not a dead notifier pipeline).
		notifierEvents().length = 0;
		const ordinary = await createOrdinary(server.app, "alice");
		const response = await server.app.inject({
			method: "POST",
			url: `/v1/conversations/${ordinary}/submissions?waitMs=5000`,
			payload: { input: "ordinary turn" },
			headers: { "content-type": "application/json", "x-sigrun-user": "alice" },
		});
		expect(response.statusCode).toBe(202);
		await vi.waitFor(
			() =>
				expect(
					notifierEvents().some(
						(event) =>
							event.type === "run.settled" &&
							event.conversationId === ordinary,
					),
				).toBe(true),
			{ timeout: 5_000, interval: 50 },
		);
	});

	test("no extension runSettled delivery", { timeout: 20_000 }, async () => {
		const server = await bootServer({
			responses: [
				fauxAssistantMessage("the internal answer"),
				fauxAssistantMessage("the ordinary answer"),
			],
			extensionSpecifiers: [MEMORY_EVENTS_SPECIFIER],
		});
		const fixture = await fixtureModule();
		fixture.resetEvents();
		const id = await createInternal(server.opened);
		await runOneTurn(server.opened, id);
		await server.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		// The fixture received nothing for the internal conversation (the
		// brief: "fixture fixture-memory-events records nothing").
		expect(
			fixture.events.filter((one) => one.conversationId === id),
		).toHaveLength(0);
		// The control: the same fixture receives the ordinary run's settle.
		const ordinary = await createOrdinary(server.app, "alice");
		const response = await server.app.inject({
			method: "POST",
			url: `/v1/conversations/${ordinary}/submissions?waitMs=5000`,
			payload: { input: "ordinary turn" },
			headers: { "content-type": "application/json", "x-sigrun-user": "alice" },
		});
		expect(response.statusCode).toBe(202);
		await vi.waitFor(
			() =>
				expect(
					fixture.events.some((one) => one.conversationId === ordinary),
				).toBe(true),
			{ timeout: 5_000, interval: 50 },
		);
		expect(
			fixture.events.filter((one) => one.conversationId === id),
		).toHaveLength(0);
	});

	test("does not stamp the idle clock", { timeout: 20_000 }, async () => {
		const server = await bootServer({
			responses: [fauxAssistantMessage("the internal answer")],
			extensionSpecifiers: [MEMORY_EVENTS_SPECIFIER],
			eventBus: { idleThresholdMs: 300, idleSweepMs: 50 },
		});
		const fixture = await fixtureModule();
		fixture.resetEvents();
		const id = await createInternal(server.opened);
		await runOneTurn(server.opened, id);
		// Let the real sweep run well past the threshold (several ticks):
		// the internal conversation's admission must never have armed the
		// idle clock, so no conversationIdle fires for it.
		await new Promise((resolve) => setTimeout(resolve, 700));
		const idle = fixture.lifecycle.filter(
			(one) =>
				one.handler === "conversationIdle" &&
				(one as { conversationId?: number }).conversationId === id,
		);
		expect(idle).toHaveLength(0);
		// The sweep itself still works (the control): an ordinary
		// conversation's run arms the clock and fires idle.
		const ordinary = await createOrdinary(server.app, "alice");
		const response = await server.app.inject({
			method: "POST",
			url: `/v1/conversations/${ordinary}/submissions?waitMs=5000`,
			payload: { input: "ordinary turn" },
			headers: { "content-type": "application/json", "x-sigrun-user": "alice" },
		});
		expect(response.statusCode).toBe(202);
		await vi.waitFor(
			() =>
				expect(
					fixture.lifecycle.some(
						(one) =>
							one.handler === "conversationIdle" &&
							(one as { conversationId?: number }).conversationId ===
								ordinary,
					),
				).toBe(true),
			{ timeout: 5_000, interval: 50 },
		);
		// And still nothing for the internal one.
		expect(
			fixture.lifecycle.filter(
				(one) =>
					one.handler === "conversationIdle" &&
					(one as { conversationId?: number }).conversationId === id,
			),
		).toHaveLength(0);
	});

	test("every :id route answers 404 for it, superuser included", { timeout: 20_000 }, async () => {
		const server = await bootServer();
		const id = await createInternal(server.opened);
		// The brief names meta, export, files, stream. The superuser is the
		// no-header caller; alice (the owner) gets the same 404s.
		for (const [label, request] of [
			["meta", { method: "GET", url: `/v1/conversations/${id}/meta` }],
			[
				"export",
				{ method: "GET", url: `/v1/conversations/${id}/export` },
			],
			[
				"files",
				{ method: "GET", url: `/v1/conversations/${id}/files` },
			],
			["get", { method: "GET", url: `/v1/conversations/${id}` }],
		] as const) {
			const response = await server.app.inject({
				...request,
				headers: { "x-sigrun-user": "alice" },
			});
			expect(response.statusCode, label).toBe(404);
			expect(response.json(), label).toEqual({
				error: "conversation_not_found",
			});
			// The superuser (no header) sees the same 404.
			const superresponse = await server.app.inject(request);
			expect(superresponse.statusCode, `superuser ${label}`).toBe(404);
			expect(superresponse.json(), `superuser ${label}`).toEqual({
				error: "conversation_not_found",
			});
		}
		// The SSE stream route hijacks the reply, so a hijacked SSE answer
		// carries no JSON body — assert its STATUS through the real socket.
		const stream = await server.app.inject({
			method: "GET",
			url: `/v1/conversations/${id}/stream`,
		});
		expect(stream.statusCode).toBe(404);
		expect(stream.json()).toEqual({ error: "conversation_not_found" });
	});

	test("the owner's event stream carries no events for it", { timeout: 20_000 }, async () => {
		const server = await bootServer({
			responses: [fauxAssistantMessage("the internal answer")],
			listen: true,
		});
		const connection = new EventsConnection(server.port, {});
		await connection.open();
		const id = await createInternal(server.opened);
		await runOneTurn(server.opened, id);
		// Wait long enough for every commit-derived event (created, changed,
		// admitted, settled) to have had its chance.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(connection.forConversation(id)).toHaveLength(0);
		// The control: the stream itself works — an ordinary conversation's
		// events arrive.
		const ordinary = await createOrdinary(server.app, "alice");
		await connection.waitFor(
			(frame) =>
				frame.event === "conversation.created" &&
				(frame.data as { conversationId?: number }).conversationId ===
					ordinary,
		);
		expect(connection.forConversation(id)).toHaveLength(0);
		connection.close();
	});

	test("PATCH meta with internal is 400 invalid_field", { timeout: 20_000 }, async () => {
		const server = await bootServer();
		const ordinary = await createOrdinary(server.app, "alice");
		const response = await server.app.inject({
			method: "PATCH",
			url: `/v1/conversations/${ordinary}/meta`,
			payload: { internal: true },
			headers: { "content-type": "application/json", "x-sigrun-user": "alice" },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: "invalid_field",
			field: "internal",
		});
	});

	// -------------------------------------------------------------------
	// The marker itself
	// -------------------------------------------------------------------

	test("markInternal sets owner and internal in the creating commit", { timeout: 20_000 }, async () => {
		const server = await bootServer();
		const id = await createInternal(server.opened, "alice");
		const meta = await metaOf(server.opened, id);
		expect(meta?.internal).toBe(true);
		expect(meta?.owner).toBe("alice");
	});
});
