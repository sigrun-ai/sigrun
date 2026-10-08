/**
 * Crash-battery item 1 driver (plan Task 12 step 1, spec §7 M1 battery):
 * `kill -9` mid-streaming-generation → restart → the answer completes or is
 * marked aborted; no duplicate final answer.
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider slowed
 *    deterministically (`tokensPerSecond: 2`, `tokenSize` pinned), so the
 *    scripted long answer streams for ~2 minutes — a wide kill window.
 * 2. Submit one input (the scenario's only turn) and record its submission
 *    id in `<dir>/scenario.json` for the verify pass.
 * 3. Poll the LiveDoc (`pi.live`, a committed document read) until
 *    `generation.message` exists — the committed throttled partial of the
 *    in-flight response (generation.js streams partials as trailing writes
 *    at most every 100 ms). This is the chosen mid-generation observable:
 *    durable committed state, not process-local stream state.
 * 4. Print `GENERATING` (only after the partial is committed) and stay alive
 *    until SIGKILL — the test times the kill off this marker.
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume (openHarness), with a fresh faux
 *    provider scripted to answer fully and fast.
 * 2. Reacquire the killed submission, await settlement (deadline).
 * 3. Assert the terminal outcome is exactly one of completed / aborted, with
 *    NO duplicate final answer, and the view serializes; record which
 *    terminal outcome upstream chose plus the transcript shape.
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
	verifyFailed,
	verified,
	withDeadline,
	writeScenarioState,
} from "./lib.js";

/** The long answer the setup pass streams slowly (never completes before the kill). */
const SLOW_ANSWER = "slow streaming answer about crash recovery ".repeat(40);
/** The full answer the verify pass's fresh provider serves. */
const RECOVERED_ANSWER = "recovered final answer after mid-generation kill";

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
		marker("GENERATING");
		// Stay alive until the test's SIGKILL: the in-flight stream's timers
		// hold the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen, resume, and settle the killed submission.
	const opened = await bootScenarioHarness(dir, [
		fauxAssistantMessage(RECOVERED_ANSWER),
	]);
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

	// The structural view (spec §9.3): serializing it is itself an assertion.
	const viewState = await root.viewState(BACKGROUND_CONTEXT);
	const view = viewState.value;
	let serialized = "";
	try {
		serialized = JSON.stringify(view);
	} catch (error) {
		await viewState.dispose();
		return verifyFailed(`view does not serialize: ${String(error)}`);
	}
	await viewState.dispose();

	// A FINAL answer: a committed assistant entry that ended the turn
	// (`stopReason: "stop"`). The interrupted attempt's partial converts to
	// an "aborted" entry — visible state, but NOT a final answer, so it must
	// not count toward duplicates.
	const assistants = assistantMessages(view.entries);
	const finalAnswers = assistants.filter(
		(message) => message.stopReason === "stop",
	);
	const abortedPartials = assistants.filter(
		(message) => message.stopReason === "aborted",
	);
	const answerText = finalAnswers
		.flatMap((message) =>
			(message.content ?? []).filter(
				(block): block is { type: "text"; text: string } =>
					block.type === "text",
			),
		)
		.map((block) => block.text)
		.join("\n");

	const outcome = settled.status === "done" ? "completed" : "aborted";
	if (outcome === "completed") {
		if (finalAnswers.length !== 1) {
			return verifyFailed(
				`expected exactly one final answer after completion, found ${finalAnswers.length} (aborted partials: ${abortedPartials.length})`,
			);
		}
		if (!answerText.includes(RECOVERED_ANSWER)) {
			return verifyFailed(
				`the single final answer does not contain the recovered answer text (got: ${JSON.stringify(answerText)})`,
			);
		}
	} else if (finalAnswers.length !== 0) {
		// Aborted: no final answer may exist (the invariant is the absence of
		// duplicates — at most one answer entry per submission).
		return verifyFailed(
			`aborted outcome must carry no final answer, found ${finalAnswers.length}`,
		);
	}
	if (serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		outcome,
		settledStatus: settled.status,
		...(settled.status === "unanswered" ? { reason: settled.reason } : {}),
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
