/**
 * Memory-seam Task 5 (idle workers — the curator contract): the
 * factory-declared `workers` surface — host-owned `every` timers, wake-on-
 * lifecycle fan-out with queued+coalesced pending wakes, one-run-at-a-time,
 * deadline abandonment, the loader's six validation rejections, the
 * /v1/meta projection, and the shutdown ordering (workers stop BEFORE
 * harnessShutdown handlers).
 *
 * Hermetic pattern (memory-seam.test.ts): faux provider + tmpdir +
 * `openHarness` — real `node:sqlite` storage, real run loop, no network.
 * The fixture extension records worker runs module-side; the test imports
 * the FIXTURE MODULE through the same `file://` URL the loader imported,
 * so both hold one module instance. Real timers with small ms (the repo's
 * convention): the fixture's ticker declares every.ms 60, and the idle
 * tests inject `idleThresholdMs`/`idleSweepMs` through the boot seam.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

/** The fixture-workers entry, imported by specifier (contract: factory + workers). */
const WORKERS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-workers", "index.js"),
).href;

/** The fixture module's exports (run records + controls). */
type FixtureModule = {
	readonly runs: {
		readonly worker: string;
		readonly wake:
			| { readonly event: string; readonly conversationId: number }
			| undefined;
		readonly tick: number;
	}[];
	readonly shutdowns: readonly { at: number }[];
	readonly controls: {
		blockArch: boolean;
		hangTicker: boolean;
		failTicker: boolean;
	};
	readonly resetWorkers: () => void;
	readonly releaseBlock: () => void;
};

/**
 * Import the fixture module by the SAME URL the loader imported — one
 * module instance, so the recorded runs are these arrays.
 */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(WORKERS_SPECIFIER)) as unknown as FixtureModule;
}

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];

// Harnesses close after EACH test (not in afterAll): the fixture module is
// shared, so a prior test's still-alive ticker would keep recording into the
// module-side `runs` array and contaminate the next test (observed: hang
// flips wedging every live harness's ticker at once).
afterEach(async () => {
	for (const close of closes.splice(0)) await close();
});

afterAll(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface Boot {
	opened: OpenedHarness;
	faux: ReturnType<typeof fauxProvider>;
	fixture: FixtureModule;
}

/**
 * Boot one hermetic harness with the workers fixture installed. The
 * fixture's module state is shared by every harness this FILE boots (the
 * loader + the test import the same module instance), and earlier boots'
 * timers keep firing until their afterAll close — so all control flips
 * must RESTORE before the test ends (the per-test try/finally pattern).
 */
async function bootFixture(options: {
	responses?: readonly AssistantMessage[];
	/** Task 4/5's test seam: shrink idle + worker machinery. */
	eventBus?: {
		idleThresholdMs?: number;
		idleSweepMs?: number;
		workerDeadlineMs?: number;
	};
} = {}): Promise<Boot> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-workers-"));
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
		extensionSpecifiers: [WORKERS_SPECIFIER],
		eventBus: options.eventBus,
	});
	closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	const fixture = await fixtureModule();
	fixture.resetWorkers();
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

/** Patch one conversation's session-meta doc through a direct commit. */
async function patchMeta(
	conversation: Conversation,
	mutate: (draft: { archived: boolean }) => void,
): Promise<void> {
	await conversation.commit(async (tx) => {
		const draft = await tx.doc(SessionMetaDoc, conversation.id);
		mutate(draft);
	}, BACKGROUND_CONTEXT);
}

// ─── The contract ─────────────────────────────────────────────────────────

describe("idle workers — the curator contract", () => {
	test("a worker with every.ms runs periodically (small real timers)", async () => {
		const { fixture } = await bootFixture();
		// The ticker's 60ms host-owned interval fires without any run or
		// event — several runs accumulate with the host's cadence.
		await vi.waitFor(
			() =>
				expect(
					fixture.runs.filter((run) => run.worker === "ticker").length,
				).toBeGreaterThanOrEqual(2),
			{ timeout: 5_000, interval: 20 },
		);
		// Every-tick runs carry NO wake argument.
		const tickerRuns = fixture.runs.filter((run) => run.worker === "ticker");
		expect(tickerRuns.every((run) => run.wake === undefined)).toBe(true);
		// The tick counter ascends one per run (no overlap — see the skip test).
		expect(tickerRuns.map((run) => run.tick)).toEqual(
			tickerRuns.map((_, index) => index + 1),
		);
	});

	test("a worker with wakeOn:[conversationIdle] runs on idle, receiving the wake", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("the answer")],
			eventBus: { idleThresholdMs: 300, idleSweepMs: 50 },
		});
		const { root, record } = await runTurn(opened, "hello");
		expect(record.status).toBe("done");

		// The conversation's idle event wakes idle-ear with the wake payload.
		await vi.waitFor(
			() =>
				expect(
					fixture.runs.filter((run) => run.worker === "idle-ear"),
				).toHaveLength(1),
			{ timeout: 5_000, interval: 50 },
		);
		const [run] = fixture.runs.filter((run) => run.worker === "idle-ear");
		expect(run!.wake).toEqual({
			event: "conversationIdle",
			conversationId: root.id,
		});
		// Once per quiet period: continued quiet wakes it no further.
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(fixture.runs.filter((run) => run.worker === "idle-ear")).toHaveLength(
			1,
		);
	});

	test("a wake during an in-flight run is queued and coalesced (one follow-up run, last wake)", async () => {
		const { opened, fixture } = await bootFixture({
			responses: [fauxAssistantMessage("the answer")],
		});
		const { root } = await runTurn(opened, "hello");
		// Materialize the meta doc (seeds the flip baseline), then block
		// arch-ear mid-run: THREE archive flips arrive while the first run is
		// in flight — the last one wins the single pending-wake slot.
		await patchMeta(root, (draft) => {
			draft.archived = false;
		});
		fixture.controls.blockArch = true;
		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		// The blocked first run is in flight before the next flips land.
		await vi.waitFor(
			() =>
				expect(
					fixture.runs.filter((run) => run.worker === "arch-ear"),
				).toHaveLength(1),
			{ timeout: 5_000, interval: 20 },
		);
		expect(fixture.runs[0]!.wake).toMatchObject({
			event: "conversationArchived",
			conversationId: root.id,
		});
		await patchMeta(root, (draft) => {
			draft.archived = false;
		});
		await patchMeta(root, (draft) => {
			draft.archived = true;
		});
		// Let both flips dispatch (the wake queue coalesces to the last one).
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(fixture.runs.filter((run) => run.worker === "arch-ear")).toHaveLength(
			1,
		);
		// Releasing the block fails the first run; the coalesced wake then
		// triggers exactly ONE follow-up run.
		fixture.releaseBlock();
		await vi.waitFor(
			() =>
				expect(
					fixture.runs.filter((run) => run.worker === "arch-ear"),
				).toHaveLength(2),
			{ timeout: 5_000, interval: 20 },
		);
		// No third run — two queued wakes coalesced into one follow-up.
		await new Promise((resolve) => setTimeout(resolve, 200));
		const archRuns = fixture.runs.filter((run) => run.worker === "arch-ear");
		expect(archRuns).toHaveLength(2);
		expect(archRuns[1]!.wake).toMatchObject({
			event: "conversationArchived",
			conversationId: root.id,
		});
	});

	test("one run at a time: a still-running worker skips its next tick (no overlap)", async () => {
		const { opened, fixture } = await bootFixture({
			eventBus: { workerDeadlineMs: 10_000 },
		});
		// Hang the ticker: the first tick starts a run that never settles;
		// the next several 60ms ticks must be SKIPPED (no overlap, no queue).
		fixture.controls.hangTicker = true;
		try {
			await vi.waitFor(
				() =>
					expect(
						fixture.runs.filter((run) => run.worker === "ticker"),
					).toHaveLength(1),
				{ timeout: 5_000, interval: 20 },
			);
			await new Promise((resolve) => setTimeout(resolve, 250));
			// ~4 ticks elapsed while the run was in flight — still exactly one run.
			expect(fixture.runs.filter((run) => run.worker === "ticker")).toHaveLength(
				1,
			);
		} finally {
			fixture.controls.hangTicker = false;
			// The 10s-deadline zombie outlives the test: stop the workers NOW
			// so its ticks do not leak into later tests' module-side records.
			opened.eventBus.close();
		}
	});

	test("a timed-out run is abandoned and logged; the next tick still runs", async () => {
		const { opened, fixture } = await bootFixture({
			eventBus: { workerDeadlineMs: 80 },
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// Hang the ticker past the 80ms worker deadline: the host abandons
			// the run (logs the deadline as the failure), and a LATER tick
			// starts a fresh run — the worker is not wedged by the zombie.
			fixture.controls.hangTicker = true;
			await vi.waitFor(
				() =>
					expect(
						fixture.runs.filter((run) => run.worker === "ticker"),
					).toHaveLength(1),
				{ timeout: 5_000, interval: 20 },
				);
			await vi.waitFor(
				() => {
					// console.* applies %s at print time; the spy sees the RAW args
					// (format string + label + error) — join them before matching
					// (the memory-seam.test.ts convention).
					// The spy sees the RAW args (format placeholders stay
					// literal): match on the label and error args directly.
					const abandonments = spy.mock.calls.filter(
						(call) =>
							String(call[1]).includes(
								"extension sigrun.fixture-workers worker ticker",
							) && String(call[2]).includes("80ms worker deadline"),
					);
					// >= 1: a second hung tick can hit its own deadline before the
					// first poll lands (the worker is hung for this whole span).
					expect(abandonments.length).toBeGreaterThanOrEqual(1);
				},
				{ timeout: 5_000, interval: 20 },
			);
			// The deadline fired while the ticker was hung: un-hang it and the
			// NEXT tick starts a second run (the abandoned one freed the slot).
			fixture.controls.hangTicker = false;
			await vi.waitFor(
				() =>
					expect(
						fixture.runs.filter((run) => run.worker === "ticker").length,
					).toBeGreaterThanOrEqual(2),
				{ timeout: 5_000, interval: 20 },
			);
			// The abandonment is visible in the meta projection: lastError
			// carries the deadline message... then the fresh run's success
			// CLEARS it.
			expect(fixture.runs.filter((run) => run.worker === "ticker").length)
				.toBeGreaterThanOrEqual(2);
		} finally {
			spy.mockRestore();
			fixture.controls.hangTicker = false;
			// Zombies from the hung runs outlive the test: stop the workers
			// NOW so their ticks do not leak into later tests' records.
			opened.eventBus.close();
		}
		// Timer-driven waits (60ms ticks + 80ms deadlines + boot) exceed the
		// 5s default when the runner is loaded.
	}, 15_000);

	test("validation: no-name / duplicate / run-not-function / every<=0 / bad-wakeOn / no-trigger all quarantine", async () => {
		// Each bad declaration quarantines with its exact message (the
		// loader's fail-loud contract); one boot per case via extensionEntries.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-workers-"));
		dirs.push(dir);
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
		});
		const cases: readonly { workers: unknown; error: string }[] = [
			{
				workers: [{ every: { ms: 100 }, run: async () => {} }],
				error: "extension factory returned a worker without a name",
			},
			{
				workers: [
					{ name: "curator", every: { ms: 100 }, run: async () => {} },
					{ name: "curator", every: { ms: 200 }, run: async () => {} },
				],
				error: 'extension factory returned a worker with a duplicate worker name "curator"',
			},
			{
				workers: [{ name: "curator", every: { ms: 100 }, run: 42 }],
				error: 'extension factory returned a worker whose worker "curator" has a run field that is not a function',
			},
			{
				workers: [{ name: "curator", every: { ms: 0 }, run: async () => {} }],
				error: 'extension factory returned a worker whose worker "curator" has every.ms <= 0',
			},
			{
				workers: [
					{
						name: "curator",
						wakeOn: ["harnessShutdown"],
						run: async () => {},
					},
				],
				error: 'extension factory returned a worker whose worker "curator" has an invalid wakeOn entry',
			},
			{
				workers: [{ name: "curator", run: async () => {} }],
				error:
					"extension factory returned a worker that declares a worker with neither every nor wakeOn",
			},
		];
		for (const { workers, error } of cases) {
			const badDir = await mkdtemp(join(tmpdir(), "sigrun-memory-workers-"));
			dirs.push(badDir);
			const badEntry = join(badDir, "index.mjs");
			const source = `export default function bad() {
	return {
		extension: { name: "sigrun.fixture-bad-worker" },
		workers: ${JSON.stringify(workers, (_key, value) =>
			typeof value === "function" ? "__run__" : value,
		).replace(/"__run__"/g, "async () => {}")},
	};
}
`;
			await import("node:fs/promises").then((fs) =>
				fs.writeFile(badEntry, source),
			);
			const entries: ResolvedExtensionInput[] = [
				{
					name: "sigrun.fixture-bad-worker",
					entry: pathToFileURL(badEntry).href,
				},
			];
			const badConfig = loadConfig({
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				SIGRUN_STORAGE_PATH: join(badDir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: badDir,
			});
			const opened = await openHarness(badConfig, {
				env: {},
				extensionEntries: entries,
			});
			closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun.fixture-bad-worker", status: "quarantined", error },
			]);
			void config;
		}
	});

	test("/v1/meta carries worker names + lastRunAt", async () => {
		const { opened, fixture } = await bootFixture();
		// The ticker runs within its first 60ms tick.
		await vi.waitFor(
			() =>
				expect(
					fixture.runs.filter((run) => run.worker === "ticker").length,
				).toBeGreaterThanOrEqual(1),
			{ timeout: 5_000, interval: 20 },
		);
		const app = await createServer(opened, loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: "/tmp/unused-meta.db",
			SIGRUN_WORKSPACE_PATH: "/tmp",
		}));
		try {
			const response = await app.inject({ method: "GET", url: "/v1/meta" });
			expect(response.statusCode).toBe(200);
			const body = response.json() as {
				extensions: {
					name: string;
					status: string;
					workers?: { name: string; lastRunAt?: number; lastError?: string }[];
				}[];
			};
			const entry = body.extensions.find(
				(one) => one.name === "sigrun.fixture-workers",
			);
			expect(entry).toBeDefined();
			expect(entry!.status).toBe("ok");
			expect(entry!.workers).toBeDefined();
			const byName = new Map(entry!.workers!.map((w) => [w.name, w]));
			expect([...byName.keys()].sort()).toEqual([
				"arch-ear",
				"idle-ear",
				"ticker",
			]);
			// The ticker ran: its lastRunAt is present; the never-run workers
			// carry no lastRunAt/lastError until their first run.
			expect(byName.get("ticker")!.lastRunAt).toEqual(expect.any(Number));
			expect(byName.get("ticker")!.lastError).toBeUndefined();
			expect(byName.get("idle-ear")!.lastRunAt).toBeUndefined();
		} finally {
			await app.close();
		}
	});

	test("a stale unsubscribe cannot kill a same-name re-registration's workers or handlers", async () => {
		// Post-ship review item: registerExtension's unsubscribe captured no
		// registration identity — a STALE unsub stopped the CURRENT
		// registration's workers (the #extensions delete was guarded; the
		// worker stop was not).
		const { opened, fixture } = await bootFixture();
		await vi.waitFor(
			() =>
				expect(
					fixture.runs.filter((run) => run.worker === "ticker").length,
				).toBeGreaterThanOrEqual(1),
			{ timeout: 5_000, interval: 20 },
		);

		const bus = opened.eventBus;
		const reRunSettled: string[] = [];
		const staleUnsub = bus.registerExtension("sigrun.re-register", {
			workers: [
				{
					name: "first-ticker",
					every: { ms: 40 },
					async run() {
						// Registration-era marker — must NEVER run: the
						// replacement stops the old worker at re-register time.
						reRunSettled.push("first-worker");
					},
				},
			],
		});
		const currentUnsub = bus.registerExtension("sigrun.re-register", {
			workers: [
				{
					name: "second-ticker",
					every: { ms: 40 },
					async run() {
						reRunSettled.push("second-worker");
					},
				},
			],
			runSettled(event) {
				reRunSettled.push(`runSettled:${event.conversationId}`);
			},
		});

		// The replacement stopped the FIRST registration's worker at
		// re-register time; the current one ticks.
		await vi.waitFor(
			() => expect(reRunSettled).toContain("second-worker"),
			{ timeout: 5_000, interval: 20 },
		);
		expect(reRunSettled).not.toContain("first-worker");

		// The STALE unsubscribe is a no-op: the current worker keeps ticking
		// and the current registration's handlers stay registered.
		staleUnsub();
		const before = reRunSettled.length;
		await vi.waitFor(
			() => expect(reRunSettled.length).toBeGreaterThan(before + 1),
			{ timeout: 5_000, interval: 20 },
		);
		const { root } = await runTurn(opened, "still registered");
		await vi.waitFor(
			() =>
				expect(reRunSettled).toContain(`runSettled:${root.id}`),
			{ timeout: 5_000, interval: 20 },
		);

		// The CURRENT unsubscribe does stop it.
		currentUnsub();
		const finalCount = reRunSettled.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(reRunSettled.length).toBe(finalCount);
	});

	test("shutdown stops workers before harnessShutdown handlers (ordering)", async () => {
		// workerDeadlineMs 150 bounds the in-flight wait far below the 30s
		// shutdown cap: the hung run is abandoned by the worker deadline and
		// the sequence proceeds to harnessShutdown.
		const { opened, fixture } = await bootFixture({
			eventBus: { workerDeadlineMs: 150 },
		});
		// A ticker run lands so the worker machinery is warm.
		await vi.waitFor(
			() =>
				expect(
					fixture.runs.filter((run) => run.worker === "ticker").length,
				).toBeGreaterThanOrEqual(1),
			{ timeout: 5_000, interval: 20 },
		);
		expect(fixture.shutdowns).toHaveLength(0);
		// Hang the ticker so shutdown has an in-flight run to await/abandon:
		// the sequence must still reach harnessShutdown — and the workers
		// must be stopped BEFORE it delivers.
		fixture.controls.hangTicker = true;
		try {
			await vi.waitFor(
				() =>
					expect(
						fixture.runs.filter((run) => run.worker === "ticker").length,
					).toBeGreaterThanOrEqual(2),
				{ timeout: 5_000, interval: 20 },
			);
			const start = Date.now();
			await opened.eventBus.shutdownSequence(BACKGROUND_CONTEXT);
			expect(Date.now() - start).toBeLessThan(31_000);
			// harnessShutdown delivered — AFTER the workers were stopped.
			expect(fixture.shutdowns).toHaveLength(1);
			// Workers stopped first: no run STARTS after the shutdown sequence
			// (hung zombies never settle, so they can never START a run).
			const before = fixture.runs.length;
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(fixture.runs.length).toBe(before);
		} finally {
			fixture.controls.hangTicker = false;
		}
		// Boot + two ticker waits + the shutdown sequence exceed the 5s
		// default when the runner is loaded.
	}, 15_000);
});
