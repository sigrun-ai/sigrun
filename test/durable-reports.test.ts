/**
 * pi-durable 1.5.0 failure visibility (D5).
 *
 * pi-durable 1.5.0 removed `task_parked` (and with it `retryTask` and
 * `applyParkedJobs`; the replacement recovery surface lands with the
 * plan's Task 4). What remains here: the collector's count/log contract
 * against the 1.5.0 report shape (one `{ kind, error, ...info }` object)
 * and the task_faulted integration over real file-backed SQLite.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineTask,
	Harness,
	type Report,
	type ReportInfo,
	type ReportTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createDurableReports, REPORT_KINDS } from "../src/harness/reports.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function task(id = 41): ReportTask {
	return { id: id as never, kind: "sigrun.schedule", conversationId: 7 as never };
}

const ALL_REPORTS: readonly ReportInfo[] = [
	{ kind: "storage_failed" },
	{ kind: "task_faulted", task: task(), extension: "ext.jobs", reason: "threw" },
	{ kind: "task_interrupted", task: task(), extension: "ext.jobs", reason: "interrupted", restarts: 1 },
	{ kind: "migration_failed", task: task(), extension: "ext.jobs" },
	{ kind: "task_outdated", task: task(), extension: "ext.jobs", reason: "missing_task" },
	{ kind: "task_error", task: task(), extension: "ext.jobs" },
	{ kind: "extension_error", extension: "ext.jobs", task: task(), conversationId: 7 as never },
	{ kind: "host_error", callback: "now", task: task() },
	{ kind: "listener_error" },
];

describe("createDurableReports", () => {
	test("counts every report kind and logs identity without stacks except storage_failed", () => {
		const lines: string[] = [];
		const reports = createDurableReports({ log: (line) => lines.push(line) });
		for (const info of ALL_REPORTS) {
			const report = { ...info, error: new Error(`failure for ${info.kind}`) } as Report;
			reports.onReport(report);
		}
		expect(reports.counts()).toEqual({
			storage_failed: 1,
			task_faulted: 1,
			task_interrupted: 1,
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
				candidate.startsWith(`sigrun: durable ${info.kind} `),
			);
			expect(line, `one log line for ${info.kind}`).toBeDefined();
			expect(line).toContain('message="failure for ');
			if ("task" in info && info.task !== undefined) {
				expect(line).toContain("task=41");
				expect(line).toContain('kind="sigrun.schedule"');
				expect(line).toContain("conversation=7");
			}
			if ("extension" in info && info.extension !== undefined) {
				expect(line).toContain('extension="ext.jobs"');
			}
			if (info.kind === "host_error") expect(line).toContain('callback="now"');
			if (info.kind === "storage_failed") expect(line).toContain("stack=");
			else expect(line).not.toContain("stack=");
		}
	});

	test("a storage_failed report increments counts().storage_failed and logs the durable prefix", () => {
		const lines: string[] = [];
		const reports = createDurableReports({ log: (line) => lines.push(line) });
		reports.onReport({ kind: "storage_failed", error: new Error("disk gone") });
		expect(reports.counts().storage_failed).toBe(1);
		expect(lines[0]).toMatch(/^sigrun: durable storage_failed/);
	});

	test("the 1.5.0 kind vocabulary dropped task_parked and session_failed", () => {
		expect(REPORT_KINDS).not.toContain("task_parked");
		expect(REPORT_KINDS).not.toContain("session_failed");
		expect(REPORT_KINDS).toContain("storage_failed");
		expect(REPORT_KINDS).toContain("task_interrupted");
	});

	test("caps the error message at 500 characters", () => {
		const lines: string[] = [];
		const reports = createDurableReports({ log: (line) => lines.push(line) });
		reports.onReport({ kind: "listener_error", error: new Error("x".repeat(600)) });
		expect(lines[0]?.match(/message="(x+)"/)?.[1]).toHaveLength(500);
	});

	test("contains throwing log and observer callbacks", () => {
		const reports = createDurableReports({
			log: () => { throw new Error("log failed"); },
			onReport: () => { throw new Error("observer failed"); },
		});
		expect(() =>
			reports.onReport({ kind: "listener_error", error: new Error("report") }),
		).not.toThrow();
		expect(reports.counts().listener_error).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Real SQLite fault integration
// ---------------------------------------------------------------------------

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

describe("durable fault reporting", () => {
	test("a throwing phase faults the task and reports task_faulted", async () => {
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
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
