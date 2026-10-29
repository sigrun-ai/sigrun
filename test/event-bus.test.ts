/**
 * Memory-seam Task 2: the event bus — commit observation + side lane.
 *
 * `EventBus` subscribes to pi-durable's `Session.subscribeCommits` (the
 * harness IS a Session) and reduces each `CommitPublication` into settled
 * runs (`SettleGroup`) and conversation lifecycle events, delivering them
 * through one bounded drain loop.
 *
 * Hermetic pattern (compaction.test.ts): faux provider + tmpdir +
 * `openHarness` — real `node:sqlite` storage, real run loop, no network.
 * The bus is opened directly on the booted harness; Task 3 wires it into
 * boot. Every test closes its bus and harness (afterAll) so the drain loop
 * never leaks across tests.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	Conversation,
	ConversationId,
	HarnessSettings,
} from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	EventBus,
	type LifecycleEvent,
	type SettleGroup,
} from "../src/harness/event-bus.js";
import { resolveExtension } from "../src/harness/loader.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { InteractionDoc } from "../src/harness/interactions.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";
import { askTree } from "./helpers/trees.js";

/** One booted harness + bus, its root conversation, and its faux provider. */
interface TestBus {
	opened: OpenedHarness;
	faux: FauxProviderHandle;
	bus: EventBus;
	root: Conversation;
}

const cleanups: Array<() => Promise<void>> = [];
const dirs: string[] = [];

afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The fixture-seam entry (its host is the C6 interaction writer in tests). */
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

/** Boot one hermetic harness and open a bus on it (records nothing yet). */
async function bootBus(
	options: {
		responses?: readonly AssistantMessage[];
		settings?: HarnessSettings;
		queueMax?: number;
		hookDeadlineMs?: number;
		shutdownSettleWaitMs?: number;
	} = {},
): Promise<TestBus> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-event-bus-"));
	dirs.push(dir);
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...(options.responses ?? [])]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	// Auto-naming off: the namer completes through the same faux provider
	// and would consume scripted responses after the first settled run —
	// these tests script exact responses for the BUS (naming behavior is
	// test/naming.test.ts's subject).
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		settings: options.settings,
		settingsDir: dir,
	});
	// The root (and its creation commit) exists BEFORE the bus subscribes:
	// lifecycle tests observe only what happens after open.
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const bus = EventBus.open(opened.harness, {
		queueMax: options.queueMax ?? 1000,
		hookDeadlineMs: options.hookDeadlineMs ?? 5_000,
		...(options.shutdownSettleWaitMs === undefined
			? {}
			: { shutdownSettleWaitMs: options.shutdownSettleWaitMs }),
		// Required since the post-ship follow-ups (no bus-side default —
		// config.ts owns the 600_000 production value; tests pick their own).
		workerDeadlineMs: 10_000,
	});
	cleanups.push(async () => {
		bus.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
	});
	return { opened, faux, bus, root };
}

/** Submit one input and return the settled record (the run's own result). */
async function runTurn(root: Conversation, input: string, whenBusy?: "steer") {
	const submission = await root.submit(
		{ type: "input", content: input, ...(whenBusy === undefined ? {} : { whenBusy }) },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	return { submission, record };
}

/** Patch one conversation's session-meta doc through a direct commit. */
async function patchMeta(
	conversation: Conversation,
	mutate: (draft: {
		pinned: boolean;
		archived: boolean;
		tagged: string[];
	}) => void,
): Promise<void> {
	await conversation.commit(async (tx) => {
		const draft = await tx.doc(SessionMetaDoc, conversation.id);
		mutate(draft);
	}, BACKGROUND_CONTEXT);
}

/** The newest entry id of a conversation (a fork point). */
async function newestEntryId(conversation: Conversation) {
	const page = await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
	const entry = page.items[0];
	if (entry === undefined) throw new Error("conversation has no entries");
	return entry.id;
}

/** Record both event streams; returns the arrays + registration. */
function recordAll(bus: EventBus): {
	settled: SettleGroup[];
	lifecycle: LifecycleEvent[];
} {
	const settled: SettleGroup[] = [];
	const lifecycle: LifecycleEvent[] = [];
	bus.onSettled((event) => {
		settled.push(event);
	});
	bus.onLifecycle((event) => {
		lifecycle.push(event);
	});
	return { settled, lifecycle };
}

// ---------------------------------------------------------------------------
// Ordered shutdown: the last admission window
// ---------------------------------------------------------------------------

describe("shutdownSequence with live runs", () => {
	test("a placed run settling after shutdown starts reaches runSettled before close", { timeout: 20_000 }, async () => {
		const { bus, root, faux } = await bootBus();
		let release!: () => void;
		let providerStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses([async () => {
			providerStarted();
			await gate;
			return fauxAssistantMessage("shutdown answer");
		}]);
		const order: string[] = [];
		bus.registerExtension("fixture-shutdown", {
			runSettled: () => {
				order.push("runSettled");
			},
			harnessShutdown: () => {
				order.push("harnessShutdown");
			},
		});
		const submission = await root.submit(
			{ type: "input", content: "settle during shutdown" },
			BACKGROUND_CONTEXT,
		);
		await vi.waitFor(() => {
			expect(bus.oldestLiveAdmissionMs()).toBeDefined();
		});
		const closing = bus.shutdownSequence(BACKGROUND_CONTEXT);
		await started;
		release();
		await closing;
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		expect(order).toEqual(["runSettled", "harnessShutdown"]);
	});

	test("a wedged live run hits the injected bound, warns, and still closes", { timeout: 20_000 }, async () => {
		const { bus, root, faux } = await bootBus({ shutdownSettleWaitMs: 30 });
		const provider = withCancel(BACKGROUND_CONTEXT);
		faux.setResponses([async () => await new Promise<AssistantMessage>((_resolve, reject) => {
			provider.context.abortSignal?.addEventListener("abort", () => {
				reject(new Error("aborted after the shutdown timeout assertion"));
			}, { once: true });
		})]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await root.submit(
				{ type: "input", content: "never settle" },
				BACKGROUND_CONTEXT,
			);
			await vi.waitFor(() => {
				expect(bus.oldestLiveAdmissionMs()).toBeDefined();
			});
			await bus.shutdownSequence(BACKGROUND_CONTEXT);
			expect(warn).toHaveBeenCalledWith(
				"event-bus: shutdown settle wait expired; stranded conversations: %s",
				String(root.id),
			);
			provider.cancel();
			await root.abort(BACKGROUND_CONTEXT);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("harnessShutdown fan-out", () => {
	test("handlers run concurrently under one shared deadline", { timeout: 10_000 }, async () => {
		const hookDeadlineMs = 250;
		const { bus } = await bootBus({ hookDeadlineMs });
		const started: string[] = [];
		for (const name of ["first", "second", "third"]) {
			bus.registerExtension(name, {
				harnessShutdown: async () => {
					started.push(name);
					await new Promise((resolve) =>
						setTimeout(resolve, hookDeadlineMs - 100),
					);
				},
			});
		}
		const before = performance.now();
		await bus.shutdownSequence(BACKGROUND_CONTEXT);
		const elapsed = performance.now() - before;
		expect(started).toHaveLength(3);
		expect(elapsed).toBeLessThan(2 * hookDeadlineMs);
	});

	test("one never-settling handler does not outlast the shared deadline, and other commits are durable", { timeout: 10_000 }, async () => {
		const hookDeadlineMs = 100;
		const { bus, root, opened } = await bootBus({ hookDeadlineMs });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const name of ["first", "second"]) {
				bus.registerExtension(name, {
					harnessShutdown: async (_api, context) => {
						await root.commit(async (tx) => {
							const draft = await tx.doc(SessionMetaDoc, root.id);
							draft.tagged = [...draft.tagged, name];
						}, context);
					},
				});
			}
			bus.registerExtension("wedged", {
				harnessShutdown: () => new Promise<void>(() => {}),
			});
			const before = performance.now();
			await bus.shutdownSequence(BACKGROUND_CONTEXT);
			const elapsed = performance.now() - before;
			expect(elapsed).toBeGreaterThanOrEqual(hookDeadlineMs - 25);
			expect(elapsed).toBeLessThan(2 * hookDeadlineMs);
			const meta = await opened.harness.snapshot(
				SessionMetaDoc,
				root.id,
				BACKGROUND_CONTEXT,
			);
			expect(meta?.tagged).toEqual(
				expect.arrayContaining(["first", "second"]),
			);
		} finally {
			error.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Settle detection
// ---------------------------------------------------------------------------

describe("settle detection", () => {
	test("a settled run emits one SettleGroup with entry + answer ids", async () => {
		const { bus, root } = await bootBus({
			responses: [fauxAssistantMessage("the answer")],
		});
		const { settled } = recordAll(bus);
		const { submission, record } = await runTurn(root, "hello");
		expect(record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		expect(settled).toHaveLength(1);
		const group = settled[0]!;
		expect(group.conversationId).toBe(root.id);
		expect(group.settled).toHaveLength(1);
		const [one] = group.settled;
		expect(one.id).toBe(submission.id);
		expect(one.status).toBe("done");
		expect(one.entryId).toBeTypeOf("number");
		expect(one.answerEntryId).toBeTypeOf("number");
		expect(one.answerEntryId).not.toBe(one.entryId);
		expect(one.reason).toBeUndefined();
	});

	test("an unanswered run (provider error) emits status unanswered with reason", async () => {
		const { bus, root } = await bootBus({
			// Retries off: the first (non-retryable) error settles at once.
			settings: { retry: { enabled: false } },
			responses: [
				fauxAssistantMessage("boom", {
					stopReason: "error",
					errorMessage: "faux provider failure",
				}),
			],
		});
		const { settled } = recordAll(bus);
		const { record } = await runTurn(root, "hello");
		expect(record.status).toBe("unanswered");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		expect(settled).toHaveLength(1);
		const [one] = settled[0]!.settled;
		expect(one.status).toBe("unanswered");
		expect(one.reason).toBe("model_error");
		expect(one.answerEntryId).toBeUndefined();
	});

	test("steer-merged runs batch both submissions into one group in admission order", async () => {
		const { bus, root } = await bootBus({
			responses: [
				// Turn one: a tool round (bash sleeps 1s — the steer window).
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "sleep 1" })],
					{ stopReason: "toolUse" },
				),
				// The post-tools generation answers both inputs.
				fauxAssistantMessage("merged answer"),
			],
		});
		const { settled } = recordAll(bus);
		const first = await root.submit(
			{ type: "input", content: "first" },
			BACKGROUND_CONTEXT,
		);
		// Admitted while the run is busy: queued as a steer, placed at the
		// post-tools boundary, and settled with the SAME run.
		const second = await root.submit(
			{ type: "input", content: "second", whenBusy: "steer" },
			BACKGROUND_CONTEXT,
		);
		const [recordA, recordB] = await Promise.all([
			first.wait(BACKGROUND_CONTEXT),
			second.wait(BACKGROUND_CONTEXT),
		]);
		expect(recordA.status).toBe("done");
		expect(recordB.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		expect(settled).toHaveLength(1);
		const group = settled[0]!;
		expect(group.conversationId).toBe(root.id);
		expect(group.settled.map((entry) => entry.id)).toEqual([
			first.id,
			second.id,
		]);
		expect(group.settled.map((entry) => entry.status)).toEqual([
			"done",
			"done",
		]);
	});

	test("a retried run emits once (the final attempt)", async () => {
		const { bus, root } = await bootBus({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			responses: [
				fauxAssistantMessage("transient", {
					stopReason: "error",
					errorMessage: "503 service unavailable",
				}),
				fauxAssistantMessage("answer after retry"),
			],
		});
		const { settled } = recordAll(bus);
		const { record } = await runTurn(root, "hello");
		expect(record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		// The retry attempt settles nothing; only the final answer does.
		expect(settled).toHaveLength(1);
		expect(settled[0]!.settled).toHaveLength(1);
		expect(settled[0]!.settled[0]!.status).toBe("done");
	});

	test("a listener throw is caught and logged; other handlers still run", async () => {
		const { bus, root } = await bootBus({
			responses: [fauxAssistantMessage("the answer")],
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const seen: SettleGroup[] = [];
			bus.onSettled(() => {
				throw new Error("handler one exploded");
			});
			bus.onSettled((event) => {
				seen.push(event);
			});
			const { record } = await runTurn(root, "hello");
			expect(record.status).toBe("done");
			await bus.drain(10_000, BACKGROUND_CONTEXT);

			expect(seen).toHaveLength(1);
			const failures = spy.mock.calls
				.map((call) => String(call[0]))
				.filter((text) => text.includes("handler failed"));
			expect(failures).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("the commit listener never blocks: submit returns before a slow handler finishes", async () => {
		const { bus, root } = await bootBus({
			hookDeadlineMs: 50,
			responses: [
				fauxAssistantMessage("one"),
				fauxAssistantMessage("two"),
			],
		});
		let handlerStarted = false;
		bus.onSettled(() => {
			handlerStarted = true;
			return new Promise<void>(() => {
				// Never resolves: the deadline must abandon it.
			});
		});
		const first = await runTurn(root, "one");
		expect(first.record.status).toBe("done");
		// Start the side lane; it reaches the never-resolving handler.
		const draining = bus.drain(10_000, BACKGROUND_CONTEXT);
		await vi.waitFor(() => expect(handlerStarted).toBe(true));

		// A whole second run admits, runs, and settles while the first
		// handler is still pending — the enqueue path is synchronous and
		// the commit listener never waits on the drain loop.
		const second = await runTurn(root, "two");
		expect(second.record.status).toBe("done");

		// Bounded cleanup: both events abandon at the 50ms deadline.
		await draining;
	});

	test("queue overflow drops the oldest event and logs (queueMax honored)", async () => {
		const { bus, opened } = await bootBus({ queueMax: 2 });
		const { lifecycle } = recordAll(bus);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const first = await opened.harness.createConversation(
				{ ownership: { kind: "ownerless" } },
				BACKGROUND_CONTEXT,
			);
			const second = await opened.harness.createConversation(
				{ ownership: { kind: "ownerless" } },
				BACKGROUND_CONTEXT,
			);
			const third = await opened.harness.createConversation(
				{ ownership: { kind: "ownerless" } },
				BACKGROUND_CONTEXT,
			);
			void first;

			const overflows = spy.mock.calls
				.map((call) => String(call[0]))
				.filter((text) => text.includes("overflow"));
			expect(overflows).toHaveLength(1);

			await bus.drain(10_000, BACKGROUND_CONTEXT);
			const created = lifecycle
				.filter((event) => event.type === "conversationCreated")
				.map((event) => event.conversationId);
			// The oldest (first) was dropped; delivery is newest-first-preserved.
			expect(created).toEqual([second.id, third.id]);
		} finally {
			spy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Lifecycle detection
// ---------------------------------------------------------------------------

describe("lifecycle detection", () => {
	test("conversationCreated fires on create and on fork-child creation", async () => {
		const { bus, opened, root } = await bootBus({
			responses: [fauxAssistantMessage("turn one")],
		});
		const { lifecycle } = recordAll(bus);
		await runTurn(root, "hello");
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toHaveLength(0);

		const created = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		const at = await newestEntryId(root);
		const child = await root.fork(
			at,
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		expect(lifecycle).toContainEqual({
			type: "conversationCreated",
			conversationId: created.id,
		});
		// A fork child is a new conversation AND a fork: both events fire.
		expect(lifecycle).toContainEqual({
			type: "conversationCreated",
			conversationId: child.id,
		});
		expect(lifecycle).toContainEqual({
			type: "conversationForked",
			childId: child.id,
			parentId: root.id,
			at,
		});
	});

	test("an archive flip fires conversationArchived(true); un-archive (false); no-op patch fires nothing", async () => {
		const { bus, root } = await bootBus();
		const { lifecycle } = recordAll(bus);

		// The first patch MATERIALIZES the doc (a creation): it seeds the
		// flip baseline and fires nothing.
		await patchMeta(root, (draft) => {
			draft.pinned = true;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toHaveLength(0);

		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toEqual([
			{ type: "conversationArchived", conversationId: root.id, archived: true },
		]);

		await patchMeta(root, (draft) => {
			draft.archived = false;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toEqual([
			{ type: "conversationArchived", conversationId: root.id, archived: true },
			{ type: "conversationArchived", conversationId: root.id, archived: false },
		]);

		// A patch that does not touch `archived` flips nothing.
		await patchMeta(root, (draft) => {
			draft.pinned = false;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toHaveLength(2);
	});

	test("a forked child born archived fires NO conversationArchived event", async () => {
		const { bus, root } = await bootBus({
			responses: [fauxAssistantMessage("turn one")],
		});
		const { lifecycle } = recordAll(bus);
		await runTurn(root, "hello");
		// Materialize the doc, then archive the parent.
		await patchMeta(root, (draft) => {
			draft.pinned = true;
		});
		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toEqual([
			{ type: "conversationArchived", conversationId: root.id, archived: true },
		]);

		const at = await newestEntryId(root);
		const child = await root.fork(
			at,
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		// The fork itself: created + forked, NEVER an inherited archive.
		const archiveEvents = lifecycle.filter(
			(event) => event.type === "conversationArchived",
		);
		expect(archiveEvents).toEqual([
			{ type: "conversationArchived", conversationId: root.id, archived: true },
		]);
		expect(lifecycle).toContainEqual({
			type: "conversationForked",
			childId: child.id,
			parentId: root.id,
			at,
		});

		// The child's baseline was seeded from the parent: a patch keeping
		// `archived: true` flips nothing...
		await patchMeta(child, (draft) => {
			draft.pinned = true;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(
			lifecycle.filter((event) => event.type === "conversationArchived"),
		).toHaveLength(1);

		// ...and a real flip on the child still fires.
		await patchMeta(child, (draft) => {
			draft.archived = false;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(
			lifecycle.filter((event) => event.type === "conversationArchived"),
		).toEqual([
			{ type: "conversationArchived", conversationId: root.id, archived: true },
			{ type: "conversationArchived", conversationId: child.id, archived: false },
		]);
	});
});

// ---------------------------------------------------------------------------
// Wedge-gauge source (W2 Task 8, spec §6.9)
// ---------------------------------------------------------------------------

describe("oldestLiveAdmissionMs (the /metrics wedge-gauge source)", () => {
	test("undefined with no live run; the age of the oldest live run while one runs", async () => {
		const { bus, root } = await bootBus({
			responses: [
				// One tool round (bash sleeps 2s — the live window), then the
				// answer: the run is live between placement and settlement.
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("the answer"),
			],
		});
		// No run yet: the gauge source is undefined (the route renders 0).
		expect(bus.oldestLiveAdmissionMs()).toBeUndefined();

		const before = Date.now();
		const submission = await root.submit(
			{ type: "input", content: "hello" },
			BACKGROUND_CONTEXT,
		);
		// While the run is live: a non-negative age, anchored at the
		// admission instant (which lies between `before` and `after`).
		await new Promise((resolve) => setTimeout(resolve, 150));
		const after = Date.now();
		const age = bus.oldestLiveAdmissionMs(after + 5_000);
		expect(age).toBeDefined();
		expect(age!).toBeGreaterThanOrEqual(5_000);
		expect(age!).toBeLessThanOrEqual(5_000 + (after - before));

		const record = await submission.wait(BACKGROUND_CONTEXT);
		expect(record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		// Settled: back to undefined — a settled conversation stops feeding
		// the wedge gauge.
		expect(bus.oldestLiveAdmissionMs()).toBeUndefined();
	});

	test("a settled conversation's admission no longer counts (only live runs feed the gauge)", async () => {
		const { bus, root } = await bootBus({
			responses: [fauxAssistantMessage("done at once")],
		});
		await runTurn(root, "hello");
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		// The admission map still holds the conversation's timestamp; the
		// LIVE gate must exclude it (a far-past settled admission reading
		// as a wedge is exactly the false alarm the gate exists for).
		expect(bus.oldestLiveAdmissionMs(Date.now() + 10 * 60_000)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// interactionSettled (gateway C6): terminal interaction transitions fan out
// to the extension lifecycle handlers from the interaction host-event site.
// ---------------------------------------------------------------------------

/** The fixture-user-events entry (contract: factory + interactionSettled). */
const USER_EVENTS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-user-events", "index.js"),
).href;

/** The fixture module's exports (settlements record + reset). */
type SettlementsModule = {
	readonly settlements: readonly {
		conversationId: number;
		callId: string;
		kind: string;
		status: string;
		answeredByUser?: string;
		answer?: Readonly<Record<string, unknown>>;
	}[];
	readonly resetSettlements: () => void;
};

/** Import the fixture module by the SAME URL the loader imported — one instance. */
async function settlementsModule(): Promise<SettlementsModule> {
	return (await import(USER_EVENTS_SPECIFIER)) as unknown as SettlementsModule;
}

describe("interactionSettled (one delivery per terminal transition, any writer)", () => {
	/** Boot a server with the user-events fixture loaded and its host captured. */
	async function bootInteractionServer(): Promise<{
		app: FastifyInstance;
		opened: OpenedHarness;
		fixture: SettlementsModule;
	}> {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-event-bus-c6-"));
		dirs.push(dir);
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "none",
		});
		const opened = await openHarness(config, {
			extensions: [contributor],
			env: {},
			identity: await seededIdentity(dir),
			extensionSpecifiers: [USER_EVENTS_SPECIFIER, SEAM_SPECIFIER],
		});
		const app = await createServer(opened, config);
		cleanups.push(async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		});
		const fixture = await settlementsModule();
		fixture.resetSettlements();
		return { app, opened, fixture };
	}

	/** Seed one pending interaction through the fixture-seam host. */
	async function seed(
		opened: OpenedHarness,
		conversationId: number,
		callId: string,
	): Promise<void> {
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host not loaded");
		// SAFETY: the plain test `number` is the branded ConversationId the
		// seam host takes; passed through by value.
		await host.seedInteraction(
			conversationId as ConversationId,
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

	/** The fixture-seam host (the answer/settle writer in the host-side cases). */
	function seamHostOf(opened: OpenedHarness) {
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host not loaded");
		return host;
	}

	/** Await the fixture's first settlement delivery for one callId. */
	async function waitForSettlement(
		fixture: SettlementsModule,
		callId: string,
	): Promise<SettlementsModule["settlements"][number]> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const found = fixture.settlements.find((one) => one.callId === callId);
			if (found !== undefined) return found;
			if (Date.now() > deadline) {
				throw new Error(
					`no interactionSettled for ${callId} (recorded: ${JSON.stringify(fixture.settlements)})`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	test("an HTTP-route answer, a host answer, and a host expire each fire exactly once; seeding fires nothing", { timeout: 30_000 }, async () => {
		const { app, opened, fixture } = await bootInteractionServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		expect(fixture.settlements).toHaveLength(0);

		// Seeding is pending, not terminal: no delivery.
		await seed(opened, root.id, "c6-route");
		await seed(opened, root.id, "c6-host");
		await seed(opened, root.id, "c6-expire");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(fixture.settlements).toHaveLength(0);

		// Writer 1: the HTTP route answers (the human path).
		const answered = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/c6-route/answer`,
			payload: { values: { decision: "allow" } },
		});
		expect(answered.statusCode).toBe(200);
		const routeEvent = await waitForSettlement(fixture, "c6-route");
		expect(routeEvent).toEqual({
			conversationId: root.id,
			callId: "c6-route",
			kind: "fixture.ask",
			status: "answered",
			answeredByUser: undefined,
			answer: { decision: "allow" },
		});

		// Writer 2: the host answers (the extension side).
		const host = seamHostOf(opened);
		const applied = await host.answerInteraction(
			root.id as ConversationId,
			"c6-host",
			{ values: { decision: "allow" } },
			BACKGROUND_CONTEXT,
			{ user: "tester" },
		);
		expect(applied).toBe(true);
		const hostEvent = await waitForSettlement(fixture, "c6-host");
		expect(hostEvent).toEqual({
			conversationId: root.id,
			callId: "c6-host",
			kind: "fixture.ask",
			status: "answered",
			answeredByUser: "tester",
			answer: { decision: "allow" },
		});

		// Writer 3: the host expires (settleInteraction's terminal write).
		const settled = await host.settleInteraction(
			root.id as ConversationId,
			"c6-expire",
			"expired",
			BACKGROUND_CONTEXT,
		);
		expect(settled).toBe(true);
		const expireEvent = await waitForSettlement(fixture, "c6-expire");
		expect(expireEvent).toEqual({
			conversationId: root.id,
			callId: "c6-expire",
			kind: "fixture.ask",
			status: "expired",
		});

		// Exactly one delivery per transition — a re-answer of a terminal
		// record writes nothing (first-answer-wins), so no duplicate fires.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(fixture.settlements).toHaveLength(3);
	});

	test("the raw lifecycle stream carries interactionSettled for terminal statuses only", async () => {
		const { bus, opened, root } = await bootBus({
			responses: [fauxAssistantMessage("turn one")],
		});
		const { lifecycle } = recordAll(bus);
		await runTurn(root, "hello");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		// Seed through a direct doc commit (the same document change shape
		// the seam host and the route produce).
		await opened.harness.commit(async (tx) => {
			const draft = await tx.doc(
				InteractionDoc,
				root.id,
				"bus-seed",
				"bus-seed",
			);
			Object.assign(draft, {
				kind: "fixture.ask",
				callId: "bus-seed",
				status: "pending",
				createdAt: 1,
			});
		}, BACKGROUND_CONTEXT);
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toHaveLength(0);

		await opened.harness.commit(async (tx) => {
			const draft = await tx.doc(
				InteractionDoc,
				root.id,
				"bus-seed",
				"bus-seed",
			);
			const mutable = draft as unknown as Record<string, unknown>;
			mutable.status = "cancelled";
			mutable.settledAt = Date.now();
		}, BACKGROUND_CONTEXT);
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toEqual([
			{
				type: "interactionSettled",
				conversationId: root.id,
				callId: "bus-seed",
				kind: "fixture.ask",
				status: "cancelled",
			},
		]);
	});

	test("a non-function interactionSettled quarantines the extension", async () => {
		// Same fail-loud branch as the other lifecycle fields (LIFECYCLE_FIELDS).
		let message = "";
		try {
			await resolveExtension({
				default: () => ({
					extension: { name: "sigrun-fixture-bad-c6" },
					interactionSettled: 42,
				}),
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe(
			"extension factory returned a interactionSettled field that is not a function",
		);
	});
});
