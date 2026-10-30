/**
 * Crash-battery item 7 driver (plan Task 12 step 7, spec §7 M1 battery,
 * App A "scheduled jobs must be crash-durable"): `kill -9` a task
 * mid-durable-sleep → restart → the task wakes at (or after) the
 * deadline EXACTLY ONCE — no double-fire, no missed wake, no early wake.
 *
 * Task definition (a `defineTask` state machine, registered identically in
 * both modes; the deadline lives in the durable INPUT, recoverable from the
 * task record in either process), on pi-durable 1.4.0:
 * - phase `"start"`: appends the `START` marker line (guarded at-most-once
 *   by the marker FILE itself, which survives any crash), then commits the
 *   checkpoint `{phase: "sleep", deadline}` — durable progress.
 * - phase `"sleep"`: `await runtime.sleepUntil(deadline, {phase: "wake",
 *   deadline}, context)` — THE durable sleep, the crash target. The phase
 *   ENDS here: the task holds no invocation while asleep (a kill during
 *   the sleep kills a process with no running invocation for this task).
 * - phase `"wake"`: the post-sleep body, re-entered on wake (or on resume
 *   past the deadline): appends `WOKE:<runtime.now()>` (file-guarded
 *   at-most-once), then commits the terminal outcome `{status:
 *   "completed", result: {wokeAt, deadline}}`.
 * A crash mid-sleep leaves the durable record `sleeping` with checkpoint
 * `{phase: "wake", deadline}`; the reopened harness resumes the task AT
 * the deadline (or immediately, if it already passed) — the START phase
 * never re-runs (its checkpoint transition is durable), so no second
 * START line.
 *
 * START/WOKE markers: the T12a execution-marker pattern, one line per
 * actual occurrence, across both processes, in `<dir>/task-wakes.count`.
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db`; register the task; create it
 *    conversation-owned on the root conversation via the Session-commit
 *    seam (`root.commit(tx => tx.createTask(…))`), carrying the deadline in
 *    the input.
 * 2. Poll `getTask` until the task record's checkpoint is durably
 *    `{phase: "sleep", deadline}` AND the START marker line exists — then
 *    the sleep intent is DURABLE and the kill marker is honest. Print
 *    `SLEEPING` and stay alive until SIGKILL (which the test lands before
 *    the deadline).
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume — BEFORE the deadline (the
 *    driver refuses to proceed if it booted late; that is a test-timing
 *    bug, not a task behavior).
 * 2. `waitForTask` the task (the scheduler wakes it when the harness clock
 *    passes the deadline) and assert the terminal outcome is `completed`.
 * 3. Assert: exactly ONE `START` and exactly ONE `WOKE` line; the WOKE
 *    timestamp ≥ deadline (no early wake); the terminal result's `wokeAt`
 *    matches the marker.
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import {
	bootScenarioHarness,
	marker,
	parseDriverArgs,
	readScenarioState,
	verifyFailed,
	verified,
	withDeadline,
	writeScenarioState,
} from "./lib.js";

/** The task's registered kind (persisted in TaskRecord.kind). */
const WAKE_TASK = "battery-wake";
/** How far in the future the durable sleep deadline sits (setup). */
const SLEEP_MS = 6_000;
/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const SLEEPING_DEADLINE_MS = 20_000;
const SETTLE_DEADLINE_MS = 30_000;
/** Poll cadence for the setup durable-checkpoint observable. */
const POLL_MS = 100;

/** The task's durable input: the sleep deadline, fixed at creation. */
interface WakeInput {
	readonly deadline: number;
}

/** The task's checkpoint phases. */
type WakeCheckpoint =
	| { phase: "start" }
	| { phase: "sleep"; deadline: number }
	| { phase: "wake"; deadline: number };

/** One marker line appended per actual START/WOKE occurrence. */
function appendWakeMarker(dir: string, line: string): void {
	appendFileSync(join(dir, "task-wakes.count"), `${line}\n`);
}

/** The marker lines, in order. */
async function wakeMarkers(dir: string): Promise<string[]> {
	try {
		const content = await readFile(join(dir, "task-wakes.count"), "utf8");
		return content.split("\n").filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

/** Append `line` unless a line equal to `line` prefix-match already exists. */
async function appendOnce(dir: string, prefix: string, line: string): Promise<void> {
	const markers = await wakeMarkers(dir);
	if (markers.some((candidate) => candidate.startsWith(prefix))) return;
	appendWakeMarker(dir, line);
}

/**
 * The crash-durable wake task. The file-guarded appends make both markers
 * at-most-once across any crash timing (a crash between an append and its
 * commit re-enters the phase, which sees the line already present).
 */
function wakeTask(dir: string) {
	return defineTask<WakeInput, WakeCheckpoint, { wokeAt: number; deadline: number }>({
		name: WAKE_TASK,
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (task, runtime, context) => {
				await appendOnce(dir, "START", "START");
				const deadline = task.input.deadline;
				// Durable progress: the sleep intent checkpoint.
				await runtime.commit(
					() => ({
						status: "running" as const,
						checkpoint: { phase: "sleep" as const, deadline },
					}),
					context,
				);
			},
			sleep: async (task, runtime, context) => {
				const deadline = task.state.checkpoint.deadline;
				// THE durable sleep — the crash target. The phase ENDS here:
				// the resumed invocation re-enters at `wake` when the harness
				// clock reaches the deadline (or immediately when past it).
				await runtime.sleepUntil(deadline, { phase: "wake", deadline }, context);
			},
			wake: async (task, runtime, context) => {
				const deadline = task.state.checkpoint.deadline;
				const wokeAt = runtime.now();
				await appendOnce(dir, "WOKE:", `WOKE:${wokeAt}`);
				// Durable terminal outcome.
				await runtime.commit(
					() => ({
						status: "terminal" as const,
						outcome: {
							status: "completed" as const,
							result: { wokeAt, deadline },
						},
					}),
					context,
				);
			},
		},
		// The battery never aborts the task; the abort handler settles
		// honestly so a stray abort mark surfaces as a visible failure.
		abort: async (task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal" as const,
					outcome: { status: "aborted" as const, reason: "battery abort" },
				}),
				context,
			);
		},
	});
}

async function main(): Promise<never> {
	const { mode, dir } = parseDriverArgs();

	if (mode === "setup") {
		const opened = await bootScenarioHarness(dir, [
			fauxAssistantMessage("unused answer"),
		]);
		opened.registry.install({
			name: "battery-tasks",
			tasks: [wakeTask(dir)],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		marker("READY");
		// Create the wake task conversation-owned via the Session-commit seam
		// (tx.createTask defaults to the bound conversation), deadline in the
		// durable input.
		const deadline = Date.now() + SLEEP_MS;
		const taskId = await root.commit(
			(tx) => tx.createTask(wakeTask(dir), { deadline }, { ownership: { kind: "conversation" } }),
			BACKGROUND_CONTEXT,
		);
		await writeScenarioState(dir, {
			wakeTaskId: taskId,
			wakeDeadline: deadline,
		});
		// The durable-sleep observable: the task record is `sleeping` with
		// the `wake` checkpoint durably committed by sleepUntil, and the
		// START marker line exists. Only then is the sleep intent durable.
		const sleepingDeadline = Date.now() + SLEEPING_DEADLINE_MS;
		for (;;) {
			const record = await opened.harness.getTask(taskId, BACKGROUND_CONTEXT);
			const checkpoint = record?.state.checkpoint as WakeCheckpoint | undefined;
			const started = (await wakeMarkers(dir)).some((line) => line === "START");
			if (
				record !== undefined &&
				record.state.status === "sleeping" &&
				checkpoint?.phase === "wake" &&
				checkpoint.deadline === deadline &&
				started
			) {
				break;
			}
			if (Date.now() > sleepingDeadline) {
				return verifyFailed(
					`the wake task never reached a durable sleep checkpoint before the deadline (record=${JSON.stringify(record?.state)}, markers=${JSON.stringify(await wakeMarkers(dir))})`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		// The kill lands inside the durable sleep window (the test kills
		// immediately; the deadline is ~6s out at this point).
		marker("SLEEPING");
		// Stay alive until the test's SIGKILL.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen BEFORE the deadline, resume, wait past it, assert.
	const state = await readScenarioState(dir);
	const deadline = state.wakeDeadline as number;
	const taskId = state.wakeTaskId as TaskId<{ wokeAt: number; deadline: number }>;
	if (Date.now() > deadline) {
		return verifyFailed(
			`the verify pass booted AFTER the deadline (${new Date(deadline).toISOString()}) — the reopen-before-deadline discipline was violated (test timing bug, not a task bug)`,
		);
	}
	const opened = await bootScenarioHarness(dir, [
		fauxAssistantMessage("unused answer"),
	]);
	opened.registry.install({
		name: "battery-tasks",
		tasks: [wakeTask(dir)],
	});
	// resume() is armed by openHarness; the task wakes when the clock passes
	// the deadline. waitForTask settles the terminal receipt.
	const task = await withDeadline(
		opened.harness.waitForTask(taskId, BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"resumed wake task settlement",
	);
	const outcome = task.state.outcome;
	if (outcome.status !== "completed") {
		return verifyFailed(
			`the resumed wake task did not complete (outcome=${JSON.stringify(outcome)}) — missed wake`,
		);
	}

	// THE assertions: exactly ONE START, exactly ONE WOKE, WOKE >= deadline.
	const markers = await wakeMarkers(dir);
	const starts = markers.filter((line) => line === "START");
	const wakes = markers.filter((line) => line.startsWith("WOKE:"));
	if (starts.length !== 1) {
		return verifyFailed(
			`expected exactly one START marker across both processes, found ${starts.length} (markers=${JSON.stringify(markers)}) — ${starts.length === 0 ? "missed start" : "double-fire"}`,
		);
	}
	if (wakes.length !== 1) {
		return verifyFailed(
			`expected exactly one WOKE marker across both processes, found ${wakes.length} (markers=${JSON.stringify(markers)}) — ${wakes.length === 0 ? "missed wake" : "double-fire"}`,
		);
	}
	const wokeAt = Number(wakes[0]?.slice("WOKE:".length) ?? Number.NaN);
	if (!Number.isFinite(wokeAt)) {
		return verifyFailed(
			`the WOKE marker does not carry a numeric timestamp (${wakes[0]})`,
		);
	}
	if (wokeAt < deadline) {
		return verifyFailed(
			`the task woke at ${wokeAt}, BEFORE the deadline ${deadline} (early wake by ${deadline - wokeAt}ms)`,
		);
	}
	const result = outcome.result as { wokeAt: number; deadline: number };
	if (result.wokeAt !== wokeAt) {
		return verifyFailed(
			`the terminal result's wokeAt (${result.wokeAt}) does not match the WOKE marker (${wokeAt})`,
		);
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		taskOutcome: outcome.status,
		startMarkers: starts.length,
		wakeMarkers: wakes.length,
		wokeAt,
		deadline,
		wokeAfterDeadline: wokeAt >= deadline,
		marginMs: wokeAt - deadline,
	});
}

main().catch((error) => {
	// The driver crashed without reaching a verify assertion: fail loud
	// with a non-zero exit (the test sees the code + this stderr).
	process.stderr.write(`driver crashed: ${String(error)}\n`);
	process.exit(1);
});
