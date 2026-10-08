/**
 * Crash-battery item 6 driver (plan Task 12 step 6, spec §7 M1 battery):
 * `kill -9` mid-streaming-generation while a `GenerationHooks.afterResponse`
 * hook is installed → restart → count the hook's ACTUAL fires across both
 * processes. The OBSERVED count is the payload — 1 = the hook never fired in
 * the killed process (the stream never completed) and fired once on the
 * recovered run; 2 = the hook fired in both processes (re-fire on replay) —
 * and it finalizes the memory extension's observe-guard design (spec §3
 * Memory row: a durable memo keyed by generation id is REQUIRED if
 * `afterResponse` can re-fire for one user turn, defensive-only otherwise).
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider slowed
 *    deterministically (`tokensPerSecond: 2`, `tokenSize` pinned) — the
 *    item-1 lever: the scripted long answer streams for ~2 minutes.
 * 2. Install an extension carrying a `GenerationHooks.afterResponse` hook
 *    (via `hook(GenerationTask, { afterResponse })` — .d.ts-verified shape:
 *    `afterResponse(message, api, context)`). The hook appends one line to
 *    `<dir>/hook-fires.count` on EVERY invocation — the T12a execution-marker
 *    pattern, one line per fire, across both processes.
 * 3. Submit one input; poll the LiveDoc until the committed generation
 *    partial carries actual streamed text (the item-1 mid-generation
 *    observable), print `GENERATING`, and stay alive until SIGKILL. The kill
 *    lands mid-token-stream: the terminal provider message NEVER arrives in
 *    this process, so `afterResponse` cannot fire in setup.
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume (same hook installed), with a
 *    fresh faux provider serving the full recovery answer fast.
 * 2. Reacquire the killed submission, await settlement (deadline).
 * 3. Count the hook fires in the marker file. The OBSERVED count is the
 *    payload (recorded, not asserted to a specific number — this is a
 *    verification, not a pass/fail on the count); the OBSERVE-GUARD
 *    conclusion is derived from it: re-fired ⇒ the memory extension's
 *    observe MUST key a durable memo by generation id to stay exactly-once;
 *    not re-fired ⇒ the guard is defensive-only. Both are reported; the
 *    test only asserts the count is a positive integer and the turn
 *    completed (non-vacuity: a completed turn guarantees at least one
 *    terminal classification, which is the hook's only fire point).
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	defineExtension,
	GenerationTask,
	hook,
	LiveDoc,
	type HookApi,
	type SubmissionId,
} from "@earendil-works/pi-durable";
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

/** The long answer the setup pass streams slowly (never completes before the kill). */
const SLOW_ANSWER = "slow streaming answer for the hook fire count ".repeat(40);
/** The full answer the verify pass's fresh provider serves. */
const RECOVERED_ANSWER = "recovered final answer observed by the afterResponse hook";

/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const PARTIAL_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 30_000;
/** Poll cadence for the committed-partial observable. */
const POLL_MS = 100;

/** Count one `afterResponse` fire in the marker file (one line per fire). */
function countHookFire(dir: string): void {
	appendFileSync(join(dir, "hook-fires.count"), `${Date.now()}\n`);
}

/** The hook-fire marker lines, in order. */
async function hookFires(dir: string): Promise<string[]> {
	try {
		const content = await readFile(join(dir, "hook-fires.count"), "utf8");
		return content.split("\n").filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

/**
 * The scenario's hook extension: installed IDENTICALLY in both modes so the
 * recovered generation resolves the same hook registration. The handler
 * appends the marker line on every invocation — the fire-count evidence.
 */
function hookExtension(dir: string) {
	return defineExtension({
		name: "battery-hook",
		hooks: [
			hook(GenerationTask, {
				// .d.ts-verified shape (harness/types.d.ts GenerationHooks):
				// afterResponse(message, api, context) — "Every terminal
				// provider message, before classification." The marker line is
				// the observation; nothing else is needed here.
				afterResponse(
					message: AssistantMessage,
					_api: HookApi,
				): void {
					countHookFire(dir);
					void message;
				},
			}),
		],
	});
}

/** The assistant messages of the committed `pi.assistant` entries. */
function assistantMessages(
	entries: readonly { kind: string; model?: readonly unknown[] }[],
): AssistantMessage[] {
	return entries
		.filter((entry) => entry.kind === "pi.assistant")
		.flatMap((entry) => entry.model ?? [])
		.filter(
			(message): message is AssistantMessage =>
				(message as { role?: string }).role === "assistant",
		);
}

async function main(): Promise<never> {
	const { mode, dir } = parseDriverArgs();

	if (mode === "setup") {
		const opened = await bootScenarioHarness(
			dir,
			[fauxAssistantMessage(SLOW_ANSWER)],
			{ tokensPerSecond: 2, tokenSize: { min: 8, max: 8 } },
		);
		opened.registry.install(hookExtension(dir));
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		marker("READY");
		const submission = await root.submit(
			{ type: "input", content: "tell me about hook re-fire on replay" },
			BACKGROUND_CONTEXT,
		);
		await writeScenarioState(dir, { submissionId: submission.id });
		// The item-1 mid-generation observable: the committed throttled partial
		// must carry actual streamed text before the kill marker — the kill is
		// unambiguously mid-token-stream, so the terminal message (and thus
		// afterResponse) has NOT arrived in this process.
		const partialDeadline = Date.now() + PARTIAL_DEADLINE_MS;
		for (;;) {
			const live = await opened.harness.snapshot(
				LiveDoc,
				root.id,
				BACKGROUND_CONTEXT,
			);
			const partial = live?.generation?.message;
			const streamed =
				partial?.content?.some(
					(block) =>
						block.type === "text" && block.text.length > 0,
				) ?? false;
			if (streamed) break;
			if (Date.now() > partialDeadline) {
				await verifyFailed(
					"no committed generation partial with streamed text appeared before the deadline",
				);
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		// Belt-and-braces non-vacuity: the hook must NOT have fired in setup
		// (if it had, the kill point was not mid-stream — a vacuous run).
		const setupFires = await hookFires(dir);
		if (setupFires.length > 0) {
			await verifyFailed(
				`the afterResponse hook fired ${setupFires.length}x in SETUP before the kill marker — the kill was not mid-stream (vacuous run)`,
			);
		}
		marker("GENERATING");
		// Stay alive until the test's SIGKILL: the in-flight stream's timers
		// hold the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen, resume, settle the killed submission, count fires.
	const opened = await bootScenarioHarness(dir, [
		fauxAssistantMessage(RECOVERED_ANSWER),
	]);
	opened.registry.install(hookExtension(dir));
	const state = await readScenarioState(dir);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const submission = await opened.harness.submission(
		state.submissionId as SubmissionId,
		BACKGROUND_CONTEXT,
	);
	if (submission === undefined) {
		return verifyFailed(
			`submission ${String(state.submissionId)} not found after reopen`,
		);
	}
	const settled = await withDeadline(
		submission.wait(BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"recovered submission settlement",
	);
	if (settled.status !== "done") {
		return verifyFailed(
			`the crashed turn did not complete after recovery (status=${settled.status}${settled.status === "unanswered" ? ` reason=${settled.reason}` : ""}) — a completed turn is the non-vacuity precondition for the fire count`,
		);
	}

	// The fire count: ONE line per actual afterResponse invocation across
	// BOTH processes. This is the verification's payload — the observed
	// count, recorded (and the observe-guard conclusion derived), not
	// asserted to a specific number.
	const fires = await hookFires(dir);
	if (fires.length < 1) {
		// Zero fires with a completed turn means the hook never fired at all —
		// a broken registration (vacuous), not a "no re-fire" observation.
		return verifyFailed(
			"the afterResponse hook never fired although the turn completed — broken hook registration (vacuous run)",
		);
	}
	const refired = fires.length >= 2;
	const observeGuard = refired
		? "REQUIRED: durable memo keyed by generation id (afterResponse re-fires on replay — without the guard the memory observe writes duplicate records for one user turn)"
		: "defensive-only: afterResponse did NOT re-fire for the killed turn (single fire on the recovered run — the guard remains a cheap idempotence backstop, not a correctness requirement)";

	// Exactly one final answer (the recovered run's answer) — the turn-level
	// sanity the fire count rides on.
	const viewState = await root.viewState(BACKGROUND_CONTEXT);
	const view = viewState.value;
	const finalAnswers = assistantMessages(
		view.entries as unknown as { kind: string; model?: readonly unknown[] }[],
	).filter((message) => message.stopReason === "stop");
	let serialized = "";
	try {
		serialized = JSON.stringify(view);
	} catch (error) {
		await viewState.dispose();
		return verifyFailed(`view does not serialize: ${String(error)}`);
	}
	await viewState.dispose();
	if (finalAnswers.length !== 1) {
		return verifyFailed(
			`expected exactly one final answer after recovery, found ${finalAnswers.length}`,
		);
	}
	if (serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		settledStatus: settled.status,
		hookFires: fires.length,
		refired,
		observeGuard,
		finalAnswers: finalAnswers.length,
		entries: view.entries.length,
	});
}

main().catch((error) => {
	// The driver crashed without reaching a verify assertion: fail loud
	// with a non-zero exit (the test sees the code + this stderr).
	process.stderr.write(`driver crashed: ${String(error)}\n`);
	process.exit(1);
});
