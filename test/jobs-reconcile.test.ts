/**
 * Jobs Task 3 (spec §8.3 + §8.1 + §5.8 + §8.1a): sources, reconciliation,
 * the run-status observers, ownership transfer, and the worker `every`
 * retirement.
 *
 * Stage 1 (this block, written first — TDD): the declared→record→task
 * reconciliation for every source, the JobsService api surface, and
 * record-only listing.
 *
 * The rig reuses the jobs-task pattern: a REAL harness (faux provider,
 * tmp sqlite) with an injectable clock, plus a REBOOT flow — the same
 * config/root/directory booted twice — so reconciliation's idempotence
 * (same task id), change detection (new hash → new task), and retirement
 * (vanishing declarations) are exercised across real process state.
 *
 * The fixture-jobs extension (test/fixtures/fixture-jobs) declares the
 * `tick` + `tasked` jobs and the `fixture-tick` task; loading or NOT
 * loading it across a reboot is the extension-source retire case.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type {
	Cursor,
	TaskId,
	TaskRecord,
} from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { JobDeclaredError, type JobsService } from "../src/jobs/index.js";
import { liveScheduleTasksByJob } from "../src/jobs/reconcile.js";
import { createScheduleTask } from "../src/jobs/task.js";
import { patchJob, readJob } from "../src/jobs/docs.js";
import { specHash } from "../src/jobs/spec.js";
import { seededIdentity } from "./helpers/identity.js";

const T0 = Date.parse("2026-10-19T12:00:00.000Z");

/** The fixture-jobs entry, imported by specifier. */
const FIXTURE_JOBS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-jobs", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One hermetic harness with a controllable clock; rebootable by dir. */
interface TestRig {
	opened: OpenedHarness;
	jobs: JobsService;
	faux: FauxProviderHandle;
	dir: string;
	setNow(ms: number): void;
	now(): number;
	close(): Promise<void>;
}

/** The shared spec: a 60s-interval prompt job, conversation "new". */
function tickSpec(overrides?: Partial<JobSpec>): JobSpec {
	return {
		name: "tick",
		schedule: { every: "60s" },
		action: { kind: "prompt", prompt: "say tick", conversation: "new" },
		...overrides,
	};
}

async function writeSettings(
	dir: string,
	settings: Record<string, unknown>,
): Promise<void> {
	await writeFile(
		join(dir, "settings.json"),
		`${JSON.stringify(settings, null, "\t")}\n`,
	);
}

async function bootRig(options?: {
	/** Reuse a prior rig's directory (the reboot flow). */
	readonly dir?: string;
	/** The settings-file contents, written BEFORE boot. */
	readonly settings?: Record<string, unknown>;
	/** Extension specifiers to load (the fixture-jobs source). */
	readonly extensions?: readonly string[];
	readonly startNow?: number;
	readonly responses?: readonly ReturnType<typeof fauxAssistantMessage>[];
}): Promise<TestRig> {
	const dir = options?.dir ?? (await mkdtemp(join(tmpdir(), "sigrun-jobs-rec-")));
	if (options?.settings !== undefined) {
		await writeSettings(dir, options.settings);
	}
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
		SIGRUN_TIMEZONE: "UTC",
	});
	let clock = options?.startNow ?? T0;
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		settingsDir: dir,
		...(options?.extensions === undefined
			? {}
			: { extensionSpecifiers: options.extensions }),
		now: () => new Date(clock),
	});
	const rig: TestRig = {
		opened,
		jobs: opened.jobs,
		faux,
		dir,
		setNow: (ms) => {
			clock = ms;
		},
		now: () => clock,
		close: async () => {
			await opened.harness.close(BACKGROUND_CONTEXT);
		},
	};
	cleanups.push(rig.close);
	return rig;
}

/** Reboot the same directory: close, then boot again (new harness). */
async function reboot(
	rig: TestRig,
	options?: {
		readonly settings?: Record<string, unknown>;
		readonly extensions?: readonly string[];
	},
): Promise<TestRig> {
	await rig.close();
	return bootRig({
		dir: rig.dir,
		...(options?.settings === undefined
			? {}
			: { settings: options.settings }),
		...(options?.extensions === undefined
			? {}
			: { extensions: options.extensions }),
	});
}

type LiveTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/**
 * Live (non-terminal) schedule tasks, optionally for one job id. A task
 * with `abortRequested` is already aborted — `abortTask` returns
 * "marked" and completes asynchronously — so it is not a live executor.
 */
async function liveScheduleTasks(
	rig: TestRig,
	jobId?: string,
): Promise<LiveTask[]> {
	const out: LiveTask[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await rig.opened.storage.scanTasks(
			{ kind: "sigrun.schedule" },
			500,
			cursor,
			BACKGROUND_CONTEXT,
		);
		for (const record of page.items) {
			if (
				record.state.status === "terminal" ||
				record.state.status === "completing"
			) {
				continue;
			}
			if (record.abortRequested === true) continue;
			if (
				jobId !== undefined &&
				(record.input as { jobId?: string } | undefined)?.jobId !== jobId
			) {
				continue;
			}
			out.push(record);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	return out;
}

/** Whether a task id is terminal (aborted, completed, …), polled to the bound. */
async function waitTerminal(
	rig: TestRig,
	taskId: TaskId<unknown>,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = await rig.opened.harness.getTask(
			taskId as never,
			BACKGROUND_CONTEXT,
		);
		if (
			record === undefined ||
			record.state.status === "terminal" ||
			record.state.status === "completing"
		) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`task ${String(taskId)} never settled (state=${JSON.stringify(record?.state)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Whether a task id is terminal right now (no wait). */
async function isTerminal(
	rig: TestRig,
	taskId: TaskId<unknown>,
): Promise<boolean> {
	const record = await rig.opened.harness.getTask(
		taskId as never,
		BACKGROUND_CONTEXT,
	);
	return (
		record === undefined ||
		record.state.status === "terminal" ||
		record.state.status === "completing"
	);
}

/** Poll until no live schedule tasks remain for `jobId` (abort handlers settle asynchronously). */
async function waitNoLiveTasks(
	rig: TestRig,
	jobId: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await liveScheduleTasks(rig, jobId)).length === 0) return;
		if (Date.now() > deadline) {
			throw new Error(`live schedule tasks for ${jobId} never drained`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

// ─── Stage 1: sources and reconciliation ───────────────────────────────────

describe("file jobs — declared in settings.json", () => {
	test("boot with a file job → one record (source file) and one live task", async () => {
		const rig = await bootRig({
			settings: { jobs: [tickSpec()] },
		});
		const id = "file:tick";
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record).toBeDefined();
		expect(record!.source).toBe("file");
		expect(record!.enabled).toBe(true);
		expect(record!.version).toBe(1);
		expect(record!.hash).toBe(specHash(id, tickSpec()));
		const live = await liveScheduleTasks(rig, id);
		expect(live).toHaveLength(1);
		expect(live[0]!.input).toMatchObject({ jobId: id, hash: record!.hash });
		expect(await rig.jobs.list()).toMatchObject([{ id, source: "file" }]);
	});

	test("reboot unchanged → still one record, the same task id, no new revision", async () => {
		const rig = await bootRig({
			settings: { jobs: [tickSpec()] },
		});
		const id = "file:tick";
		const before = (await liveScheduleTasks(rig, id))[0]!;
		const next = await reboot(rig, { settings: { jobs: [tickSpec()] } });
		const record = await readJob(next.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record!.version).toBe(1);
		const live = await liveScheduleTasks(next, id);
		expect(live).toHaveLength(1);
		expect(String(live[0]!.id)).toBe(String(before.id));
		// An unchanged declaration writes nothing: no extra revision.
		const revisions = await next.jobs.revisions(id);
		expect(revisions).toHaveLength(1);
	});

	test("changing the prompt → v2 revision changedBy file, old task aborted, new task, lastRun preserved", async () => {
		const rig = await bootRig({
			settings: { jobs: [tickSpec()] },
		});
		const id = "file:tick";
		const oldTask = (await liveScheduleTasks(rig, id))[0]!;
		// A prior run's lastRun, to prove reconciliation preserves it.
		await patchJob(rig.opened.harness, id, (draft) => {
			draft.lastRun = {
				jobId: id,
				version: 1,
				fireAt: new Date(T0).toISOString(),
				manual: false,
				outcome: "succeeded",
				startedAt: new Date(T0).toISOString(),
				settledAt: new Date(T0).toISOString(),
			};
		}, BACKGROUND_CONTEXT);
		const changed = tickSpec({ action: { kind: "prompt", prompt: "say tock", conversation: "new" } });
		const next = await reboot(rig, { settings: { jobs: [changed] } });
		const record = await readJob(next.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record!.version).toBe(2);
		expect(record!.hash).toBe(specHash(id, changed));
		expect(record!.lastRun).toMatchObject({ outcome: "succeeded" });
		const revisions = await next.jobs.revisions(id);
		expect(revisions[0]!.version).toBe(2);
		expect(revisions[0]!.changedBy).toBe("file");
		// The old task is aborted (terminal); a NEW live task carries the
		// new hash.
		await waitTerminal(next, oldTask.id);
		const live = await liveScheduleTasks(next, id);
		expect(live).toHaveLength(1);
		expect(String(live[0]!.id)).not.toBe(String(oldTask.id));
		expect(live[0]!.input).toMatchObject({ hash: record!.hash });
	});

	test("the next run's record carries version 2", async () => {
		const rig = await bootRig({
			settings: { jobs: [tickSpec()] },
			responses: [fauxAssistantMessage("tock")],
		});
		const id = "file:tick";
		const changed = tickSpec({ action: { kind: "prompt", prompt: "say tock", conversation: "new" } });
		const next = await reboot(rig, { settings: { jobs: [changed] } });
		const fired = await next.jobs.runNow(id);
		expect(fired.outcome).toBe("running");
		const runs = await next.jobs.runs(id, 20);
		expect(runs[0]!.version).toBe(2);
	});

	test("removing the declaration → record retired, task aborted", async () => {
		const rig = await bootRig({
			settings: { jobs: [tickSpec()] },
		});
		const id = "file:tick";
		const oldTask = (await liveScheduleTasks(rig, id))[0]!;
		const next = await reboot(rig, { settings: {} });
		expect(await readJob(next.opened.harness, id, BACKGROUND_CONTEXT)).toBeUndefined();
		await waitNoLiveTasks(next, id);
		await waitTerminal(next, oldTask.id);
	});
});

describe("extension jobs — declared by a factory result", () => {
	test("the fixture-jobs declaration → ext records and live tasks", async () => {
		const rig = await bootRig({
			extensions: [FIXTURE_JOBS_SPECIFIER],
		});
		const id = "ext:fixture-jobs:tick";
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record).toBeDefined();
		expect(record!.source).toBe("extension");
		expect((await rig.jobs.list()).map((job) => job.id)).toContain(id);
		const live = await liveScheduleTasks(rig, id);
		expect(live).toHaveLength(1);
		// The tasked job reconciles too.
		expect(await liveScheduleTasks(rig, "ext:fixture-jobs:tasked")).toHaveLength(1);
	});

	test("the fixture unloaded on reboot → records retired, tasks aborted", async () => {
		const rig = await bootRig({
			extensions: [FIXTURE_JOBS_SPECIFIER],
		});
		const id = "ext:fixture-jobs:tick";
		const oldTask = (await liveScheduleTasks(rig, id))[0]!;
		const next = await reboot(rig, { extensions: [] });
		expect(await readJob(next.opened.harness, id, BACKGROUND_CONTEXT)).toBeUndefined();
		await waitNoLiveTasks(next, id);
		await waitTerminal(next, oldTask.id);
	});
});

describe("api jobs — the JobsService surface", () => {
	test("createApi → a record and a live task", async () => {
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		expect(job.source).toBe("api");
		expect(job.id).toMatch(/^api:/);
		expect(job.owner).toBe("alice");
		const record = await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT);
		expect(record!.version).toBe(1);
		const live = await liveScheduleTasks(rig, job.id);
		expect(live).toHaveLength(1);
	});

	test("updateApi({enabled:false}) → task aborted, record persists disabled, still listed", async () => {
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		const disabled = await rig.jobs.updateApi(job.id, { enabled: false }, "alice");
		expect(disabled.enabled).toBe(false);
		expect(disabled.state).toBe("disabled");
		const live = await liveScheduleTasks(rig, job.id);
		expect(live).toHaveLength(0);
		const listed = await rig.jobs.list();
		expect(listed.map((one) => one.id)).toContain(job.id);
		// runNow on a disabled job is blocked.
		const fired = await rig.jobs.runNow(job.id);
		expect(fired.outcome).toBe("blocked");
	});

	test("re-enabling → a new task", async () => {
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		await rig.jobs.updateApi(job.id, { enabled: false }, "alice");
		const enabled = await rig.jobs.updateApi(job.id, { enabled: true }, "alice");
		expect(enabled.enabled).toBe(true);
		const live = await liveScheduleTasks(rig, job.id);
		expect(live).toHaveLength(1);
	});

	test("updateApi on a file: id → JobDeclaredError", async () => {
		const rig = await bootRig({ settings: { jobs: [tickSpec()] } });
		await expect(
			rig.jobs.updateApi("file:tick", { enabled: false }, "alice"),
		).rejects.toBeInstanceOf(JobDeclaredError);
	});

	test("deleteApi → final disabled revision, record retired, task aborted", async () => {
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		await rig.jobs.deleteApi(job.id, "alice");
		expect(await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await liveScheduleTasks(rig, job.id)).toHaveLength(0);
		// The final revision is enabled:false; runs/revisions still answer.
		const revisions = await rig.jobs.revisions(job.id);
		expect(revisions[0]!.enabled).toBe(false);
	});

	test("disable then immediately re-enable → exactly one live executor with the record's hash", async () => {
		// Review Focus 3: no awaits between the two updateApi calls other
		// than the calls themselves — the abort from the disable must not
		// leave the job executor-less, and the abort-marked old task must
		// not be counted as live by the re-enable's reconciliation.
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		const disabled = await rig.jobs.updateApi(job.id, { enabled: false }, "alice");
		expect(disabled.enabled).toBe(false);
		const enabled = await rig.jobs.updateApi(job.id, { enabled: true }, "alice");
		expect(enabled.enabled).toBe(true);
		const record = await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT);
		// Exactly one schedule task for the job is a real live executor:
		// not abort-marked and not terminal.
		const live = await liveScheduleTasks(rig, job.id);
		expect(live).toHaveLength(1);
		expect((live[0]!.input as { hash?: unknown }).hash).toBe(record!.hash);
		// The job must not be left without an executor: the record's state
		// is waiting, not disabled.
		expect(record!.state).toBe("waiting");
	});

	test("an abort-marked, not-yet-terminal task is not live in reconcile's scan", async () => {
		// The direct check of the finding: after deleteApi, before the
		// abort settles, liveScheduleTasksByJob must not return the
		// abort-marked task (abortTask returns "marked" and completes
		// asynchronously).
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		const oldTask = (await liveScheduleTasks(rig, job.id))[0]!;
		await rig.opened.harness.abortTask(oldTask.id as never, BACKGROUND_CONTEXT);
		// The abort is MARKED but not yet settled: the scan must not see it.
		const marked = await rig.opened.harness.getTask(
			oldTask.id as never,
			BACKGROUND_CONTEXT,
		);
		expect(marked!.abortRequested).toBe(true);
		expect(marked!.state.status).not.toBe("terminal");
		const byJob = await liveScheduleTasksByJob(
			rig.opened.storage,
			BACKGROUND_CONTEXT,
		);
		expect(byJob.get(job.id) ?? []).toHaveLength(0);
		await waitTerminal(rig, oldTask.id);
	});

	test("reconcile creates the replacement executor while the old task's abort is still pending", async () => {
		// The end-to-end consequence: a reconcile pass run while an abort
		// is pending (not yet terminal) must create the replacement task —
		// the job is never executor-less — and the pending abort must not
		// be treated as the executor.
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		const oldTask = (await liveScheduleTasks(rig, job.id))[0]!;
		await rig.opened.harness.abortTask(oldTask.id as never, BACKGROUND_CONTEXT);
		// Reconcile with the abort pending (marked, not terminal).
		await rig.jobs.reconcile();
		const live = await liveScheduleTasks(rig, job.id);
		expect(live).toHaveLength(1);
		expect(String(live[0]!.id)).not.toBe(String(oldTask.id));
		const record = await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT);
		expect((live[0]!.input as { hash?: unknown }).hash).toBe(record!.hash);
		await waitTerminal(rig, oldTask.id);
	});
});

describe("history — revisions and versions", () => {
	test("updateApi writes a revision; revisions() is newest-first", async () => {
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		const changed = tickSpec({ action: { kind: "prompt", prompt: "say tock", conversation: "new" } });
		await rig.jobs.updateApi(job.id, { action: changed.action }, "alice");
		const revisions = await rig.jobs.revisions(job.id);
		expect(revisions).toHaveLength(2);
		expect(revisions[0]!.version).toBe(2);
		expect(revisions[0]!.changedBy).toBe("alice");
		expect(revisions[1]!.version).toBe(1);
	});

	test("disable and enable each bump the version", async () => {
		const rig = await bootRig({});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		await rig.jobs.updateApi(job.id, { enabled: false }, "alice");
		await rig.jobs.updateApi(job.id, { enabled: true }, "alice");
		const record = await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT);
		expect(record!.version).toBe(3);
		expect((await rig.jobs.revisions(job.id))).toHaveLength(3);
	});
});

describe("listing — records only, never tasks", () => {
	test("a terminal schedule task with no record never appears", async () => {
		const rig = await bootRig({
			settings: { jobs: [tickSpec()] },
		});
		const id = "file:tick";
		// A schedule task for a job that has no record: its first phase
		// reads the absent record (the stale-executor rule) and commits
		// terminal. It must never appear in the listing.
		const ghost = "file:ghost";
		const root = await rig.opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: rig.opened.defaultModel },
		});
		const ghostTaskId = await rig.opened.harness.commit(
			async (tx) =>
				await tx.createTask(
					createScheduleTask({
						harness: rig.opened.harness,
						storage: rig.opened.storage,
						registry: rig.opened.registry,
						models: rig.opened.models,
						defaultModel: rig.opened.defaultModel,
						now: rig.now,
						defaultTz: "UTC",
					}),
					{ jobId: ghost, hash: "no-record" },
					{
						ownership: { kind: "conversation" },
						conversationId: root.id as never,
						background: true,
					},
				),
			BACKGROUND_CONTEXT,
		);
		// The ghost task's first phase reads the absent record and commits
		// terminal — bounded wait.
		const deadline = Date.now() + 5_000;
		for (;;) {
			const record = await rig.opened.harness.getTask(
				ghostTaskId as never,
				BACKGROUND_CONTEXT,
			);
			if (
				record !== undefined &&
				(record.state.status === "terminal" ||
					record.state.status === "completing")
			) {
				break;
			}
			if (Date.now() > deadline) {
				throw new Error("ghost task never settled");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const listed = await rig.jobs.list();
		expect(listed.map((job) => job.id)).not.toContain(ghost);
		expect(listed.map((job) => job.id)).toContain(id);
	});
});

// ─── Stage 2: the run-status observers ─────────────────────────────────────

describe("the runSettled observer — prompt runs", () => {
	test("a cron run answering → lastRun.outcome succeeded with settledAt", async () => {
		const rig = await bootRig({
			responses: [fauxAssistantMessage("tick answer")],
		});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		const fired = await rig.jobs.runNow(job.id);
		expect(fired.outcome).toBe("running");
		// Let the run settle and the observer deliver.
		await rig.opened.harness.waitForIdle(BACKGROUND_CONTEXT);
		await rig.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		const record = await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT);
		expect(record!.lastRun).toBeDefined();
		expect(record!.lastRun!.outcome).toBe("succeeded");
		expect(record!.lastRun!.settledAt).toBeDefined();
		expect(record!.lastRun!.conversationId).toBe(fired.conversationId);
		const runs = await rig.jobs.runs(job.id, 20);
		expect(runs[0]!.outcome).toBe("succeeded");
		expect(runs[0]!.settledAt).toBeDefined();
	});

	test("a faux error turn → failed with the error", async () => {
		const rig = await bootRig({
			responses: [
				fauxAssistantMessage("boom", {
					stopReason: "error",
					errorMessage: "faux provider failure",
				}),
			],
		});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		await rig.jobs.runNow(job.id);
		await rig.opened.harness.waitForIdle(BACKGROUND_CONTEXT);
		await rig.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		const record = await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT);
		expect(record!.lastRun!.outcome).toBe("failed");
		expect(record!.lastRun!.error).toBeDefined();
	});
});

describe("the taskSettled observer — task-action runs", () => {
	test("a fixture task completing → its run record becomes succeeded", async () => {
		const fixture = await (await import(FIXTURE_JOBS_SPECIFIER)) as {
			resetFixtureJobs: () => void;
		};
		fixture.resetFixtureJobs();
		const rig = await bootRig({ extensions: [FIXTURE_JOBS_SPECIFIER] });
		const id = "ext:fixture-jobs:tasked";
		const fired = await rig.jobs.runNow(id);
		expect(fired.outcome).toBe("running");
		// The child task runs to terminal; the observer settles the run.
		const deadline = Date.now() + 10_000;
		for (;;) {
			const runs = await rig.jobs.runs(id, 20);
			if (runs[0]?.outcome === "succeeded") break;
			if (Date.now() > deadline) throw new Error("task run never settled succeeded");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record!.lastRun!.outcome).toBe("succeeded");
	});

	test("a fixture task throwing → failed with the error", async () => {
		const fixture = await (await import(FIXTURE_JOBS_SPECIFIER)) as {
			resetFixtureJobs: () => void;
			controls: { boom: boolean };
		};
		fixture.resetFixtureJobs();
		fixture.controls.boom = true;
		const rig = await bootRig({ extensions: [FIXTURE_JOBS_SPECIFIER] });
		const id = "ext:fixture-jobs:tasked";
		const fired = await rig.jobs.runNow(id);
		expect(fired.outcome).toBe("running");
		const deadline = Date.now() + 10_000;
		for (;;) {
			const runs = await rig.jobs.runs(id, 20);
			if (runs[0]?.outcome === "failed") break;
			if (Date.now() > deadline) throw new Error("task run never settled failed");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const runs = await rig.jobs.runs(id, 20);
		expect(runs[0]!.error).toBeDefined();
		fixture.controls.boom = false;
		fixture.resetFixtureJobs();
	});
});

// ─── Stage 2: ownership transfer ───────────────────────────────────────────

describe("the jobs ownership participant", () => {
	test("transferOwnership(bob → alice) rewrites the record, bumps version, recreates the task", async () => {
		const { createServer } = await import("../src/server/index.js");
		const rig = await bootRig({});
		// Seed bob (the job owner, deletable) and alice (the transferee,
		// admin — she performs the delete).
		await rig.opened.identity.users.add({
			user: "bob",
			admin: false,
			source: "cli",
		});
		await rig.opened.identity.users.add({
			user: "alice",
			admin: true,
			source: "cli",
		});
		const job = await rig.jobs.createApi(tickSpec(), "bob");
		const oldTask = (await liveScheduleTasks(rig, job.id))[0]!;
		const app = await createServer(rig.opened, loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(rig.dir, "sigrun.db"),
			SIGRUN_AUTH: "token",
			SIGRUN_WORKSPACE_PATH: rig.dir,
		}), [], { listenHost: "127.0.0.1" });
		try {
			const { token } = await rig.opened.identity.tokens.create("test", "alice");
			const response = await app.inject({
				method: "DELETE",
				url: `/v1/users/bob?transferTo=alice`,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.statusCode).toBe(204);
		} finally {
			await app.close();
		}
		const record = await readJob(rig.opened.harness, job.id, BACKGROUND_CONTEXT);
		expect(record!.owner).toBe("alice");
		expect(record!.version).toBe(2);
		const revisions = await rig.jobs.revisions(job.id);
		expect(revisions[0]!.changedBy).toBe("transfer");
		// The new hash → a NEW task; the old one aborted.
		await waitTerminal(rig, oldTask.id);
		const live = await liveScheduleTasks(rig, job.id);
		expect(live).toHaveLength(1);
		expect(String(live[0]!.id)).not.toBe(String(oldTask.id));
	});
});

// ─── Stage 2: retention ────────────────────────────────────────────────────

describe("jobHistory retention", () => {
	test("runs capped at jobHistory.runs; revisions at jobHistory.revisions plus referenced", async () => {
		const rig = await bootRig({
			responses: Array.from({ length: 8 }, () => fauxAssistantMessage("tick")),
			settings: { jobHistory: { runs: 3, revisions: 2 } },
		});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		// 4 settled runs (the clock advances per fire — distinct manual
		// fire keys, one run record each).
		for (let index = 0; index < 4; index++) {
			rig.setNow(T0 + (index + 1) * 60_000);
			await rig.jobs.runNow(job.id);
			await rig.opened.harness.waitForIdle(BACKGROUND_CONTEXT);
			await rig.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		}
		const runs = await rig.jobs.runs(job.id, 100);
		expect(runs).toHaveLength(3);
		// 3 edits → versions 1..4; revisions keep the newest 2 plus any a
		// retained run references.
		for (let index = 0; index < 3; index++) {
			await rig.jobs.updateApi(
				job.id,
				{ action: { kind: "prompt", prompt: `v${index + 2}`, conversation: "new" } },
				"alice",
			);
		}
		const revisions = await rig.jobs.revisions(job.id);
		expect(revisions.length).toBeLessThanOrEqual(4);
		expect(revisions[0]!.version).toBe(4);
		const retained = new Set(runs.map((run) => run.version));
		for (const revision of revisions) {
			// A revision beyond the limit survives ONLY when referenced.
			if (!retained.has(revision.version)) {
				expect(revisions.indexOf(revision)).toBeLessThan(2);
			}
		}
	});
});

// ─── Fix round 1: the aborted-task error text ──────────────────────────────

describe("an aborted task-action run settles failed WITH the error text", () => {
	test("aborting the live child task → failed with the abort reason", async () => {
		const fixture = (await import(FIXTURE_JOBS_SPECIFIER)) as {
			resetFixtureJobs: () => void;
			controls: { boom: boolean; hangTask: boolean };
		};
		fixture.resetFixtureJobs();
		// Park the fixture task mid-run so the abort has a live task to
		// signal: the fixture's abort handler commits terminal (aborted,
		// reason "aborted"), the taskSettled reduction carries the reason
		// (the fix: the aborted shape has `reason`, not `error`), and the
		// observer settles the run failed WITH the text.
		fixture.controls.hangTask = true;
		const rig = await bootRig({ extensions: [FIXTURE_JOBS_SPECIFIER] });
		const id = "ext:fixture-jobs:tasked";
		const fired = await rig.jobs.runNow(id);
		expect(fired.outcome).toBe("running");
		// The run record carries the child task id.
		const deadline = Date.now() + 5_000;
		let taskId: number | undefined;
		for (;;) {
			const runs = await rig.jobs.runs(id, 20);
			taskId = runs[0]?.taskId;
			if (taskId !== undefined) break;
			if (Date.now() > deadline) throw new Error("run record never carried the task id");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await rig.opened.harness.abortTask(taskId as never, BACKGROUND_CONTEXT);
		const settleDeadline = Date.now() + 10_000;
		for (;;) {
			const runsNow = await rig.jobs.runs(id, 20);
			if (runsNow[0]?.outcome === "failed") break;
			if (Date.now() > settleDeadline) {
				throw new Error("aborted task run never settled failed");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const settled = (await rig.jobs.runs(id, 20))[0]!;
		expect(settled.outcome).toBe("failed");
		expect(settled.error).toBe("aborted");
		fixture.resetFixtureJobs();
	});
});

// ─── Stage 2: fire re-entry semantics (the Task-2 deferred fix) ────────────

describe("fireJob re-entry on a settled run record", () => {
	test("a re-entered fire whose run settled returns blocked, not running", async () => {
		const rig = await bootRig({
			responses: [fauxAssistantMessage("tick")],
		});
		const job = await rig.jobs.createApi(tickSpec(), "alice");
		await rig.jobs.runNow(job.id);
		await rig.opened.harness.waitForIdle(BACKGROUND_CONTEXT);
		await rig.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		const runs = await rig.jobs.runs(job.id, 20);
		expect(runs[0]!.outcome).toBe("succeeded");
		// Re-fire the SAME key (a crash-recovered schedule task re-entering
		// after the observer settled): the settled record must not read as
		// "running" — the fire reports its terminal state.
		const now = Date.parse(runs[0]!.startedAt);
		const reentered = await rig.jobs.runNow(job.id);
		void now;
		// The re-entry uses a NEW manual key (fresh now), so exercise the
		// exact path: call fireJob directly with the settled record's key.
		const { fireJob } = await import("../src/jobs/fire.js");
		const settledKey = runs[0]!.manual
			? `${job.id}:manual:${Date.parse(runs[0]!.startedAt)}`
			: `${job.id}:${Date.parse(runs[0]!.fireAt)}`;
		const outcome = await fireJob(
			{
				harness: rig.opened.harness,
				storage: rig.opened.storage,
				registry: rig.opened.registry,
				models: rig.opened.models,
				defaultModel: rig.opened.defaultModel,
				now: rig.now,
				defaultTz: "UTC",
			},
			job.id,
			settledKey,
			Date.parse(runs[0]!.fireAt),
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("blocked");
		expect(outcome.conversationId).toBe(runs[0]!.conversationId);
		void reentered;
	});
});
