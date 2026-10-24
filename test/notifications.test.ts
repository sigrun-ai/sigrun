/**
 * Core hardening W5 Task 6 (spec §9.6): notifier contributions.
 *
 * `startNotifications` (src/server/notifications.ts) subscribes to the
 * event hub, builds one `NotificationEvent` PER RECIPIENT, and delivers
 * to every collected notifier through the event bus's bounded side lane
 * (`eventBus.runBounded`). Pinned here:
 *
 * - `interaction.pending` goes to the conversation owner, and — after a
 *   `write` share — to the sharee too (every directory user with `write`
 *   via `accessOf`); title "Sigrun needs you", body the display name
 *   (`name ?? autoName ?? "Conversation <id>"`);
 * - `run.settled` follows `notifications.runSettled`: the default
 *   `"unwatched"` suppresses the notification while a `/stream` client
 *   is attached (the away-from-desk rule — the SSE route's
 *   `watchersByConversation` count) and delivers once the stream is
 *   gone; `"never"` suppresses entirely; `"cron"` serves only
 *   job-run conversations (`SessionMeta.source === "cron"`);
 * - `job.failed` fires when a job's run record settles failed, to the
 *   job's owner, with title "Job <name> failed" and the error as body;
 * - a notifier that throws is logged and isolated: the other notifiers
 *   still receive the event, and no unhandled rejection escapes;
 * - `url` is `${SIGRUN_PUBLIC_URL}/#/c/<conversationId>` when the env is
 *   set and absent otherwise.
 *
 * Hermetic pattern (interactions-inbox + sse-view): token method, faux
 * provider, tmp workspace, `app.inject()` for the plain routes — plus a
 * REAL loopback socket for the `/stream` attach test (a hijacked SSE
 * reply is unreachable through inject). The fixtures: `fixture-notifier`
 * (the two notifiers under delivery) and `fixture-seam` (its host seeds
 * interactions). bob and dave are the only directory users (no admin —
 * the recipient set stays exactly assertable).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterAll, describe, expect, test, vi } from "vitest";
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
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import type { JobWire } from "@sigrun/shared/jobs";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import type { NotificationEvent } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { unclaimedIdentity } from "./helpers/identity.js";
import { askTree } from "./helpers/trees.js";

/**
 * The recorder's shared array (the fixture-channel retrieval pattern: the
 * loader's `import()` and this test never share a module instance, so the
 * fixture publishes its array on globalThis — the one shared address space).
 */
function notifierEvents(): NotificationEvent[] {
	return (globalThis as { __fixtureNotifierEvents?: NotificationEvent[] })
		.__fixtureNotifierEvents ?? [];
}

/** Clear the recorded events (per-test isolation). */
function resetNotifierEvents(): void {
	((globalThis as { __fixtureNotifierEvents?: NotificationEvent[] }).__fixtureNotifierEvents ??= [])
		.length = 0;
}

const NOTIFIER_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notifier", "index.js"),
).href;
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

/** One parsed SSE frame (comments excluded). */
interface SseEvent {
	readonly id: number;
	readonly event: string;
	readonly data: string;
}

/** One hermetic notifications server: harness + faux provider + port. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	/** The loopback port (the /stream attach test's real socket). */
	port: number;
	readonly bob: string;
	readonly dave: string;
	readonly faux: FauxProviderHandle;
	/**
	 * Every watch the server acquired, captured by a Proxy over the
	 * harness's conversation handles (the sse-view pattern) — lets the
	 * attach test await the stream's watch termination (the server-side
	 * `finish`, where the watcher count decrements) before proceeding.
	 */
	watches: ConversationWatch[];
	close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic CLAIMED server under the token method. */
async function bootServer(options?: {
	/** `SIGRUN_PUBLIC_URL` — set to build notification deep links. */
	readonly publicUrl?: string;
	/** The `notifications` settings section, written before boot. */
	readonly notifications?: Record<string, unknown>;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-notif-"));
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
		SIGRUN_AUTH: "token",
		...(options?.publicUrl === undefined
			? {}
			: { SIGRUN_PUBLIC_URL: options.publicUrl }),
	};
	const config = loadConfig(env);
	// namingModel off: the display-name assertions pin "Conversation <id>"
	// exactly (the auto-namer would otherwise race the delivery).
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			namingModel: false,
			...(options?.notifications === undefined
				? {}
				: { notifications: options.notifications }),
		}),
	);
	const identity = await unclaimedIdentity(dir);
	for (const user of ["bob", "dave"]) {
		if (identity.users.get(user) === undefined) {
			await identity.users.add({ user, admin: false, source: "cli" });
		}
	}
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
		identity,
		settingsDir: dir,
		extensionSpecifiers: [NOTIFIER_SPECIFIER, SEAM_SPECIFIER],
	});
	const app = await createServer(opened, config);
	// The watch capture (see TestServer.watches).
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
				// Conversation handles carry ES private fields: every method
				// must run with `this` bound to the REAL instance.
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	await app.listen({ port: 0, host: "127.0.0.1" });
	const port = (app.server.address() as { port: number }).port;
	const { token: bob } = await opened.identity.tokens.create("bob-cli", "bob");
	const { token: dave } = await opened.identity.tokens.create(
		"dave-cli",
		"dave",
	);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(close);
	resetNotifierEvents();
	return { app, opened, config, port, bob, dave, faux, watches, close };
}

/** The Bearer header set for one token. */
function auth(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

/** Create a conversation as `token`'s user; returns its id. */
async function createConversation(
	app: FastifyInstance,
	token: string,
): Promise<number> {
	const created = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: auth(token),
	});
	expect(created.statusCode).toBe(201);
	return created.json().id as number;
}

/** Submit one text turn; returns when admitted (202). */
async function submit(
	app: FastifyInstance,
	token: string,
	id: number,
	text: string,
): Promise<void> {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/submissions`,
		headers: auth(token),
		payload: { input: [{ type: "text", text }] },
	});
	expect(response.statusCode).toBe(202);
}

/** The fixture-seam host (its `seedInteraction` writes a pending record). */
function seamHostOf(opened: OpenedHarness): SeamHost {
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("fixture-seam host not loaded");
	return host;
}

/** Seed one pending interaction in `conv`. */
async function seedInteraction(
	opened: OpenedHarness,
	conv: number,
	callId: string,
): Promise<void> {
	await seamHostOf(opened).seedInteraction(
		conv as never,
		{
			kind: "fixture.ask",
			callId,
			status: "pending",
			createdAt: Date.now(),
			body: askTree(),
		},
		BACKGROUND_CONTEXT,
	);
}

/** Poll the recorder until one event matches; fails at the deadline. */
async function waitForEvent(
	predicate: (event: NotificationEvent) => boolean,
	timeoutMs = 10_000,
): Promise<NotificationEvent> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = notifierEvents().find(predicate);
		if (found !== undefined) return found;
		if (Date.now() > deadline) {
			throw new Error(
				`no matching notification arrived (recorded: ${JSON.stringify(notifierEvents())})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Poll the conversation view until an assistant entry lands. */
async function waitAssistant(
	app: FastifyInstance,
	token: string,
	id: number,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const view = await app.inject({
			method: "GET",
			url: `/v1/conversations/${id}`,
			headers: auth(token),
		});
		expect(view.statusCode).toBe(200);
		const answered = (
			view.json() as { entries: readonly { kind: string }[] }
		).entries.some((entry) => entry.kind === "pi.assistant");
		if (answered) return;
		if (Date.now() > deadline) {
			throw new Error(`no pi.assistant entry in conversation ${id} yet`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** The settled events of one type (all recipients). */
function ofType(type: NotificationEvent["type"]): NotificationEvent[] {
	return notifierEvents().filter((event) => event.type === type);
}

/** Poll an async read until `accepts` passes (or fail at the deadline). */
async function waitFor<T>(
	read: () => Promise<T>,
	accepts: (value: T) => boolean,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (accepts(value)) return value;
		if (Date.now() > deadline) throw new Error("condition never arrived");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * One open SSE connection over a REAL loopback socket (the sse-view
 * pattern: a hijacked reply never resolves light-my-request's promise).
 */
class SseConnection {
	private readonly request: http.ClientRequest;
	private readonly response: Promise<http.IncomingMessage>;
	private readonly events: SseEvent[] = [];
	private buffer = "";

	constructor(port: number, path: string, token: string) {
		this.request = http.get({
			host: "127.0.0.1",
			port,
			path,
			headers: { authorization: `Bearer ${token}` },
			agent: false,
		});
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
				if (line.startsWith(":")) continue;
				if (line.startsWith("id:")) id = Number(line.slice(3).trim());
				else if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			this.events.push({ id, event, data });
		}
	}

	/** Await the first event matching `predicate`. */
	async waitFor(
		predicate: (event: SseEvent) => boolean,
		timeoutMs = 10_000,
	): Promise<SseEvent> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find(predicate);
			if (found !== undefined) return found;
			if (Date.now() > deadline) throw new Error("no SSE frame arrived");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	/** Close the client socket — the route's disconnect cleanup path. */
	destroy(): void {
		this.request.destroy();
	}
}

describe("interaction.pending recipients (spec §9.6)", () => {
	test("the owner alone under a private share; the write sharee joins; url from SIGRUN_PUBLIC_URL", { timeout: 30_000 }, async () => {
		const server = await bootServer({
			publicUrl: "https://sigrun.example.invalid",
		});
		const conv = await createConversation(server.app, server.bob);
		resetNotifierEvents();
		await seedInteraction(server.opened, conv, "notif-first");
		const first = await waitForEvent(
			(event) => event.type === "interaction.pending",
		);
		expect(first).toEqual({
			type: "interaction.pending",
			conversationId: conv,
			// Gateway C6: the pending record's callId rides the event (the
			// notifier can read the record via host.snapshotInteraction).
			callId: "notif-first",
			jobId: undefined,
			user: "bob",
			title: "Sigrun needs you",
			body: `Conversation ${conv}`,
			url: `https://sigrun.example.invalid/#/c/${conv}`,
		});
		// Exactly one recipient: dave (no share yet) is NOT notified.
		expect(ofType("interaction.pending")).toHaveLength(1);

		// A `write` share to dave: he can now answer, so he is notified too.
		const shared = await server.app.inject({
			method: "PATCH",
			url: `/v1/conversations/${conv}/meta`,
			headers: auth(server.bob),
			payload: {
				sharing: { scope: "people", users: ["dave"], level: "write" },
			},
		});
		expect(shared.statusCode).toBe(200);
		resetNotifierEvents();
		await seedInteraction(server.opened, conv, "notif-second");
		await waitForEvent(
			(event) =>
				(event.type === "interaction.pending" && event.user === "dave"),
		);
		// Gateway C6: the SECOND seed's callId rides its events too.
		const second = waitForEvent(
			(event) =>
				event.type === "interaction.pending" &&
				event.callId === "notif-second",
		);
		await second;
		const users = ofType("interaction.pending")
			.map((event) => event.user)
			.sort();
		expect(users).toEqual(["bob", "dave"]);
	});
});

describe("run.settled per notifications.runSettled", () => {
	test("unwatched (default): suppressed while a /stream client is attached, delivered after it closes", { timeout: 30_000 }, async () => {
		const server = await bootServer({
			publicUrl: "https://sigrun.example.invalid",
		});
		const conv = await createConversation(server.app, server.bob);
		const connection = new SseConnection(
			server.port,
			`/v1/conversations/${conv}/stream`,
			server.bob,
		);
		await connection.waitFor((frame) => frame.event === "snapshot");
		resetNotifierEvents();
		await submit(server.app, server.bob, conv, "watched turn");
		await waitAssistant(server.app, server.bob, conv);
		// The settle was observed (the answer is in the view); delivery is
		// kicked at the settle commit, so a grace period bounds the
		// absence assertion.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(ofType("run.settled")).toHaveLength(0);

		// Close the stream: the route's finish decrements the watcher
		// count. Await the watch termination (it stops inside finish)
		// before the next settle, so the unwatched rule sees zero.
		connection.destroy();
		const watch = server.watches[server.watches.length - 1];
		expect(watch).toBeDefined();
		await Promise.race([
			watch!.closed,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("watch never closed")), 10_000),
			),
		]);
		server.faux.appendResponses([fauxAssistantMessage("unwatched answer")]);
		resetNotifierEvents();
		await submit(server.app, server.bob, conv, "unwatched turn");
		const settled = await waitForEvent(
			(event) => event.type === "run.settled",
		);
		expect(settled).toEqual({
			type: "run.settled",
			conversationId: conv,
			jobId: undefined,
			user: "bob",
			title: "Reply ready",
			body: `Conversation ${conv}`,
			url: `https://sigrun.example.invalid/#/c/${conv}`,
		});
		// Gateway C6: callId rides ONLY interaction.pending — never settle events.
		expect("callId" in settled).toBe(false);
	});

	test('"never": no run.settled at all', { timeout: 30_000 }, async () => {
		const server = await bootServer({
			notifications: { runSettled: "never" },
		});
		const conv = await createConversation(server.app, server.bob);
		resetNotifierEvents();
		await submit(server.app, server.bob, conv, "never turn");
		await waitAssistant(server.app, server.bob, conv);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(ofType("run.settled")).toHaveLength(0);
	});

	test('"cron": only job-run conversations (source "cron"), never plain user conversations', { timeout: 30_000 }, async () => {
		const server = await bootServer({
			notifications: { runSettled: "cron" },
		});
		// A plain user conversation: suppressed.
		const conv = await createConversation(server.app, server.bob);
		await submit(server.app, server.bob, conv, "cron-mode user turn");
		await waitAssistant(server.app, server.bob, conv);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(
			ofType("run.settled").filter(
				(event) => event.conversationId === conv,
			),
		).toHaveLength(0);

		// A job run's conversation (source "cron"): delivered to the job
		// owner, whose name the conversation carries.
		server.faux.appendResponses([fauxAssistantMessage("cron ok")]);
		const created = await server.app.inject({
			method: "POST",
			url: "/v1/jobs",
			headers: auth(server.bob),
			payload: {
				name: "tickler",
				schedule: { every: "3600s" },
				action: { kind: "prompt", prompt: "say ok", conversation: "new" },
			},
		});
		expect(created.statusCode).toBe(201);
		const job = created.json().job as JobWire;
		const fired = await server.app.inject({
			method: "POST",
			url: `/v1/jobs/${job.id}/run`,
			headers: auth(server.bob),
		});
		expect(fired.statusCode).toBe(200);
		const settled = await waitForEvent(
			(event) =>
				event.type === "run.settled" &&
				event.conversationId === fired.json().conversationId,
		);
		expect(settled.user).toBe("bob");
		expect(settled.title).toBe("Reply ready");
	});
});

describe("job.failed", () => {
	test("a failed run notifies the job owner with the error; url absent without SIGRUN_PUBLIC_URL", { timeout: 30_000 }, async () => {
		const server = await bootServer();
		server.faux.setResponses([
			fauxAssistantMessage("boom", {
				stopReason: "error",
				errorMessage: "faux provider failure",
			}),
		]);
		const created = await server.app.inject({
			method: "POST",
			url: "/v1/jobs",
			headers: auth(server.bob),
			payload: {
				name: "nightly",
				schedule: { every: "3600s" },
				action: { kind: "prompt", prompt: "say ok", conversation: "new" },
			},
		});
		expect(created.statusCode).toBe(201);
		const job = created.json().job as JobWire;
		const fired = await server.app.inject({
			method: "POST",
			url: `/v1/jobs/${job.id}/run`,
			headers: auth(server.bob),
		});
		expect(fired.statusCode).toBe(200);
		// The failed run record's error text is the notification's body —
		// read it off the job row (the observer settles `failed` with the
		// run's unanswered reason).
		const failedRun = await waitFor(async () => {
			const row = await server.app.inject({
				method: "GET",
				url: `/v1/jobs/${job.id}`,
				headers: auth(server.bob),
			});
			expect(row.statusCode).toBe(200);
			return (row.json().job as JobWire).lastRun;
		}, (run) => run?.outcome === "failed");
		expect(failedRun?.error).toBeDefined();
		const failed = await waitForEvent(
			(event) => event.type === "job.failed",
		);
		expect(failed).toEqual({
			type: "job.failed",
			conversationId: fired.json().conversationId,
			jobId: job.id,
			user: "bob",
			title: "Job nightly failed",
			body: failedRun?.error,
		});
		// Gateway C6: callId rides ONLY interaction.pending — the other
		// event types never carry it (a notifier reads records itself).
		expect("callId" in failed).toBe(false);
		// No publicUrl on this boot: the deep link is omitted entirely.
		expect("url" in failed).toBe(false);
		// Exactly one job.failed — job.changed fires for every record
		// change, but the per-run identity dedupes.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(ofType("job.failed")).toHaveLength(1);
	});
});

describe("delivery isolation (best-effort, logged)", () => {
	test("a throwing notifier is logged; the recorder still receives the event; no unhandled rejection", { timeout: 30_000 }, async () => {
		const server = await bootServer();
		const conv = await createConversation(server.app, server.bob);
		resetNotifierEvents();
		const errors = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			await seedInteraction(server.opened, conv, "notif-isolation");
			// The recorder received the event DESPITE the thrower ahead of
			// it in the delivery list — the vitest run completing is itself
			// the no-unhandled-rejection assertion.
			const recorded = await waitForEvent(
				(event) =>
					event.type === "interaction.pending" && event.user === "bob",
			);
			// Gateway C6: the seeded record's callId — exactly, not just present.
			expect(recorded.callId).toBe("notif-isolation");
			expect(recorded.body).toBe(`Conversation ${conv}`);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const logged = errors.mock.calls.some((args) =>
				args.some(
					(arg) =>
						typeof arg === "string" && arg.includes("fixture-notifier.throwing"),
				),
			);
			expect(logged).toBe(true);
		} finally {
			errors.mockRestore();
		}
	});
});
