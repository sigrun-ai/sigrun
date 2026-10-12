/**
 * Crash-battery item 3 driver (plan Task 12 step 3, spec §7 M1 battery,
 * Review Focus #5): `kill -9` during a background compaction → resume
 * succeeds, NO half-written summary, committed turns intact, the view
 * serializes, and subsequent submits succeed.
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider slowed
 *    deterministically (`tokensPerSecond: 2`, `tokenSize` pinned) and the
 *    compaction policy forced through the OpenHarnessOptions.settings seam
 *    to thresholds calibrated for the core-tools era: the seven core tool
 *    schemas (pi parity) ride in every request, so the warm-up turn and
 *    turn 2 both start from a tools-sized baseline. Blocking threshold
 *    4000 (`contextWindow - reserveTokens`), background band from 2000
 *    (`blocking - backgroundTokens`), `keepRecentTokens: 1`. A short
 *    warm-up turn stays under the band; turn 2's preparation (thousands of
 *    estimated tokens, baseline plus filler) lands inside it, so upstream
 *    creates a conversation-owned BACKGROUND compaction task while turn
 *    2's generation proceeds.
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
 * 1. Reopen the SAME storage dir and resume, with factories serving a fresh
 *    summary plus the post-kill turn's answer.
 * 2. `waitForTask` the recorded compaction task → must complete; the write
 *    submission places the summary entry (poll with deadline).
 * 3. Assert: exactly ONE `pi.compaction` entry, well-formed (upstream's
 *    summary wrapper + the full scripted summary text including its END
 *    sentinel — a half-written summary would be truncated), `reason:
 *    "threshold"`, the summarize marker file shows the request fired in BOTH
 *    processes (setup started it; verify re-requested it from the durable
 *    checkpoint), the pre-kill turns are all present, the view serializes,
 *    and a subsequent submit settles `done`.
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
/** The summary the VERIFY pass's re-request serves; the sentinel proves completeness. */
const RECOVERED_SUMMARY = "recovered compaction summary payload SUMMARY-END";
/** Upstream's summary wrapper prefix (observed in test/compaction.test.ts). */
const SUMMARY_WRAPPER = "compacted into the following summary";

/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const COMPACTION_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 30_000;
const SUMMARY_ENTRY_DEADLINE_MS = 15_000;
/** Poll cadence for the setup conditions and the verify summary entry. */
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
	const summaryText = mode === "setup" ? SETUP_SUMMARY : RECOVERED_SUMMARY;
	const summarizer = () => {
		countSummarizeRequest(dir, mode);
		return fauxAssistantMessage(summaryText);
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
			// thresholds calibrated for the core-tools era (see header) —
			// the seven core tool schemas ride in every request, so the
			// old 700/300 band no longer brackets turn 2's estimate.
				compaction: {
					reserveTokens: 124_000,
					keepRecentTokens: 1,
					backgroundTokens: 2000,
				},
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
		// Turn 2: ~550 estimated tokens — inside the background band
		// (300 … 700). Upstream creates a conversation-owned background
		// compaction while this turn's generation proceeds.
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

	// verify mode: reopen, resume (the compaction task re-runs from its
	// durable summarize checkpoint), and check every Review-Focus-#5 leg.
	const opened = await bootScenarioHarness(dir, routingResponses(dir, mode));
	const state = await readScenarioState(dir);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const taskId = state.compactionTaskId as TaskId<CompactionResult>;	// The resumed compaction must complete (a failed recovery is a finding).
	const task = await withDeadline(
		opened.harness.waitForTask(taskId, BACKGROUND_CONTEXT),
		SETTLE_DEADLINE_MS,
		"resumed compaction task settlement",
	);
	const outcome = task.state.outcome;
	if (outcome.status !== "completed") {
		return verifyFailed(
			`the resumed compaction task did not complete (outcome=${JSON.stringify(outcome)})`,
		);
	}

	// The summary entry appears when the compaction's write submission places
	// it at the next boundary (the conversation is idle → at once).
	let summaries: EntryLike[] = [];
	const entryDeadline = Date.now() + SUMMARY_ENTRY_DEADLINE_MS;
	for (;;) {
		const entries = await conversationEntries(root);
		summaries = entries.filter((entry) => entry.kind === "pi.compaction");
		if (summaries.length > 0) break;
		if (Date.now() > entryDeadline) {
			return verifyFailed(
				"no pi.compaction summary entry appeared after the resumed task completed",
			);
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	if (summaries.length !== 1) {
		return verifyFailed(
			`expected exactly one compaction summary entry, found ${summaries.length}`,
		);
	}
	const summaryText = entryText(summaries[0]);
	// NO half-written summary: upstream's wrapper plus the COMPLETE scripted
	// summary — a summary cut mid-write loses the trailing sentinel.
	if (!summaryText.includes(SUMMARY_WRAPPER)) {
		return verifyFailed(
			`summary entry lacks upstream's wrapper prefix (text head: ${JSON.stringify(summaryText.slice(0, 120))})`,
		);
	}
	if (!summaryText.includes("SUMMARY-END")) {
		return verifyFailed(
			"summary entry is truncated — the scripted summary's end sentinel is missing (half-written summary)",
		);
	}
	const summaryData = summaries[0].data;
	if (JSON.stringify(summaryData) !== JSON.stringify({ reason: "threshold" })) {
		return verifyFailed(
			`summary entry data is ${JSON.stringify(summaryData)}, expected {"reason":"threshold"}`,
		);
	}
	// The summarize request fired in BOTH processes: setup started it (the
	// kill was mid-flight) and verify re-requested it from the checkpoint.
	const requests = await summarizeRequests(dir);
	if (
		requests.length !== 2 ||
		requests[0] !== "setup" ||
		requests[1] !== "verify"
	) {
		return verifyFailed(
			`summarize request markers are ${JSON.stringify(requests)}, expected ["setup","verify"]`,
		);
	}

	// Committed turns intact: every pre-kill turn is still in the history.
	const entries = await conversationEntries(root);
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
	const viewState = await root.viewState(BACKGROUND_CONTEXT);
	let serialized = "";
	try {
		serialized = JSON.stringify(viewState.value);
	} catch (error) {
		await viewState.dispose();
		return verifyFailed(`view does not serialize: ${String(error)}`);
	}
	await viewState.dispose();
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
		summaryVia: outcome.result.entryId !== undefined ? "entryId" : "submissionId",
		summaryEntries: 1,
		summaryWellFormed: true,
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
