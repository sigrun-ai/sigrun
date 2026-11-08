/**
 * Memory-seam Task 2: the event bus — commit observation + side lane.
 *
 * `EventBus` subscribes to pi-durable's `harness observeCommits` (the
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
	CommitPublication,
	Storage,
} from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { createJobsService } from "../src/jobs/index.js";
import { JobDoc } from "../src/jobs/docs.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	EventBus,
	RunDeliveryDoc,
	type LifecycleEvent,
	type SettleGroup,
	type HostEvent,
	type RunSettledEvent,
} from "../src/harness/event-bus.js";
import { resolveExtension } from "../src/harness/loader.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { InteractionDoc } from "../src/harness/interactions.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";
import { askTree } from "./helpers/trees.js";
import { markInternal } from "../src/curation/internal.js";

/** One booted harness + bus, its root conversation, and its faux provider. */
interface TestBus {
	opened: OpenedHarness;
	faux: FauxProviderHandle;
	bus: EventBus;
	root: Conversation;
	dir: string;
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
		idleThresholdMs?: number;
		replayPage?: number;
		dir?: string;
	} = {},
): Promise<TestBus> {
	const dir = options.dir ?? await mkdtemp(join(tmpdir(), "sigrun-event-bus-"));
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
		eventBus: {
			shutdownSettleWaitMs: options.shutdownSettleWaitMs,
			idleThresholdMs: options.idleThresholdMs,
			workerDeadlineMs: 10_000,
		},
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
		...(options.idleThresholdMs === undefined
			? {}
			: { idleThresholdMs: options.idleThresholdMs }),
		...(options.replayPage === undefined
			? {}
			: { replayPage: options.replayPage }),
		// Required since the post-ship follow-ups (no bus-side default —
		// config.ts owns the 600_000 production value; tests pick their own).
		workerDeadlineMs: 10_000,
	});
	cleanups.push(async () => {
		bus.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
	});
	return { opened, faux, bus, root, dir };
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

/** Commit server-owned session-meta fields directly (the same writer path the
 *  jobs service uses); kept separate from the small interactive patch helper. */
async function writeServerMeta(
	conversation: Conversation,
	mutate: (draft: {
		source: string;
		jobOutcome?: "succeeded" | "failed";
		adopted?: boolean;
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

	test("the final live-run drain can consume settle + hook within the event-bus budget", { timeout: 20_000 }, async () => {
		const settleMs = 60;
		const hookMs = 100;
		const { bus, root, opened, faux } = await bootBus({
			hookDeadlineMs: hookMs,
			shutdownSettleWaitMs: settleMs,
		});
		const provider = withCancel(BACKGROUND_CONTEXT);
		faux.setResponses([async () => await new Promise<AssistantMessage>((_resolve, reject) => {
			provider.context.abortSignal?.addEventListener("abort", () => {
				reject(new Error("aborted after the settle-budget assertion"));
			}, { once: true });
		})]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// One REAL run remains live through the settle deadline. A real
			// terminal-interaction commit after that deadline queues lifecycle
			// work for the final drain, exactly the budgeted settle+hook path.
			await root.submit(
				{ type: "input", content: "remain live through the final drain" },
				BACKGROUND_CONTEXT,
			);
			await vi.waitFor(() => {
				expect(bus.oldestLiveAdmissionMs()).toBeDefined();
			});
			// Settle any creation/placement work before the measured sequence;
			// the lifecycle commit below is then the only queued work.
			await bus.drain(hookMs, BACKGROUND_CONTEXT);
			let handled = false;
			bus.onLifecycle(async () => {
				handled = true;
				// Start before the settle deadline, finish one hook later. The
				// live run keeps the settle loop active while this drain waits.
				await new Promise((resolve) =>
					setTimeout(resolve, settleMs + hookMs),
				);
			});
			await opened.harness.commit(async (tx) => {
				const draft = await tx.doc(
					InteractionDoc,
					root.id,
					"settle-budget",
					"settle-budget",
				);
				Object.assign(draft, {
					kind: "fixture.ask",
					callId: "settle-budget",
					status: "cancelled",
					createdAt: 1,
					settledAt: Date.now(),
				});
			}, BACKGROUND_CONTEXT);
			const before = performance.now();
			await bus.shutdownSequence(BACKGROUND_CONTEXT);
			const elapsed = performance.now() - before;
			expect(elapsed).toBeGreaterThanOrEqual(settleMs + hookMs - 25);
			expect(elapsed).toBeLessThan(settleMs + hookMs + 150);
			expect(handled).toBe(true);
			provider.cancel();
			await root.abort(BACKGROUND_CONTEXT);
		} finally {
			warn.mockRestore();
		}
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
		const events: string[] = [];
		for (const name of ["first", "second", "third"]) {
			bus.registerExtension(name, {
				harnessShutdown: async () => {
					events.push(`start:${name}`);
					await new Promise((resolve) =>
						setTimeout(resolve, hookDeadlineMs - 100),
					);
					events.push(`end:${name}`);
				},
			});
		}
		const before = performance.now();
		await bus.shutdownSequence(BACKGROUND_CONTEXT);
		const elapsed = performance.now() - before;
		const firstEnd = events.findIndex((event) => event.startsWith("end:"));
		expect(firstEnd).toBeGreaterThanOrEqual(3);
		expect(events.slice(0, firstEnd)).toEqual([
			"start:first",
			"start:second",
			"start:third",
		]);
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

describe("continue submissions", () => {
	/** The deterministic first failure followed by the continue's response. */
	async function bootContinue(
		second: AssistantMessage,
		idleThresholdMs?: number,
	) {
		return await bootBus({
			settings: { retry: { enabled: false }, afterFailedRun: "keep" },
			responses: [
				fauxAssistantMessage("boom", {
					stopReason: "error",
					errorMessage: "faux provider failure",
				}),
				second,
			],
			...(idleThresholdMs === undefined ? {} : { idleThresholdMs }),
		});
	}

	test("a continue-only run emits one settle group with kind continue", async () => {
		const { bus, root } = await bootContinue(fauxAssistantMessage("resumed"));
		const { settled } = recordAll(bus);
		const failed = await runTurn(root, "hello");
		expect(failed.record.status).toBe("unanswered");
		const submission = await root.submit(
			{ type: "continue" },
			BACKGROUND_CONTEXT,
		);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		const group = settled[settled.length - 1]!;
		expect(group.settled).toHaveLength(1);
		expect(group.settled[0]).toMatchObject({
			kind: "continue",
			status: "done",
			entryId: undefined,
		});
		expect(group.settled[0]!.answerEntryId).toBeTypeOf("number");
	});

	test("runSettled carries continued and an empty input text", async () => {
		const { bus, root } = await bootContinue(fauxAssistantMessage("resumed"));
		const events: Array<Record<string, unknown>> = [];
		bus.registerExtension("fixture-continue", {
			runSettled: (event) => {
				events.push({
					continued: event.continued,
					inputs: [...event.inputs],
					inputTexts: [...event.inputTexts],
					outcome: event.outcome,
				});
			},
		});
		expect((await runTurn(root, "hello")).record.status).toBe("unanswered");
		const continued = await root.submit(
			{ type: "continue" },
			BACKGROUND_CONTEXT,
		);
		expect((await continued.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ continued: false });
		expect(events[1]).toMatchObject({
			continued: true,
			inputTexts: [""],
			outcome: { status: "answered" },
		});
		expect((events[1]!.inputs as unknown[]).length).toBe(1);
	});

	test("a continued run ends the live run", async () => {
		const idleThresholdMs = 100;
		const { bus, root } = await bootContinue(
			fauxAssistantMessage("resumed"),
			idleThresholdMs,
		);
		const { lifecycle } = recordAll(bus);
		expect((await runTurn(root, "hello")).record.status).toBe("unanswered");
		const continued = await root.submit(
			{ type: "continue" },
			BACKGROUND_CONTEXT,
		);
		expect((await continued.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(bus.oldestLiveAdmissionMs()).toBeUndefined();

		expect(bus.sweepIdle(Date.now() + idleThresholdMs + 1)).toBe(1);
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(lifecycle).toContainEqual({
			type: "conversationIdle",
			conversationId: root.id,
			idleMs: expect.any(Number),
		});
	});

	test("a failed continue ends the live run", async () => {
		const { bus, root } = await bootContinue(
			fauxAssistantMessage("still broken", {
				stopReason: "error",
				errorMessage: "faux continue failure",
			}),
		);
		const { settled } = recordAll(bus);
		expect((await runTurn(root, "hello")).record.status).toBe("unanswered");
		const continued = await root.submit(
			{ type: "continue" },
			BACKGROUND_CONTEXT,
		);
		expect((await continued.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		const group = settled[settled.length - 1]!;
		expect(group.settled).toHaveLength(1);
		expect(group.settled[0]).toMatchObject({
			kind: "continue",
			status: "unanswered",
			reason: "model_error",
		});
		expect(bus.oldestLiveAdmissionMs()).toBeUndefined();
	});

	test("a continue emits run.admitted and run.settled host events", async () => {
		const { bus, root } = await bootContinue(fauxAssistantMessage("resumed"));
		const events: HostEvent[] = [];
		bus.onHostEvent((event) => events.push(event));
		expect((await runTurn(root, "hello")).record.status).toBe("unanswered");
		const continued = await root.submit(
			{ type: "continue" },
			BACKGROUND_CONTEXT,
		);
		expect((await continued.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		expect(events).toContainEqual({
			type: "run.admitted",
			conversationId: root.id,
			submissionId: continued.id,
		});
		expect(events).toContainEqual({
			type: "run.settled",
			conversationId: root.id,
			outcome: "answered",
		});
	});

	test("a continue that places a queued input settles both in one group", async () => {
		const { bus, root, faux } = await bootBus({
			settings: { retry: { enabled: false }, afterFailedRun: "keep" },
		});
		let failFirst!: () => void;
		const firstGate = new Promise<AssistantMessage>((resolve) => {
			failFirst = () => resolve(fauxAssistantMessage("boom", {
				stopReason: "error",
				errorMessage: "faux provider failure",
			}));
		});
		faux.setResponses([async () => await firstGate]);
		const { settled } = recordAll(bus);
		const events: Array<Record<string, unknown>> = [];
		bus.registerExtension("fixture-continue", {
			runSettled: (event) => {
				events.push({
					continued: event.continued,
					inputs: [...event.inputs],
					inputTexts: [...event.inputTexts],
				});
			},
		});
		const first = await root.submit(
			{ type: "input", content: "first" },
			BACKGROUND_CONTEXT,
		);
		const queued = await root.submit(
			{ type: "input", content: "queued text", whenBusy: "steer" },
			BACKGROUND_CONTEXT,
		);
		failFirst();
		expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		expect(faux.getPendingResponseCount()).toBe(0);
		faux.setResponses([fauxAssistantMessage("resumed")]);

		const continued = await root.submit(
			{ type: "continue" },
			BACKGROUND_CONTEXT,
		);
		expect((await queued.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		expect((await continued.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		const group = settled[settled.length - 1]!;
		expect(group.settled.map((entry) => entry.id)).toEqual([
			queued.id,
			continued.id,
		]);
		expect(group.settled.map((entry) => entry.kind)).toEqual([
			"input",
			"continue",
		]);
		expect(events[events.length - 1]).toEqual({
			continued: true,
			inputs: [queued.id, continued.id],
			inputTexts: ["queued text", ""],
		});
	});
});

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
		expect(one.kind).toBe("input");
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
// pi-durable 1.5.0 commit semantics (Task 3 pins): tagged document kinds,
// observer-throw isolation, and the quiet session-closed end.
// ---------------------------------------------------------------------------

describe("pi-durable 1.5.0 commit semantics", () => {
	test("archive and unarchive still emit after tagged changes (kind === \"retire\" rewrite)", async () => {
		// 1.5.0 tags every document change's `kind` (`create` / `change` /
		// `retire`); pre-1.5.0 the presence of `value` marked a change. This
		// pins the bus's flip detection on the POST-1.5.0 stream shape: a
		// true flip emits `archived: true`, a false flip `archived: false`.
		const { bus, root } = await bootBus();
		const { lifecycle } = recordAll(bus);
		// Materialize the meta doc first (a creation — fires nothing), so
		// both flips below are plain `change` records against a baseline.
		await patchMeta(root, (draft) => {
			draft.pinned = true;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(
			lifecycle.filter((event) => event.type === "conversationArchived"),
		).toHaveLength(0);

		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		await patchMeta(root, (draft) => {
			draft.archived = false;
		});
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		expect(
			lifecycle.filter((event) => event.type === "conversationArchived"),
		).toEqual([
			{ type: "conversationArchived", conversationId: root.id, archived: true },
			{
				type: "conversationArchived",
				conversationId: root.id,
				archived: false,
			},
		]);
	});

	test("a throwing job-change hook does not detach the jobs observer", async () => {
		// Pins Task 1's try/catch inside the jobs service's `observeCommits`
		// advance body (src/jobs/index.ts): a throwing onChange is caught and
		// logged, and LATER commits still invoke the hook — a throwing
		// listener must never detach the observation.
		const { opened } = await bootBus();
		const calls: string[] = [];
		let armed = false;
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			createJobsService({
				harness: opened.harness,
				storage: opened.storage,
				runtime: {
					harness: opened.harness,
					storage: opened.storage,
					registry: opened.registry,
					models: opened.models,
					defaultModel: opened.defaultModel,
					now: () => Date.now(),
					defaultTz: "UTC",
					gatewayLoaded: false,
					effectiveOwner: (owner: string | undefined) => owner,
				},
				effectiveOwner: (owner: string | undefined) => owner,
				rootId: 0,
				sources: () => ({ file: [], extensions: [] }),
				settings: () => ({}),
				onChange: (jobId: string) => {
					// The built-ins load in this rig (1.5.0 family), so the
					// curator's tick-job row also fires onChange; the test owns
					// only its own job-* rows.
					if (!jobId.startsWith("job-")) return;
					calls.push(jobId);
					if (!armed) {
						armed = true;
						throw new Error("first call exploded");
					}
				},
			});

			const write = async (jobId: string, pinned: number) => {
				await opened.harness.commit(async (tx) => {
					const draft = await tx.doc(JobDoc, jobId, {
						source: "api",
						spec: {
							name: jobId,
							schedule: { every: "1h" },
							action: { kind: "prompt", prompt: "x", conversation: "new" },
						},
						enabled: true,
						createdAt: new Date(0).toISOString(),
						hash: "h",
						state: "waiting",
						version: 1,
						updatedAt: new Date(0).toISOString(),
					});
					draft.updatedAt = new Date(pinned).toISOString();
				}, BACKGROUND_CONTEXT);
			};

			await write("job-a", 1);
			await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1), {
				timeout: 5_000,
				interval: 50,
			});
			// The throw happened on the first call; it was caught + logged by
			// the observer body, and the observation is still attached.
			expect(calls).toEqual(["job-a"]);
			expect(
				spy.mock.calls.some((call) =>
					call.map(String).join(" ").includes("commit observer failed"),
				),
			).toBe(true);

			await write("job-b", 2);
			await write("job-c", 3);
			await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3), {
				timeout: 5_000,
				interval: 50,
			});
			expect(calls).toEqual(["job-a", "job-b", "job-c"]);
		} finally {
			spy.mockRestore();
		}
	});

	test("harness close does not log an observer failure (quiet session-closed end)", async () => {
		// pi-durable 1.5.0 ends every `observeCommits` observation with a
		// `failed` end carrying a `session closed` Error on harness close —
		// an EXPECTED teardown path. The bus's and the jobs observer's `end`
		// handlers must swallow it quietly: no `console.error` mentioning
		// `observeCommits` or `session closed` across a close.
		const { opened, bus, root } = await bootBus({
			responses: [fauxAssistantMessage("the answer")],
		});
		recordAll(bus);
		await runTurn(root, "hello");
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		bus.close();

		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await opened.harness.close(BACKGROUND_CONTEXT);
			// The observer ends land on the close's settle; give the side
			// lane a beat to flush anything it would log.
			await new Promise((resolve) => setTimeout(resolve, 100));
			const failures = spy.mock.calls.filter((call) => {
				const text = call.map(String).join(" ");
				return (
					text.includes("observeCommits") ||
					text.includes("session closed") ||
					text.includes("commit observation failed")
				);
			});
			expect(failures).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Summary change events (quiet job runs)
// ---------------------------------------------------------------------------

describe("conversation summary change events", () => {
	test("jobOutcome, adopted and source changes emit conversation.changed", async () => {
		const { bus, root } = await bootBus();
		const events: HostEvent[] = [];
		bus.onHostEvent((event) => events.push(event));

		await writeServerMeta(root, (draft) => {
			draft.source = "cron";
			draft.jobOutcome = "failed";
		});
		expect(events).toContainEqual({
			type: "conversation.changed",
			conversationId: root.id,
			fields: { source: "cron", jobOutcome: "failed" },
		});

		// Source changes after creation use the generalized path.
		events.length = 0;
		await writeServerMeta(root, (draft) => {
			draft.source = "acme-scheduled";
		});
		expect(events).toContainEqual({
			type: "conversation.changed",
			conversationId: root.id,
			fields: { source: "acme-scheduled" },
		});

		events.length = 0;
		await writeServerMeta(root, (draft) => {
			draft.adopted = true;
		});
		expect(events).toContainEqual({
			type: "conversation.changed",
			conversationId: root.id,
			fields: { adopted: true },
		});
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

// ---------------------------------------------------------------------------
// Delivered-through marker (durable run-settled, Task 1): the live-path
// bookkeeping + save. Replay (Task 2) and boot wiring (Task 3) are separate.
// ---------------------------------------------------------------------------

describe("delivered-through marker", () => {
	/** Read the stored marker doc (undefined when never written). */
	async function storedThrough(opened: OpenedHarness): Promise<number | undefined> {
		const doc = await opened.harness.snapshot(RunDeliveryDoc, BACKGROUND_CONTEXT);
		return doc?.through;
	}

	/**
	 * Boot a harness and use its OWN bus (not a second one). The marker is
	 * a session-scoped doc — a second bus would double-save. The opened bus
	 * has the built-in extensions registered; tests that need a blocking
	 * handler register an additional extension on it.
	 */
	async function bootOpenedBus(
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
		await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
		const opened = await openHarness(config, {
			extensions: [contributor],
			env: {},
			settings: options.settings,
			settingsDir: dir,
			eventBus: {
				queueMax: options.queueMax,
				hookDeadlineMs: options.hookDeadlineMs,
				shutdownSettleWaitMs: options.shutdownSettleWaitMs,
				workerDeadlineMs: 10_000,
			},
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const bus = opened.eventBus;
		cleanups.push(async () => {
			bus.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		});
		return { opened, faux, bus, root, dir };
	}

	test("the marker advances past a delivered run", async () => {
		const { bus, root, opened } = await bootOpenedBus({
			responses: [fauxAssistantMessage("the answer")],
		});
		const { submission, record } = await runTurn(root, "hello");
		expect(record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		const through = await storedThrough(opened);
		expect(through).toBeDefined();
		expect(through!).toBeGreaterThan(submission.id);
		expect(bus.deliveredThrough()).toBe(through);
	});

	test("a live run holds the marker below it", { timeout: 20_000 }, async () => {
		const { bus, root, opened, faux } = await bootOpenedBus();
		// The held run's tool round sleeps 2s. The other conversation's run
		// settles during that window. The held run's second response is gated
		// (never resolves until release()).
		let release!: () => void;
		const gate = new Promise<AssistantMessage>((resolve) => {
			release = () => resolve(fauxAssistantMessage("held answer"));
		});
		faux.setResponses([
			// Response 1: the held run's tool round.
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2" })], {
				stopReason: "toolUse",
			}),
			// Response 2: the other conversation's answer (consumed first —
			// the other run starts while the held run's tool sleeps).
			fauxAssistantMessage("other answer"),
			// Response 3: the held run's gated answer (consumed after release).
			async () => await gate,
		]);
		const held = await root.submit(
			{ type: "input", content: "held run" },
			BACKGROUND_CONTEXT,
		);
		await vi.waitFor(() => expect(bus.oldestLiveAdmissionMs()).toBeDefined());

		// A second conversation settles while the first is held.
		const other = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const otherTurn = await runTurn(other, "other");
		expect(otherTurn.record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		const through = await storedThrough(opened);
		expect(through).toBeDefined();
		expect(through!).toBeLessThanOrEqual(held.id);

		release();
		expect((await held.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect((await storedThrough(opened))!).toBeGreaterThan(held.id);
	});

	test("a queued group holds the marker", { timeout: 20_000 }, async () => {
		const { bus, root, opened } = await bootOpenedBus({
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
			],
		});
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		bus.registerExtension("fixture-block-first", {
			runSettled: async () => {
				await firstGate;
			},
		});

		const first = await runTurn(root, "first");
		expect(first.record.status).toBe("done");
		// Start draining: the pump reaches the blocking handler.
		const draining = bus.drain(10_000, BACKGROUND_CONTEXT);

		// A second conversation's run settles while the first group is in dispatch.
		const other = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const second = await runTurn(other, "second");
		expect(second.record.status).toBe("done");

		// The marker must not advance past the queued (in-dispatch) group.
		expect(bus.deliveredThrough()).toBeLessThanOrEqual(first.submission.id);

		releaseFirst();
		await draining;
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		expect((await storedThrough(opened))!).toBeGreaterThan(second.submission.id);
	});

	test("an internal run never pins the marker", { timeout: 20_000 }, async () => {
		const { bus, root, opened, faux } = await bootOpenedBus();
		// Create an internal conversation and hold a run in it.
		const internal = await opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: opened.defaultModel },
				init: async (tx, id) => {
					await markInternal(tx, id, "alice");
				},
			},
			BACKGROUND_CONTEXT,
		);
		let release!: () => void;
		const gate = new Promise<AssistantMessage>((resolve) => {
			release = () => resolve(fauxAssistantMessage("internal answer"));
		});
		let internalStarted!: () => void;
		const internalStartedGate = new Promise<void>((resolve) => {
			internalStarted = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], {
				stopReason: "toolUse",
			}),
			async () => {
				internalStarted();
				return await gate;
			},
		]);
		const held = await internal.submit(
			{ type: "input", content: "internal held run" },
			BACKGROUND_CONTEXT,
		);
		// Wait for the internal run to be placed.
		await vi.waitFor(async () => {
			expect((await held.status(BACKGROUND_CONTEXT)).status).toBe("placed");
		});
		await internalStartedGate;
		// The ordinary run gets its own deterministic response while the
		// internal run remains held.
		faux.setResponses([fauxAssistantMessage("ordinary answer")]);
		const ordinary = await runTurn(root, "ordinary");
		expect(ordinary.record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		// The marker advances past the ordinary run even though the internal
		// run's submission id is lower.
		expect(held.id).toBeLessThan(ordinary.submission.id);
		const through = await storedThrough(opened);
		expect(through!).toBeGreaterThan(ordinary.submission.id);

		release();
		await held.wait(BACKGROUND_CONTEXT);
	});

	test("a write submission never pins the marker", { timeout: 20_000 }, async () => {
		const { bus, root, opened, faux } = await bootOpenedBus({
			responses: [fauxAssistantMessage("the answer")],
		});
		// Settle a run first so the marker has a starting point.
		const first = await runTurn(root, "first");
		expect(first.record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		// A write submission (passive entry write, no run).
		const write = await root.submit(
			{ type: "write", entry: { kind: "fixture.heartbeat", data: { n: 1 } } },
			BACKGROUND_CONTEXT,
		);
		const writeRecord = await write.wait(BACKGROUND_CONTEXT);
		expect(writeRecord.status).toBe("done");

		// Another run settles after the write.
		faux.setResponses([fauxAssistantMessage("second answer")]);
		const second = await runTurn(root, "second");
		expect(second.record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		// The marker passes both runs — the write never held it back.
		const through = await storedThrough(opened);
		expect(through!).toBeGreaterThan(second.submission.id);
	});

	test("an overflow drop pins the marker", { timeout: 20_000 }, async () => {
		const { bus, root, opened } = await bootOpenedBus({
			queueMax: 1,
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("third answer"),
			],
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			let releaseFirst!: () => void;
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			bus.registerExtension("fixture-block", {
				runSettled: async () => {
					await firstGate;
				},
			});

			const first = await runTurn(root, "first");
			expect(first.record.status).toBe("done");
			const draining = bus.drain(10_000, BACKGROUND_CONTEXT);

			// Two more runs settle while the first is in dispatch → overflow.
			const other = await opened.harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
				BACKGROUND_CONTEXT,
			);
			const second = await runTurn(other, "second");
			expect(second.record.status).toBe("done");
			const third = await runTurn(root, "third");
			expect(third.record.status).toBe("done");

			releaseFirst();
			await draining;
			await bus.drain(10_000, BACKGROUND_CONTEXT);

			// The dropped group's id stays >= through.
			const through = await storedThrough(opened);
			expect(through).toBeDefined();
			// The dropped group (second or third) must not be passed.
			const droppedId = Math.min(second.submission.id, third.submission.id);
			expect(through!).toBeLessThanOrEqual(droppedId);
		} finally {
			spy.mockRestore();
		}
	});

	test("no advance without a delivered settle group", async () => {
		const { bus, opened } = await bootOpenedBus();
		// Boot initializes the marker even when history is empty; lifecycle
		// commits alone must never advance it past that baseline.
		const baseline = await storedThrough(opened);
		expect(baseline).toBe(1);
		await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		await bus.drain(10_000, BACKGROUND_CONTEXT);

		expect(await storedThrough(opened)).toBe(baseline);
	});

	test("the shutdown drains save the marker", async () => {
		const { bus, root, opened } = await bootOpenedBus({
			responses: [fauxAssistantMessage("the answer")],
		});
		const { submission, record } = await runTurn(root, "hello");
		expect(record.status).toBe("done");

		// Shutdown without an explicit drain — the shutdown drains save.
		await bus.shutdownSequence(BACKGROUND_CONTEXT);
		const through = await storedThrough(opened);
		expect(through).toBeDefined();
		expect(through!).toBeGreaterThan(submission.id);
	});

	test("close drops the queue without advancing", { timeout: 20_000 }, async () => {
		const { bus, root, opened } = await bootOpenedBus({
			hookDeadlineMs: 50_000,
			responses: [fauxAssistantMessage("the answer")],
		});
		bus.registerExtension("fixture-block", {
			runSettled: () => new Promise<void>(() => {}),
		});
		const { submission, record } = await runTurn(root, "hello");
		expect(record.status).toBe("done");

		// Start draining (the pump reaches the blocking handler), then close.
		const draining = bus.drain(10_000, BACKGROUND_CONTEXT);
		bus.close();
		await draining;

		const through = await storedThrough(opened);
		// The run was never delivered (close dropped the queue).
		expect(through ?? 0).toBeLessThanOrEqual(submission.id);
	});
});

// ---------------------------------------------------------------------------
// Startup replay (durable run-settled, Task 2): terminal submissions at or
// above the marker regroup and reach runSettled after a crash/restart.
// ---------------------------------------------------------------------------

describe("startup replay", () => {
	type ReplayRecord = {
		event: RunSettledEvent;
		label: string;
	};

	/** Close without delivering a blocked settle group, then reopen its database. */
	async function restartAfterCrash(
		first: TestBus,
		release: () => void,
		options: { replayPage?: number } = {},
	): Promise<{ restarted: TestBus; events: ReplayRecord[] }> {
		await crashClose(first);
		void release;
		const restarted = await bootBus({
			dir: first.dir,
			...options,
		});
		// These tests drive replay explicitly on their own bus. Stop boot's
		// automatic replay bus so the two buses cannot race the same tail.
		restarted.opened.eventBus.close();
		const events: ReplayRecord[] = [];
		restarted.bus.registerExtension("fixture-replay-recorder", {
			runSettled: (event) => {
				events.push({
					event,
					label: `${event.replayed === true ? "replay" : "live"}:${event.inputs.join(",")}`,
				});
			},
		});
		return { restarted, events };
	}

	/** A crash close: boot's replay pump must not drain at harness close. */
	async function crashClose(first: TestBus): Promise<void> {
		first.opened.eventBus.close();
		first.bus.close();
		await first.opened.harness.close(BACKGROUND_CONTEXT);
	}

	/** One blocking delivery, with the abandoned call resolved on cleanup. */
	async function crashWithBlockedDelivery(bus: EventBus): Promise<{
		release: () => void;
		draining: Promise<void>;
	}> {
		let release!: () => void;
		let started!: () => void;
		const startedGate = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		bus.registerExtension("fixture-crash-block", {
			runSettled: async () => {
				started();
				await gate;
			},
		});
		const draining = bus.drain(10_000, BACKGROUND_CONTEXT);
		await startedGate;
		return { release, draining };
	}

	/** A first delivered run establishes the marker without a first-boot replay. */
	async function seedMarker(root: Conversation, bus: EventBus) {
		const seeded = await runTurn(root, "seed the delivered-through marker");
		expect(seeded.record.status).toBe("done");
		await bus.drain(10_000, BACKGROUND_CONTEXT);
		return seeded;
	}

	test("an undelivered run replays after a crash", async () => {
		const first = await bootBus({
			responses: [
				fauxAssistantMessage("marker answer"),
				fauxAssistantMessage("undelivered answer"),
			],
		});
		await seedMarker(first.root, first.bus);
		const settled = await runTurn(first.root, "undelivered input");
		expect(settled.record.status).toBe("done");
		const { release } = await crashWithBlockedDelivery(first.bus);
		try {
			const { restarted, events } = await restartAfterCrash(first, release);
			expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(1);
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);

			expect(events).toHaveLength(1);
			expect(events[0]!.event).toMatchObject({
				conversationId: first.root.id,
				inputs: [settled.submission.id],
				inputTexts: ["undelivered input"],
				replayed: true,
				outcome: { status: "answered", answerEntryId: settled.record.answer },
			});
			expect(restarted.bus.deliveredThrough()).toBeGreaterThan(settled.submission.id);
		} finally {
			release();
		}
	});

	test("a clean restart replays nothing", async () => {
		const first = await bootBus({
			responses: [fauxAssistantMessage("delivered before restart")],
		});
		const settled = await seedMarker(first.root, first.bus);
		const before = first.bus.deliveredThrough();
		expect(before).toBeGreaterThan(settled.submission.id);
		first.bus.close();
		await first.opened.harness.close(BACKGROUND_CONTEXT);
		const restarted = await bootBus({ dir: first.dir });

		expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(0);
		expect(restarted.bus.deliveredThrough()).toBe(before);
		await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(await restarted.opened.harness.snapshot(RunDeliveryDoc, BACKGROUND_CONTEXT)).toEqual({ through: before });
	});

	test("a failed replay leaves the marker unchanged after a later live settle", async () => {
		const first = await bootBus({
			responses: [
				fauxAssistantMessage("marker answer"),
				fauxAssistantMessage("undelivered answer"),
			],
		});
		await seedMarker(first.root, first.bus);
		const undelivered = await runTurn(first.root, "undelivered before replay failure");
		const { release } = await crashWithBlockedDelivery(first.bus);
		try {
			const { restarted } = await restartAfterCrash(first, release);
			const failingStorage = new Proxy(restarted.opened.storage, {
				get(target, property, receiver) {
					if (property === "scanSubmissions") {
						return async () => {
							throw new Error("synthetic replay scan failure");
						};
					}
					return Reflect.get(target, property, receiver);
				},
			}) as Storage;
			await expect(
				restarted.bus.replayUndelivered(failingStorage, BACKGROUND_CONTEXT),
			).rejects.toThrow("synthetic replay scan failure");
			restarted.faux.setResponses([fauxAssistantMessage("live after replay failure")]);
			const live = await runTurn(restarted.root, "live after replay failure");
			expect(live.record.status).toBe("done");
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(await restarted.opened.harness.snapshot(RunDeliveryDoc, BACKGROUND_CONTEXT)).toEqual({
				through: first.bus.deliveredThrough(),
			});
			expect(live.submission.id).toBeGreaterThan(undelivered.submission.id);
		} finally {
			release();
		}
	});

	test("an internal live run seeded at boot never pins the marker", { timeout: 20_000 }, async () => {
		const first = await bootBus({
			responses: [fauxAssistantMessage("marker answer")],
		});
		await seedMarker(first.root, first.bus);
		const internal = await first.opened.harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: first.opened.defaultModel },
			init: async (tx, id) => await markInternal(tx, id, "alice"),
		}, BACKGROUND_CONTEXT);
		const provider = withCancel(BACKGROUND_CONTEXT);
		first.faux.setResponses([
			async () => {
				return await new Promise<AssistantMessage>((_resolve, reject) => {
					provider.context.abortSignal?.addEventListener("abort", () => {
						reject(new Error("aborted after the replay seed assertion"));
					}, { once: true });
				});
			},
		]);
		const held = await internal.submit({ type: "input", content: "internal held" }, BACKGROUND_CONTEXT);
		await vi.waitFor(async () => {
			expect((await held.status(BACKGROUND_CONTEXT)).status).toBe("placed");
		});
		await first.bus.drain(10_000, BACKGROUND_CONTEXT);
		first.bus.close();
		await first.opened.harness.close(BACKGROUND_CONTEXT);
		try {
			const restarted = await bootBus({
				dir: first.dir,
				responses: [
					fauxAssistantMessage("resumed internal answer"),
					fauxAssistantMessage("ordinary answer"),
				],
			});
			expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(0);
			const ordinary = await runTurn(restarted.root, "ordinary after restart");
			expect(ordinary.record.status).toBe("done");
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(restarted.bus.deliveredThrough()).toBeGreaterThan(ordinary.submission.id);
			expect(held.id).toBeLessThan(ordinary.submission.id);
		} finally {
			provider.cancel();
		}
	});

	test("a first-boot placed run keeps the marker pinned across restart", { timeout: 20_000 }, async () => {
		const first = await bootBus({
			settings: { retry: { enabled: false }, afterFailedRun: "keep" },
		});
		let release!: () => void;
		const gate = new Promise<AssistantMessage>((resolve) => {
			release = () => resolve(fauxAssistantMessage("held first-boot answer"));
		});
		first.faux.setResponses([async () => await gate]);
		const placed = await first.root.submit(
			{ type: "input", content: "held before the first marker" },
			BACKGROUND_CONTEXT,
		);
		await vi.waitFor(async () => {
			expect((await placed.status(BACKGROUND_CONTEXT)).status).toBe("placed");
		});
		await vi.waitFor(() => {
			expect(first.opened.eventBus.oldestLiveAdmissionMs()).toBeDefined();
		});
		await crashClose(first);

		const restarted = await bootBus({ dir: first.dir });
		expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(0);
		expect(restarted.opened.eventBus.deliveredThrough()).toBeLessThanOrEqual(placed.id);
		let releaseDelivery!: () => void;
		const deliveryGate = new Promise<void>((resolve) => {
			releaseDelivery = resolve;
		});
		restarted.opened.eventBus.registerExtension("fixture-first-boot-block", {
			runSettled: async () => await deliveryGate,
		});
		restarted.faux.setResponses([
			fauxAssistantMessage("resumed held answer"),
			fauxAssistantMessage("second run answer"),
		]);
		release();
		const resumed = await restarted.opened.harness.submission(placed.id, BACKGROUND_CONTEXT);
		expect((await resumed!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		const second = await runTurn(restarted.root, "second run beside the placed run");
		expect(second.record.status).toBe("done");
		await vi.waitFor(() => {
			expect(restarted.opened.eventBus.deliveredThrough()).toBeLessThanOrEqual(placed.id);
		});
		await crashClose(restarted);
		releaseDelivery();

		const again = await bootBus({ dir: first.dir });
		expect(again.opened.eventBus.deliveredThrough()).toBeLessThanOrEqual(placed.id);
		again.opened.eventBus.close();
		expect(await again.bus.replayUndelivered(again.opened.storage, BACKGROUND_CONTEXT)).toBe(2);
	});

	test("first boot sets the marker and boot replays history once", async () => {
		const first = await bootBus({ responses: [fauxAssistantMessage("history answer")] });
		const history = await runTurn(first.root, "history before the marker existed");
		expect(history.record.status).toBe("done");
		await crashClose(first);
		const restarted = await bootBus({ dir: first.dir });
		const events: RunSettledEvent[] = [];
		restarted.bus.registerExtension("fixture-first-boot-recorder", {
			runSettled: (event) => { events.push(event); },
		});

		// bootBus's own EventBus.open instance (not opened.eventBus) has not
		// replayed yet. This manual call queues the group; the test proves
		// boot's bus seeded the marker. Boot's own replay delivery is covered
		// by event-bus-restart.test.ts.
		expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(1);
		await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ inputs: [history.submission.id], replayed: true });
		expect(restarted.bus.deliveredThrough()).toBeGreaterThan(history.submission.id);
	});

	test("done inputs regroup by answer", async () => {
		const first = await bootBus({
			responses: [
				fauxAssistantMessage("marker answer"),
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("merged answer"),
			],
		});
		await seedMarker(first.root, first.bus);
		const one = await first.root.submit({ type: "input", content: "first merged input" }, BACKGROUND_CONTEXT);
		const two = await first.root.submit({ type: "input", content: "second merged input", whenBusy: "steer" }, BACKGROUND_CONTEXT);
		expect((await one.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		expect((await two.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		const { release } = await crashWithBlockedDelivery(first.bus);
		try {
			const { restarted, events } = await restartAfterCrash(first, release);
			expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(1);
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(events.map((one) => one.event.inputs)).toEqual([[one.id, two.id]]);
			expect(events[0]!.event.inputTexts).toEqual(["first merged input", "second merged input"]);
		} finally {
			release();
		}
	});

	test("a withdrawn queued input replays alone", async () => {
		const first = await bootBus({
			settings: { retry: { enabled: false }, afterFailedRun: "keep" },
			responses: [fauxAssistantMessage("marker answer")],
		});
		await seedMarker(first.root, first.bus);
		let fail!: () => void;
		const failedResponse = new Promise<AssistantMessage>((resolve) => {
			fail = () => resolve(fauxAssistantMessage("failed held run", { stopReason: "error", errorMessage: "faux provider failure" }));
		});
		first.faux.setResponses([async () => await failedResponse]);
		const held = await first.root.submit({ type: "input", content: "held failed input" }, BACKGROUND_CONTEXT);
		const withdrawn = await first.root.submit({ type: "input", content: "withdraw while queued" }, BACKGROUND_CONTEXT);
		expect(await withdrawn.abort(BACKGROUND_CONTEXT)).toBe("aborted");
		expect((await withdrawn.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		fail();
		expect((await held.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		const { release } = await crashWithBlockedDelivery(first.bus);
		try {
			const { restarted, events } = await restartAfterCrash(first, release);
			expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(2);
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(events.map((one) => one.event.inputs)).toEqual([[held.id], [withdrawn.id]]);
			expect(events.map((one) => one.event.outcome)).toEqual([
				{ status: "unanswered", reason: "model_error" },
				{ status: "unanswered", reason: "aborted" },
			]);
		} finally {
			release();
		}
	});

	test("internal conversations are not replayed", async () => {
		const first = await bootBus({ responses: [fauxAssistantMessage("marker answer")] });
		await seedMarker(first.root, first.bus);
		const internal = await first.opened.harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: first.opened.defaultModel },
			init: async (tx, id) => await markInternal(tx, id, "alice"),
		}, BACKGROUND_CONTEXT);
		first.faux.setResponses([fauxAssistantMessage("internal settled answer")]);
		const settled = await runTurn(internal, "internal undelivered input");
		expect(settled.record.status).toBe("done");
		await crashClose(first);
		const restarted = await bootBus({ dir: first.dir });
		const events: RunSettledEvent[] = [];
		restarted.bus.registerExtension("fixture-replay-recorder", {
			runSettled: (event) => {
				events.push(event);
			},
		});
		expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(0);
		await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(events).toEqual([]);
	});

	test("replays skip raw onSettled subscribers", async () => {
		const first = await bootBus({
			responses: [fauxAssistantMessage("marker answer"), fauxAssistantMessage("replay answer")],
		});
		await seedMarker(first.root, first.bus);
		await runTurn(first.root, "undelivered replay input");
		const { release } = await crashWithBlockedDelivery(first.bus);
		try {
			const { restarted, events } = await restartAfterCrash(first, release);
			const raw = vi.fn();
			restarted.bus.onSettled(raw);
			await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT);
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(raw).not.toHaveBeenCalled();
			expect(events).toHaveLength(1);
			expect(events[0]!.event.replayed).toBe(true);
		} finally {
			release();
		}
	});

	test("dropped groups replay after restart", { timeout: 20_000 }, async () => {
		const first = await bootBus({
			queueMax: 1,
			responses: [fauxAssistantMessage("marker answer"), fauxAssistantMessage("dropped answer"), fauxAssistantMessage("queued answer")],
		});
		await seedMarker(first.root, first.bus);
		let releaseFirst!: () => void;
		let dispatching!: () => void;
		const dispatchStarted = new Promise<void>((resolve) => {
			dispatching = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		first.bus.registerExtension("fixture-overflow-block", {
			runSettled: async () => {
				dispatching();
				await firstGate;
			},
		});
		const blocked = await runTurn(first.root, "overflow-blocked input");
		const draining = first.bus.drain(10_000, BACKGROUND_CONTEXT);
		await dispatchStarted;
		const other = await first.opened.harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: first.opened.defaultModel },
		}, BACKGROUND_CONTEXT);
		const dropped = await runTurn(other, "overflow-dropped input");
		expect(blocked.record.status).toBe("done");
		expect(dropped.record.status).toBe("done");
		// Deterministic overflow: evict the queued settle group with one
		// lifecycle event while the first group is still in dispatch.
		await first.opened.harness.createConversation({
			ownership: { kind: "ownerless" },
		}, BACKGROUND_CONTEXT);
		// Drain BEFORE close: the dropped id itself must pin the marker,
		// not merely the absence of a save during the blocked crash.
		releaseFirst();
		await draining;
		await first.bus.drain(10_000, BACKGROUND_CONTEXT);
		expect(await first.opened.harness.snapshot(RunDeliveryDoc, BACKGROUND_CONTEXT)).toEqual({
			through: expect.any(Number),
		});
		expect(first.bus.deliveredThrough()).toBeLessThanOrEqual(dropped.submission.id);
		await crashClose(first);
		const restarted = await bootBus({ dir: first.dir });
		const events: RunSettledEvent[] = [];
		restarted.bus.registerExtension("fixture-replay-recorder", {
			runSettled: (event) => {
				events.push(event);
			},
		});
		try {
			expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(1);
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(events.map((event) => event.inputs)).toEqual([[dropped.submission.id]]);
		} finally {
			releaseFirst();
		}
	});

	test("replay pages interleave with live events", { timeout: 20_000 }, async () => {
		const first = await bootBus({
			responses: [
				fauxAssistantMessage("marker answer"),
				...Array.from({ length: 5 }, (_, index) => fauxAssistantMessage(`replay answer ${index + 1}`)),
			],
		});
		await seedMarker(first.root, first.opened.eventBus);
		let release!: () => void;
		let started!: () => void;
		const startedGate = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		first.opened.eventBus.registerExtension("fixture-page-block", {
			runSettled: async () => {
				started();
				await gate;
			},
		});
		const undelivered: Awaited<ReturnType<typeof runTurn>>[] = [];
		for (let index = 0; index < 5; index += 1) {
			undelivered.push(await runTurn(first.root, `replay page input ${index + 1}`));
		}
		const draining = first.opened.eventBus.drain(10_000, BACKGROUND_CONTEXT);
		await startedGate;
		await crashClose(first);
		release();
		await draining;
		try {
			const restarted = await bootBus({
				dir: first.dir,
				replayPage: 2,
				responses: [fauxAssistantMessage("live answer")],
			});
			restarted.opened.eventBus.close();
			const events: ReplayRecord[] = [];
			restarted.bus.registerExtension("fixture-replay-recorder", {
				runSettled: (event) => {
					events.push({
						event,
						label: `${event.replayed === true ? "replay" : "live"}:${event.inputs.join(",")}`,
					});
				},
			});
			expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(5);
			const live = await runTurn(restarted.root, "live input behind replay pages");
			expect(live.record.status).toBe("done");
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(events.map((one) => one.label)).toEqual([
				`replay:${undelivered[0]!.submission.id}`,
				`replay:${undelivered[1]!.submission.id}`,
				`live:${live.submission.id}`,
				...undelivered.slice(2).map((one) => `replay:${one.submission.id}`),
			]);
			expect(restarted.bus.deliveredThrough()).toBeGreaterThan(live.submission.id);
		} finally {
			release();
		}
	});

	test("a failed continue merges with the input it placed", async () => {
		const first = await bootBus({
			settings: { retry: { enabled: false }, afterFailedRun: "keep" },
			responses: [fauxAssistantMessage("marker answer")],
		});
		await seedMarker(first.root, first.bus);
		let failFirst!: () => void;
		const firstFailure = new Promise<AssistantMessage>((resolve) => {
			failFirst = () => resolve(fauxAssistantMessage("failed original run", { stopReason: "error", errorMessage: "faux original failure" }));
		});
		first.faux.setResponses([async () => await firstFailure]);
		const original = await first.root.submit({ type: "input", content: "original failure" }, BACKGROUND_CONTEXT);
		const queued = await first.root.submit({ type: "input", content: "queued for continue", whenBusy: "steer" }, BACKGROUND_CONTEXT);
		failFirst();
		expect((await original.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		first.faux.setResponses([
			fauxAssistantMessage("failed continue", { stopReason: "error", errorMessage: "faux continue failure" }),
		]);
		const continued = await first.root.submit({ type: "continue" }, BACKGROUND_CONTEXT);
		expect((await queued.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		expect((await continued.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		const { release } = await crashWithBlockedDelivery(first.bus);
		try {
			const { restarted, events } = await restartAfterCrash(first, release);
			expect(await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT)).toBe(1);
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(events.map((one) => one.event.inputs)).toEqual([
				[queued.id, continued.id],
			]);
			expect(events[0]!.event).toMatchObject({
				continued: true,
				inputTexts: ["queued for continue", ""],
				replayed: true,
				outcome: { status: "unanswered", reason: "model_error" },
			});
		} finally {
			release();
		}
	});

	test("a live settle of a replayed id is dropped", async () => {
		const first = await bootBus({
			responses: [fauxAssistantMessage("marker answer"), fauxAssistantMessage("replay answer")],
		});
		await seedMarker(first.root, first.bus);
		const settled = await runTurn(first.root, "one replayed id");
		const { release } = await crashWithBlockedDelivery(first.bus);
		try {
			const { restarted, events } = await restartAfterCrash(first, release);
			await restarted.bus.replayUndelivered(restarted.opened.storage, BACKGROUND_CONTEXT);
			const publication: CommitPublication = {
				seq: 999_999 as CommitPublication["seq"],
				changes: [{
					type: "submission",
					value: settled.record,
				}],
			};
			(restarted.bus as unknown as { observe(publication: CommitPublication): void }).observe(publication);
			await restarted.bus.drain(10_000, BACKGROUND_CONTEXT);
			expect(events).toHaveLength(1);
			expect(events[0]!.event.inputs).toEqual([settled.submission.id]);
			expect(events[0]!.event.replayed).toBe(true);
		} finally {
			release();
		}
	});
});
