/**
 * Jobs restart-limit recovery (pi-durable 1.5.0, plan Task 4 / D2).
 *
 * pi-durable 1.5.0 removed `task_parked`/`retryTask`: a schedule task
 * cut off `settings.restartLimit` times in a row ends FAULTED with
 * detail `{reason: "restart_limit"}` and a `task_faulted` report. This
 * suite pins the replacement recovery machinery:
 *
 * - the reports collector (`src/harness/reports.ts`) queues
 *   restart-limited reports and NEVER calls back into the Harness from
 *   inside `onReport` (delivery is `setImmediate`-deferred, and only
 *   once a listener is registered);
 * - boot drains the queue after open, then registers the live listener
 *   (`markRestartLimitedJob`), which patches the owning job record to
 *   `state: "blocked"`, `reason: "restart_limit"`;
 * - reconcile LEAVES a blocked/restart_limit record alone (no executor
 *   recreation on reboot);
 * - `JobsService.resume(id)` re-arms a blocked job (waiting, reason
 *   cleared, exactly one live executor) and refuses a healthy job with
 *   `JobNotBlockedError`.
 *
 * The crash-loop fixture is `test/admin-tasks.test.ts`'s
 * `bootParkedRig`: a `sigrun.schedule`-KIND task whose only phase never
 * resolves, driven through one creating boot + four abandoned reopens
 * so the sixth open hits the restart limit during `Harness.open`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineTask,
	type Harness,
	type Report,
	type ReportTask,
} from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createDurableReports } from "../src/harness/reports.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { JobNotBlockedError } from "../src/jobs/index.js";
import { JobDoc, readJob, type JobRecord } from "../src/jobs/docs.js";
import { liveScheduleTasksByJob } from "../src/jobs/reconcile.js";
import { markRestartLimitedJob } from "../src/jobs/restart-limit.js";
import { SCHEDULE_TASK_KIND } from "../src/jobs/task.js";
import { createFakeClock, type FakeClock } from "./helpers/fake-clock.js";
import { seededIdentity } from "./helpers/identity.js";
import type { IdentityStores } from "../src/harness/identity/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The fixture extension installed as the replacement core jobs
 *  extension (same name, same task kind — the crash-loop fixture). */
const TEST_JOBS_EXTENSION = { name: "sigrun.jobs", tasks: [waitingScheduleTask()] };

const EVERY_MINUTE: JobSpec = {
	name: "park-fixture",
	schedule: { every: "60s" },
	action: { kind: "prompt", prompt: "unused", conversation: "new" },
};

/** A short real-time beat for async settling. */
async function beat(ms = 25): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds (fail-loud bound, real time). */
async function until<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	description: string,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (predicate(value)) return value;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${description}`);
		}
		await beat();
	}
}

/** The reports-collector unit rig: no Harness — the listener is faked. */
describe("durable reports: the restart-limited queue", () => {
	test("reports never call back synchronously; non-restart reports never reach the listener", async () => {
		const reports = createDurableReports({
			log: () => {},
		});
		const delivered: ReportTask[] = [];
		reports.onRestartLimited((task) => {
			delivered.push(task);
		});
		const task: ReportTask = {
			id: 7 as TaskId<void>,
			kind: SCHEDULE_TASK_KIND,
			conversationId: 1 as ConversationId,
		};
		const faulted: Report = {
			kind: "task_faulted",
			task,
			reason: "restart_limit",
			error: new Error("restart limit reached"),
		};
		reports.onReport(faulted);
		// The listener must NOT have run before onReport returned — the
		// collector queues, it never calls back into the Session line.
		expect(delivered).toEqual([]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(delivered).toEqual([task]);

		// A storage_failed report (and any other kind/reason) never
		// reaches the listener.
		reports.onReport({
			kind: "storage_failed",
			error: new Error("disk gone"),
		});
		reports.onReport({
			kind: "task_faulted",
			task,
			reason: "threw",
			error: new Error("boom"),
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(delivered).toEqual([task]);
	});

	test("reports before listener registration stay queued; registration drains them via setImmediate", async () => {
		const reports = createDurableReports({
			log: () => {},
		});
		const task: ReportTask = {
			id: 9 as TaskId<void>,
			kind: SCHEDULE_TASK_KIND,
			conversationId: 1 as ConversationId,
		};
		reports.onReport({
			kind: "task_faulted",
			task,
			reason: "restart_limit",
			error: new Error("restart limit reached"),
		});
		expect(reports.takeRestartLimited()).toEqual([task]);
		// Registration must drain the QUEUED backlog asynchronously.
		const delivered: ReportTask[] = [];
		reports.onRestartLimited((one) => {
			delivered.push(one);
		});
		expect(delivered).toEqual([]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(delivered).toEqual([task]);
	});
});

// ---------------------------------------------------------------------------
// The boot-level rig: a real openHarness crash-looped into restart_limit.
// ---------------------------------------------------------------------------

interface RestartRig {
	readonly dir: string;
	readonly config: SigrunConfig;
	readonly identity: IdentityStores;
	readonly contributor: ProviderContributor;
	readonly clock: FakeClock;
	opened: OpenedHarness;
	/** The schedule task's id (set once the first boot created it). */
	taskId: TaskId<void>;
	/** Every report the collector logged across the CURRENT boot. */
	readonly reports: Report[];
}

/** Boot a real openHarness over `rig`'s storage (no HTTP app needed). */
async function boot(rig: RestartRig): Promise<void> {
	rig.reports.length = 0;
	rig.opened = await openHarness(rig.config, {
		identity: rig.identity,
		extensions: [rig.contributor],
		env: {},
		settingsDir: rig.dir,
		now: rig.clock.now,
		setTimer: rig.clock.setTimer,
		onReport: (report) => {
			rig.reports.push(report);
		},
	});
	// Replace the core jobs extension's `sigrun.schedule` definition with
	// the waiting fixture: the task KIND stays `sigrun.schedule`, but the
	// phase never resolves — the crash-loop simulation (the admin-tasks
	// rig's exact pattern: the scheduler resolves definitions from the
	// live registry, so the fixture must be INSTALLED to survive a
	// reopen).
	rig.opened.registry.uninstall({ name: "sigrun.jobs" });
	rig.opened.registry.install(TEST_JOBS_EXTENSION);
}

/** Abandon a boot WITHOUT closing the harness (the crash simulation). */
async function abandon(_rig: RestartRig): Promise<void> {
	// Deliberately no harness.close() — the waiting phase's
	// never-resolving promise leaves the task record `running`, which is
	// what counts a restart on the next open.
	await Promise.resolve();
}

async function closeRig(rig: RestartRig): Promise<void> {
	await rig.opened.harness.close(BACKGROUND_CONTEXT);
	await rm(rig.dir, { recursive: true, force: true });
}

/**
 * Build the restart-limited state through real openHarness boots: the
 * first boot creates the job + task (job state `waiting`), four
 * abandoned reopens count restarts 1..4, and the sixth open reaches
 * restart limit 5 — the task faults DURING `Harness.open`, and the
 * boot's drain marks the owning job blocked before openHarness returns.
 */
async function bootRestartLimitedRig(): Promise<RestartRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-restart-limit-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const rig = {
		dir,
		clock: createFakeClock(Date.now()),
		config: loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
		}),
		identity: await seededIdentity(dir),
		contributor: {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		} satisfies ProviderContributor,
		reports: [] as Report[],
	} as unknown as RestartRig;
	cleanups.push(() => closeRig(rig));

	await boot(rig);
	const root = await rig.opened.harness.root(BACKGROUND_CONTEXT);
	const record: JobRecord = {
		source: "api",
		spec: EVERY_MINUTE,
		owner: "tester",
		enabled: true,
		createdAt: "2026-10-28T00:00:00.000Z",
		hash: "park-fixture",
		state: "waiting",
		version: 1,
		updatedAt: "2026-10-28T00:00:00.000Z",
	};
	await rig.opened.harness.commit(async (tx) => {
		await tx.doc(JobDoc, "api:parked-job", record);
	}, BACKGROUND_CONTEXT);
	// The input carries the record's hash: the boot reconcile treats a
	// hash-mismatched (or hashless) live task as stale and aborts it,
	// which would fault the fixture instead of restart-limiting it.
	rig.taskId = await rig.opened.harness.commit(
		async (tx) =>
			await tx.createTask(
				waitingScheduleTask(),
				{ jobId: "api:parked-job", hash: "park-fixture" },
				{
					ownership: { kind: "conversation" },
					conversationId: root.id,
					background: true,
				},
			),
		BACKGROUND_CONTEXT,
	);
	expect(await readJob(rig.opened.harness, "api:parked-job", BACKGROUND_CONTEXT)).toMatchObject({
		state: "waiting",
	});
	await until(
		async () => await rig.opened.harness.getTask(rig.taskId, BACKGROUND_CONTEXT),
		(task) => task?.state.status === "running",
		"the first task invocation to run",
	);

	// Four abandoned reopens: restart counts 1..4 run again.
	for (let open = 2; open <= 5; open += 1) {
		await abandon(rig);
		await boot(rig);
		await until(
			async () => await rig.opened.harness.getTask(rig.taskId, BACKGROUND_CONTEXT),
			(task) => task?.state.status === "running",
			`open ${open} to run the task`,
		);
	}
	// The sixth open (creation + five reopens) reaches restart limit 5:
	// the task faults DURING Harness.open; the report and the boot
	// drain's job patch settle asynchronously right after open returns.
	await abandon(rig);
	await boot(rig);
	await until(
		async () => rig.reports,
		(reports) =>
			reports.some(
				(one) => "reason" in one && one.reason === "restart_limit",
			),
		"the restart_limit report",
	);
	await until(
		async () =>
			await readJob(rig.opened.harness, "api:parked-job", BACKGROUND_CONTEXT),
		(job) => job?.state === "blocked",
		"the boot drain to block the job",
	);
	return rig;
}

/** The waiting task: an extension-kind task whose only phase never
 *  resolves until its abort signal fires (the crash-loop fixture). */
function waitingScheduleTask() {
	return defineTask<{ jobId: string; hash: string }, { phase: "wait" }, void, object>({
		name: SCHEDULE_TASK_KIND,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (_task, runtime) =>
				await new Promise<void>((resolve) => {
					if (runtime.signal.aborted) return resolve();
					runtime.signal.addEventListener("abort", () => resolve(), { once: true });
				}),
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal" as const,
					outcome: { status: "aborted" as const, reason: "test cleanup" },
				}),
				context,
			);
		},
	});
}

describe("restart-limit recovery (D2)", () => {
	test(
		"restart limit blocks the job",
		{ timeout: 120_000 },
		async () => {
			const rig = await bootRestartLimitedRig();
			// The collected report: a schedule-kind task faulted by the
			// restart limit (extension-kind tasks arrive as task_faulted).
			const report = rig.reports.find(
				(one) =>
					"reason" in one &&
					one.reason === "restart_limit",
			);
			expect(report).toMatchObject({
				kind: "task_faulted",
				reason: "restart_limit",
				task: { kind: SCHEDULE_TASK_KIND },
			});
			// The job record was marked blocked by the boot drain.
			expect(
				await readJob(rig.opened.harness, "api:parked-job", BACKGROUND_CONTEXT),
			).toMatchObject({ state: "blocked", reason: "restart_limit" });
			// The task ended terminal (faulted), not blocked.
			const task = await rig.opened.harness.getTask(
				rig.taskId,
				BACKGROUND_CONTEXT,
			);
			expect(task?.state.status).toBe("terminal");
		},
	);

	test(
		"reboot does not recreate a blocked job's executor",
		{ timeout: 120_000 },
		async () => {
			const rig = await bootRestartLimitedRig();
			// One more CLEAN boot: reconcile must leave the blocked
			// record alone (no executor recreation).
			await rig.opened.harness.close(BACKGROUND_CONTEXT);
			await boot(rig);
			cleanups.push(async () => {
				await rig.opened.harness.close(BACKGROUND_CONTEXT);
			});
			const live = await liveScheduleTasksByJob(
				rig.opened.storage,
				BACKGROUND_CONTEXT,
			);
			expect(live.get("api:parked-job") ?? []).toEqual([]);
			expect(
				await readJob(rig.opened.harness, "api:parked-job", BACKGROUND_CONTEXT),
			).toMatchObject({ state: "blocked", reason: "restart_limit" });
		},
	);

	test(
		"resume re-arms the job; resume refuses a healthy job",
		{ timeout: 120_000 },
		async () => {
			const rig = await bootRestartLimitedRig();
			const wire = await rig.opened.jobs.resume("api:parked-job");
			expect(wire).toMatchObject({ state: "waiting" });
			expect(wire.reason).toBeUndefined();
			const record = await readJob(
				rig.opened.harness,
				"api:parked-job",
				BACKGROUND_CONTEXT,
			);
			expect(record).toMatchObject({ state: "waiting" });
			expect(record?.reason).toBeUndefined();
			// Exactly one live executor, carrying the record's hash.
			const live = await liveScheduleTasksByJob(
				rig.opened.storage,
				BACKGROUND_CONTEXT,
			);
			const executors = live.get("api:parked-job") ?? [];
			expect(executors).toHaveLength(1);
			expect(
				(executors[0]?.input as { hash?: unknown }).hash,
			).toBe("park-fixture");

			// A healthy (waiting) job cannot be resumed.
			await expect(
				rig.opened.jobs.resume("api:parked-job"),
			).rejects.toBeInstanceOf(JobNotBlockedError);
		},
	);

	test(
		"restart limit reported after open is applied live",
		{ timeout: 120_000 },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-restart-live-"));
			const faux = fauxProvider({
				provider: "faux",
				models: [{ id: "m", contextWindow: 128_000 }],
			});
			faux.setResponses([fauxAssistantMessage("ok")]);
			const opened = await openHarness(
				loadConfig({
					SIGRUN_DEFAULT_MODEL: "faux/m",
					SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
					SIGRUN_AUTH: "none",
					SIGRUN_WORKSPACE_PATH: dir,
				}),
				{
					identity: await seededIdentity(dir),
					extensions: [
						{
							name: "ext-faux",
							providers: [{ provider: faux.provider }],
						} satisfies ProviderContributor,
					],
					env: {},
					settingsDir: dir,
				},
			);
			cleanups.push(async () => {
				await opened.harness.close(BACKGROUND_CONTEXT);
				await rm(dir, { recursive: true, force: true });
			});
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const record: JobRecord = {
				source: "api",
				spec: EVERY_MINUTE,
				owner: "tester",
				enabled: true,
				createdAt: "2026-10-28T00:00:00.000Z",
				hash: "live-fixture",
				state: "waiting",
				version: 1,
				updatedAt: "2026-10-28T00:00:00.000Z",
			};
			await opened.harness.commit(async (tx) => {
				await tx.doc(JobDoc, "api:live-job", record);
			}, BACKGROUND_CONTEXT);
			// A live schedule task for the job, created the same way the
			// crash-loop rig creates its executor (the record was written
			// AFTER boot, so no reconcile will create one here).
			const taskId = await opened.harness.commit(
				async (tx) =>
					await tx.createTask(
						waitingScheduleTask(),
						{ jobId: "api:live-job", hash: "live-fixture" },
						{
							ownership: { kind: "conversation" },
							conversationId: root.id,
							background: true,
						},
					),
				BACKGROUND_CONTEXT,
			);
			// Feed a synthetic restart_limit report through the collector
			// exactly as pi-durable would: the boot-registered listener
			// applies it live (no reboot).
			opened.reports.onReport({
				kind: "task_faulted",
				task: {
					id: taskId,
					kind: SCHEDULE_TASK_KIND,
					conversationId: root.id,
				},
				reason: "restart_limit",
				error: new Error("restart limit reached"),
			});
			await until(
				async () =>
					await readJob(opened.harness, "api:live-job", BACKGROUND_CONTEXT),
				(job) => job?.state === "blocked",
				"the live listener to block the job",
			);
			expect(
				await readJob(opened.harness, "api:live-job", BACKGROUND_CONTEXT),
			).toMatchObject({ state: "blocked", reason: "restart_limit" });
		},
	);

	test("markRestartLimitedJob ignores non-schedule tasks and bad inputs", async () => {
		// Unit-level: wrong kind, unknown task id, non-string jobId all
		// no-op without throwing.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-restart-unit-"));
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const opened = await openHarness(
			loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_AUTH: "none",
				SIGRUN_WORKSPACE_PATH: dir,
			}),
			{
				identity: await seededIdentity(dir),
				extensions: [
					{
						name: "ext-faux",
						providers: [{ provider: faux.provider }],
					} satisfies ProviderContributor,
				],
				env: {},
				settingsDir: dir,
			},
		);
		cleanups.push(async () => {
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const ctx: Context = BACKGROUND_CONTEXT;
		const harness: Harness = opened.harness;
		// Wrong task kind: ignored.
		await markRestartLimitedJob(
			harness,
			{ id: 1 as TaskId<void>, kind: "pi.generation", conversationId: root.id },
			ctx,
		);
		// Unknown task id: ignored.
		await markRestartLimitedJob(
			harness,
			{
				id: 424242 as TaskId<void>,
				kind: SCHEDULE_TASK_KIND,
				conversationId: root.id,
			},
			ctx,
		);
	});
});
