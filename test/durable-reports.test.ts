/**
 * pi-durable 1.4.0 failure visibility (D5 / Task B5).
 *
 * The park integration uses real file-backed SQLite and abandoned Harness
 * instances, never a real process crash: a schedule-shaped phase waits on a
 * promise that never resolves, leaving its record `running`. Each reopen
 * counts one restart; the fifth REOPEN reports the park DURING Harness.open.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineTask,
	Harness,
	type ReportInfo,
	type ReportTask,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createDurableReports } from "../src/harness/reports.js";
import { applyParkedJobs } from "../src/jobs/parked.js";
import { JobDoc, readJob, type JobRecord } from "../src/jobs/docs.js";
import type { JobSpec } from "@sigrun/shared/jobs";

const EVERY_MINUTE: JobSpec = {
	name: "park-fixture",
	schedule: { every: "60s" },
	action: { kind: "prompt", prompt: "unused", conversation: "new" },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function task(id = 41): ReportTask {
	return { id: id as never, kind: "sigrun.schedule", conversationId: 7 as never };
}

const ALL_REPORTS: readonly ReportInfo[] = [
	{ type: "session_failed" },
	{ type: "task_faulted", task: task(), extension: "ext.jobs", reason: "threw" },
	{ type: "task_parked", task: task(), extension: "ext.jobs" },
	{ type: "migration_failed", task: task(), extension: "ext.jobs" },
	{ type: "task_outdated", task: task(), extension: "ext.jobs", reason: "missing_task" },
	{ type: "task_error", task: task(), extension: "ext.jobs" },
	{ type: "extension_error", extension: "ext.jobs", task: task(), conversationId: 7 as never },
	{ type: "host_error", callback: "now", task: task() },
	{ type: "listener_error" },
];

describe("createDurableReports", () => {
	test("counts every report type and logs identity without stacks except session_failed", () => {
		const lines: string[] = [];
		const reports = createDurableReports({ log: (line) => lines.push(line) });
		for (const info of ALL_REPORTS) {
			reports.onReport(new Error(`failure for ${info.type}`), info);
		}
		expect(reports.counts()).toEqual({
			session_failed: 1,
			task_faulted: 1,
			task_parked: 1,
			migration_failed: 1,
			task_outdated: 1,
			task_error: 1,
			extension_error: 1,
			host_error: 1,
			listener_error: 1,
		});
		expect(lines).toHaveLength(ALL_REPORTS.length);
		for (const info of ALL_REPORTS) {
			const line = lines.find((candidate) =>
				candidate.startsWith(`sigrun: durable ${info.type} `),
			);
			expect(line, `one log line for ${info.type}`).toBeDefined();
			expect(line).toContain('message="failure for ');
			if ("task" in info && info.task !== undefined) {
				expect(line).toContain("task=41");
				expect(line).toContain('kind="sigrun.schedule"');
				expect(line).toContain("conversation=7");
			}
			if ("extension" in info && info.extension !== undefined) {
				expect(line).toContain('extension="ext.jobs"');
			}
			if (info.type === "host_error") expect(line).toContain('callback="now"');
			if (info.type === "session_failed") expect(line).toContain("stack=");
			else expect(line).not.toContain("stack=");
		}
	});

	test("caps the error message at 500 characters", () => {
		const lines: string[] = [];
		const reports = createDurableReports({ log: (line) => lines.push(line) });
		reports.onReport(new Error("x".repeat(600)), { type: "listener_error" });
		expect(lines[0]?.match(/message="(x+)"/)?.[1]).toHaveLength(500);
	});

	test("contains throwing log and observer callbacks", () => {
		const reports = createDurableReports({
			log: () => { throw new Error("log failed"); },
			onReport: () => { throw new Error("observer failed"); },
		});
		expect(() => reports.onReport(new Error("report"), ALL_REPORTS[2]!)).not.toThrow();
		expect(reports.counts().task_parked).toBe(1);
		expect(reports.takeParked()).toHaveLength(1);
	});

	test("takeParked returns each parked task once", () => {
		const reports = createDurableReports({ log: () => {} });
		reports.onReport(new Error("parked"), ALL_REPORTS[2]!);
		expect(reports.takeParked()).toEqual([task()]);
		expect(reports.takeParked()).toEqual([]);
	});
});

describe("applyParkedJobs", () => {
	test("logs and drops a patch failure", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const harness = {
				inspect: async () => { throw new Error("inspect failed"); },
			} as unknown as Harness;
			await expect(
				applyParkedJobs(harness, [task()], BACKGROUND_CONTEXT),
			).resolves.toBeUndefined();
			expect(error).toHaveBeenCalledOnce();
		} finally {
			error.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Real SQLite crash-loop simulation
// ---------------------------------------------------------------------------

type WaitingTask = ReturnType<typeof waitingScheduleTask>;

function waitingScheduleTask() {
	return defineTask<{ jobId: string }, { phase: "wait" }, void, object>({
		name: "sigrun.schedule",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async () => await new Promise<never>(() => {}),
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

async function openWaitingHarness(
	storagePath: string,
	reports: ReturnType<typeof createDurableReports>,
	definition: WaitingTask = waitingScheduleTask(),
): Promise<Harness> {
	const registry = createRegistry();
	registry.install({ name: "sigrun.test.jobs", tasks: [definition] });
	const storage = await openNodeSqliteStorage(storagePath);
	return await Harness.open(
		storage,
		{ models: createModels(), registry, onReport: reports.onReport },
		BACKGROUND_CONTEXT,
	);
}

async function until(
	read: () => Promise<boolean>,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await read())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("parked schedule recovery", () => {
	test("the fifth reopen after creation parks during open and patches the job", { timeout: 20_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-durable-park-"));
		const storagePath = join(dir, "sigrun.db");
		const reports = createDurableReports({ log: () => {} });
		const jobId = "api:parked-job";
		let taskId: TaskId<void> | undefined;
		let finalHarness: Harness | undefined;
		try {
			const first = await openWaitingHarness(storagePath, reports);
			const root = await first.root(BACKGROUND_CONTEXT);
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
			await first.commit(async (tx) => {
				await tx.doc(JobDoc, jobId, record);
			}, BACKGROUND_CONTEXT);
			const definition = waitingScheduleTask();
			taskId = await first.commit(
				async (tx) => await tx.createTask(definition, { jobId }, {
					ownership: { kind: "conversation" },
					conversationId: root.id,
					background: true,
				}),
				BACKGROUND_CONTEXT,
			);
			first.resume();
			await until(async () =>
				(await first.getTask(taskId!, BACKGROUND_CONTEXT))?.state.status === "running",
			"the first task invocation to run");
			// Deliberately abandon `first` and the next four Harnesses without
			// close(): their never-resolving phases leave `running` records.

			for (let open = 2; open <= 5; open += 1) {
				const abandoned = await openWaitingHarness(storagePath, reports);
				abandoned.resume();
				await until(async () =>
					(await abandoned.getTask(taskId!, BACKGROUND_CONTEXT))?.state.status === "running",
				`open ${open} to run the task`);
			}

			let opening = true;
			let parkedDuringOpen = false;
			const observing = createDurableReports({
				log: () => {},
				onReport: (_error, info) => {
					if (info.type === "task_parked" && opening) parkedDuringOpen = true;
				},
			});
			// The initial creation plus five reopens: restart counts 1..4
			// run again; reopen five reaches the unchanged default limit 5.
			finalHarness = await openWaitingHarness(storagePath, observing);
			opening = false;
			expect(parkedDuringOpen).toBe(true);
			expect(observing.counts().task_parked).toBe(1);
			const inspection = await finalHarness.inspect(BACKGROUND_CONTEXT);
			const parked = inspection.tasks.find((candidate) => String(candidate.record.id) === String(taskId));
			expect(parked?.state).toMatchObject({ kind: "blocked", reason: "restart_limit" });
			await applyParkedJobs(finalHarness, observing.takeParked(), BACKGROUND_CONTEXT);
			expect(await readJob(finalHarness, jobId, BACKGROUND_CONTEXT)).toMatchObject({
				state: "blocked",
				reason: "restart_limit",
			});
		} finally {
			if (finalHarness !== undefined) await finalHarness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a throwing phase faults the task and never parks it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-durable-fault-"));
		cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
		const reports = createDurableReports({ log: () => {} });
		const throwing = defineTask<Record<string, never>, { phase: "throw" }, void, object>({
			name: "sigrun.test.throw",
			version: 1,
			initial: () => ({ phase: "throw" }),
			phases: { throw: async () => { throw new Error("phase failed"); } },
			abort: async () => {},
		});
		const registry = createRegistry();
		registry.install({ name: "sigrun.test.throw", tasks: [throwing] });
		const storage = await openNodeSqliteStorage(join(dir, "sigrun.db"));
		const harness = await Harness.open(storage, {
			models: createModels(), registry, onReport: reports.onReport,
		}, BACKGROUND_CONTEXT);
		try {
			const root = await harness.root(BACKGROUND_CONTEXT);
			const id = await root.commit(
				(tx) => tx.createTask(throwing, {}, { ownership: { kind: "conversation" } }),
				BACKGROUND_CONTEXT,
			);
			harness.resume();
			await until(async () => reports.counts().task_faulted === 1, "the thrown phase to fault");
			const record = await harness.getTask(id, BACKGROUND_CONTEXT);
			expect(record?.state.status).toBe("terminal");
			expect(reports.counts().task_parked).toBe(0);
			expect(reports.takeParked()).toEqual([]);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
