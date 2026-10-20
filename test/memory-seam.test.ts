/**
 * Memory-seam Task 3 (`runSettled`) + Task 4 (conversation lifecycle
 * events, `conversationIdle` detection, `harnessShutdown`): the
 * extension-facing event contract — boot wiring (bus open before resume,
 * extension registration under final names, scheduled drains), inputTexts
 * resolution (position-preserving, "" on unresolvable), the loader's
 * factory-result validation (runSettled + the five lifecycle fields),
 * handler isolation, the narrowed api, and the idle/shutdown machinery.
 *
 * Hermetic pattern (event-bus.test.ts / seam.test.ts): faux provider +
 * tmpdir + `openHarness` — real `node:sqlite` storage, real run loop, no
 * network. The fixture extension records delivered events module-side;
 * the test imports the FIXTURE MODULE through the same `file://` URL the
 * loader imported, so both hold one module instance (the fixture-memory
 * pattern). Delivery here rides the BOOT-scheduled drain (no manual
 * `drain()` call) — the production path this task wires. Idle tests pass a
 * small `idleThresholdMs`/`idleSweepMs` through the boot seam (real
 * timers, short waits — the repo's convention) rather than fake timers.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	Conversation,
	HarnessSettings,
} from "@earendil-works/pi-durable";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { AmbientDoc } from "../src/harness/ambient.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { resolveExtension } from "../src/harness/loader.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

/** The fixture-memory-events entry, imported by specifier (contract: factory + runSettled). */
const MEMORY_EVENTS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory-events", "index.js"),
).href;

/** The malformed-runSettled fixture (contract: factory result carrying `runSettled: 42`). */
const BAD_RUNSETTLED_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-bad-runsettled", "index.js"),
).href;

/** The fixture module's exports (events record + lifecycle record + state flips). */
type FixtureModule = {
	readonly events: {
		conversationId: number;
		inputs: number[];
		inputTexts: string[];
		outcome:
			| { status: "answered"; answerEntryId: number; answerText: string }
			| { status: "unanswered"; reason: string };
		apiKeys: string[];
	}[];
	/** Lifecycle deliveries (Task 4): `{handler, ...event}` in delivery order. */
	readonly lifecycle: {
		readonly handler: string;
		readonly conversationId?: number;
		readonly childId?: number;
		readonly parentId?: number;
		readonly at?: number;
		readonly archived?: boolean;
		readonly idleMs?: number;
	}[];
	/** harnessShutdown deliveries (Task 4): one record per shutdown event. */
	readonly shutdowns: readonly { at: number }[];
	readonly resetEvents: () => void;
	readonly setThrowOnRunSettled: (value: boolean) => void;
};

/**
 * Import the fixture module by the SAME URL the loader imported — one
 * module instance, so the recorded events are these arrays.
 */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(MEMORY_EVENTS_SPECIFIER)) as unknown as FixtureModule;
}

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];

afterAll(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface Boot {
	opened: OpenedHarness;
	faux: ReturnType<typeof fauxProvider>;
	fixture: FixtureModule;
}

/** Boot one hermetic harness with the memory-events fixture installed. */
async function bootFixture(options: {
	responses?: readonly AssistantMessage[];
	settings?: HarnessSettings;
	/** Task 4's test seam: shrink the idle threshold + sweep cadence. */
	eventBus?: { idleThresholdMs?: number; idleSweepMs?: number };
} = {}): Promise<Boot> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-seam-"));
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
	// these tests script exact responses for the seam's own observables
	// (naming behavior is test/naming.test.ts's subject).
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		settings: options.settings,
		extensionSpecifiers: [MEMORY_EVENTS_SPECIFIER],
		eventBus: options.eventBus,
		settingsDir: dir,
	});
	closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	const fixture = await fixtureModule();
	fixture.resetEvents();
	fixture.setThrowOnRunSettled(false);
	return { opened, faux, fixture };
}

/** Submit one input and return the settled record. */
async function runTurn(opened: OpenedHarness, input: string) {
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const submission = await root.submit(
		{ type: "input", content: input },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	return { root, submission, record };
}

/** Await the boot-scheduled delivery of the fixture's next event. */
async function nextDelivered(fixture: FixtureModule, count = 1) {
	await vi.waitFor(() => expect(fixture.events).toHaveLength(count), {
		timeout: 5_000,
		interval: 100,
	});
	return fixture.events.slice(-count);
}

/** The fixture's `conversationIdle` deliveries. */
function idleEvents(fixture: FixtureModule) {
	return fixture.lifecycle.filter((one) => one.handler === "conversationIdle");
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

// ─── The contract ─────────────────────────────────────────────────────────

describe("runSettled contract", () => {
	test("the fixture extension receives runSettled with paired inputTexts", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("the answer")],
		});
		const { root, record } = await runTurn(opened, "remember ZEBRA");
		expect(record.status).toBe("done");

		const [event] = await nextDelivered(fixture);
		expect(event.inputs).toHaveLength(1);
		expect(event.inputTexts).toEqual(["remember ZEBRA"]);
		expect(event.conversationId).toBe(root.id);
		expect(event.outcome).toMatchObject({
			status: "answered",
			answerText: "the answer",
		});
		expect(event.outcome).toHaveProperty("answerEntryId");
	});

	test("a factory runSettled that is not a function is quarantined with the reason", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-seam-"));
		dirs.push(dir);
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
		});
		// Quarantined outcomes carry the DISPLAY name — passing the fixture
		// as a pre-resolved entry with the extension's name as its label
		// keeps the outcome readable as the fixture's own name.
		const entries: ResolvedExtensionInput[] = [
			{ name: "sigrun-fixture-bad-runsettled", entry: BAD_RUNSETTLED_SPECIFIER },
		];
		const opened = await openHarness(config, {
			env: {},
			extensionEntries: entries,
		});
		closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
		expect(opened.extensionOutcomes).toEqual([
			{
				name: "sigrun-fixture-bad-runsettled",
				status: "quarantined",
				error: "extension factory returned a runSettled field that is not a function",
			},
		]);
		// The bus still exists (Task 4 needs it regardless) with nothing registered.
		expect(opened.eventBus).toBeDefined();
	});

	test("inputTexts are position-preserving when a submission's text is unresolvable", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [
				// A tool round opens the steer/queue window.
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("never reached"),
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const first = await root.submit(
			{ type: "input", content: "the real text" },
			BACKGROUND_CONTEXT,
		);
		// Queued (default whenBusy): admitted into the inbox, never placed.
		const second = await root.submit(
			{ type: "input", content: "queued text" },
			BACKGROUND_CONTEXT,
		);
		await root.abort(BACKGROUND_CONTEXT);
		const [recordA, recordB] = await Promise.all([
			first.wait(BACKGROUND_CONTEXT),
			second.wait(BACKGROUND_CONTEXT),
		]);
		expect(recordA.status).toBe("unanswered");
		expect(recordB.status).toBe("unanswered");

		// The abort settles in TWO commits — the queued input's withdrawal
		// first (no entry ever placed → "" at its position), then the aborted
		// run's placed input (its entry exists → the text resolves even
		// though the run itself went unanswered). Positions never reorder.
		await vi.waitFor(
			() => expect(fixture.events).toHaveLength(2),
			{
				timeout: 5_000,
				interval: 100,
			},
		);
		expect(fixture.events.map((event) => event.inputTexts)).toEqual([
			[""],
			["the real text"],
		]);
		expect(
			fixture.events.every((event) => event.outcome.status === "unanswered"),
		).toBe(true);
	});

	test("runSettled fires once for a run whose final attempt follows a retry", async () => {
		const { opened, fixture } = await bootFixture({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			responses: [
				fauxAssistantMessage("transient", {
					stopReason: "error",
					errorMessage: "503 service unavailable",
				}),
				fauxAssistantMessage("answer after retry"),
			],
		});
		const { record } = await runTurn(opened, "hello");
		expect(record.status).toBe("done");
		await nextDelivered(fixture);
		expect(fixture.events).toHaveLength(1);
		expect(fixture.events[0]!.outcome).toMatchObject({
			status: "answered",
			answerText: "answer after retry",
		});
	});

	test("an extension handler throw is caught and logged; the run still settles", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("the answer")],
		});
		fixture.setThrowOnRunSettled(true);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { record } = await runTurn(opened, "hello");
			// The run settles normally — the handler throw never escapes.
			expect(record.status).toBe("done");
			await vi.waitFor(
				() => {
					// console.* applies %s at print time; the spy sees the RAW args
					// (format string + label + error) — join them before matching.
					const failures = spy.mock.calls
						.map((call) => call.map(String).join(" "))
						.filter((text) =>
							text.includes(
								"handler failed: extension sigrun-fixture-memory-events runSettled",
							),
						);
					expect(failures).toHaveLength(1);
				},
				{
					timeout: 5_000,
					interval: 100,
				},
			);
			// The throw was not recorded as a delivery.
			expect(fixture.events).toHaveLength(0);
		} finally {
			spy.mockRestore();
			fixture.setThrowOnRunSettled(false);
		}
	});

	test("handlers receive a narrowed api (no taskId, no memo)", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("the answer")],
		});
		await runTurn(opened, "hello");
		const [event] = await nextDelivered(fixture);
		expect(event.apiKeys).toContain("entry");
		expect(event.apiKeys).toContain("entries");
		expect(event.apiKeys).toContain("document");
		expect(event.apiKeys).not.toContain("taskId");
		expect(event.apiKeys).not.toContain("memo");
		expect(event.apiKeys).not.toContain("conversationId");
	});

	test("a steer-merged run delivers one event with both texts in admission order", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("merged answer"),
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const first = await root.submit(
			{ type: "input", content: "first text" },
			BACKGROUND_CONTEXT,
		);
		const second = await root.submit(
			{ type: "input", content: "second text", whenBusy: "steer" },
			BACKGROUND_CONTEXT,
		);
		const [recordA, recordB] = await Promise.all([
			first.wait(BACKGROUND_CONTEXT),
			second.wait(BACKGROUND_CONTEXT),
		]);
		expect(recordA.status).toBe("done");
		expect(recordB.status).toBe("done");

		const [event] = await nextDelivered(fixture);
		expect(event.inputs).toHaveLength(2);
		expect(event.inputTexts).toEqual(["first text", "second text"]);
		expect(event.outcome).toMatchObject({
			status: "answered",
			answerText: "merged answer",
		});
	});
});

// ─── Task 4: lifecycle handlers + conversationIdle + harnessShutdown ──────

describe("conversation lifecycle contract", () => {
	test(
		"the fixture extension receives conversationCreated/Forked and NOT archived for an inherited-archive fork",
		{ timeout: 75_000 },
		async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("turn one")],
		});
		const { root } = await runTurn(opened, "hello");
		await nextDelivered(fixture);

		// Materialize the meta doc (seeds the flip baseline), then archive the
		// parent: a REAL flip fires for the parent only.
		await patchMeta(root, (draft) => {
			draft.pinned = true;
		});
		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		// The fork child is born archived (fork: "current") — created + forked,
		// NEVER an inherited archive event.
		const at = await newestEntryId(root);
		const child = await root.fork(
			at,
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);

		// Four deliveries in order: created(root) [root() in runTurn],
		// archived(root, true), created(child), forked(child, root, at).
		// W4's jobs boot work (harness.root + reconcile + observers + the
		// commit subscriptions) runs during this window and starves the
		// delivery lane — under the full-suite's parallel load the four
		// deliveries take 15–26s+. 60s is the observed bound with headroom;
		// the test timeout carries the extra margin. The assertion below is
		// the pin; the timeout is the measurement budget.
		await vi.waitFor(
			() => expect(fixture.lifecycle).toHaveLength(4),
			{ timeout: 60_000, interval: 100 },
		);
		expect(fixture.lifecycle.map((one) => one.handler)).toEqual([
			"conversationCreated",
			"conversationArchived",
			"conversationCreated",
			"conversationForked",
		]);
		expect(fixture.lifecycle[0]).toMatchObject({
			handler: "conversationCreated",
			conversationId: root.id,
		});
		expect(fixture.lifecycle[1]).toMatchObject({
			handler: "conversationArchived",
			conversationId: root.id,
			archived: true,
		});
		expect(fixture.lifecycle[2]).toMatchObject({
			handler: "conversationCreated",
			conversationId: child.id,
		});
		expect(fixture.lifecycle[3]).toEqual({
			handler: "conversationForked",
			childId: child.id,
			parentId: root.id,
			at,
		});
		// The inherited archive NEVER fired for the child.
		const archivedForChild = fixture.lifecycle.filter(
			(one) =>
				one.handler === "conversationArchived" &&
				one.conversationId === child.id,
		);
		expect(archivedForChild).toHaveLength(0);
	});

	test("conversationIdle fires after the threshold of quiet (idleMs >= threshold)", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [
				fauxAssistantMessage("the answer"),
				fauxAssistantMessage("the second answer"),
			],
			eventBus: { idleThresholdMs: 300, idleSweepMs: 50 },
		});
		const { root, record } = await runTurn(opened, "hello");
		expect(record.status).toBe("done");

		// Quiet for the threshold: exactly one idle event, idleMs measured
		// from the LAST input admission.
		await vi.waitFor(() => expect(idleEvents(fixture)).toHaveLength(1), {
			timeout: 5_000,
			interval: 50,
		});
		expect(idleEvents(fixture)[0]).toMatchObject({
			handler: "conversationIdle",
			conversationId: root.id,
		});
		expect(idleEvents(fixture)[0]!.idleMs).toBeGreaterThanOrEqual(300);

		// Once per quiet period: continued quiet does not fire again.
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(idleEvents(fixture)).toHaveLength(1);

		// Re-arm: a new admission starts a new quiet period that fires again.
		const second = await runTurn(opened, "again");
		expect(second.record.status).toBe("done");
		await vi.waitFor(() => expect(idleEvents(fixture)).toHaveLength(2), {
			timeout: 5_000,
			interval: 50,
		});
		expect(idleEvents(fixture)[1]).toMatchObject({
			conversationId: root.id,
		});
		expect(idleEvents(fixture)[1]!.idleMs).toBeGreaterThanOrEqual(300);
	});

	test("idle does NOT fire while a run is live, even past the threshold", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [
				// A tool round keeps the run live ~1s — well past the 300ms
				// threshold and several sweep ticks.
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done after tools"),
			],
			eventBus: { idleThresholdMs: 300, idleSweepMs: 50 },
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: "long running" },
			BACKGROUND_CONTEXT,
		);
		// Mid-run checkpoint: the threshold AND ~9 sweep ticks have elapsed
		// while the run is live — no idle (Review Focus 6).
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(idleEvents(fixture)).toHaveLength(0);

		const record = await submission.wait(BACKGROUND_CONTEXT);
		expect(record.status).toBe("done");
		// The run ends; the next sweep fires idle with idleMs past threshold.
		await vi.waitFor(() => expect(idleEvents(fixture)).toHaveLength(1), {
			timeout: 5_000,
			interval: 50,
		});
		expect(idleEvents(fixture)[0]!.idleMs).toBeGreaterThanOrEqual(300);
	});

	test("write-type submissions do not reset the idle clock", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("the answer")],
			eventBus: { idleThresholdMs: 250, idleSweepMs: 50 },
		});
		const { root, record } = await runTurn(opened, "hello");
		expect(record.status).toBe("done");
		await vi.waitFor(() => expect(idleEvents(fixture)).toHaveLength(1), {
			timeout: 5_000,
			interval: 50,
		});

		// A passive write lands at once (display-only: kind + data, no run)...
		const write = await root.submit(
			{ type: "write", entry: { kind: "fixture.heartbeat", data: { n: 1 } } },
			BACKGROUND_CONTEXT,
		);
		const writeRecord = await write.wait(BACKGROUND_CONTEXT);
		expect(writeRecord.status).toBe("done");
		expect(writeRecord.type).toBe("write");

		// ...and does NOT re-arm the clock: waiting well past another full
		// threshold fires nothing more (a write counted as an admission would
		// re-arm and fire a second idle here).
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(idleEvents(fixture)).toHaveLength(1);
	});

	test("a run live in an archived conversation still settles (settle emission untouched)", async () => {
		// Post-ship review item: the idle-map prune on archive touches ONLY
		// idle bookkeeping — a run admitted BEFORE the archive settles
		// normally (runSettled fires) and the live-run decrement does not
		// re-create a pruned entry.
		const { opened, fixture } = await bootFixture({
			responses: [
				// A tool round keeps the run live across the archive flip.
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done after the archive"),
			],
			eventBus: { idleThresholdMs: 300, idleSweepMs: 50 },
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: "long running" },
			BACKGROUND_CONTEXT,
		);
		// Materialize the meta doc (seeds the flip baseline), then archive
		// MID-RUN: the prune drops the conversation's idle bookkeeping while
		// its run is live.
		await patchMeta(root, (draft) => {
			draft.pinned = true;
		});
		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		await vi.waitFor(
			() =>
				expect(
					fixture.lifecycle.filter(
						(one) =>
							one.handler === "conversationArchived" &&
							one.archived === true,
					),
				).toHaveLength(1),
			{ timeout: 5_000, interval: 50 },
		);

		const record = await submission.wait(BACKGROUND_CONTEXT);
		expect(record.status).toBe("done");
		// The settle emission is untouched: runSettled delivers normally.
		const [event] = await nextDelivered(fixture);
		expect(event.conversationId).toBe(root.id);
		expect(event.outcome).toMatchObject({
			status: "answered",
			answerText: "done after the archive",
		});
		// The settle's live-run decrement skipped the pruned key (no floored
		// 0 re-creation): continued quiet past the threshold fires NO idle
		// — the pruned conversation stays out of the sweep until its next
		// admission.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(idleEvents(fixture)).toHaveLength(0);
	});

	test("archiving prunes idle state: no idle while archived, re-armed at the next admission", async () => {
		// Post-ship review item: conversationArchived(true) prunes the
		// per-conversation idle maps (#lastAdmission/#liveInputs/#idleFiredAt)
		// — archive is stronger idle with its own event; un-archive does NOT
		// restore (conservative: misses idles, never invents them); the next
		// admission re-enters the idle clock.
		const { opened, fixture } = await bootFixture({
			responses: [
				fauxAssistantMessage("the answer"),
				fauxAssistantMessage("the second answer"),
			],
			eventBus: { idleThresholdMs: 300, idleSweepMs: 50 },
		});
		const { root, record } = await runTurn(opened, "hello");
		expect(record.status).toBe("done");

		// Quiet past the threshold: exactly one idle fire.
		await vi.waitFor(() => expect(idleEvents(fixture)).toHaveLength(1), {
			timeout: 5_000,
			interval: 50,
		});

		// Materialize the meta doc (seeds the flip baseline), then ARCHIVE:
		// the archived(true) event prunes the conversation's idle state.
		await patchMeta(root, (draft) => {
			draft.pinned = true;
		});
		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		// Pin the archive delivery BEFORE the quiet-window assertions: an
		// unsynchronized archive patch could land after (or never) — the
		// sweep's prune is keyed on this delivery.
		await vi.waitFor(
			() =>
				expect(
					fixture.lifecycle.filter(
						(one) =>
							one.handler === "conversationArchived" &&
							one.archived === true,
					),
				).toHaveLength(1),
			{ timeout: 5_000, interval: 50 },
		);

		// Continued quiet well past the threshold fires NO further idle
		// (post-ship review item: the archived(true) event PRUNES the
		// per-conversation idle maps — archive is stronger idle, and the
		// already-fired record must not keep this conversation from
		// re-firing after a later admission).
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(idleEvents(fixture)).toHaveLength(1);

		// Un-archive: no restoration — STILL no idle (the conversation
		// re-enters the idle clock only at its NEXT admission; conservative
		// — misses idles, never invents them).
		await patchMeta(root, (draft) => {
			draft.archived = false;
		});
		await vi.waitFor(
			() =>
				expect(
					fixture.lifecycle.filter(
						(one) =>
							one.handler === "conversationArchived" &&
							one.archived === false,
					),
				).toHaveLength(1),
			{ timeout: 5_000, interval: 50 },
		);
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(idleEvents(fixture)).toHaveLength(1);

		// Un-pruned-state proof: a second full threshold of quiet while
		// UN-archived fires nothing (the pre-archive fire is the once-per-
		// quiet-period record; the archive/un-archive round-trip restores
		// nothing). This is the assertion the un-pruned shape fails: without
		// the prune the last-phase re-admission re-fires identically, so
		// this window is what separates the shapes.
		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		await patchMeta(root, (draft) => {
			draft.archived = false;
		});
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(idleEvents(fixture)).toHaveLength(1);

		// A new admission settles; the sweep re-arms from it and idle fires
		// again past the threshold — WITHOUT the prune, the pre-archive
		// #idleFiredAt would suppress this fire (idleFiredAt >= admittedAt).
		const second = await runTurn(opened, "again");
		expect(second.record.status).toBe("done");
		await vi.waitFor(() => expect(idleEvents(fixture)).toHaveLength(2), {
			timeout: 5_000,
			interval: 50,
		});
		expect(idleEvents(fixture)[1]).toMatchObject({
			handler: "conversationIdle",
			conversationId: root.id,
		});
	});

	test("harnessShutdown fires during shutdown; the handler's commit lands", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("the answer")],
		});
		const { root, record } = await runTurn(opened, "hello");
		expect(record.status).toBe("done");
		await nextDelivered(fixture);
		expect(fixture.shutdowns).toHaveLength(0);

		// The shutdown sequence (what src/index.ts runs between app.close and
		// harness.close): pending settles drain first, then harnessShutdown.
		await opened.eventBus.shutdownSequence(BACKGROUND_CONTEXT);
		expect(fixture.shutdowns).toHaveLength(1);

		// The handler's commit LANDED — admission was still open (the seal is
		// Harness.close, which has not run yet): the ambient doc the fixture
		// writes through its captured host is readable post-sequence.
		const doc = await opened.harness.snapshot(
			AmbientDoc,
			root.id,
			"fixture-flush",
			BACKGROUND_CONTEXT,
		);
		expect(doc?.body?.line?.text).toBe("flushed at shutdown");
	});

	test("a factory lifecycle field that is not a function is quarantined with the reason", async () => {
		// The five validation branches mirror runSettled's fail-loud pattern,
		// each naming its own field.
		const extension = { name: "sigrun-fixture-bad-lifecycle" } as never;
		const fields = [
			"conversationCreated",
			"conversationForked",
			"conversationArchived",
			"conversationIdle",
			"harnessShutdown",
		] as const;
		for (const field of fields) {
			// The throw propagates out of resolveExtension (async — factories
			// may return a Promise, provider plugins Task 1) and surfaces
			// through the loader as the quarantine reason; assert the message
			// exactly.
			let message = "";
			try {
				await resolveExtension({
					default: () => ({ extension, [field]: 42 }),
				});
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toBe(
				`extension factory returned a ${field} field that is not a function`,
			);
		}
	});

	test("idle does not fire when a queued input is withdrawn mid-run (live-run gate holds)", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [
				// A tool round keeps the run live ~1s — past the 300ms
				// threshold and several sweep ticks.
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done after tools"),
			],
			eventBus: { idleThresholdMs: 300, idleSweepMs: 50 },
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const first = await root.submit(
			{ type: "input", content: "long running" },
			BACKGROUND_CONTEXT,
		);
		// Queued behind the busy run (the default whenBusy): admitted but
		// never placed — no entry, no live-run count.
		const queued = await root.submit(
			{ type: "input", content: "queued then withdrawn" },
			BACKGROUND_CONTEXT,
		);
		// Withdraw the QUEUED input: it settles `unanswered` with NO entry.
		// The settle must not decrement the run's live count (the placed
		// input's run is still live) — the sweep stays gated (Focus 6).
		const aborted = await opened.harness.abortSubmission(
			queued.id,
			BACKGROUND_CONTEXT,
			root.id,
		);
		expect(aborted).toBe("aborted");

		// Past the threshold, several sweeps, run still live: NO idle.
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(idleEvents(fixture)).toHaveLength(0);

		const record = await first.wait(BACKGROUND_CONTEXT);
		expect(record.status).toBe("done");
		// The run ends; the sweep fires idle after the threshold.
		await vi.waitFor(() => expect(idleEvents(fixture)).toHaveLength(1), {
			timeout: 5_000,
			interval: 50,
		});
		expect(idleEvents(fixture)[0]!.idleMs).toBeGreaterThanOrEqual(300);
	});
});
