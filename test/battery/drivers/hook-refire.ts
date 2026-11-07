/**
 * Crash-battery item 6 driver (plan Task 12 step 6, spec §7 M1 battery):
 * `kill -9` mid-streaming-generation while a `GenerationHooks.afterResponse`
 * hook is installed → restart → count the hook's ACTUAL fires across both
 * processes. The OBSERVED count is the payload. Under pi-durable 1.5.0 the
 * kill lands while the request is in flight, so the terminal provider
 * message NEVER arrives in the killed process, and with the recovery
 * pass's retry pinned (`maxRetries: 0`) the run ends `unanswered`
 * reason `interrupted` — `afterResponse` fires ONLY on a terminal
 * provider message, and an interrupted run never produces one, so the
 * 1.5.0 outcome is ZERO fires: the memory extension's observe guard
 * (a durable memo keyed by generation id) stays DEFENSIVE-ONLY — the
 * hook cannot re-fire for a killed turn, because the turn never
 * classifies a terminal message at all.
 *
 * setup mode:
 * 1. Run ONE fast CONTROL turn in an ISOLATED harness (its own tmpdir):
 *    the hook MUST fire exactly once for it — positive evidence the hook
 *    is loaded and working, so the crash pass's zero-fire assertion
 *    cannot pass vacuously with an absent/broken hook. The control
 *    harness writes its fires to the scenario dir's marker file but its
 *    conversations to its own storage, so the scenario conversation's
 *    history stays clean.
 * 2. Boot the scenario harness on `<dir>/sigrun.db` with the faux
 *    provider slowed deterministically (`tokensPerSecond: 2`,
 *    `tokenSize` pinned) — the item-1 lever: the scripted long answer
 *    streams for ~2 minutes.
 * 3. Install an extension carrying a `GenerationHooks.afterResponse` hook
 *    (via `hook(GenerationTask, { afterResponse })` — .d.ts-verified shape:
 *    `afterResponse(message, api, context)`). The hook appends one line to
 *    `<dir>/hook-fires.count` on EVERY invocation — the T12a execution-marker
 *    pattern, one line per fire, across both processes.
 * 4. Submit one input; poll the LiveDoc until the committed generation
 *    partial carries actual streamed text (the item-1 mid-generation
 *    observable), wait STORE_SETTLE_MS (the 1.5.0 deferred-persistence
 *    window — `settings.progress.persistWithinMs` default 1,000 ms — so
 *    the kill lands after STORED progress, not just shown progress),
 *    print `GENERATING`, and stay alive until SIGKILL. The kill lands
 *    mid-token-stream: the terminal provider message NEVER arrives in
 *    this process, so `afterResponse` cannot fire in setup.
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume (same hook installed), with
 *    retry pinned to `maxRetries: 0` (1.5.0: the interrupted attempt is
 *    never resent, so the run ends `unanswered` reason `interrupted`
 *    deterministically).
 * 2. Reacquire the killed submission, await settlement (deadline).
 * 3. Count the hook fires in the marker file. The setup CONTROL turn
 *    proves the hook works (exactly one fire before the crash scenario);
 *    the crash pass must add ZERO — 1.5.0: an interrupted run has NO
 *    terminal provider message, so `afterResponse` never fires. The
 *    observe-guard conclusion is defensive-only (no re-fire is possible
 *    without a classification).
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
	STORE_SETTLE_MS,
	verifyFailed,
	verified,
	withDeadline,
	writeScenarioState,
} from "./lib.js";

/** The long answer the setup pass streams slowly (never completes before the kill). */
const SLOW_ANSWER = "slow streaming answer for the hook fire count ".repeat(40);
/** The scripted answer a regression's resend would serve (1.5.0 must never consume it). */
const RECOVERED_ANSWER = "resent answer — must never be served";

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
		// CONTROL TURN (non-vacuity): one fast, settled turn in an ISOLATED
		// harness (its own tmpdir — the control conversation must NOT share
		// the scenario's history) with the hook writing to the scenario
		// dir's marker file. The hook MUST fire exactly once, proving the
		// registration works before the crash scenario's zero-fire assertion
		// can mean anything.
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const controlDir = await mkdtemp(join(tmpdir(), "sigrun-hook-control-"));
		try {
			const control = await bootScenarioHarness(controlDir, [
				fauxAssistantMessage("control answer"),
			]);
			control.registry.install(hookExtension(dir));
			const controlRoot = await control.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: control.defaultModel },
			});
			const controlSubmission = await controlRoot.submit(
				{ type: "input", content: "control turn" },
				BACKGROUND_CONTEXT,
			);
			await withDeadline(
				controlSubmission.wait(BACKGROUND_CONTEXT),
				SETTLE_DEADLINE_MS,
				"control turn settlement",
			);
			await control.harness.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(controlDir, { recursive: true, force: true });
		}
		const controlFires = await hookFires(dir);
		if (controlFires.length !== 1) {
			await verifyFailed(
				`the control turn produced ${controlFires.length} afterResponse fires (expected exactly one — a working hook registration is the non-vacuity precondition for the crash pass's zero-fire assertion)`,
			);
		}

		const opened = await bootScenarioHarness(
			dir,
			[fauxAssistantMessage(SLOW_ANSWER)],
			{ tokensPerSecond: 2, tokenSize: { min: 8, max: 8 } },
			// 1.5.0 pin (matching the recovery pass): no retry attempt, so a
			// regression that retried could not mask the hook accounting.
			{ retry: { maxRetries: 0 } },
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
		// Belt-and-braces non-vacuity: the hook must NOT have fired for the
		// SCENARIO conversation in setup (if it had, the kill point was not
		// mid-stream — a vacuous run). The control turn's one fire predates
		// the scenario (and lives in a different conversation), so the crash
		// pass's count is the file total minus the control's one.
		const setupFires = await hookFires(dir);
		if (setupFires.length !== 1) {
			await verifyFailed(
				`expected exactly the control turn's one fire before the kill marker, found ${setupFires.length} — the scenario conversation's hook fired in setup (kill not mid-stream) or the control evidence drifted`,
			);
		}
		// 1.5.0 deferred persistence: the partial is SHOWN at once but STORED
		// only within settings.progress.persistWithinMs (default 1,000 ms) —
		// the kill marker waits the store window plus slack so the kill lands
		// after STORED progress (STORE_SETTLE_MS, drivers/lib.ts).
		await new Promise((resolve) => setTimeout(resolve, STORE_SETTLE_MS));
		marker("GENERATING");
		// Stay alive until the test's SIGKILL: the in-flight stream's timers
		// hold the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen, resume, settle the killed submission, count fires.
	// 1.5.0: retry pinned to maxRetries 0 — the interrupted attempt is NEVER
	// resent, so the run ends `unanswered` reason `interrupted`.
	const opened = await bootScenarioHarness(
		dir,
		[fauxAssistantMessage(RECOVERED_ANSWER)],
		undefined,
		{ retry: { maxRetries: 0 } },
	);
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
	if (
		settled.status !== "unanswered" ||
		(settled as { reason?: string }).reason !== "interrupted"
	) {
		return verifyFailed(
			`expected the killed submission to settle unanswered/interrupted under the pinned retry policy (status=${settled.status}${settled.status === "unanswered" ? ` reason=${settled.reason}` : ""}) — 1.5.0 never resends the in-flight request`,
		);
	}
	// `pi.live.run` must clear (the conversation is NOT stuck busy); the
	// run-ending commit can publish a beat after the wait resolves — poll.
	let live = await opened.harness.snapshot(
		LiveDoc,
		root.id,
		BACKGROUND_CONTEXT,
	);
	const failureDeadline = Date.now() + SETTLE_DEADLINE_MS;
	while (live?.runFailure === undefined) {
		if (Date.now() > failureDeadline) {
			return verifyFailed(
				`pi.live.runFailure never appeared after the interrupted run settled (live: ${JSON.stringify(live)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		live = await opened.harness.snapshot(
			LiveDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
	}
	if (live?.run !== undefined) {
		return verifyFailed(
			`pi.live.run is still set after the interrupted run settled — the conversation is stuck busy`,
		);
	}
	if (live?.runFailure?.reason !== "interrupted") {
		return verifyFailed(
			`expected pi.live.runFailure.reason "interrupted" (got ${JSON.stringify(live?.runFailure)})`,
		);
	}

	// The fire count: ONE line per actual afterResponse invocation across
	// BOTH processes, minus the control turn's one (the control proves the
	// hook works; the crash pass must add ZERO — 1.5.0: an interrupted run
	// has NO terminal provider message, so afterResponse never fires).
	const fires = (await hookFires(dir)).length - 1;
	if (fires !== 0) {
		return verifyFailed(
			`the afterResponse hook fired ${fires}x for the interrupted run (expected 0 — 1.5.0: no resend, no terminal message, no afterResponse)`,
		);
	}
	const observeGuard =
		"defensive-only: afterResponse never fires for an interrupted run (1.5.0: the in-flight request is a failed attempt, never resent; with no retry left the run ends interrupted with NO terminal provider message — the hook's only fire point never occurs)";

	// The stored partial converts to exactly one aborted entry; no final
	// answer exists (never resent). The view's entries are the SCENARIO
	// conversation's window — the control turn's answer lives in its own
	// conversation, so any final answer here is a resend regression.
	const watch = await root.watch(BACKGROUND_CONTEXT);
	const view = watch.value;
	const assistants = assistantMessages(
		view.entries as unknown as { kind: string; model?: readonly unknown[] }[],
	);
	const finalAnswers = assistants.filter(
		(message) => message.stopReason === "stop",
	);
	const abortedPartials = assistants.filter(
		(message) => message.stopReason === "aborted",
	);
	let serialized = "";
	try {
		serialized = JSON.stringify(view);
	} catch (error) {
		await watch.stop();
		return verifyFailed(`view does not serialize: ${String(error)}`);
	}
	await watch.stop();
	if (finalAnswers.length !== 0) {
		return verifyFailed(
			`expected NO final answer for the interrupted run (1.5.0 never resends), found ${finalAnswers.length}`,
		);
	}
	if (abortedPartials.length !== 1) {
		return verifyFailed(
			`expected exactly one aborted entry from the stored interrupted partial, found ${abortedPartials.length}`,
		);
	}
	if (serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		settledStatus: settled.status,
		reason: (settled as { reason?: string }).reason,
		runFailureReason: live?.runFailure?.reason,
		runCleared: live?.run === undefined,
		hookFires: fires,
		observeGuard,
		finalAnswers: finalAnswers.length,
		abortedPartials: abortedPartials.length,
		entries: view.entries.length,
	});
}

main().catch((error) => {
	// The driver crashed without reaching a verify assertion: fail loud
	// with a non-zero exit (the test sees the code + this stderr).
	process.stderr.write(`driver crashed: ${String(error)}\n`);
	process.exit(1);
});
