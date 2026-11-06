/**
 * Crash-battery item 1 driver (plan Task 12 step 1, spec §7 M1 battery):
 * `kill -9` mid-streaming-generation → restart → the answer completes or is
 * marked aborted; no duplicate final answer.
 *
 * 1.5.0 crash semantics (spec §3.2-e, upstream #11139): a generation
 * whose request was in flight at the kill is NEVER resent — it counts as
 * a failed attempt under `settings.retry` (pinned `maxRetries: 0` here,
 * so the run's outcome is deterministic), and with no retry left the run
 * ends `unanswered` with `pi.live.runFailure.reason === "interrupted"`.
 * The interrupted attempt's STORED partial (the kill lands after
 * STORE_SETTLE_MS, so the first deferred store happened) converts to an
 * `aborted` assistant entry.
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider slowed
 *    deterministically (`tokensPerSecond: 2`, `tokenSize` pinned), so the
 *    scripted long answer streams for ~2 minutes — a wide kill window.
 *    `settings.retry.maxRetries: 0` pins the 1.5.0 interrupted outcome
 *    (no retry attempt races the settle deadline on a slow machine).
 * 2. Submit one input (the scenario's only turn) and record its submission
 *    id in `<dir>/scenario.json` for the verify pass.
 * 3. Poll the LiveDoc (`pi.live`, a committed document read) until
 *    `generation.message` carries streamed text, then wait STORE_SETTLE_MS
 *    (the 1.5.0 deferred-persistence window — `settings.progress.
 *    persistWithinMs` default 1,000 ms — plus slack) so the partial is
 *    STORED, not just shown: a crash before the first store would leave
 *    no aborted entry and this scenario would assert nothing.
 * 4. Print `GENERATING` (only after the partial is stored) and stay alive
 *    until SIGKILL — the test times the kill off this marker.
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume (openHarness), with a fresh
 *    faux provider scripted to answer fully and fast.
 * 2. Reacquire the killed submission, await settlement (deadline).
 * 3. Assert the 1.5.0 terminal outcome: settled `unanswered` reason
 *    `interrupted` with `pi.live.runFailure.reason === "interrupted"`, no
 *    final answer, exactly one aborted entry (the stored partial), and
 *    `pi.live.run === undefined` (the conversation is NOT stuck busy);
 *    the view serializes.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, type SubmissionId } from "@earendil-works/pi-durable";
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
const SLOW_ANSWER = "slow streaming answer about crash recovery ".repeat(40);

/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const PARTIAL_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 30_000;

/** The assistant messages of the committed `pi.assistant` entries, oldest-first. */
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
			// 1.5.0: the killed in-flight request is a FAILED ATTEMPT under
			// settings.retry, never resent. maxRetries 0 pins the
			// runFailure "interrupted" outcome — no retry attempt can race
			// the verify pass's settle deadline.
			{ retry: { maxRetries: 0 } },
		);
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		marker("READY");
		const submission = await root.submit(
			{ type: "input", content: "tell me about crash recovery" },
			BACKGROUND_CONTEXT,
		);
		await writeScenarioState(dir, { submissionId: submission.id });
		// Mid-generation observable: poll the committed LiveDoc read until the
		// throttled partial carries actual streamed TEXT (the empty start-event
		// partial commits within ~100ms; the first text delta lands ~4s in at
		// tokensPerSecond 2 — waiting for text makes the kill unambiguously
		// mid-token-stream, with minutes of streaming left to be interrupted).
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
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		// 1.5.0 deferred persistence: the partial is SHOWN at once but STORED
		// only within settings.progress.persistWithinMs (default 1,000 ms).
		// The kill observable must be STORED state — a crash before the first
		// store leaves no aborted entry — so the kill marker waits the store
		// window plus slack (STORE_SETTLE_MS, drivers/lib.ts).
		await new Promise((resolve) => setTimeout(resolve, STORE_SETTLE_MS));
		marker("GENERATING");
		// Stay alive until the test's SIGKILL: the in-flight stream's timers
		// hold the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen and settle the killed submission. The fresh
	// provider scripts one answer, but 1.5.0 NEVER resends the interrupted
	// request — the scripted response exists only to fail loudly (fast) if a
	// regression DOES resend (the answer would land as a second final answer
	// the assertions below reject).
	const opened = await bootScenarioHarness(
		dir,
		[fauxAssistantMessage("resent answer — must never be served")],
		undefined,
		{ retry: { maxRetries: 0 } },
	);
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

	// 1.5.0: the in-flight request is never resent; the run ends
	// `unanswered` reason "interrupted" (retry was pinned to maxRetries 0),
	// the STORED partial converts to exactly one aborted entry, and
	// `pi.live.run` clears (the conversation is NOT stuck busy).
	// `runFailure` is set by the run-ending commit, which can publish a
	// beat after the submission wait resolves — poll it with a deadline.
	let live = await opened.harness.snapshot(
		LiveDoc,
		root.id,
		BACKGROUND_CONTEXT,
	);
	const runFailureDeadline = Date.now() + SETTLE_DEADLINE_MS;
	while (live?.runFailure === undefined) {
		if (Date.now() > runFailureDeadline) {
			return verifyFailed(
				`pi.live.runFailure never appeared after the interrupted run settled (live: ${JSON.stringify(live)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		live = await opened.harness.snapshot(
			LiveDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
	}
	if (live?.run !== undefined) {
		return verifyFailed(
			`pi.live.run is still set after the interrupted run settled — the conversation is stuck busy (run: ${JSON.stringify(live.run)})`,
		);
	}
	if (live?.runFailure?.reason !== "interrupted") {
		return verifyFailed(
			`expected pi.live.runFailure.reason "interrupted" after the mid-generation kill (got ${JSON.stringify(live?.runFailure)})`,
		);
	}
	if (
		settled.status !== "unanswered" ||
		(settled as { reason?: string }).reason !== "interrupted"
	) {
		return verifyFailed(
			`expected the killed submission to settle unanswered/interrupted (status=${settled.status}${settled.status === "unanswered" ? ` reason=${settled.reason}` : ""}) — 1.5.0 never resends the in-flight request`,
		);
	}

	// The structural view (spec §9.3): serializing it is itself an assertion.
	const watch = await root.watch(BACKGROUND_CONTEXT);
	const view = watch.value;
	let serialized = "";
	try {
		serialized = JSON.stringify(view);
	} catch (error) {
		await watch.stop();
		return verifyFailed(`view does not serialize: ${String(error)}`);
	}
	await watch.stop();

	// The interrupted attempt's stored partial converts to an "aborted"
	// assistant entry — visible state, and NOT a final answer (1.5.0: no
	// resend means no recovered answer exists).
	const assistants = assistantMessages(view.entries);
	const finalAnswers = assistants.filter(
		(message) => message.stopReason === "stop",
	);
	const abortedPartials = assistants.filter(
		(message) => message.stopReason === "aborted",
	);
	if (finalAnswers.length !== 0) {
		return verifyFailed(
			`the interrupted outcome must carry no final answer (1.5.0 never resends), found ${finalAnswers.length}`,
		);
	}
	if (abortedPartials.length !== 1) {
		return verifyFailed(
			`expected exactly one aborted assistant entry from the stored interrupted partial, found ${abortedPartials.length} (a crash before the first store leaves none — the kill marker waits STORE_SETTLE_MS, so zero here means the persistence rule regressed)`,
		);
	}
	if (serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		outcome: "aborted",
		settledStatus: settled.status,
		reason: (settled as { reason?: string }).reason,
		runFailureReason: live?.runFailure?.reason,
		runCleared: live?.run === undefined,
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
