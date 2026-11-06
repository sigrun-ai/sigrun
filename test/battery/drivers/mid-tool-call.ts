/**
 * Crash-battery item 2 driver (plan Task 12 step 2, spec §7 M1 battery;
 * 1.5.0 crash semantics per spec §3.2-e): `kill -9` mid-tool-call →
 * restart-limited tools no longer park — with `settings.restartLimit`
 * pinned to 1, the FIRST recovery of the cut-off round ends each cut-off
 * tool with a VISIBLE error result carrying diagnostic code
 * `restart_limit` (at-most-once: the execution marker files prove no
 * tool body re-ran), and the run ends `unanswered` with
 * `pi.live.runFailure.reason === "restart_limit"`. In 1.4.0 the safe
 * tool re-executed and the unsafe one ended `interrupted`; in 1.5.0 the
 * cut-off IS the limit, so NEITHER tool re-executes and both carry the
 * restart_limit error.
 *
 * setup mode:
 * 1. Boot a REAL harness on `<dir>/sigrun.db` with the faux provider
 *    scripted to answer with TWO tool calls in one round (parallel
 *    execution): `unsafe_write` (replay "unsafe") and `safe_read`
 *    (replay "safe").
 * 2. Submit one input; the model's tool-calling answer starts the round.
 *    Each tool's execute() appends one line to `<dir>/exec-<tool>.count`
 *    (the execution marker), then in setup mode prints
 *    `TOOL_RUNNING:<tool>` and blocks on a long sleep. The intent
 *    checkpoint `{phase: "execute", arguments, replay}` is committed
 *    BEFORE execute() runs, so the markers fire only with the replay
 *    decision already durable.
 * 3. Stay alive until SIGKILL.
 *
 * verify mode:
 * 1. Reopen the SAME storage dir and resume, registering the SAME tools
 *    with the SAME replay policies and `restartLimit: 1` — the cut-off
 *    tools are at the limit on the first recovery, so they END (never
 *    re-execute) with the restart_limit error result.
 * 2. Reacquire the submission, await settlement (deadline).
 * 3. Assert: NEITHER tool's marker file gained a line (at most one
 *    execution across both processes — the no-duplicate-side-effect
 *    invariant); both tools' result entries are errors carrying the
 *    `restart_limit` diagnostic; the submission settles `unanswered`
 *    reason `restart_limit` with `pi.live.runFailure.reason` matching;
 *    `pi.live.run` is cleared; the view serializes.
 *
 * NOTE on STORE_SETTLE_MS (the deferred-persistence wait the other
 * drivers add before their kill markers): this driver deliberately omits
 * it. The kill observable here is each tool's `TOOL_RUNNING:<tool>`
 * marker, printed INSIDE execute() — and the execute-intent checkpoint
 * (`{phase: "execute", arguments, replay}`) is committed as a NON-deferred
 * commit BEFORE execute() runs (the tool task's phase transition reads
 * `pi.live`, which flushes any held deferred progress). The replay
 * decision is therefore already durable when the marker prints; no extra
 * settle window is needed.
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineTool, LiveDoc, type SubmissionId } from "@earendil-works/pi-durable";
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

/** The unsafe (non-idempotent) tool of the scenario. */
const UNSAFE_TOOL = "unsafe_write";
/** The safe (idempotent) tool of the scenario. */
const SAFE_TOOL = "safe_read";
/** How long a setup-mode tool blocks inside execute() (killed long before). */
const TOOL_SLEEP_MS = 120_000;
/** Marker-wait deadlines INSIDE the driver (fail loud, never hang). */
const SETTLE_DEADLINE_MS = 30_000;
/** The scripted answer a regression's continued run would serve (1.5.0: the run must end first). */
const RECOVERED_ANSWER = "continued answer — must never be served";

/** Count one execution of `tool` in its marker file (one line per run,
 * carrying the arguments so a REPLAYED execution proves it received the
 * original arguments, not a reconstructed/default set). */
function countExecution(dir: string, tool: string, argsNote: string): void {
	appendFileSync(join(dir, `exec-${tool}.count`), `${argsNote}\n`);
}

/** The line count of a tool's execution marker file (0 when absent). */
async function executionCount(dir: string, tool: string): Promise<number> {
	try {
		const content = await readFile(join(dir, `exec-${tool}.count`), "utf8");
		return content.split("\n").filter((line) => line.length > 0).length;
	} catch {
		return 0;
	}
}

/**
 * The scenario's tools. Both modes register them identically (name +
 * parameters + replay policy) so recovery resolves the same registrations;
 * only the execute() behavior differs: setup blocks mid-execution, verify
 * returns at once. BOTH modes append the execution marker line — that is
 * the at-most-once evidence.
 */
function scenarioTools(dir: string, mode: "setup" | "verify") {
	const blockOrReturn = async (tool: string) => {
		if (mode === "setup") {
			// The kill marker: printed after the execution line was written and
			// (upstream) after the execute-intent checkpoint committed.
			marker(`TOOL_RUNNING:${tool}`);
			await new Promise((resolve) => setTimeout(resolve, TOOL_SLEEP_MS));
		}
	};
	const unsafeWrite = defineTool({
		name: UNSAFE_TOOL,
		description: "Non-idempotent write tool for the crash battery.",
		parameters: Type.Object({ note: Type.String() }),
		replay: "unsafe",
		async execute(args) {
			countExecution(dir, UNSAFE_TOOL, args.note);
			await blockOrReturn(UNSAFE_TOOL);
			return {
				output: [{ type: "text", text: `${UNSAFE_TOOL} executed (${mode}) with ${args.note}` }],
			};
		},
	});
	const safeRead = defineTool({
		name: SAFE_TOOL,
		description: "Idempotent read tool for the crash battery.",
		parameters: Type.Object({ note: Type.String() }),
		replay: "safe",
		async execute(args) {
			countExecution(dir, SAFE_TOOL, args.note);
			await blockOrReturn(SAFE_TOOL);
			return {
				output: [{ type: "text", text: `${SAFE_TOOL} executed (${mode}) with ${args.note}` }],
			};
		},
	});
	return { unsafeWrite, safeRead };
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

/** The committed `pi.tool-result` entry of `toolName`, when present. */
function toolResultEntry(
	entries: readonly {
		kind: string;
		model?: readonly unknown[];
		data?: unknown;
	}[],
	toolName: string,
):
	| { isError: boolean | undefined; diagnostics: { code?: string; message?: string }[] }
	| undefined {
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		const message = (entry.model ?? []).find(
			(candidate) =>
				(candidate as { role?: string; toolName?: string }).role ===
					"toolResult" &&
				(candidate as { toolName?: string }).toolName === toolName,
		) as { isError?: boolean } | undefined;
		if (message === undefined) continue;
		const diagnostics =
			(entry.data as { diagnostics?: { code?: string; message?: string }[] })
				?.diagnostics ?? [];
		return { isError: message.isError, diagnostics };
	}
	return undefined;
}

async function main(): Promise<never> {
	const { mode, dir } = parseDriverArgs();

	if (mode === "setup") {
		const opened = await bootScenarioHarness(dir, [
			// The tool-calling answer: both tools in ONE round (parallel
			// execution is the harness default).
			fauxAssistantMessage(
				[
					fauxToolCall(UNSAFE_TOOL, { note: "side effect" }, { id: "call-unsafe" }),
					fauxToolCall(SAFE_TOOL, { note: "lookup" }, { id: "call-safe" }),
				],
				{ stopReason: "toolUse" },
			),
			// Never consumed in setup (the tools block until the kill).
			fauxAssistantMessage("unreachable final answer"),
		], undefined, { restartLimit: 1 });
		const { unsafeWrite, safeRead } = scenarioTools(dir, mode);
		opened.registry.install({
			name: "battery-tools",
			tools: [unsafeWrite, safeRead],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		marker("READY");
		const submission = await root.submit(
			{ type: "input", content: "use both tools" },
			BACKGROUND_CONTEXT,
		);
		await writeScenarioState(dir, { submissionId: submission.id });
		// Stay alive until the test's SIGKILL: the blocked tool sleeps hold
		// the loop open; this keepalive makes it independent of them.
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// verify mode: reopen and resume with restartLimit 1 — the cut-off
	// tools are at the limit on the FIRST recovery, so they end with the
	// restart_limit error result instead of running again (1.5.0). The
	// scripted answer exists only to fail loudly if a regression lets the
	// run continue past the cut-off round.
	const opened = await bootScenarioHarness(
		dir,
		[fauxAssistantMessage(RECOVERED_ANSWER)],
		undefined,
		{ restartLimit: 1 },
	);
	const { unsafeWrite, safeRead } = scenarioTools(dir, mode);
	opened.registry.install({
		name: "battery-tools",
		tools: [unsafeWrite, safeRead],
	});
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

	const unsafeExecutions = await executionCount(dir, UNSAFE_TOOL);
	const safeExecutions = await executionCount(dir, SAFE_TOOL);

	// THE invariant (no duplicate side effect): NEITHER tool re-executed —
	// exactly one execution each, from the setup process (1.5.0: the
	// cut-off tools are at the pinned restart limit, so recovery ENDS them
	// instead of running them again).
	if (unsafeExecutions !== 1) {
		return verifyFailed(
			`unsafe tool ${UNSAFE_TOOL} executed ${unsafeExecutions} times across the crash (exactly one expected — the setup pass's blocked run only)`,
		);
	}
	if (safeExecutions !== 1) {
		return verifyFailed(
			`safe tool ${SAFE_TOOL} executed ${safeExecutions} times across the crash (exactly one expected — at the restart limit even a replay-safe tool is not re-run)`,
		);
	}

	// Visible state for BOTH cut-off calls: each result entry must be an
	// error carrying the `restart_limit` diagnostic (1.5.0 harness tool.js
	// endCutOff), never a silent success-shaped result.
	const resultErrors: string[] = [];
	for (const tool of [UNSAFE_TOOL, SAFE_TOOL]) {
		const result = toolResultEntry(view.entries, tool);
		if (result === undefined) {
			resultErrors.push(`no ${tool} tool-result entry found after recovery`);
			continue;
		}
		const restartLimitDiagnostic = (result.diagnostics ?? []).find(
			(diagnostic) => diagnostic.code === "restart_limit",
		);
		if (result.isError !== true || restartLimitDiagnostic === undefined) {
			resultErrors.push(
				`${tool} result is not a visible restart_limit error (isError=${String(result.isError)}, diagnostics=${JSON.stringify(result.diagnostics)})`,
			);
		}
	}
	if (resultErrors.length > 0) {
		return verifyFailed(resultErrors.join("; "));
	}

	// 1.5.0: the round's tools ended restart_limited; the generation then
	// either fails the run (`pi.live.runFailure` reason `restart_limit`) or
	// CONTINUES it from the round's error results (the model may answer
	// from the errors — both are upstream-legitimate; the task-level
	// interruption and the visible restart_limit results are the settled
	// 1.5.0 semantics). The wait may resolve a beat before the run-ending
	// commit publishes — poll live.
	let liveAfter = view.docs["pi.live"] as
		| { run?: unknown; runFailure?: { reason?: string } }
		| undefined;
	const liveDeadline = Date.now() + SETTLE_DEADLINE_MS;
	for (;;) {
		const runEnded = liveAfter?.run === undefined;
		if (runEnded) break;
		if (Date.now() > liveDeadline) {
			return verifyFailed(
				`pi.live.run never cleared after the restart-limited round settled (stuck busy; live: ${JSON.stringify(liveAfter)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		liveAfter = (await opened.harness.snapshot(
			LiveDoc,
			root.id,
			BACKGROUND_CONTEXT,
		)) as { run?: unknown; runFailure?: { reason?: string } } | undefined;
	}
	const finalAnswers = assistantMessages(view.entries).filter(
		(message) => message.stopReason === "stop",
	);
	const runFailureReason = liveAfter?.runFailure?.reason;
	if (settled.status !== "done") {
		// The failing branch: the run's failure is specifically the
		// restart limit (both task_interrupted reports carry it).
		if (runFailureReason !== "restart_limit") {
			return verifyFailed(
				`the restart-limited run neither answered nor ended runFailure restart_limit (status=${settled.status}${settled.status === "unanswered" ? ` reason=${settled.reason}` : ""}, runFailure=${JSON.stringify(liveAfter?.runFailure)})`,
			);
		}
	}
	// Answer accounting: a continued run answers at most once; a
	// restart-limited run answers never.
	if (finalAnswers.length > 1) {
		return verifyFailed(
			`expected at most one final answer, found ${finalAnswers.length}`,
		);
	}
	if (settled.status === "done" && finalAnswers.length !== 1) {
		return verifyFailed(
			`the run settled done but carries ${finalAnswers.length} final answers (expected exactly one)`,
		);
	}
	if (serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		settledStatus: settled.status,
		...(settled.status === "unanswered"
			? { reason: (settled as { reason?: string }).reason }
			: {}),
		runFailureReason,
		runCleared: liveAfter?.run === undefined,
		unsafeExecutions,
		safeExecutions,
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
