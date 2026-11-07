/**
 * Crash-battery item 3 driver (plan Task 12 step 3, spec §7 M1 battery,
 * Review Focus #5; 1.5.0 crash semantics per spec §3.2-e): `kill -9`
 * during a background compaction → the restart-limited compaction no
 * longer parks nor re-runs: with `settings.restartLimit` pinned to 1,
 * the FIRST recovery ENDS the cut-off compaction task into
 * `pi.live.compactionFailure` (visible state; the summarize request
 * fired in SETUP only — it is never re-requested), NO summary entry is
 * ever placed (no half-written summary is possible), the committed
 * turns stay intact, the view serializes, and subsequent submits
 * succeed.
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider slowed
 *    deterministically (`tokensPerSecond: 2`, `tokenSize` pinned) and the
 *    compaction policy forced through the OpenHarnessOptions.settings seam.
 *    Band 2200..5000 (`contextWindow - reserveTokens` = 5000 blocking;
 *    background floor 2200 via `backgroundTokens: 2_800`),
 *    `keepRecentTokens: 1`. Calibration is against the MEASURED-USAGE
 *    baseline: upstream's estimateContext reads the last assistant
 *    message's totalTokens, and the faux provider's simulated cache
 *    counts prompt tokens in cacheWrite (input 0), inflating totalTokens
 *    to ~2× the prompt — warm-up measured ≈2142, turn 2 ≈2505 (see the
 *    inline comment at the settings object). A short warm-up turn stays
 *    under the band; turn 2 (baseline plus filler) lands inside it, so
 *    upstream creates a conversation-owned BACKGROUND compaction task
 *    while turn 2's generation proceeds.
 * 2. All faux responses are content-discriminating factories: the
 *    summarizer's request serializes the pre-cut transcript (it contains the
 *    warm-up ANSWER text but never turn 2's marker), so routing needs no
 *    assumption about which request consumes the queue first. The summarizer
 *    branch appends `<mode>` to `<dir>/summarize-request.count` — the T12a
 *    execution-marker pattern, one line per actual summarize request.
 * 3. Poll until ALL hold: turn 2 settled `done` (durable record), the
 *    LiveDoc `pi.live` lists a compaction task (durable doc), the summarize
 *    request has STARTED (a `setup` line in the marker file), and NO
 *    `pi.compaction` entry exists yet (it has not completed). Then print
 *    `COMPACTING` and stay alive until SIGKILL — the kill lands while the
 *    summarizer streams (~3 minutes of scripted summary at 2 tokens/s; the
 *    marker fires within ~10s of boot).
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume, with `restartLimit: 1`
 *    pinned: the cut-off compaction task is at the limit, so it ENDS.
 * 2. `waitForTask` the recorded compaction task → its outcome is FAILED
 *    (restart-limited), and `pi.live.compactionFailure` records it
 *    (polled with a deadline — the task-settling commit can publish a
 *    beat after the wait resolves).
 * 3. Assert: ZERO `pi.compaction` entries (no summary — half-written is
 *    impossible by construction: the verify summarizer is never asked),
 *    the summarize marker file shows the request fired in SETUP ONLY
 *    (`["setup"]`), the pre-kill turns are all present, the view
 *    serializes, and a subsequent submit settles `done`.
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
	LiveDoc,
	type CompactionResult,
	type Conversation,
	type SubmissionId,
	type TaskId,
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

/** The warm-up turn's user marker and answer. */
const WARM_MARKER = "warm up";
const WARM_ANSWER = "warm-up answer";
/** Turn 2's user marker (identical filler sizing to the green background test). */
const TURN2_MARKER = "long question";
const TURN2_ANSWER = "second answer quick";
/** The post-kill turn's marker and answer (the "subsequent submit succeeds" leg). */
const TURN3_MARKER = "third question after compaction";
const TURN3_ANSWER = "third answer";
/**
 * The summary the SETUP pass streams slowly (~375 tokens at 8 chars/token =
 * ~187s at 2 tokens/s — the wide kill window). Deliberately free of every
 * discriminator marker.
 */
const SETUP_SUMMARY = `background compaction summary payload ${"s".repeat(2_800)}`;

/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const COMPACTION_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 30_000;
/** Deadline for the verify pass's pi.live.compactionFailure poll. */
const COMPACTION_FAILURE_DEADLINE_MS = 15_000;
/** Poll cadence for the setup conditions and the verify compactionFailure poll. */
const POLL_MS = 100;

/** The shape the driver reads from a conversation's history entries. */
type EntryLike = {
	id: unknown;
	kind: string;
	model?: readonly unknown[];
	data?: unknown;
};

/** One summarize-request marker line appended per actual request. */
function countSummarizeRequest(dir: string, mode: string): void {
	appendFileSync(join(dir, "summarize-request.count"), `${mode}\n`);
}

/** The summarize-request marker lines, in order. */
async function summarizeRequests(dir: string): Promise<string[]> {
	try {
		const content = await readFile(
			join(dir, "summarize-request.count"),
			"utf8",
		);
		return content.split("\n").filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

/**
 * Content-discriminating faux responses: the newest request's marker wins.
 * Turn 3's request is checked first (its transcript carries the placed
 * summary), then turn 2's (the summarizer's transcript predates it), then
 * the warm-up answer (only the summarizer's serialized transcript contains
 * it — a generation request for the warm-up turn cannot contain its own
 * answer), else the warm-up generation itself. The faux queue serves ONE
 * step per provider request (steps are consumed, never cycled), so the same
 * factory is queued repeatedly — retries and reorderings stay routed.
 */
function routingResponses(
	dir: string,
	mode: "setup" | "verify",
	copies = 8,
): FauxResponseFactory[] {
	const summarizer = () => {
		countSummarizeRequest(dir, mode);
		return fauxAssistantMessage(SETUP_SUMMARY);
	};
	return Array.from(
		{ length: copies },
		() =>
			(context: Parameters<FauxResponseFactory>[0]) => {
				const text = JSON.stringify(context.messages);
				if (text.includes(TURN3_MARKER)) {
					return fauxAssistantMessage(TURN3_ANSWER);
				}
				if (text.includes(TURN2_MARKER)) {
					return fauxAssistantMessage(TURN2_ANSWER);
				}
				if (text.includes(WARM_ANSWER)) {
					return summarizer();
				}
				return fauxAssistantMessage(WARM_ANSWER);
			},
	);
}

/** The text of an entry's first model message, flattening content blocks. */
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

/** The conversation's entries, newest-first (fork-aware history query). */
async function conversationEntries(root: Conversation): Promise<EntryLike[]> {
	const page = await root.entries({}, 200, undefined, BACKGROUND_CONTEXT);
	return page.items as unknown as EntryLike[];
}

async function main(): Promise<never> {
	const { mode, dir } = parseDriverArgs();

	if (mode === "setup") {
		const opened = await bootScenarioHarness(
			dir,
			routingResponses(dir, mode),
			{ tokensPerSecond: 2, tokenSize: { min: 8, max: 8 } },
			{
			// The T8 settings seam (OpenHarnessOptions.settings): forced
			// thresholds calibrated against the 1.5.0 measured-usage baseline
			// (upstream's estimateContext reads the LAST assistant message's
			// totalTokens, then estimates forward). The faux provider's
			// simulated cache counts prompt tokens in cacheWrite (input 0),
			// so totalTokens ≈ promptTokens + cacheWrite ≈ 2× the prompt:
			// measured warm-up answer ≈ 2142, turn 2's baseline ≈ 2505
			// (warm-up totalTokens + turn-2 user ~350 + system patches).
			// Band 2200..5000 (background = 5000 - 2800): the warm-up
			// generation (measured 0 → estimated ~2200) stays under the
			// floor, turn 2 (~2500+) lands inside it.
				compaction: {
					reserveTokens: 123_000,
					keepRecentTokens: 1,
					backgroundTokens: 2_800,
				},
				// 1.5.0 pin: the cut-off compaction task is at the limit on the
				// first recovery, so it ENDS into pi.live.compactionFailure
				// instead of re-running (deterministic — no re-summarize race).
				restartLimit: 1,
			},
		);
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		marker("READY");
		// Turn 1: short warm-up, stays under the background band.
		const warm = await root.submit(
			{ type: "input", content: WARM_MARKER },
			BACKGROUND_CONTEXT,
		);
		await withDeadline(
			warm.wait(BACKGROUND_CONTEXT),
			SETTLE_DEADLINE_MS,
			"warm-up settlement",
		);
		// Turn 2: the warm-up answer's measured totalTokens (~2142) plus the
		// filler (~350) land the request inside the background band
		// (2200 … 5000). Upstream creates a conversation-owned background
		// compaction while this turn's generation proceeds. Guard: NO
		// compaction may exist before turn 2 — a warm-up drift into the band
		// would make the killed compaction the wrong one.
		const liveBeforeTurn2 = await opened.harness.snapshot(
			LiveDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
		if ((liveBeforeTurn2?.compactions ?? []).length !== 0) {
			return verifyFailed(
				`a compaction already exists before turn 2 (${JSON.stringify(liveBeforeTurn2?.compactions)}) — the warm-up drifted into the band; the killed compaction would be the wrong one`,
			);
		}
		const second = await root.submit(
			{
				type: "input",
				content: `${TURN2_MARKER} ${"filler ".repeat(200)}`,
			},
			BACKGROUND_CONTEXT,
		);
		const settled = await withDeadline(
			second.wait(BACKGROUND_CONTEXT),
			SETTLE_DEADLINE_MS,
			"turn-2 settlement",
		);
		if (settled.status !== "done") {
			return verifyFailed(
				`turn 2 did not complete under the background band (status=${settled.status}${settled.status === "unanswered" ? ` reason=${settled.reason}` : ""})`,
			);
		}
		// Wait until the compaction task is durably listed AND its summarize
		// request has actually started, with no summary placed yet.
		let compactionTaskId: TaskId<CompactionResult> | undefined;
		const deadline = Date.now() + COMPACTION_DEADLINE_MS;
		for (;;) {
			const live = await opened.harness.snapshot(
				LiveDoc,
				root.id,
				BACKGROUND_CONTEXT,
			);
			const compactions = live?.compactions ?? [];
			const polledEntries = await conversationEntries(root);
			const summaryPlaced = polledEntries.some(
				(entry) => entry.kind === "pi.compaction",
			);
			if (summaryPlaced) {
				return verifyFailed(
					"the background compaction completed before the kill marker (vacuous run — summary entry already placed)",
				);
			}
			if (compactions.length > 0) {
				compactionTaskId = compactions[0]?.taskId;
			}
			const started = (await summarizeRequests(dir)).some(
				(line) => line === "setup",
			);
			if (compactions.length > 0 && started) break;
			if (Date.now() > deadline) {
				return verifyFailed(
					`background compaction never reached summarize-in-flight before the deadline (compactions listed: ${compactions.length}, summarize requests: ${JSON.stringify(await summarizeRequests(dir))})`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		// 1.5.0 deferred persistence: `pi.live` (the compactions listing) is
		// SHOWN at once but STORED only within settings.progress.
		// persistWithinMs (default 1,000 ms) — the kill marker waits the store
		// window plus slack so the kill lands after the listing is STORED
		// (STORE_SETTLE_MS, drivers/lib.ts).
		await new Promise((resolve) => setTimeout(resolve, STORE_SETTLE_MS));
		await writeScenarioState(dir, {
			submissionId: second.id,
			compactionTaskId,
		});
		marker("COMPACTING");
		// Stay alive until the test's SIGKILL: the summarizer's stream timers
		// hold the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen and resume with restartLimit 1 — the cut-off
	// compaction task is at the limit, so it ENDS into
	// pi.live.compactionFailure and the summarize request is NEVER
	// re-issued (1.5.0 restart-limit semantics).
	const opened = await bootScenarioHarness(
		dir,
		routingResponses(dir, mode),
		undefined,
		{ restartLimit: 1 },
	);
	const state = await readScenarioState(dir);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const taskId = state.compactionTaskId as TaskId<CompactionResult>;
	// The cut-off compaction task must END (a failed recovery is the 1.5.0
	// outcome, not a completion).
	const task = await withDeadline(
		opened.harness.waitForTask(taskId, BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"restart-limited compaction task settlement",
	);
	const outcome = task.state.outcome;
	if (outcome.status !== "failed") {
		return verifyFailed(
			`the restart-limited compaction task did not end failed (outcome=${JSON.stringify(outcome)})`,
		);
	}

	// `pi.live.compactionFailure` records the failure (polled — the ending
	// commit can publish a beat after waitForTask resolves).
	let compactionFailure: unknown;
	const failureDeadline = Date.now() + COMPACTION_FAILURE_DEADLINE_MS;
	for (;;) {
		const live = await opened.harness.snapshot(
			LiveDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
		compactionFailure = live?.compactionFailure;
		if (compactionFailure !== undefined) break;
		if (Date.now() > failureDeadline) {
			return verifyFailed(
				`pi.live.compactionFailure never appeared after the restart-limited compaction ended (live: ${JSON.stringify(live)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}

	// NO summary entry: the compaction ended, so no pi.compaction entry may
	// EVER be placed (a short settle window makes a late placement visible).
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	const entries = await conversationEntries(root);
	const summaries = entries.filter((entry) => entry.kind === "pi.compaction");
	if (summaries.length !== 0) {
		return verifyFailed(
			`expected NO compaction summary entry after the restart-limited compaction ended (found ${summaries.length})`,
		);
	}
	// The summarize request fired in SETUP ONLY — the restart-limited
	// compaction never re-requests it (no half-written summary is possible).
	const requests = await summarizeRequests(dir);
	if (requests.length !== 1 || requests[0] !== "setup") {
		return verifyFailed(
			`summarize request markers are ${JSON.stringify(requests)}, expected ["setup"] (a verify re-request would mean the cut-off compaction re-ran)`,
		);
	}

	// Committed turns intact: every pre-kill turn is still in the history.
	const userTexts = entries
		.filter((entry) => entry.kind === "pi.user")
		.map(entryText)
		.join("\n");
	for (const expected of [WARM_MARKER, TURN2_MARKER]) {
		if (!userTexts.includes(expected)) {
			return verifyFailed(
				`pre-kill turn missing from the transcript after recovery (wanted ${JSON.stringify(expected)})`,
			);
		}
	}

	// The structural view (spec §9.3): serializing it is itself an assertion.
	const watch = await root.watch(BACKGROUND_CONTEXT);
	let serialized = "";
	try {
		serialized = JSON.stringify(watch.value);
	} catch (error) {
		await watch.stop();
		return verifyFailed(`view does not serialize: ${String(error)}`);
	}
	await watch.stop();
	if (serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	// Subsequent submits succeed.
	const third = await root.submit(
		{ type: "input", content: TURN3_MARKER },
		BACKGROUND_CONTEXT,
	);
	const thirdSettled = await withDeadline(
		third.wait(BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"post-compaction submit settlement",
	);
	if (thirdSettled.status !== "done") {
		return verifyFailed(
			`subsequent submit did not succeed (status=${thirdSettled.status}${thirdSettled.status === "unanswered" ? ` reason=${thirdSettled.reason}` : ""})`,
		);
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		compactionOutcome: outcome.status,
		compactionFailureRecorded: compactionFailure !== undefined,
		summaryEntries: summaries.length,
		summarizeRequests: requests,
		preKillTurnsIntact: true,
		viewSerializes: true,
		subsequentSubmitStatus: thirdSettled.status,
	});
}

main().catch((error) => {
	// The driver crashed without reaching a verify assertion: fail loud
	// with a non-zero exit (the test sees the code + this stderr).
	process.stderr.write(`driver crashed: ${String(error)}\n`);
	process.exit(1);
});
