/**
 * Jobs Task 2 (spec §8.1 "The executor"): the `sigrun.schedule` task —
 * one long-lived background pi-durable task per ENABLED job, looping
 * `waiting` → `firing` → `waiting` over a durable `runtime.sleep`.
 *
 * The input is only `{jobId, hash, firstAt?}` (the plan's Global
 * Constraints): the task NEVER trusts its input's spec — EVERY phase
 * re-reads the job record, and a record that is absent, disabled, or
 * hash-mismatched makes the task commit TERMINAL (it is a stale executor;
 * reconciliation owns the replacement). `firstAt` exists because
 * `initial(input)` sees only the input: the creator computes the first
 * fire (`nextFireAt(schedule, now, tz)`).
 *
 * The phases:
 * - `waiting`: durable `runtime.sleep(nextAt)`. On wake: under
 *   `catchUp: "none"` and `now - nextAt > 60_000`, the missed slot is
 *   recorded `skipped` and the task re-commits `waiting` at the NEXT
 *   slot from NOW. Otherwise it commits `{phase: "firing", fireAt:
 *   nextAt}`.
 * - `firing`: `fireJob(…, fireKey = <jobId>:<fireAt>)` — the run record
 *   doubles as the idempotency record, so a crash mid-fire re-enters
 *   here and reuses it. Then `nextAt = nextFireAt(schedule, max(now,
 *   fireAt), tz)` — FROM NOW, never from the missed slot (Review Focus
 *   5: catchUp decides whether a missed fire is recorded; the schedule
 *   never fires once per missed interval). No next slot → terminal
 *   completed (a past one-shot `at`).
 *
 * `abort` commits terminal (aborted) — the disable/delete path's signal.
 *
 * The record's status fields (`state`, `nextRun`, `lastRun`) ride
 * `patchJob` — small status edits, never version bumps.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask, type Task } from "@earendil-works/pi-durable";
import type { JobRunWire } from "@sigrun/shared/jobs";
import { JobRunDoc, patchJob, readJob, type JobRecord } from "./docs.js";
import { fireJob, type JobRuntimeDeps } from "./fire.js";
import { nextFireAt } from "./schedule.js";

/** The persisted task kind (TaskRecord.kind). */
export const SCHEDULE_TASK_KIND = "sigrun.schedule";
/** The definition version persisted with the task. */
export const SCHEDULE_TASK_VERSION = 1;
/** Under `catchUp: "none"`, a fire missed by more than this is skipped. */
const CATCHUP_GRACE_MS = 60_000;

/** The task's durable input: identity + the creation-time hash. */
export interface ScheduleInput {
	jobId: string;
	hash: string;
	firstAt?: number;
}

/** The task's checkpoint (the two-phase loop). */
export type ScheduleState =
	| { phase: "waiting"; nextAt: number }
	| { phase: "firing"; fireAt: number };

/**
 * The per-job executor. `deps` threads the harness + the injectable
 * clock (`deps.now` — the tests' lever; `runtime.sleep` reads the same
 * clock through the harness, which is why the phases re-check it).
 */
export function createScheduleTask(
	deps: JobRuntimeDeps,
): Task<ScheduleInput, ScheduleState, void, object> {
	return defineTask<ScheduleInput, ScheduleState, void, object>({
		name: SCHEDULE_TASK_KIND,
		version: SCHEDULE_TASK_VERSION,
		// `initial` sees only the input: the creator computed `firstAt`
		// (nextFireAt at creation); absent, the first phase re-derives it
		// from the record at its first run.
		initial: (input) => ({
			phase: "waiting",
			nextAt: input.firstAt ?? 0,
		}),
		phases: {
			waiting: async (task, runtime, context) => {
				const record = await readJob(deps.harness, task.input.jobId, context);
				if (stale(record, task.input.hash)) {
					await runtime.commit(
						() => ({
							status: "terminal" as const,
							outcome: { status: "completed" as const, result: undefined },
						}),
						context,
					);
					return;
				}
				let nextAt = task.state.checkpoint.nextAt;
				if (nextAt === 0) {
					// No creator-computed firstAt (a re-derived first fire).
					const first = nextFireAt(
						record.spec.schedule,
						deps.now(),
						deps.defaultTz,
					);
					if (first === undefined) {
						await runtime.commit(
							() => ({
								status: "terminal" as const,
								outcome: { status: "completed" as const, result: undefined },
							}),
							context,
						);
						return;
					}
					nextAt = first;
				}
				// The durable wait — the crash point the battery kills inside.
				await runtime.sleep(nextAt, context);
				// Re-check the record after the sleep (it may have changed).
				const after = await readJob(deps.harness, task.input.jobId, context);
				if (stale(after, task.input.hash)) {
					await runtime.commit(
						() => ({
							status: "terminal" as const,
							outcome: { status: "completed" as const, result: undefined },
						}),
						context,
					);
					return;
				}
				const now = deps.now();
				const catchUp = after.spec.catchUp ?? "once";
				if (catchUp === "none" && now - nextAt > CATCHUP_GRACE_MS) {
					// Missed beyond the grace: record `skipped` (settled
					// immediately), then schedule the NEXT slot from now.
					const skipped: JobRunWire = {
						jobId: task.input.jobId,
						version: after.version,
						fireAt: new Date(nextAt).toISOString(),
						manual: false,
						outcome: "skipped",
						startedAt: new Date(now).toISOString(),
						settledAt: new Date(now).toISOString(),
					};
					const fireKey = `${task.input.jobId}:${nextAt}`;
					await deps.harness.commit(async (tx) => {
						await tx.doc(JobRunDoc, fireKey, skipped);
					}, context);
					await patchJob(
						deps.harness,
						task.input.jobId,
						(draft) => {
							draft.lastRun = skipped;
						},
						context,
					);
					const next = nextFireAt(after.spec.schedule, now, deps.defaultTz);
					if (next === undefined) {
						await runtime.commit(
							() => ({
								status: "terminal" as const,
								outcome: { status: "completed" as const, result: undefined },
							}),
							context,
						);
						return;
					}
					await runtime.commit(
						() => ({
							status: "running" as const,
							checkpoint: { phase: "waiting" as const, nextAt: next },
						}),
						context,
					);
					await patchJob(
						deps.harness,
						task.input.jobId,
						(draft) => {
							draft.state = "waiting";
							draft.nextRun = new Date(next).toISOString();
						},
						context,
					);
					return;
				}
				await runtime.commit(
					() => ({
						status: "running" as const,
						checkpoint: { phase: "firing" as const, fireAt: nextAt },
					}),
					context,
				);
				await patchJob(
					deps.harness,
					task.input.jobId,
					(draft) => {
						draft.state = "firing";
					},
					context,
				);
			},

			firing: async (task, runtime, context) => {
				const record = await readJob(deps.harness, task.input.jobId, context);
				if (stale(record, task.input.hash)) {
					await runtime.commit(
						() => ({
							status: "terminal" as const,
							outcome: { status: "completed" as const, result: undefined },
						}),
						context,
					);
					return;
				}
				const fireAt = task.state.checkpoint.fireAt;
				const fireKey = `${task.input.jobId}:${fireAt}`;
				await fireJob(deps, task.input.jobId, fireKey, fireAt, context, runtime);
				// From NOW, never from the missed slot (Review Focus 5).
				const now = deps.now();
				const next = nextFireAt(
					record.spec.schedule,
					Math.max(now, fireAt),
					deps.defaultTz,
				);
				if (next === undefined) {
					await patchJob(
						deps.harness,
						task.input.jobId,
						(draft) => {
							draft.state = "waiting";
							delete draft.nextRun;
						},
						context,
					);
					await runtime.commit(
						() => ({
							status: "terminal" as const,
							outcome: { status: "completed" as const, result: undefined },
						}),
						context,
					);
					return;
				}
				await runtime.commit(
					() => ({
						status: "running" as const,
						checkpoint: { phase: "waiting" as const, nextAt: next },
					}),
					context,
				);
				await patchJob(
					deps.harness,
					task.input.jobId,
					(draft) => {
						draft.state = "waiting";
						draft.nextRun = new Date(next).toISOString();
					},
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal" as const,
					outcome: { status: "aborted" as const, reason: "job disabled or deleted" },
				}),
				context,
			);
		},
	});
}

/** The stale-executor rule: absent/disabled/hash-mismatched record. */
function stale(record: JobRecord | undefined, hash: string): record is undefined {
	return (
		record === undefined || record.hash !== hash || record.enabled === false
	);
}

/** Awaiting `runtime.sleep` on the harness's background context. */
export const SCHEDULE_CONTEXT = BACKGROUND_CONTEXT;
