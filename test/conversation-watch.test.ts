/**
 * Task 2: the full-history view contract (D1-A) — `entries` is the
 * append-only, fork-aware raw history, NEVER cut at a compaction/reset head
 * marker and never slid by the upstream default window (min 50 / max 100).
 *
 * Boot shapes follow the existing hermetic suites: faux provider + temp
 * storage (sse-view.test.ts for the SSE leg, host-conversations.test.ts
 * for the host-bridge leg). Entries are seeded by appending drafts in one
 * commit the way `POST /v1/conversations/import` does (`tx.appendEntry`,
 * src/server/routes/conversations.ts:299).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	Conversation,
	ConversationId,
	EntryDraft,
} from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import {
	FULL_HISTORY_WINDOW,
	readFullView,
} from "../src/server/conversation-watch.js";
import { readView } from "../src/server/helpers.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import type { SigrunHost } from "../src/extension.js";
import { seededIdentity } from "./helpers/identity.js";
import { applyDelta, type ViewDelta } from "@sigrun/shared/view-delta";
import type { ConversationViewWire } from "@sigrun/shared/views";
import type { FastifyInstance } from "fastify";

const CHANNEL_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One hermetic boot: faux provider, claimed directory, no auto-namer. */
async function boot(options?: {
	responses?: Parameters<
		ReturnType<typeof fauxProvider>["setResponses"]
	>[0];
	env?: Record<string, string>;
	channel?: boolean;
}): Promise<{ opened: OpenedHarness; app: FastifyInstance; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-watch-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(options?.responses ?? [
		fauxAssistantMessage("seeded answer"),
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
		SIGRUN_COMPACTION_BACKGROUND_TOKENS: "0",
		SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "1",
		...options?.env,
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		...(options?.channel
			? { extensionSpecifiers: [CHANNEL_SPECIFIER] }
			: {}),
		env: {},
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	await app.listen({ port: 0, host: "127.0.0.1" });
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, app, dir };
}

/** The host the fixture-channel stashed (the host-conversations pattern). */
function channelHost(): SeamHost & SigrunHost {
	const host = (globalThis as { __fixtureChannelHost?: SeamHost & SigrunHost })
		.__fixtureChannelHost;
	if (host === undefined) throw new Error("fixture-channel host not captured");
	return host;
}

/** A fresh conversation seeded with `count` draft entries in ONE commit. */
async function seeded(
	opened: OpenedHarness,
	count: number,
): Promise<Conversation> {
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: opened.defaultModel },
		},
		BACKGROUND_CONTEXT,
	);
	const drafts: EntryDraft[] = Array.from({ length: count }, (_, i) => ({
		kind: "test.seed",
		data: { i },
	}));
	await conversation.commit(async (tx) => {
		for (const draft of drafts) {
			await tx.appendEntry(conversation.id, draft);
		}
	}, BACKGROUND_CONTEXT);
	return conversation;
}

/** One parsed SSE frame (comment lines are heartbeats, not events). */
interface SseEvent {
	readonly event: string;
	readonly data: string;
}

/** A minimal SSE collector over a real loopback socket. */
class SseCollector {
	private readonly request: http.ClientRequest;
	private readonly events: SseEvent[] = [];
	private buffer = "";
	private readonly waiters: Array<() => void> = [];

	constructor(port: number, path: string) {
		this.request = http.get({
			host: "127.0.0.1",
			port,
			path,
			agent: false,
		});
		this.request.on("error", () => {});
		this.request.on("response", (incoming) => {
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => {
				this.buffer += chunk;
				this.drain();
			});
			incoming.on("error", () => {});
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
			this.events.push({ event, data });
			for (const wake of this.waiters.splice(0)) wake();
		}
	}

	eventsSoFar(): readonly SseEvent[] {
		return [...this.events];
	}

	async waitFor(
		predicate: (event: SseEvent) => boolean,
		timeoutMs = 15_000,
	): Promise<SseEvent> {
		const found = this.events.find(predicate);
		if (found !== undefined) return found;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							`timed out; events: ${JSON.stringify(
								this.events.map((e) => e.event),
							)}`,
						),
					),
				timeoutMs,
			);
			const attempt = () => {
				const match = this.events.find(predicate);
				if (match === undefined) {
					this.waiters.push(attempt);
					return;
				}
				clearTimeout(timer);
				resolve(match);
			};
			this.waiters.push(attempt);
			this.drain();
		});
	}

	destroy(): void {
		this.request.destroy();
	}
}

/** The client's fold rule: snapshot replaces, delta folds. */
function fold(events: readonly SseEvent[]): ConversationViewWire {
	let view: ConversationViewWire | undefined;
	for (const event of events) {
		if (event.event === "snapshot") {
			view = JSON.parse(event.data) as ConversationViewWire;
		} else if (event.event === "delta") {
			if (view === undefined) throw new Error("delta before snapshot");
			view = applyDelta(view, JSON.parse(event.data) as ViewDelta);
		}
	}
	if (view === undefined) throw new Error("no snapshot frame received");
	return view;
}

describe("full-history view contract (D1-A)", () => {
	test("snapshot holds every entry past the window size", async () => {
		const { opened } = await boot();
		const conversation = await seeded(opened, 150);
		const view = await readFullView(conversation, BACKGROUND_CONTEXT);
		expect(view.entries.length).toBe(150);
		expect(view.before).toBeUndefined();
		// The helper route (Task 1's temporary shape, now full-history).
		const viaHelper = await readView(conversation);
		expect(viaHelper.entries.length).toBe(150);
	});

	test("a 1,000-entry conversation reads whole", async () => {
		const { opened } = await boot();
		const conversation = await seeded(opened, 1_000);
		const started = performance.now();
		const view = await readFullView(conversation, BACKGROUND_CONTEXT);
		const elapsedMs = Math.round(performance.now() - started);
		console.log(`readFullView over 1,000 entries: ${elapsedMs}ms`);
		expect(view.entries.length).toBe(1_000);
	});

	test("long conversation streams without removals", async () => {
		const { opened, app } = await boot();
		const conversation = await seeded(opened, 150);
		const port = (app.server.address() as { port: number }).port;
		const connection = new SseCollector(
			port,
			`/v1/conversations/${conversation.id}/stream`,
		);
		try {
			await connection.waitFor((event) => event.event === "snapshot");
			// 60 more entries in 6 commits of 10 — each commit is one revision.
			for (let batch = 0; batch < 6; batch++) {
				await conversation.commit(async (tx) => {
					for (let i = 0; i < 10; i++) {
						await tx.appendEntry(conversation.id, {
							kind: "test.append",
							data: { batch, i },
						});
					}
				}, BACKGROUND_CONTEXT);
			}
			await connection.waitFor(
				() => fold(connection.eventsSoFar()).entries.length === 210,
			);
			const events = connection.eventsSoFar();
			const deltas = events.filter((event) => event.event === "delta");
			expect(deltas.length).toBeGreaterThan(0);
			for (const delta of deltas) {
				const parsed = JSON.parse(delta.data) as ViewDelta;
				expect(parsed.entries?.remove).toBeUndefined();
			}
			// No snapshot after the first: the window never slides, so the
			// prefix rule always holds and the stream stays delta-only.
			expect(
				events.filter((event) => event.event === "snapshot").length,
			).toBe(1);
			expect(fold(events).entries.length).toBe(210);
		} finally {
			connection.destroy();
		}
	});

	test("compaction appends its divider in place", async () => {
		// 12 faux turns = 24 transcript entries; the compaction response is
		// scripted last (seeded answer ×12, then the summary).
		const responses = [
			...Array.from({ length: 12 }, () => fauxAssistantMessage("turn answer")),
			fauxAssistantMessage("compacted history summary"),
		];
		const { opened, app } = await boot({ responses });
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		for (let i = 0; i < 12; i++) {
			const turn = await root.submit(
				{ type: "input", content: `question ${i}` },
				BACKGROUND_CONTEXT,
			);
			expect((await turn.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		}
		const before = await readFullView(root, BACKGROUND_CONTEXT);
		const preCompactionEntries = before.entries.length;
		// 24 turn entries plus the boot/root bookkeeping entry or two.
		expect(preCompactionEntries).toBeGreaterThanOrEqual(24);
		const port = (app.server.address() as { port: number }).port;
		const connection = new SseCollector(
			port,
			`/v1/conversations/${root.id}/stream`,
		);
		try {
			await connection.waitFor((event) => event.event === "snapshot");
			const task = await root.compact(undefined, BACKGROUND_CONTEXT);
			const settled = await opened.harness.waitForTask(
				task,
				BACKGROUND_CONTEXT,
			);
			expect(settled.state.outcome.status).toBe("completed");
			// The compaction lands as a DELTA appending the divider — the full
			// history stays, so the change is always representable.
			const delta = await connection.waitFor(
				(event) =>
					event.event === "delta" &&
					(
						(JSON.parse(event.data) as ViewDelta).entries?.append ?? []
					).some((entry) => entry.kind === "pi.compaction"),
			);
			const appended = (JSON.parse(delta.data) as ViewDelta).entries
				?.append ?? [];
			expect(
				appended.filter((entry) => entry.kind === "pi.compaction").length,
			).toBe(1);
			// No fresh snapshot: a compaction is no longer a non-representable
			// rewrite, because nothing was cut.
			const events = connection.eventsSoFar();
			expect(
				events.filter((event) => event.event === "snapshot").length,
			).toBe(1);
			const view = fold(events);
			for (const entry of before.entries) {
				expect(view.entries.some((e) => e.id === entry.id)).toBe(true);
			}
			expect(view.entries.length).toBeGreaterThanOrEqual(
				preCompactionEntries + 1,
			);
		} finally {
			connection.destroy();
		}
	});

	test("bridge watch delivers full history", async () => {
		const { opened } = await boot({ channel: true });
		const conversation = await seeded(opened, 150);
		const host = channelHost();
		const frames: number[] = [];
		const stop = await host.conversations.watch(
			conversation.id as unknown as ConversationId,
			(view) => {
				frames.push(
					(view as unknown as { entries: readonly unknown[] }).entries
						.length,
				);
			},
		);
		try {
			// Snapshot-first: the acquisition frame is the first listener call.
			expect(frames.length).toBeGreaterThanOrEqual(1);
			expect(frames[0]).toBe(150);
		} finally {
			await stop();
		}
	});

	test("FULL_HISTORY_WINDOW is the never-sliding upstream cap", () => {
		expect(FULL_HISTORY_WINDOW).toEqual({ min: 2 ** 30, max: 2 ** 31 });
	});
});
