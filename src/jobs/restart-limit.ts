/**
 * Jobs restart-limit recovery (D2): the restart-limited listener.
 *
 * pi-durable 1.5.0 removed `task_parked`/`retryTask`: a schedule task
 * cut off `settings.restartLimit` times in a row ends FAULTED (reason
 * `restart_limit`), reported through `HarnessOptions.onReport`. The
 * reports collector queues those tasks; boot registers this listener
 * after open, and it marks the owning job record
 * `state: "blocked"`, `reason: "restart_limit"` — the signal reconcile
 * respects (a blocked job gets NO new executor) and `POST
 * /v1/jobs/:id/resume` clears.
 *
 * The listener is async and owns all Harness reads/commits; its
 * rejection is logged, never thrown (the collector's delivery lane must
 * not fail on a follow-up error).
 */

import type { Context } from "@earendil-works/chord";
import type { Harness, ReportTask } from "@earendil-works/pi-durable";
import { patchJob } from "./docs.js";
import { SCHEDULE_TASK_KIND } from "./task.js";

/**
 * Mark the job owning a restart-limited schedule task blocked. Anything
 * that is not a schedule task (built-in kinds, unknown ids, malformed
 * inputs) is ignored — the restart-limit recovery surface is jobs-only.
 */
export async function markRestartLimitedJob(
	harness: Harness,
	task: ReportTask,
	context: Context,
): Promise<void> {
	try {
		if (task.kind !== SCHEDULE_TASK_KIND) return;
		const record = await harness.getTask(task.id, context);
		if (record === undefined) return;
		const jobId = (record.input as { jobId?: unknown }).jobId;
		if (typeof jobId !== "string") return;
		await patchJob(
			harness,
			jobId,
			(draft) => {
				draft.state = "blocked";
				draft.reason = "restart_limit";
			},
			context,
		);
	} catch (error) {
		console.error("jobs: restart-limited listener failed:", error);
	}
}
