import type { Context } from "@earendil-works/chord";
import {
	LiveDoc,
	type ConversationId,
	type Harness,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import type { JobRunWire } from "@sigrun/shared/jobs";
import type { SettingsFile } from "../harness/settings.js";
import { scanRunningRuns } from "./docs.js";
import { settleJobRun } from "./observe.js";

/** A crash leaves a run unobserved; only old fires are safe to repair. */
const ORPHAN_AGE_MS = 300_000;

/** Settle old runs whose durable executor or submission can no longer do so. */
export async function sweepOrphanedRuns(
	deps: {
		harness: Harness;
		storage: Storage;
		settings: () => SettingsFile;
		now(): number;
	},
	ctx: Context,
): Promise<number> {
	const now = deps.now();
	const runs = await scanRunningRuns(deps.storage, ctx);
	let settledCount = 0;
	for (const run of runs) {
		if (Date.parse(run.fireAt) >= now - ORPHAN_AGE_MS) continue;
		const settled = await orphanedSettlement(deps, run, now, ctx);
		if (settled === undefined) continue;
		await settleJobRun(deps, run, settled, ctx);
		settledCount += 1;
	}
	return settledCount;
}

async function orphanedSettlement(
	deps: { harness: Harness; storage: Storage },
	run: JobRunWire,
	now: number,
	ctx: Context,
): Promise<JobRunWire | undefined> {
	if (run.taskId !== undefined) {
		// SAFETY: JobRunWire stores pi-durable's branded TaskId as a number.
		const task = await deps.harness.getTask(run.taskId as unknown as TaskId, ctx);
		if (task !== undefined && task.state.status !== "terminal") return undefined;
		return orphaned(run, now);
	}

	if (run.conversationId === undefined) return orphaned(run, now);
	// SAFETY: JobRunWire stores pi-durable's branded ConversationId as a number.
	const conversationId = run.conversationId as unknown as ConversationId;
	if (await deps.harness.conversation(conversationId, ctx) === undefined) {
		return orphaned(run, now);
	}
	const fireKey = run.manual
		? `${run.jobId}:manual:${Date.parse(run.fireAt)}`
		: `${run.jobId}:${Date.parse(run.fireAt)}`;
	const submission = await deps.storage.submissionByRequest(
		conversationId,
		`job:${fireKey}`,
		ctx,
	);
	if (submission === undefined) return orphaned(run, now);
	if (submission.status !== "done" && submission.status !== "unanswered") {
		return undefined;
	}
	const live = await deps.harness.snapshot(LiveDoc, conversationId, ctx);
	if (live?.run?.inputs.includes(submission.id) === true) return undefined;
	return {
		...run,
		outcome: submission.status === "done" ? "succeeded" : "failed",
		settledAt: new Date(now).toISOString(),
		...(submission.status === "unanswered" ? { error: submission.reason } : {}),
	};
}

function orphaned(run: JobRunWire, now: number): JobRunWire {
	return {
		...run,
		outcome: "failed",
		settledAt: new Date(now).toISOString(),
		error: "orphaned",
	};
}
