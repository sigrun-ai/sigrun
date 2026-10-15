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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	Conversation,
	HarnessSettings,
} from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	EventBus,
	type LifecycleEvent,
	type SettleGroup,
} from "../src/harness/event-bus.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";

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
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Boot one hermetic harness and open a bus on it (records nothing yet). */
async function bootBus(
	options: {
		responses?: readonly AssistantMessage[];
		settings?: HarnessSettings;
		queueMax?: number;
		hookDeadlineMs?: number;
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
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		settings: options.settings,
	});
	// The root (and its creation commit) exists BEFORE the bus subscribes:
	// lifecycle tests observe only what happens after open.
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const bus = EventBus.open(opened.harness, {
		queueMax: options.queueMax ?? 1000,
		hookDeadlineMs: options.hookDeadlineMs ?? 5_000,
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
		let handlerFinished = false;
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
		expect(handlerFinished).toBe(false);

		// Bounded cleanup: both events abandon at the 50ms deadline.
		await draining;
		expect(handlerFinished).toBe(false);
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
