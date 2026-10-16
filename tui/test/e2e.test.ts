/**
 * Task 9: the end-to-end smoke — the full wire path an `attach`-mode client
 * drives, headlessly, against a REAL harness+server on an ephemeral
 * loopback port (no terminal: the UI layers are tested in
 * app/sidebar/conversation-pane/composer/interactions/ambient; this suite
 * proves the wire underneath them):
 *
 *   list → create → submit (faux provider streams) → SSE snapshot+frames
 *   observed → fork → interaction round-trip (fixture seam) → identity
 *   header stamps `owner`
 *
 * Server pattern: `openHarness` + `createServer` + `app.listen({port: 0})`
 * (sse-view.test.ts's real-loopback idiom — `app.inject()` cannot serve a
 * hijacked SSE reply). The pending interaction is seeded through the seam
 * host of the EXISTING fixture extension (test/fixtures/fixture-seam) —
 * the established interaction-fabrication idiom (seam.test.ts), no new
 * fixture. The client layers under test are Task 4's own: `SigrunClient`
 * and `watchConversation` with their real `fetch` defaults.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { openHarness, type OpenedHarness } from "../../src/harness/boot.js";
import type { ProviderContributor } from "../../src/harness/providers/index.js";
import { createServer } from "../../src/server/index.js";
import { SigrunClient, type ConversationViewWire } from "../src/api.js";
import { watchConversation, type WatchHandlers } from "../src/sse.js";

/** The existing seam fixture, loaded through the REAL loader. */
const FIXTURE_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"..",
		"..",
		"test",
		"fixtures",
		"fixture-seam",
		"index.js",
	),
).href;

/** One hermetic server: harness + faux provider + seam fixture + port. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The loopback origin (`http://127.0.0.1:PORT`) clients dial. */
	baseUrl: string;
}

/** Boot a hermetic server on an ephemeral port; registers cleanup. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tui-e2e-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	// Two responses: the create-submit answer, then the fork's submit (if a
	// test drives one). A queue exhausts in declaration order.
	faux.setResponses([
		fauxAssistantMessage("the e2e answer"),
		fauxAssistantMessage("the follow-up answer"),
	]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		extensionSpecifiers: [FIXTURE_SPECIFIER],
		env: {},
	});
	const app = await createServer(opened, config);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const port = (app.server.address() as { port: number }).port;
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, baseUrl: `http://127.0.0.1:${port}` };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * The assistant texts of one wire view (`pi.assistant` entries whose
 * `model[0].content` is a string or content parts — the same narrowing
 * server-settings.test.ts uses).
 */
function assistantTexts(view: ConversationViewWire): string[] {
	const entries = view.entries as readonly {
		kind: string;
		model?: { content?: unknown }[];
	}[];
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.kind !== "pi.assistant") continue;
		const content = entry.model?.[0]?.content;
		const parts = Array.isArray(content) ? content : [{ text: content }];
		for (const part of parts) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts;
}

/**
 * A watch recorder: every snapshot and view frame, in arrival order, plus
 * every error. `waitFor` resolves with the first frame (already recorded
 * or yet to arrive) matching a predicate — the headless stand-in for the
 * UI's render loop.
 */
class WatchRecorder {
	readonly snapshots: ConversationViewWire[] = [];
	readonly views: ConversationViewWire[] = [];
	readonly errors: string[] = [];
	readonly handlers: WatchHandlers;
	readonly #waiters: {
		predicate: (view: ConversationViewWire) => boolean;
		resolve: (view: ConversationViewWire) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];

	constructor() {
		this.handlers = {
			onSnapshot: (view) => this.#record(this.snapshots, view),
			onView: (view) => this.#record(this.views, view),
			onError: (message) => {
				this.errors.push(message);
			},
		};
	}

	#record(
		list: ConversationViewWire[],
		view: ConversationViewWire,
	): void {
		list.push(view);
		for (const waiter of this.#waiters.splice(0)) {
			if (!waiter.predicate(view)) {
				this.#waiters.push(waiter);
				continue;
			}
			clearTimeout(waiter.timer);
			waiter.resolve(view);
		}
	}

	/** The first frame matching `predicate`, waiting up to `timeoutMs`. */
	waitFor(
		predicate: (view: ConversationViewWire) => boolean,
		timeoutMs = 10_000,
	): Promise<ConversationViewWire> {
		const existing = [...this.snapshots, ...this.views].find(predicate);
		if (existing !== undefined) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					const index = this.#waiters.indexOf(waiter);
					if (index !== -1) this.#waiters.splice(index, 1);
					reject(
						new Error(
							`timed out waiting for a stream frame (snapshots: ${this.snapshots.length}, views: ${this.views.length}, errors: ${this.errors.join("; ")})`,
						),
					);
				}, timeoutMs),
			};
			this.#waiters.push(waiter);
		});
	}
}

describe("tui e2e smoke (attach-mode wire path)", () => {
	test(
		"list → create → submit over SSE → fork → interaction round-trip → identity owner",
		{ timeout: 60_000 },
		async () => {
			const server = await bootServer();
			// The attach-mode client: X-Sigrun-User rides every request.
			const client = new SigrunClient({
				baseUrl: server.baseUrl,
				user: "e2e-user",
			});

			// ── list: the durable enumeration (Task 3) — root present ──
			const initial = await client.listConversations();
			expect(initial.conversations.some((c) => c.root)).toBe(true);
			const beforeCount = initial.conversations.length;

			// ── create: 201 + the first view frame; the listing grows ──
			const created = await client.createConversation();
			expect(created.view.conversation.id).toBe(created.id);
			const afterCreate = await client.listConversations();
			expect(afterCreate.conversations).toHaveLength(beforeCount + 1);
			// Identity seam (Task 2): the create stamped the header's user.
			const summary = afterCreate.conversations.find(
				(c) => c.id === created.id,
			);
			expect(summary?.owner).toBe("e2e-user");

			// ── watch: a fresh snapshot on connect ──
			const recorder = new WatchRecorder();
			const unwatch = watchConversation(created.id, recorder.handlers, {
				baseUrl: server.baseUrl,
				user: "e2e-user",
				reconnectBaseMs: 25,
			});
			try {
				const snapshot = await recorder.waitFor(() => true);
				expect(recorder.snapshots).toHaveLength(1);
				expect(snapshot.conversation.id).toBe(created.id);
				expect(snapshot.steer).toEqual({ busy: false, queued: 0 });

				// ── submit: the server settles; the stream renders revisions ──
				const submission = await client.submit(
					created.id,
					"hello from the e2e",
				);
				expect(submission.status).toBe("done");
				// Streaming observed: a busy frame landed before settlement.
				// Wait (never a sync check): the submit response and the SSE
				// frame travel on separate connections, so arrival order is not
				// guaranteed even though the busy revision commits first.
				await recorder.waitFor((view) => view.steer.busy);
				// ...and a settled frame carries the faux answer.
				const settled = await recorder.waitFor(
					(view) =>
						!view.steer.busy &&
						assistantTexts(view).some((text) =>
							text.includes("the e2e answer"),
						),
				);
				expect(settled.conversation.id).toBe(created.id);

				// ── fork at the latest entry: new id, history carried ──
				const forked = await client.forkConversation(created.id);
				expect(forked.id).not.toBe(created.id);
				expect(
					assistantTexts(forked.view).some((text) =>
						text.includes("the e2e answer"),
					),
				).toBe(true);

				// ── interaction round-trip on the fork (fixture seam) ──
				const host = server.opened.seamHosts.get("sigrun.fixture-seam");
				if (host === undefined) throw new Error("seam host missing");
				await host.seedInteraction(
					forked.id as ConversationId,
					{
						kind: "fixture.ask",
						callId: "e2e-call-1",
						status: "pending",
						createdAt: Date.now(),
						body: {
							text: "pick one",
							options: [
								{ id: "a", label: "A", tone: "ok" },
								{ id: "b", label: "B" },
							],
						},
					},
					BACKGROUND_CONTEXT,
				);
				const pending = await client.listInteractions(forked.id);
				expect(pending.interactions).toHaveLength(1);
				expect(pending.interactions[0]).toMatchObject({
					kind: "fixture.ask",
					callId: "e2e-call-1",
					status: "pending",
				});
				const answered = await client.answerInteraction(
					forked.id,
					"e2e-call-1",
					{ ids: ["a"] },
				);
				expect(answered).toMatchObject({
					callId: "e2e-call-1",
					status: "answered",
					answer: { ids: ["a"] },
				});
				// Drained: the record is terminal and off the pending list.
				expect(
					(await client.listInteractions(forked.id)).interactions,
				).toHaveLength(0);

				// ── identity: owner visible in meta on create AND fork ──
				expect((await client.getMeta(created.id)).owner).toBe("e2e-user");
				expect((await client.getMeta(forked.id)).owner).toBe("e2e-user");

				// The happy-path stream never errored or reconnected.
				expect(recorder.errors).toEqual([]);
			} finally {
				unwatch();
			}
		},
	);

	test("no configured user → naive mode: create succeeds, owner absent", async () => {
		const server = await bootServer();
		const client = new SigrunClient({ baseUrl: server.baseUrl });
		const created = await client.createConversation();
		const meta = await client.getMeta(created.id);
		expect("owner" in meta).toBe(false);
		const list = await client.listConversations();
		const summary = list.conversations.find((c) => c.id === created.id);
		expect(summary).toBeDefined();
		expect(summary && "owner" in summary).toBe(false);
	});
});
