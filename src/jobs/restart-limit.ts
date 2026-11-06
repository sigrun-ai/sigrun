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
 * The listener is async and owns all Harness reads/commits; a
 * rejection is logged by the boot wrapper, never thrown into the
 * collector's delivery lane.
 */

import type { Context } from "@earendil-works/chord";
import type { Harness, ReportTask } from "@earendil-works/pi-durable";
import { patchJob } from "./docs.js";
import { SCHEDULE_TASK_KIND } from "./task.js";

/**
 * Mark the job owning a restart-limited schedule task blocked. Anything
 * that is not a schedule task (built-in kinds, unknown ids, malformed
 * inputs) is ignored — the restart-limit recovery surface is jobs-only.
 * A failure REJECTS: boot's registration wrapper owns the logging (one
 * log per failure, never a double-log).
 */
export async function markRestartLimitedJob(
	harness: Harness,
	task: ReportTask,
	context: Context,
): Promise<void> {
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
}
