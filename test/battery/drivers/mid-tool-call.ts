/**
 * Crash-battery item 2 driver (plan Task 12 step 2, spec §7 M1 battery):
 * `kill -9` mid-tool-call → safe tools may re-execute; unsafe tools must NOT
 * silently re-execute — they end failed with visible state, and the execution
 * marker files prove at-most-one execution across both processes.
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
 *    with the SAME replay policies (recovery re-reads `tool.replay` —
 *    "rerun only when the stored AND the current policy both say safe"),
 *    with a fresh faux provider scripted to give the final answer.
 * 2. Reacquire the submission, await settlement (deadline).
 * 3. Assert: the unsafe tool's marker file shows AT MOST one execution
 *    across both processes; the unsafe tool's result entry is an error
 *    carrying the `interrupted` diagnostic (visible state, not a silent
 *    re-execution); the safe tool re-executed (recorded, fine); the
 *    submission completes with exactly one final answer; view serializes.
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type SubmissionId } from "@earendil-works/pi-durable";
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
/** The final answer the verify pass's fresh provider serves. */
const RECOVERED_ANSWER = "recovered final answer after mid-tool kill";

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
				content: [{ type: "text", text: `${UNSAFE_TOOL} executed (${mode}) with ${args.note}` }],
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
				content: [{ type: "text", text: `${SAFE_TOOL} executed (${mode}) with ${args.note}` }],
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
		]);
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

	// verify mode: reopen, resume (tool tasks recover under the replay rule),
	// and settle the killed submission through to its final answer.
	const opened = await bootScenarioHarness(dir, [
		fauxAssistantMessage(RECOVERED_ANSWER),
	]);
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

	const unsafeExecutions = await executionCount(dir, UNSAFE_TOOL);
	const safeExecutions = await executionCount(dir, SAFE_TOOL);

	// THE invariant: the unsafe tool executed AT MOST once across both
	// processes (the setup pass wrote exactly one line before TOOL_RUNNING;
	// a silent re-execution on recovery would write a second).
	if (unsafeExecutions > 1) {
		return verifyFailed(
			`unsafe tool ${UNSAFE_TOOL} executed ${unsafeExecutions} times across the crash (at most one allowed)`,
		);
	}
	// The safe tool MAY re-execute (fine per spec §7) — once per recovery at
	// most; the observed count is recorded in the verified payload.
	if (safeExecutions < 1 || safeExecutions > 2) {
		return verifyFailed(
			`safe tool ${SAFE_TOOL} execution count ${safeExecutions} outside the expected 1–2`,
		);
	}
	// Argument fidelity: when the safe tool RE-executed, the replay must have
	// received the ORIGINAL arguments (recovery re-runs from the durable
	// intent checkpoint — a reconstructed/default argument set would prove
	// the checkpoint contents wrong). Every marker line carries the note.
	if (safeExecutions === 2) {
		const lines = (await readFile(join(dir, `exec-${SAFE_TOOL}.count`), "utf8"))
			.split("\n")
			.filter((line) => line.length > 0);
		if (lines.some((line) => line !== "lookup")) {
			return verifyFailed(
				`safe tool re-executed with wrong arguments (marker lines: ${JSON.stringify(lines)})`,
			);
		}
	}

	// Visible state for the unsafe call: its result entry must be an error
	// carrying the `interrupted` diagnostic (harness tool.js settles a
	// non-replayed recovery as failed with that code), never a silent
	// success-shaped result.
	const unsafeResult = toolResultEntry(view.entries, UNSAFE_TOOL);
	if (unsafeResult === undefined) {
		return verifyFailed(
			`no ${UNSAFE_TOOL} tool-result entry found after recovery`,
		);
	}
	const interrupted = (unsafeResult.diagnostics ?? []).find(
		(diagnostic) => diagnostic.code === "interrupted",
	);
	if (unsafeResult.isError !== true || interrupted === undefined) {
		return verifyFailed(
			`unsafe tool result is not a visible interrupted error (isError=${String(unsafeResult.isError)}, diagnostics=${JSON.stringify(unsafeResult.diagnostics)})`,
		);
	}

	// The conversation completed out of recovery with exactly one final
	// answer (the tool-call entry has stopReason "toolUse" and does not count).
	const finalAnswers = assistantMessages(view.entries).filter(
		(message) => message.stopReason === "stop",
	);
	if (settled.status !== "done" || finalAnswers.length !== 1) {
		return verifyFailed(
			`expected the recovered conversation to complete with one final answer (status=${settled.status}, finalAnswers=${finalAnswers.length})`,
		);
	}
	if (serialized.length === 0) {
		return verifyFailed("serialized view is empty");
	}

	await opened.harness.close(BACKGROUND_CONTEXT);
	return verified({
		settledStatus: settled.status,
		unsafeExecutions,
		safeExecutions,
		unsafeInterrupted: interrupted !== undefined,
		interruptedMessage: interrupted?.message,
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
