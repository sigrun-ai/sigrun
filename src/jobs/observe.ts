/**
 * Jobs Task 3 (spec §8.1 "Run status"): the two run-settle observers.
 *
 * - **The `runSettled` handler** (registered on the event bus as
 *   `sigrun:jobs`): a settled run whose conversation's `SessionMeta`
 *   carries a `jobId` settles the job's RUNNING run record matching that
 *   `conversationId` — `succeeded` (answered) or `failed` (unanswered,
 *   `error: reason`) + `settledAt` — refreshes the job record's
 *   `lastRun` copy, then prunes history. It sees ONLY prompt runs (the
 *   bus derives settled runs from `submission` writes).
 * - **The `taskSettled` listener** (the host-event reduction the bus
 *   emits from terminal `task` table writes): settles `task`-action run
 *   records whose `taskId` matches — `completed` → `succeeded`, any
 *   other terminal → `failed` + the error text — then the same
 *   lastRun/prune refresh.
 *
 * Both are idempotent by construction: they settle only a run whose
 * outcome is still `running`, so a re-delivery (the bus's at-least-once
 * posture) is a no-op. Failures are caught and logged — an observer must
 * never break the run or the drain loop.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import type { JobRunWire } from "@sigrun/shared/jobs";
import type { SettingsFile } from "../harness/settings.js";
import { SessionMetaDoc } from "../server/session-meta.js";
import { EventBus, type RunSettledEvent } from "../harness/event-bus.js";
import { JobDoc, JobRunDoc, listRuns, patchJob, pruneHistory, scanJobs } from "./docs.js";
import type { JobRuntimeDeps } from "./fire.js";

/** The `sigrun.job.run` key a run record was written under. */
function runKeyOf(run: JobRunWire): string {
	if (run.manual) {
		return `${run.jobId}:manual:${Date.parse(run.startedAt)}`;
	}
	return `${run.jobId}:${Date.parse(run.fireAt)}`;
}

/** The retention limits read live per prune (§8.1 ruling 14). */
function limitsOf(settings: () => SettingsFile): { runs: number; revisions: number } {
	const jobHistory = settings().jobHistory;
	return {
		runs: jobHistory?.runs ?? 50,
		revisions: jobHistory?.revisions ?? 50,
	};
}

export interface JobObserversDeps {
	readonly harness: Harness;
	readonly storage: Storage;
	readonly runtime: JobRuntimeDeps;
	readonly settings: () => SettingsFile;
	/** The bus the runSettled handler registers on + taskSettled subscribes to. */
	readonly eventBus: EventBus;
}

/** Settle one run record + the job's lastRun copy + prune. */
async function settleRun(
	deps: JobObserversDeps,
	run: JobRunWire,
	settled: JobRunWire,
	ctx: Context,
): Promise<void> {
	await deps.harness.commit(async (tx) => {
		// The seed only applies when the doc is absent (it never is — the
		// fire created it); mutate the LIVE draft instead. Carried field by
		// field so a concurrent writer's fields cannot be lost wholesale.
		// SAFETY: the draft is the JsonObject-backed JobRunWire draft —
		// pi-durable's Draft<T> tracks mutations on the same object, so the
		// Object.assign lands in the tracked doc, not a copy.
		const draft = await tx.doc(JobRunDoc, runKeyOf(run), settled);
		Object.assign(draft as unknown as Record<string, unknown>, settled);
	}, ctx);
	await patchJob(deps.harness, run.jobId, (draft) => {
		draft.lastRun = settled;
	}, ctx);
	await pruneHistory(deps.storage, deps.harness, run.jobId, limitsOf(deps.settings), ctx);
}

/**
 * Register both observers (boot calls this after the bus opens, before
 * `resume()` — recovery settles are observed). Returns the unsubscribe.
 */
export function registerJobObservers(deps: JobObserversDeps): () => void {
	const ctx: Context = BACKGROUND_CONTEXT;
	const nowIso = (): string => new Date(deps.runtime.now()).toISOString();

	// The runSettled handler (prompt runs): registered as `sigrun:jobs`,
	// install order = run order (after every loaded extension, like the
	// auto-namer — a job observation never delays an extension's).
	const runSettled = async (event: RunSettledEvent): Promise<void> => {
		try {
			const meta = await deps.harness.snapshot(
				SessionMetaDoc,
				event.conversationId,
				ctx,
			);
			const jobId = (meta as { jobId?: unknown } | undefined)?.jobId;
			if (typeof jobId !== "string") return;
			const runs = await listRuns(
				deps.storage,
				jobId,
				Number.MAX_SAFE_INTEGER,
				ctx,
			);
			const run = runs.find(
				(one) =>
					one.outcome === "running" &&
					// SAFETY: ConversationId is the branded number the run record's
					// plain `conversationId` field carries; compared across both forms.
					one.conversationId === (event.conversationId as unknown as number),
			);
			if (run === undefined) return;
			const answered = event.outcome.status === "answered";
			const settled: JobRunWire = {
				...run,
				outcome: answered ? "succeeded" : "failed",
				settledAt: nowIso(),
				...(answered || event.outcome.status !== "unanswered"
					? {}
					: { error: event.outcome.reason }),
			};
			await settleRun(deps, run, settled, ctx);
		} catch (error) {
			console.error("jobs: runSettled observer failed:", error);
		}
	};
	const unregister = deps.eventBus.registerExtension("sigrun:jobs", {
		runSettled,
	});

	// The taskSettled listener (task runs): the host-event reduction the
	// bus emits synchronously from terminal task-table writes. The settle
	// work runs on a microtask side lane (the listener contract is
	// no-blocking-work); each settle is idempotent, so ordering with the
	// drain loop's deliveries does not matter.
	//
	// LOAD GUARD: tool-call tasks (every bash/read/write a conversation
	// runs) also produce terminal task writes — a jobs-harnessing scan per
	// terminal task would tax every busy conversation. The listener first
	// checks `jobsMayExist`, a conservative flag: false only until the
	// first `sigrun.job` document write is observed (the commit
	// subscription below — job records appear ONLY through writes), and
	// never reset afterwards (retirement is not a return to no-jobs for
	// this process). A no-jobs harness pays ONE boolean check per terminal
	// task, never a scan.
	let jobsMayExist = false;
	const offJobWrites = deps.harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (change.type !== "document") continue;
			if (change.record.kind === JobDoc.definition.kind) {
				jobsMayExist = true;
				return;
			}
		}
	});
	const offTaskSettled = deps.eventBus.onHostEvent((event) => {
		if (event.type !== "taskSettled") return;
		if (!jobsMayExist) return;
		const { taskId, status, error } = event;
		void (async () => {
			try {
				// The run records' jobId is unknown here (the event carries
				// only the task id) — scan every live job's running runs and
				// match by taskId. Household scale: one scan over the runs of
				// jobs whose action is `task` would need the record read per
				// job; the scan below walks ALL live job records once, then
				// each one's runs (the same shape reconcile's pass-2 uses).
				const jobs = await scanJobs(deps.storage, ctx);
				for (const { id } of jobs) {
					const runs = await listRuns(
						deps.storage,
						id,
						Number.MAX_SAFE_INTEGER,
						ctx,
					);
					const run = runs.find(
						(one) => one.outcome === "running" && one.taskId === taskId,
					);
					if (run === undefined) continue;
					const succeeded = status === "completed";
					const settled: JobRunWire = {
						...run,
						outcome: succeeded ? "succeeded" : "failed",
							settledAt: nowIso(),
						...(succeeded || error === undefined ? {} : { error }),
					};
					await settleRun(deps, run, settled, ctx);
					return;
				}
			} catch (error) {
				console.error("jobs: taskSettled observer failed:", error);
			}
		})();
	});

	return () => {
		unregister();
		offTaskSettled();
		offJobWrites();
	};
}
