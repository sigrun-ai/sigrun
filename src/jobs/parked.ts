/**
 * D5 parked-schedule recovery: translate pi-durable's task_parked identity
 * into the job record's status fields after Harness.open has returned.
 */

import type { Context } from "@earendil-works/chord";
import type { Harness, ReportTask } from "@earendil-works/pi-durable";
import { patchJob } from "./docs.js";
import { SCHEDULE_TASK_KIND, type ScheduleInput } from "./task.js";

/** Patch each parked schedule job; individual failures are logged and dropped. */
export async function applyParkedJobs(
	harness: Harness,
	parked: readonly ReportTask[],
	context: Context,
): Promise<void> {
	if (parked.length === 0) return;
	let inspection: Awaited<ReturnType<Harness["inspect"]>>;
	try {
		inspection = await harness.inspect(context);
	} catch (error) {
		console.error("jobs: parked task inspection failed:", error);
		return;
	}
	for (const task of parked) {
		if (task.kind !== SCHEDULE_TASK_KIND) continue;
		try {
			const record = inspection.tasks.find((candidate) => candidate.record.id === task.id)?.record;
			if (record === undefined) continue;
			const jobId = (record.input as Partial<ScheduleInput>).jobId;
			if (typeof jobId !== "string") continue;
			await patchJob(harness, jobId, (draft) => {
				draft.state = "blocked";
				draft.reason = "restart_limit";
			}, context);
		} catch (error) {
			console.error(`jobs: parked task ${String(task.id)} status patch failed:`, error);
		}
	}
}
