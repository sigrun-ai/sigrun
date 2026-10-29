/**
 * Jobs Task 2 (spec §8.1) on pi-durable 1.4.0: the schedule task and
 * `fireJob`, in-process on the FAKE harness clock (Task B1 Step 2).
 *
 * In 1.4.0 the `waiting` phase ends with a durable
 * `runtime.sleepUntil(nextAt, {phase:"due", nextAt})`: the task holds no
 * invocation while asleep, and the scheduler wakes it from ONE foreground
 * timer armed for `until - now`. Moving an injected `now` forward does
 * NOT fire a real timer, so these tests drive BOTH `HarnessOptions.now`
 * and `HarnessOptions.setTimer` from `createFakeClock`; `advance(ms)`
 * fires the due timers and the `due` phase runs.
 *
 * Covered (B1 Step 2):
 * - `waiting` commits a sleep and ends the phase (inspect: `sleeping`,
 *   `until === firstAt`, no running invocation);
 * - the sleep survives a close/reopen, and firing happens after
 *   `advance` past `until`;
 * - abort while sleeping (until 3 days out) settles `aborted` with NO
 *   advance (Review Focus 1);
 * - a missed slot while down: `catchUp:"once"` fires once; `catchUp:
 *   "none"` past the 60s grace records one `skipped` run and computes
 *   the next slot from NOW (Review Focus 2);
 * - a version-1 `waiting` checkpoint written by pi-durable 1.3.0 (the
 *   Step 0b fixture) migrates on open, sleeps, and fires after advance;
 * - `afterFailedRun` stays `keep` (the spec's non-goal pin).
 *
 * Plus the pre-existing `fireJob` behaviour (overlap skip, blocked
 * fires, cron meta, deliver targets, prompt expansion), unchanged.
 */

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineTask,
	type ModelRef,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	JobDoc,
	JobRunDoc,
	listRuns,
	patchJob,
	readJob,
	writeJobChange,
} from "../src/jobs/docs.js";
import { fireJob, type JobRuntimeDeps } from "../src/jobs/fire.js";
import { specHash } from "../src/jobs/spec.js";
import {
	createScheduleTask,
	type ScheduleInput,
	type ScheduleState,
} from "../src/jobs/task.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { createFakeClock, type FakeClock } from "./helpers/fake-clock.js";
import { seededIdentity } from "./helpers/identity.js";
import type { IdentityStores } from "../src/harness/identity/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

const T0 = Date.parse("2026-10-19T12:00:00.000Z");
const FIXTURE_DB = join(
	import.meta.dirname,
	"fixtures",
	"durable-v1",
	"sigrun.db",
);

/** One hermetic harness on the fake clock with the schedule task registered. */
interface TestRig {
	opened: OpenedHarness;
	faux: FauxProviderHandle;
	deps: JobRuntimeDeps;
	clock: FakeClock;
	dir: string;
	config: SigrunConfig;
	identity: IdentityStores;
	contributor: ProviderContributor;
	responses: readonly ReturnType<typeof fauxAssistantMessage>[];
	rootId: number;
	/** Close the harness (idempotent); the storage stays on disk. */
	close(): Promise<void>;
	/** Reopen on the SAME storage + clock; a fresh harness over the old data. */
	reopen(): Promise<void>;
	/** Current fake time in epoch ms. */
	now(): number;
}

/**
 * Wait for async task/observer commits by stepping the fake clock. The
 * zero-time flush also drains non-timer work; the small advance prevents
 * a wedged condition from spinning forever without letting a timer fire.
 */
async function until<T>(
	clock: FakeClock,
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	description: string,
): Promise<T> {
	for (;;) {
		const value = await read();
		if (predicate(value)) return value;
		await clock.flush();
		const settled = await read();
		if (predicate(settled)) return settled;
		await clock.advance(1);
	}
}

async function bootRig(options?: {
	readonly responses?: readonly ReturnType<typeof fauxAssistantMessage>[];
	readonly startNow?: number;
	readonly storagePath?: string;
	readonly dir?: string;
	readonly createRoot?: boolean;
}): Promise<TestRig> {
	const dir = options?.dir ?? (await mkdtemp(join(tmpdir(), "sigrun-jobs-task-")));
	const responses = options?.responses ?? [];
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...responses]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: options?.storagePath ?? join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const clock = createFakeClock(options?.startNow ?? T0);
	const identity = await seededIdentity(dir);

	const rig = {
		faux,
		clock,
		dir,
		config,
		identity,
		contributor,
		responses,
	} as TestRig & { closed: boolean };

	const open = async (createRoot: boolean): Promise<void> => {
		const opened = await openHarness(config, {
			identity,
			extensions: [contributor],
			env: {},
			settingsDir: dir,
			// BOTH seams come from the one fake clock: a sleeping task wakes
			// from a foreground timer, so `now` alone cannot wake it.
			now: clock.now,
			setTimer: clock.setTimer,
		});
		rig.opened = opened;
		const defaultModel: ModelRef = opened.defaultModel;
		rig.deps = {
			harness: opened.harness,
			storage: opened.storage,
			registry: opened.registry,
			models: opened.models as Models,
			defaultModel,
			now: () => clock.nowMs(),
			defaultTz: "UTC",
			gatewayLoaded: false,
		};
		opened.registry.install({
			name: "sigrun.jobs",
			tasks: [createScheduleTask(rig.deps)],
		});
		if (createRoot) {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: defaultModel },
			});
			rig.rootId = root.id as number;
		}
	};

	rig.closed = false;
	rig.close = async () => {
		if (rig.closed) return;
		rig.closed = true;
		await rig.opened.harness.close(BACKGROUND_CONTEXT);
	};
	rig.reopen = async () => {
		faux.setResponses([...responses]);
		await open(false);
		rig.closed = false;
	};
	rig.now = () => clock.nowMs();
	await open(options?.createRoot ?? true);
	cleanups.push(async () => {
		await rig.close();
		if (options?.dir === undefined) {
			await rm(dir, { recursive: true, force: true });
		}
	});
	return rig;
}

/** The spec every test shares: a 60s-interval prompt job, conversation "new". */
function everyMinuteSpec(overrides?: Partial<JobSpec>): JobSpec {
	return {
		name: "tick",
		schedule: { every: "60s" },
		action: { kind: "prompt", prompt: "say tick", conversation: "new" },
		...overrides,
	};
}

/** Seed a job record via `writeJobChange` (the Task-3 write path). */
async function seedJob(
	rig: TestRig,
	id: string,
	spec: JobSpec,
	overrides?: { enabled?: boolean },
): Promise<{ hash: string }> {
	const hash = specHash(id, spec);
	const nowIso = new Date(rig.now()).toISOString();
	await rig.opened.harness.commit(async (tx) => {
		await writeJobChange(
			tx,
			id,
			{
				source: "api",
				spec,
				owner: "tester",
				enabled: overrides?.enabled ?? true,
				createdAt: nowIso,
				hash,
				state: "waiting",
			},
			"tester",
			nowIso,
		);
	}, BACKGROUND_CONTEXT);
	return { hash };
}

/** Create the schedule task for one seeded job, conversation-owned on root. */
async function createTask(
	rig: TestRig,
	id: string,
	hash: string,
	firstAt?: number,
): Promise<TaskId<void>> {
	return await rig.opened.harness.commit(
		async (tx) =>
			await tx.createTask(
				createScheduleTask(rig.deps),
				{ jobId: id, hash, ...(firstAt === undefined ? {} : { firstAt }) } satisfies ScheduleInput,
				{
					ownership: { kind: "conversation" },
					conversationId: rig.rootId as never,
					background: true,
				},
			),
		BACKGROUND_CONTEXT,
	);
}

/** Wait for a task's terminal state by stepping the fake clock. */
async function waitTerminal(
	rig: TestRig,
	taskId: TaskId<void>,
): Promise<TaskRecord<JsonValue, JsonValue, void>> {
	return await until(
		rig.clock,
		() => rig.opened.harness.getTask(taskId, BACKGROUND_CONTEXT),
		(record) =>
			record !== undefined &&
			(record.state.status === "terminal" || record.state.status === "completing"),
		`task ${String(taskId)} to settle`,
	) as TaskRecord<JsonValue, JsonValue, void>;
}

/** The task's `inspect()` entry (the live scheduler view). */
async function inspection(rig: TestRig, taskId: TaskId<void>) {
	const view = await rig.opened.harness.inspect(BACKGROUND_CONTEXT);
	return view.tasks.find((task) => String(task.record.id) === String(taskId));
}

/** Wait until the task is `sleeping` and return its `until`. */
async function waitSleeping(rig: TestRig, taskId: TaskId<void>): Promise<number> {
	const entry = await until(
		rig.clock,
		() => inspection(rig, taskId),
		(task) => task?.state.kind === "sleeping",
		`task ${String(taskId)} to sleep`,
	);
	if (entry?.state.kind !== "sleeping") throw new Error("unreachable");
	return entry.state.until;
}

// ─── The 1.4.0 durable-sleep schedule (B1 Step 2) ─────────────────────────

describe("the schedule task on durable sleeps", () => {
	test("waiting commits a sleep and ends the phase", async () => {
		const rig = await bootRig({});
		const id = "api:job-sleep";
		const { hash } = await seedJob(rig, id, everyMinuteSpec());
		const firstAt = rig.now() + 60_000;
		const taskId = await createTask(rig, id, hash, firstAt);

		const until_ = await waitSleeping(rig, taskId);
		expect(until_).toBe(firstAt);
		// No running invocation: the phase ENDED at sleepUntil.
		const entry = await inspection(rig, taskId);
		expect(entry?.state.kind).toBe("sleeping");
		// The job's status fields were patched BEFORE the sleep.
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record?.state).toBe("waiting");
		expect(record?.nextRun).toBe(new Date(firstAt).toISOString());
		// The checkpoint is the durable `due` continuation.
		const taskRecord = await rig.opened.harness.getTask(taskId, BACKGROUND_CONTEXT);
		expect(taskRecord?.state.status).toBe("sleeping");
		const checkpoint = taskRecord?.state.checkpoint as ScheduleState | undefined;
		expect(checkpoint).toEqual({ phase: "due", nextAt: firstAt });
	});

	test("sleep survives reopen: advance past until fires one run", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("tick")] });
		const id = "api:job-reopen";
		const { hash } = await seedJob(rig, id, everyMinuteSpec());
		const firstAt = rig.now() + 60_000;
		const taskId = await createTask(rig, id, hash, firstAt);
		expect(await waitSleeping(rig, taskId)).toBe(firstAt);

		await rig.close();
		await rig.reopen();
		// The sleeping record is durable: it reappears without any advance.
		expect(await waitSleeping(rig, taskId)).toBe(firstAt);

		await rig.clock.advance(61_000);
		await until(
			rig.clock,
			() => readJob(rig.opened.harness, id, BACKGROUND_CONTEXT),
			(record) => record?.lastRun !== undefined,
			"the reopened job to fire",
		);
		const runs = await listRuns(rig.opened.storage, id, 10, BACKGROUND_CONTEXT);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.fireAt).toBe(new Date(firstAt).toISOString());
		expect(["running", "succeeded"]).toContain(runs[0]!.outcome);
	});

	test("abort while sleeping settles aborted with no advance", async () => {
		const rig = await bootRig({});
		const id = "api:job-abort-sleep";
		const { hash } = await seedJob(rig, id, everyMinuteSpec());
		const firstAt = rig.now() + 3 * 86_400_000; // three days out
		const taskId = await createTask(rig, id, hash, firstAt);
		expect(await waitSleeping(rig, taskId)).toBe(firstAt);

		// The disable path's signal: the record flips off and the task is
		// abort-marked. 1.4.0 makes an abort-requested sleeping task
		// schedulable, so the abort handler runs WITHOUT any advance.
		const nowIso = new Date(rig.now()).toISOString();
		await rig.opened.harness.commit(async (tx) => {
			await writeJobChange(
				tx,
				id,
				{
					source: "api",
					spec: everyMinuteSpec(),
					owner: "tester",
					enabled: false,
					createdAt: nowIso,
					hash,
					state: "disabled",
				},
				"tester",
				nowIso,
			);
		}, BACKGROUND_CONTEXT);
		await rig.opened.harness.abortTask(taskId, BACKGROUND_CONTEXT);
		const terminal = await waitTerminal(rig, taskId);
		expect(terminal.state.status).toBe("terminal");
		if (terminal.state.status === "terminal") {
			expect(terminal.state.outcome.status).toBe("aborted");
		}
	});

	test("missed slot while down, catchUp once: one fire", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("tick")] });
		const id = "api:job-catchup-once";
		const { hash } = await seedJob(rig, id, everyMinuteSpec());
		const firstAt = rig.now() + 60_000;
		const taskId = await createTask(rig, id, hash, firstAt);
		expect(await waitSleeping(rig, taskId)).toBe(firstAt);

		await rig.close();
		// Downtime: the clock moves three slots past the deadline.
		rig.clock.set(firstAt + 180_000);
		await rig.reopen();

		await until(
			rig.clock,
			() => readJob(rig.opened.harness, id, BACKGROUND_CONTEXT),
			(record) => record?.lastRun !== undefined,
			"the catch-up fire",
		);
		const runs = await listRuns(rig.opened.storage, id, 10, BACKGROUND_CONTEXT);
		expect(runs).toHaveLength(1);
		// Exactly ONE fire for the missed slot, never one per interval.
		expect(runs[0]!.fireAt).toBe(new Date(firstAt).toISOString());
		expect(["running", "succeeded"]).toContain(runs[0]!.outcome);
		// The next slot is computed from NOW (the reopened clock).
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		const nextRun = Date.parse(record!.nextRun!);
		expect(nextRun).toBeGreaterThan(rig.now());
		expect(nextRun).toBeLessThanOrEqual(rig.now() + 60_000);
	});

	test("missed slot while down, catchUp none past the grace: one skipped run, next from now", async () => {
		const rig = await bootRig({});
		const id = "api:job-catchup-none";
		const { hash } = await seedJob(
			rig,
			id,
			everyMinuteSpec({ catchUp: "none" }),
		);
		const firstAt = rig.now() + 60_000;
		const taskId = await createTask(rig, id, hash, firstAt);
		expect(await waitSleeping(rig, taskId)).toBe(firstAt);

		await rig.close();
		// >60 000 ms late: the slot is skipped, not fired.
		rig.clock.set(firstAt + 90_000);
		await rig.reopen();

		await until(
			rig.clock,
			() => readJob(rig.opened.harness, id, BACKGROUND_CONTEXT),
			(record) => record?.lastRun !== undefined,
			"the skipped run",
		);
		const runs = await listRuns(rig.opened.storage, id, 10, BACKGROUND_CONTEXT);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.outcome).toBe("skipped");
		expect(runs[0]!.fireAt).toBe(new Date(firstAt).toISOString());
		expect(runs[0]!.settledAt).toBeDefined();
		// No conversation was created for a skipped run.
		expect(runs[0]!.conversationId).toBeUndefined();
		// The next slot comes from NOW.
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		const nextRun = Date.parse(record!.nextRun!);
		expect(nextRun).toBeGreaterThan(rig.now());
		expect(nextRun).toBeLessThanOrEqual(rig.now() + 60_000);
		// And the task is sleeping for that next slot.
		expect(await waitSleeping(rig, taskId)).toBe(nextRun);
	});

	test("version-1 waiting checkpoint resumes: the 1.3.0 fixture migrates, sleeps, and fires", async () => {
		// The Step 0b fixture (written by pi-durable 1.3.0): conversation 1
		// with an answered turn, job "api:fixture-job" mid-`waiting` with
		// nextAt = T0 + 1 day, SessionMeta deltas.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-fixture-resume-"));
		const storagePath = join(dir, "sigrun.db");
		await cp(FIXTURE_DB, storagePath);
		const rig = await bootRig({
			dir,
			storagePath,
			createRoot: false,
			responses: [fauxAssistantMessage("fixture tick")],
		});
		cleanups.push(() => rm(dir, { recursive: true, force: true }));

		// The job's task (id 15 in the fixture) migrates on open: the
		// running 1.3.0 record re-enters `waiting` and commits a durable
		// sleep for its stored nextAt.
		const taskId = 15 as unknown as TaskId<void>;
		const firstAt = T0 + 86_400_000;
		expect(await waitSleeping(rig, taskId)).toBe(firstAt);
		// The answered turn and the meta doc survived the migration.
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			1 as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.pinned).toBe(true);
		expect(meta?.tagged).toEqual(["fixture"]);

		await rig.clock.advance(86_400_000 + 1_000);
		const id = "api:fixture-job";
		await until(
			rig.clock,
			() => readJob(rig.opened.harness, id, BACKGROUND_CONTEXT),
			(record) => record?.lastRun !== undefined,
			"the fixture job to fire",
		);
		const runs = await listRuns(rig.opened.storage, id, 10, BACKGROUND_CONTEXT);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.fireAt).toBe(new Date(firstAt).toISOString());
	});

	test("retry clears restart_limit when the schedule waits again", async () => {
		const rig = await bootRig({});
		const id = "api:job-retry-reason";
		const { hash } = await seedJob(rig, id, everyMinuteSpec());
		const firstAt = rig.now() + 60_000;
		const taskId = await createTask(rig, id, hash, firstAt);
		expect(await waitSleeping(rig, taskId)).toBe(firstAt);
		await rig.close();
		await rig.reopen();

		// B5 parks the durable task and stamps the owning job on reopen.
		// Seed that exact recovery surface, then retry the real task.
		await patchJob(
			rig.opened.harness,
			id,
			(draft) => {
				draft.state = "blocked";
				draft.reason = "restart_limit";
			},
			BACKGROUND_CONTEXT,
		);
		await rig.opened.harness.retryTask(taskId, BACKGROUND_CONTEXT);
		const record = await until(
			rig.clock,
			() => readJob(rig.opened.harness, id, BACKGROUND_CONTEXT),
			(job) => job?.state === "waiting",
			"the retried job to wait again",
		);
		expect(record?.state).toBe("waiting");
		expect(record).not.toHaveProperty("reason");
	});

	test("afterFailedRun stays keep", async () => {
		const rig = await bootRig({});
		// The harness's RESOLVED settings, read through a probe task's
		// runtime (the only public accessor of the resolved object).
		const probe = defineTask<Record<string, never>, { phase: "read" }, string, object>({
			name: "sigrun.test.settings-probe",
			version: 1,
			initial: () => ({ phase: "read" }),
			phases: {
				read: async (_task, runtime, context) => {
					const value = runtime.settings.afterFailedRun;
					await runtime.commit(
						() => ({
							status: "terminal" as const,
							outcome: { status: "completed" as const, result: value },
						}),
						context,
					);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({
						status: "terminal" as const,
						outcome: { status: "aborted" as const, reason: "probe aborted" },
					}),
					context,
				);
			},
		});
		rig.opened.registry.install({ name: "sigrun.test.probe", tasks: [probe] });
		const taskId = await rig.opened.harness.commit(
			async (tx) =>
				await tx.createTask(probe, {}, {
					ownership: { kind: "conversation" },
					conversationId: rig.rootId as never,
					background: true,
				}),
			BACKGROUND_CONTEXT,
		);
		const terminal = await until(
			rig.clock,
			() => rig.opened.harness.getTask(taskId, BACKGROUND_CONTEXT),
			(record) =>
				record !== undefined &&
				(record.state.status === "terminal" || record.state.status === "completing"),
			"the settings probe to settle",
		);
		if (terminal?.state.status === "terminal") {
			expect(terminal.state.outcome.status).toBe("completed");
			if (terminal.state.outcome.status === "completed") {
				expect(terminal.state.outcome.result).toBe("keep");
			}
		} else {
			throw new Error("probe task did not reach terminal");
		}
	});
});

// ─── The stale-executor rule (pre-existing, on the fake clock) ────────────

describe("the stale-executor rule", () => {
	test("a record with a changed hash commits the live task terminal", async () => {
		const rig = await bootRig({});
		const id = "api:job-stale";
		const spec = everyMinuteSpec();
		const { hash } = await seedJob(rig, id, spec);
		const taskId = await createTask(rig, id, hash, rig.now() + 60_000);
		await waitSleeping(rig, taskId);
		// Change the record under the live task: the hash it was created
		// with no longer matches (reconciliation would own a replacement).
		const nowIso = new Date(rig.now()).toISOString();
		await rig.opened.harness.commit(async (tx) => {
			await writeJobChange(
				tx,
				id,
				{
					source: "api",
					spec: everyMinuteSpec({ name: "tick-renamed" }),
					owner: "tester",
					enabled: true,
					createdAt: nowIso,
					hash: "different-hash",
					state: "waiting",
				},
				"tester",
				nowIso,
			);
		}, BACKGROUND_CONTEXT);
		// A sleeping task notices no record change by itself (no
		// wake-on-change): drive the abort path — `abortTask` makes the
		// sleeping task schedulable and its abort handler commits terminal.
		await rig.opened.harness.abortTask(taskId, BACKGROUND_CONTEXT);
		const terminal = await waitTerminal(rig, taskId);
		expect(
			terminal.state.status === "terminal" ||
				terminal.state.status === "completing",
		).toBe(true);
		// A fresh task created against the stale hash never fires: its
		// first phase reads the record, sees the mismatch, and commits
		// terminal WITHOUT creating a run.
		const freshId = await createTask(rig, id, hash, rig.now() - 1_000);
		const freshTerminal = await waitTerminal(rig, freshId);
		expect(
			freshTerminal.state.status === "terminal" ||
				freshTerminal.state.status === "completing",
		).toBe(true);
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record?.lastRun).toBeUndefined();
	});
});

// ─── fireJob behaviour (pre-existing, unchanged) ──────────────────────────

describe("fireJob", () => {
	test("fires an overdue every-job once and computes nextAt from now", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("tick")] });
		const id = "api:job-one";
		const spec = everyMinuteSpec();
		const { hash } = await seedJob(rig, id, spec);
		// Three slots in the past → catchUp "once": exactly one fire.
		const taskId = await createTask(rig, id, hash, T0 - 180_000);
		// The first waiting phase derives the overdue sleep (already due),
		// so the task fires without any clock advance.
		await until(
			rig.clock,
			() => readJob(rig.opened.harness, id, BACKGROUND_CONTEXT),
			(record) => record?.lastRun !== undefined,
			"the overdue fire",
		);
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record!.lastRun!.jobId).toBe(id);
		expect(record!.lastRun!.version).toBe(1);
		expect(record!.lastRun!.manual).toBe(false);
		expect(["running", "succeeded"]).toContain(record!.lastRun!.outcome);
		expect(record!.lastRun!.conversationId).toBeTypeOf("number");
		// The run conversation carries the cron meta.
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			record!.lastRun!.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.source).toBe("cron");
		expect(meta?.jobId).toBe(id);
		expect(meta?.owner).toBe("tester");
		// nextRun is computed from NOW, not from the missed slot.
		const nextRun = Date.parse(record!.nextRun!);
		expect(nextRun).toBeGreaterThan(rig.now());
		expect(nextRun).toBeLessThanOrEqual(rig.now() + 60_000);
		// The task is sleeping for that next slot.
		expect(await waitSleeping(rig, taskId)).toBe(nextRun);
		const runs = await listRuns(rig.opened.storage, id, 10, BACKGROUND_CONTEXT);
		expect(runs).toHaveLength(1);
	});

	test("overlap skip: a second fire while the last run is running returns skipped", async () => {
		const rig = await bootRig({});
		const id = "api:job-overlap";
		await seedJob(rig, id, everyMinuteSpec());
		const first = await fireJob(rig.deps, id, `${id}:1000`, 1000, BACKGROUND_CONTEXT);
		expect(first.outcome).toBe("running");
		const second = await fireJob(rig.deps, id, `${id}:2000`, 2000, BACKGROUND_CONTEXT);
		expect(second.outcome).toBe("skipped");
		expect(second.conversationId).toBeUndefined();
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record!.lastRun!.outcome).toBe("skipped");
		expect(record!.lastRun!.settledAt).toBeDefined();
		const skipped = await rig.opened.harness.snapshot(
			JobRunDoc,
			`${id}:2000`,
			BACKGROUND_CONTEXT,
		);
		expect(skipped?.outcome).toBe("skipped");
	});

	test("a registered task action clears a prior blocked reason", async () => {
		const rig = await bootRig({});
		const id = "api:job-task-recovery";
		const target = defineTask<
			Record<string, never>,
			{ phase: "wait" },
			void,
			object
		>({
			name: "sigrun.test.job-target",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime) =>
					await new Promise<void>((resolve) => {
						runtime.signal.addEventListener("abort", () => resolve(), { once: true });
					}),
			},
			abort: async () => {},
		});
		rig.opened.registry.install({
			name: "sigrun.test.job-target",
			tasks: [target],
		});
		await seedJob(
			rig,
			id,
			everyMinuteSpec({
				action: { kind: "task", task: "sigrun.test.job-target" },
			}),
		);
		await patchJob(
			rig.opened.harness,
			id,
			(draft) => {
				draft.state = "blocked";
				draft.reason = "restart_limit";
			},
			BACKGROUND_CONTEXT,
		);
		const outcome = await fireJob(
			rig.deps,
			id,
			`${id}:manual:1000`,
			rig.now(),
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("running");
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record?.state).toBe("waiting");
		expect(record).not.toHaveProperty("reason");
	});

	test("fireJob on an absent job record returns blocked", async () => {
		const rig = await bootRig({});
		const outcome = await fireJob(
			rig.deps,
			"api:missing",
			"api:missing:1000",
			1000,
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("blocked");
	});

	test("a disabled job's fire is blocked and writes no run", async () => {
		const rig = await bootRig({});
		const id = "api:job-disabled";
		await seedJob(rig, id, everyMinuteSpec(), { enabled: false });
		const outcome = await fireJob(rig.deps, id, `${id}:1000`, 1000, BACKGROUND_CONTEXT);
		expect(outcome.outcome).toBe("blocked");
		const run = await rig.opened.harness.snapshot(
			JobRunDoc,
			`${id}:1000`,
			BACKGROUND_CONTEXT,
		);
		expect(run).toBeUndefined();
	});

	test("the auto-namer does not name the cron conversation", async () => {
		const rig = await bootRig({
			responses: [
				fauxAssistantMessage("tick"),
				// If the namer fired it would consume this; it must never run.
				fauxAssistantMessage("unused name"),
			],
		});
		const id = "api:job-naming";
		await seedJob(rig, id, everyMinuteSpec());
		const first = await fireJob(rig.deps, id, `${id}:1000`, 1000, BACKGROUND_CONTEXT);
		expect(first.outcome).toBe("running");
		await rig.opened.harness.waitForIdle(BACKGROUND_CONTEXT);
		await rig.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		await rig.opened.autoNamer.idle();
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			first.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.autoName).toBeUndefined();
		expect(meta?.autoNameAttempts).toBeUndefined();
	});
});

// ─── Gateway C7: deliver targets on the fire path ─────────────────────────

describe("deliver targets (gateway C7)", () => {
	test("a new-conversation fire stamps meta deliver + jobId (typed fields)", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-deliver";
		await seedJob(rig, id, {
			...everyMinuteSpec(),
			action: {
				kind: "prompt",
				prompt: "say tick",
				conversation: "new",
				deliver: ["telegram:42"],
			},
		});
		const outcome = await fireJob(
			rig.deps,
			id,
			`${id}:1000`,
			1000,
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("running");
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			outcome.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.deliver).toEqual(["telegram:42"]);
		expect(meta?.jobId).toBe(id);
	});

	test("a fire WITHOUT deliver stamps jobId but never deliver", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-no-deliver";
		await seedJob(rig, id, everyMinuteSpec());
		const outcome = await fireJob(
			rig.deps,
			id,
			`${id}:1000`,
			1000,
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("running");
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			outcome.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.jobId).toBe(id);
		expect(meta?.deliver).toBeUndefined();
	});

	test("no gateway loaded: one warning per run when deliver is set", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-deliver-nogw";
		await seedJob(rig, id, {
			...everyMinuteSpec(),
			action: {
				kind: "prompt",
				prompt: "say tick",
				conversation: "new",
				deliver: ["telegram:42"],
			},
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const outcome = await fireJob(
				rig.deps,
				id,
				`${id}:1000`,
				1000,
				BACKGROUND_CONTEXT,
			);
			expect(outcome.outcome).toBe("running");
			const quiet = "api:job-deliver-quiet";
			await seedJob(rig, quiet, everyMinuteSpec());
			await fireJob(rig.deps, quiet, `${quiet}:1000`, 1000, BACKGROUND_CONTEXT);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith("deliver targets ignored: no gateway");
		} finally {
			warn.mockRestore();
		}
	});

	test("a loaded gateway (gatewayLoaded true) never warns", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-deliver-gw";
		await seedJob(rig, id, {
			...everyMinuteSpec(),
			action: {
				kind: "prompt",
				prompt: "say tick",
				conversation: "new",
				deliver: ["telegram:42"],
			},
		});
		rig.deps.gatewayLoaded = true;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const outcome = await fireJob(
				rig.deps,
				id,
				`${id}:1000`,
				1000,
				BACKGROUND_CONTEXT,
			);
			expect(outcome.outcome).toBe("running");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

// ─── Task 2c: job prompts expand /skill:name and template commands ─────────

test("a job prompt naming a prompt template sends the expanded text", async () => {
	const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
	const promptsDir = await (async () => {
		const { writeFile } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-prompts-"));
		await writeFile(
			join(dir, "review.md"),
			"---\ndescription: Review\n---\nNightly review focus: $1\n",
		);
		return dir;
	})();
	const bootExpansion = rig.opened.commandExpansion;
	rig.deps.commandExpansion = {
		skills: bootExpansion.skills,
		templates: { userDir: promptsDir, packageRoots: () => [] },
		commandNames: bootExpansion.commandNames,
	};
	rig.deps.envBuilder = rig.opened.envBuilder;
	const id = "api:job-template-prompt";
	await seedJob(rig, id, {
		...everyMinuteSpec(),
		action: { kind: "prompt", prompt: "/review nightly", conversation: "new" },
	});
	const outcome = await fireJob(
		rig.deps,
		id,
		`${id}:1000`,
		1000,
		BACKGROUND_CONTEXT,
	);
	expect(outcome.outcome).toBe("running");
	const conversationId = outcome.conversationId as number;
	await until(
		rig.clock,
		async () => {
			const conversation = await rig.opened.harness.conversation(
				conversationId as never,
				BACKGROUND_CONTEXT,
			);
			const state = await conversation!.viewState(BACKGROUND_CONTEXT);
			const found = state.value.entries.some((entry) => entry.kind === "pi.assistant");
			await state.dispose();
			return found;
		},
		(found) => found,
		"the expanded-prompt answer",
	);
	const conversation = await rig.opened.harness.conversation(
		conversationId as never,
		BACKGROUND_CONTEXT,
	);
	const state = await conversation!.viewState(BACKGROUND_CONTEXT);
	const entries = state.value.entries;
	const user = entries.find((entry) => entry.kind === "pi.user");
	const content = user?.model?.[0]?.content;
	const text = Array.isArray(content)
		? content
				.map((part: { text?: string }) => part.text ?? "")
				.join("")
		: String(content ?? "");
	expect(text).toContain("Nightly review focus: nightly");
	expect(
		entries.some((entry) => entry.kind === "sigrun.user.expanded"),
	).toBe(false);
	await state.dispose();
	await (await import("node:fs/promises")).rm(promptsDir, {
		recursive: true,
		force: true,
	});
});

// Keep the JobDoc import meaningful for the family types used above.
void JobDoc;
