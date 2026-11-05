/**
 * Interactive tools (ask-user Task 3, spec §6): the helpers that hide an
 * extension's `interactiveTools` — tool names that need a human present —
 * from every NON-INTERACTIVE run core creates.
 *
 * Core owns the definition of a non-interactive conversation (spec §6):
 * scheduled job run conversations and the curator's internal runs. In
 * those conversations core leaves interactive tools out of the offered
 * tools at creation time by removing them from the ENABLED-tools filter
 * (pi-durable `AgentDoc.tools`): a removal there makes the tool neither
 * offered to the model NOR reachable from nested `executeTool()` calls
 * (the nested resolution reads the same enabled set), which no
 * `modelTools` narrowing could give.
 *
 * Fork reviews deliberately do NOT pass through here — they copy the
 * parent's stored selection for byte-identical prompt prefixes (cache
 * parity), and the curation gate blocks an interactive call instead.
 *
 * Jobs that fire into an EXISTING conversation are not covered by this
 * creation-time filter either (the conversation predates the fire);
 * the tool stays listed and must guard its own execute with
 * `host.jobs.isJobRun` (spec §6's option A).
 */

import { AgentDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { SessionMetaDoc } from "../server/session-meta.js";

/**
 * Remove every name in `names` from the conversation's stored
 * `AgentDoc.tools` enabled filter, preserving the stored shape:
 * - unset → `{remove: [...names].sort()}`;
 * - an object → `remove ∪ names` (sorted);
 * - an array → the array without the names.
 *
 * A no-op when `names` is empty (the no-interactive-extension deploy
 * writes nothing). Runs inside an existing commit (the callers are the
 * creating commits and the server create op's post-create stamp commit);
 * document access only — no table reads.
 */
export async function excludeInteractiveTools(
	tx: Tx,
	conversationId: ConversationId,
	names: ReadonlySet<string>,
): Promise<void> {
	if (names.size === 0) return;
	const agent = await tx.doc(AgentDoc, conversationId);
	const stored = agent.tools;
	if (stored === undefined) {
		agent.tools = { remove: [...names].sort() };
		return;
	}
	if (Array.isArray(stored)) {
		agent.tools = stored.filter((name) => !names.has(name));
		return;
	}
	agent.tools = {
		remove: [...new Set([...stored.remove, ...names])].sort(),
	};
}

/**
 * Whether the conversation's CURRENT run is job-driven (ask-user Task 3,
 * spec §6): true when the session meta carries a `jobId` (a
 * `conversation: "new"` run — the stamp persists past the run's settle,
 * which is fine: every run of that conversation is a job run), or any
 * input of the conversation's current run (`LiveDoc` `run.inputs`,
 * present exactly while busy) resolves to a submission whose requestId
 * carries the job prefix (`job:<fireKey>`, stamped by `jobs/fire.ts` on
 * BOTH fire shapes — that branch covers a job firing into an EXISTING
 * conversation, which carries no `jobId`). Interactive tools call this in
 * execute and refuse instead of waiting on a human.
 */
export async function isJobRunConversation(
	harness: Harness,
	conversationId: ConversationId,
	context: Context,
): Promise<boolean> {
	const meta = await harness.snapshot(SessionMetaDoc, conversationId, context);
	if (meta?.jobId !== undefined) return true;
	const live = await harness.snapshot(LiveDoc, conversationId, context);
	for (const id of live?.run?.inputs ?? []) {
		const submission = await harness.submission(id, context);
		if (submission === undefined) continue;
		const record = await submission.status(context);
		if (record.requestId?.startsWith("job:")) return true;
	}
	return false;
}

/**
 * Filter `list` to the names outside `names` (a curator run's `allow`
 * list losing its interactive members). Never fails — stripping must not
 * let installing an interactive-tool extension break unrelated curation
 * targets — but warns ONCE per call naming the removed tools and `where`
 * (an all-interactive list then still hits the existing
 * non-empty-`allow` check, loudly). Returns a fresh array in every case
 * (the tracker requires alias-free roots).
 */
export function withoutInteractive(
	list: readonly string[],
	names: ReadonlySet<string>,
	warn: (message: string) => void,
	where: string,
): string[] {
	const removed = list.filter((name) => names.has(name));
	if (removed.length === 0) return [...list];
	warn(
		`interactive tools [${removed.join(", ")}] removed from the ${where} allow list — they need a human present`,
	);
	return list.filter((name) => !names.has(name));
}
