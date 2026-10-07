/**
 * Crash-battery item 5 driver (plan Task 12 step 5, spec §7 M1 battery):
 * submit-while-busy — the named queue-semantics verification. OBSERVE and
 * record what the default `whenBusy` admission does, verify nothing is
 * lost across a crash with a submission durably queued, and record the
 * explicit `whenBusy: "steer"` and `whenBusy: "reject"` variants.
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider slowed
 *    deterministically (`tokensPerSecond: 2`, `tokenSize` pinned) — the
 *    item-1 lever: the first turn's answer streams for ~2 minutes.
 * 2. Submit the first input (the running turn), wait for its committed
 *    generation partial to carry streamed text (item-1 observable).
 * 3. Submit the SECOND input with NO `whenBusy` (the default admission).
 *    Upstream queues it in `pi.inbox` with mode `steer`|`followUp` (the
 *    observed default — record which), status `queued`.
 * 4. Wait until ALL hold — the inbox item listed, the record `queued`, and
 *    the first generation's partial still carries text — then print
 *    `QUEUED:<mode>` and stay alive until SIGKILL. The kill lands with the
 *    queued submission durably admitted behind the streaming turn.
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume (also slowed: the busy-stream
 *    lever below needs it). Both submissions must recover: the crashed
 *    first turn completes, and the queued second submission reaches an
 *    honest terminal state (`done` with an answer, or `unanswered` with a
 *    reason — never stuck, never silently lost).
 * 2. Then observe the EXPLICIT variants on a FRESH ownerless conversation
 *    (single-process observation, no kill — the brief allows it): its first
 *    input consumes a content-routed LONG answer (streamed slowly → busy),
 *    then `whenBusy: "steer"` (must queue, inbox mode `steer`) and
 *    `whenBusy: "reject"` (must throw `ConversationBusy`, nothing written —
 *    upstream's admitSubmission throws before any table write).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
	ConversationBusy,
	InboxDoc,
	LiveDoc,
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

/** The first (running) turn's content marker. */
const FIRST_MARKER = "submit-while-busy first turn";
/** The second (submitted-while-busy) input's content marker. */
const SECOND_MARKER = "submit-while-busy second input";
/** The long answer the setup pass streams slowly (never completes before the kill). */
const SLOW_ANSWER = "slow streaming answer while a second input queues ".repeat(40);
/** The long answer that keeps the steer/reject variant conversation busy. */
const VARIANT_BUSY_ANSWER = "variant busy stream ".repeat(220);
/** The answer the verify pass serves for either scenario marker. */
const RECOVERED_ANSWER = "recovered answer after submit-while-busy crash";

/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const PARTIAL_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 30_000;
/** Poll cadence for observables. */
const POLL_MS = 100;

/**
 * Content-discriminating faux factory: the variant conversation's request
 * (its transcript contains the variant marker) gets the LONG answer —
 * streamed slowly, so the conversation stays busy for the observations;
 * the root conversation's recovery markers get the recovered answer. The
 * faux queue serves ONE step per provider request, so the same factory is
 * queued repeatedly.
 */
function variantFactory(): FauxResponseFactory {
	return (context) => {
		const text = JSON.stringify(context.messages);
		if (text.includes("variant")) {
			return fauxAssistantMessage(VARIANT_BUSY_ANSWER);
		}
		if (text.includes(FIRST_MARKER) || text.includes(SECOND_MARKER)) {
			return fauxAssistantMessage(RECOVERED_ANSWER);
		}
		return fauxAssistantMessage("unexpected request shape");
	};
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
		const first = await root.submit(
			{ type: "input", content: FIRST_MARKER },
			BACKGROUND_CONTEXT,
		);
		// The item-1 observable: the running turn is genuinely streaming.
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
		// The second input: NO whenBusy — the default admission. The
		// conversation is busy (the run is streaming), so it must queue.
		const second = await root.submit(
			{ type: "input", content: SECOND_MARKER },
			BACKGROUND_CONTEXT,
		);
		// Record the observed queue mode + the durable status.
		const inbox = await opened.harness.snapshot(
			InboxDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
		const item = (inbox?.items ?? []).find(
			(candidate) => candidate.mode !== "write" && candidate.id === second.id,
		);
		if (item === undefined) {
			return verifyFailed(
				"the default-whenBusy second input is not listed in pi.inbox after admission",
			);
		}
		const observedMode = item.mode;
		const secondStatus = await second.status(BACKGROUND_CONTEXT);
		if (secondStatus.status !== "queued") {
			return verifyFailed(
				`the default-whenBusy second input's durable status is ${secondStatus.status}, expected queued`,
			);
		}
		await writeScenarioState(dir, {
			submissionId: first.id,
			secondSubmissionId: second.id,
			observedDefaultMode: observedMode,
			secondInitialStatus: secondStatus.status,
		});
		marker(`QUEUED:${observedMode}`);
		// Stay alive until the test's SIGKILL: the in-flight stream's timers
		// hold the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen, resume (slowed — the variant busy lever needs
	// it), recover BOTH submissions, then observe the explicit variants.
	const opened = await bootScenarioHarness(
		dir,
		Array.from({ length: 8 }, variantFactory),
		{ tokensPerSecond: 2, tokenSize: { min: 8, max: 8 } },
	);
	const state = await readScenarioState(dir);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);

	const first = await opened.harness.submission(
		state.submissionId as SubmissionId,
		BACKGROUND_CONTEXT,
	);
	if (first === undefined) {
		return verifyFailed(
			`first submission ${String(state.submissionId)} not found after reopen`,
		);
	}
	const firstSettled = await withDeadline(
		first.wait(BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"first (crashed mid-generation) submission settlement",
	);
	if (firstSettled.status !== "done") {
		return verifyFailed(
			`the crashed first turn did not complete after recovery (status=${firstSettled.status}${firstSettled.status === "unanswered" ? ` reason=${firstSettled.reason}` : ""})`,
		);
	}

	const second = await opened.harness.submission(
		state.secondSubmissionId as SubmissionId,
		BACKGROUND_CONTEXT,
	);
	if (second === undefined) {
		return verifyFailed(
			`queued submission ${String(state.secondSubmissionId)} not found after reopen`,
		);
	}
	// The queued submission must reach an honest terminal state — never
	// stuck, never silently aborted away.
	const secondSettled = await withDeadline(
		second.wait(BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"queued submission settlement after recovery",
	);
	const secondHonest =
		secondSettled.status === "done" ||
		(secondSettled.status === "unanswered" &&
			typeof secondSettled.reason === "string" &&
			secondSettled.reason.length > 0 &&
			secondSettled.reason !== "aborted");
	if (!secondHonest) {
		return verifyFailed(
			`queued submission did not reach an honest terminal state: ${JSON.stringify(secondSettled)}`,
		);
	}

	// Wait for the root conversation's ordinary scope to go idle before the
	// variant observations (they use a FRESH conversation, so cross-talk is
	// impossible — idle is belt-and-braces for queue determinism).
	await withDeadline(
		root.waitForIdle(BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"root conversation idle",
	);

	// The variant conversation: its first input streams the LONG answer
	// (~3520 chars ≈ 440 tokens ≈ 220s at 2 tokens/s) → busy for well past
	// the observations below.
	const variant = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	const variantFirst = await variant.submit(
		{ type: "input", content: "variant first turn busy stream" },
		BACKGROUND_CONTEXT,
	);
	const variantLive = await opened.harness.snapshot(
		LiveDoc,
		variant.id,
		BACKGROUND_CONTEXT,
	);
	if (variantLive?.run === undefined) {
		return verifyFailed(
			"the variant conversation has no live run after its first submit (busy lever failed)",
		);
	}

	// whenBusy: "steer" — must queue with inbox mode "steer".
	const steerSecond = await variant.submit(
		{
			type: "input",
			content: "variant second input steer",
			whenBusy: "steer",
		},
		BACKGROUND_CONTEXT,
	);
	const steerInbox = await opened.harness.snapshot(
		InboxDoc,
		variant.id,
		BACKGROUND_CONTEXT,
	);
	const steerItem = (steerInbox?.items ?? []).find(
		(candidate) => candidate.mode !== "write" && candidate.id === steerSecond.id,
	);
	if (steerItem === undefined) {
		return verifyFailed(
			'whenBusy "steer" input was not queued in pi.inbox while busy',
		);
	}
	if (steerItem.mode !== "steer") {
		return verifyFailed(
			`whenBusy "steer" input queued with inbox mode ${String(steerItem.mode)}, expected steer`,
		);
	}

	// whenBusy: "reject" — must throw ConversationBusy and write nothing
	// (upstream throws before the commit's first table write).
	let rejected = false;
	let rejectError: unknown = undefined;
	try {
		await variant.submit(
			{
				type: "input",
				content: "variant second input reject",
				whenBusy: "reject",
			},
			BACKGROUND_CONTEXT,
		);
	} catch (error) {
		rejected = error instanceof ConversationBusy;
		rejectError = error;
	}
	if (!rejected) {
		return verifyFailed(
			`whenBusy "reject" did not throw ConversationBusy (got: ${String(rejectError)})`,
		);
	}
	// Nothing written: no inbox item and no submission for the reject draft.
	const rejectInbox = await opened.harness.snapshot(
		InboxDoc,
		variant.id,
		BACKGROUND_CONTEXT,
	);
	if (
		(rejectInbox?.items ?? []).some(
			(candidate) => candidate.mode !== "write",
		)
	) {
		// (the steer item legitimately remains — only a SECOND non-write
		// item would be a written reject)
		const userItems = (rejectInbox?.items ?? []).filter(
			(candidate) => candidate.mode !== "write",
		);
		if (userItems.length !== 1) {
			return verifyFailed(
				`whenBusy "reject" wrote inbox items (${userItems.length} user items after the reject attempt; only the steer item may exist)`,
			);
		}
	}

	// The variant conversation never settles (its stream runs past this
	// process's purpose) — verified() hard-exits 0, so no close is needed
	// and none is attempted (close would await the live run; the hard exit
	// is exactly the crash-battery semantics, and every assertion-relevant
	// commit is already durable).
	void variantFirst;
	return verified({
		observedDefaultMode: state.observedDefaultMode,
		secondInitialStatus: state.secondInitialStatus,
		firstSettledStatus: firstSettled.status,
		secondSettledStatus: secondSettled.status,
		...(secondSettled.status === "unanswered"
			? { secondReason: secondSettled.reason }
			: {}),
		steerObservedMode: steerItem.mode,
		rejectRejected: rejected,
	});
}

main().catch((error) => {
	// The driver crashed without reaching a verify assertion: fail loud
	// with a non-zero exit (the test sees the code + this stderr).
	process.stderr.write(`driver crashed: ${String(error)}\n`);
	process.exit(1);
});
