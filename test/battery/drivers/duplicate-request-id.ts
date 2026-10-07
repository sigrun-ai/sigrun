/**
 * Crash-battery item 4 driver (plan Task 12 step 4, spec §7 M1 battery):
 * duplicate-`requestId` submit after a crash → single completion. The
 * idempotence contract (pi-durable submissions.d.ts): "A known request ID
 * returns its existing submission without writing."
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider slowed
 *    deterministically (`tokensPerSecond: 2`, `tokenSize` pinned) — the
 *    item-1 lever: the scripted long answer streams for ~2 minutes.
 * 2. Submit one input carrying `requestId: "req-1"`; record its submission
 *    id in `<dir>/scenario.json`.
 * 3. Print `ADMITTED` once `submit()` has resolved — the admission commit
 *    (the submission record + its requestId) is durable at that point.
 * 4. Poll the LiveDoc (`pi.live`) until the committed generation partial
 *    carries actual streamed TEXT (the item-1 mid-generation observable),
 *    print `GENERATING`, and stay alive until SIGKILL — the test times the
 *    kill off this marker, landing mid-generation with the requestId
 *    admitted.
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume, with a fresh faux factory
 *    serving the full answer for the recorded content.
 * 2. Reacquire the killed submission, await settlement (deadline).
 * 3. RESUBMIT the identical draft (same requestId + content): the contract
 *    must return the SAME submission (same id) without writing — assert
 *    same-id, and that no second run happened (still exactly one final
 *    answer and exactly one user entry for the content, view serializes).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, type Conversation, type SubmissionId } from "@earendil-works/pi-durable";
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

/** The request id the scenario deduplicates on. */
const REQUEST_ID = "req-1";
/** The turn's user content (the resubmit repeats it byte-for-byte). */
const CONTENT = "duplicate request marker: tell me about idempotence";
/** The long answer the setup pass streams slowly (never completes before the kill). */
const SLOW_ANSWER = "slow streaming answer about duplicate requests ".repeat(40);
/** The full answer the verify pass's fresh provider serves. */
const RECOVERED_ANSWER = "recovered answer for the duplicate request";

/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const PARTIAL_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 30_000;
/** Poll cadence for the committed-partial observable. */
const POLL_MS = 100;

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

/** The text of a user entry's first model message. */
function entryText(entry: { model?: readonly unknown[] }): string {
	const message = entry.model?.[0] as
		| { content?: string | { type?: string; text?: string }[] }
		| undefined;
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("");
}

/** The structural view snapshot + its serialization (itself an assertion). */
async function serializedView(
	root: Conversation,
): Promise<{
	serialized: string;
	entries: { kind: string; model?: readonly unknown[] }[];
}> {
	const viewState = await root.viewState(BACKGROUND_CONTEXT);
	const entries = viewState.value.entries as unknown as {
		kind: string;
		model?: readonly unknown[];
	}[];
	let serialized = "";
	try {
		serialized = JSON.stringify(viewState.value);
	} finally {
		await viewState.dispose();
	}
	return { serialized, entries };
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
			{ type: "input", content: CONTENT, requestId: REQUEST_ID },
			BACKGROUND_CONTEXT,
		);
		await writeScenarioState(dir, { submissionId: submission.id });
		// submit() resolved: the admission commit — the submission record
		// carrying requestId "req-1" — is durable.
		marker("ADMITTED");
		// The item-1 mid-generation observable: the committed throttled
		// partial must carry actual streamed text before the kill marker.
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
		marker("GENERATING");
		// Stay alive until the test's SIGKILL: the in-flight stream's timers
		// hold the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen, resume, settle, then resubmit the same requestId.
	// The faux queue serves ONE step per provider request, so the factory is
	// queued repeatedly (recovery retries and reorderings stay routed).
	const factory: FauxResponseFactory = (context) => {
		const text = JSON.stringify(context.messages);
		if (text.includes("duplicate request marker")) {
			return fauxAssistantMessage(RECOVERED_ANSWER);
		}
		return fauxAssistantMessage("unexpected request shape");
	};
	const opened = await bootScenarioHarness(
		dir,
		Array.from({ length: 8 }, () => factory),
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
	if (settled.status !== "done") {
		return verifyFailed(
			`recovered submission did not complete (status=${settled.status}${settled.status === "unanswered" ? ` reason=${settled.reason}` : ""})`,
		);
	}

	// The single-completion baseline BEFORE the resubmit.
	const before = await serializedView(root);
	const finalAnswersBefore = assistantMessages(before.entries).filter(
		(message) => message.stopReason === "stop",
	);
	const userEntriesBefore = before.entries.filter(
		(entry) =>
			entry.kind === "pi.user" && entryText(entry).includes("duplicate request marker"),
	);
	if (finalAnswersBefore.length !== 1 || userEntriesBefore.length !== 1) {
		return verifyFailed(
			`recovery produced ${finalAnswersBefore.length} final answers and ${userEntriesBefore.length} user entries for the content (expected exactly one of each)`,
		);
	}
	const answerText = finalAnswersBefore[0]
		? (finalAnswersBefore[0].content ?? [])
				.filter(
					(block): block is { type: "text"; text: string } =>
						block.type === "text",
				)
				.map((block) => block.text)
				.join("\n")
		: "";
	if (!answerText.includes(RECOVERED_ANSWER)) {
		return verifyFailed(
			`the final answer does not contain the recovered text (got: ${JSON.stringify(answerText)})`,
		);
	}

	// THE resubmit: identical requestId + content. The idempotence contract
	// returns the existing submission without writing.
	const resubmitted = await root.submit(
		{ type: "input", content: CONTENT, requestId: REQUEST_ID },
		BACKGROUND_CONTEXT,
	);
	const sameId = resubmitted.id === (state.submissionId as SubmissionId);
	if (!sameId) {
		return verifyFailed(
			`duplicate requestId resubmit created a NEW submission (${String(resubmitted.id)}) instead of returning the existing one (${String(state.submissionId)})`,
		);
	}
	const resubmittedSettled = await withDeadline(
		resubmitted.wait(BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"resubmitted submission settlement",
	);

	// No second run: still exactly one final answer and one user entry.
	const after = await serializedView(root);
	const finalAnswersAfter = assistantMessages(after.entries).filter(
		(message) => message.stopReason === "stop",
	);
	const userEntriesAfter = after.entries.filter(
		(entry) =>
			entry.kind === "pi.user" && entryText(entry).includes("duplicate request marker"),
	);
	if (finalAnswersAfter.length !== 1 || userEntriesAfter.length !== 1) {
		return verifyFailed(
			`the resubmit produced a second run (${finalAnswersAfter.length} final answers, ${userEntriesAfter.length} user entries for the content)`,
		);
	}
	if (after.serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		dedupReturnedSameId: sameId,
		settledStatus: settled.status,
		resubmitSettledStatus: resubmittedSettled.status,
		sameAnswerEntry: settled.answer === resubmittedSettled.answer,
		finalAnswers: finalAnswersAfter.length,
		userEntriesForContent: userEntriesAfter.length,
	});
}

main().catch((error) => {
	// The driver crashed without reaching a verify assertion: fail loud
	// with a non-zero exit (the test sees the code + this stderr).
	process.stderr.write(`driver crashed: ${String(error)}\n`);
	process.exit(1);
});
