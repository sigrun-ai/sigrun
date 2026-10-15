/**
 * Memory-seam Task 3: the extension-facing `runSettled` contract — boot
 * wiring (bus open before resume, extension registration under final
 * names, scheduled drains), inputTexts resolution (position-preserving,
 * "" on unresolvable), the loader's factory-result validation, handler
 * isolation, and the narrowed api.
 *
 * Hermetic pattern (event-bus.test.ts / seam.test.ts): faux provider +
 * tmpdir + `openHarness` — real `node:sqlite` storage, real run loop, no
 * network. The fixture extension records delivered events module-side;
 * the test imports the FIXTURE MODULE through the same `file://` URL the
 * loader imported, so both hold one module instance (the fixture-memory
 * pattern). Delivery here rides the BOOT-scheduled drain (no manual
 * `drain()` call) — the production path this task wires.
 */

import { mkdtemp, rm } from "node:fs/promises";
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
	HarnessSettings,
} from "@earendil-works/pi-durable";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

/** The fixture-memory-events entry, imported by specifier (contract: factory + runSettled). */
const MEMORY_EVENTS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory-events", "index.js"),
).href;

/** The malformed-runSettled fixture (contract: factory result carrying `runSettled: 42`). */
const BAD_RUNSETTLED_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-bad-runsettled", "index.js"),
).href;

/** The fixture module's exports (events record + state flips). */
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
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		settings: options.settings,
		extensionSpecifiers: [MEMORY_EVENTS_SPECIFIER],
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
			{ name: "sigrun.fixture-bad-runsettled", entry: BAD_RUNSETTLED_SPECIFIER },
		];
		const opened = await openHarness(config, {
			env: {},
			extensionEntries: entries,
		});
		closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
		expect(opened.extensionOutcomes).toEqual([
			{
				name: "sigrun.fixture-bad-runsettled",
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
								"handler failed: extension sigrun.fixture-memory-events runSettled",
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
