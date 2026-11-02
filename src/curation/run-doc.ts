/**
 * The curator run doc (P3/P4, spec §6.3): one conversation-scoped
 * record identifying an INTERNAL curator run — the conversation A9's
 * producer creates for a fork review or digest, whose tool calls the
 * `skill_manage` tool (A6) executes mutating actions under.
 *
 * Shape (the A9 producer writes it in the conversation's CREATING
 * commit, so it predates every observer):
 *
 * - `user` — the curated user the run acts FOR. The store user on every
 *   mutating `skill_manage` action is THIS value, never the calling
 *   principal (the run's parent may be shared by another user entirely).
 * - `reviewId` — the review (or digest) the run belongs to.
 * - `allow` — the action set the run may perform (P6's producer fills
 *   it; A6 reads it but does not enforce it — A8's wrapper owns the
 *   tool-level gate).
 * - `parent` — the reviewed conversation (a fork review's source).
 * - `viewed` — the read-before-write ledger: skill names the run has
 *   VIEWED through the tool. `markViewed` appends here through the tool
 *   call's own `api.commit` (memos are per tool task and die with the
 *   call, so the ledger must be a durable doc).
 */

import type { Context } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import type {
	ConversationId,
	DocumentReader,
	ToolExecutionApi,
	Tx,
} from "@earendil-works/pi-durable";

/**
 * One curator run. A type alias (not an interface): pi-durable's
 * `T extends JsonObject` needs the implicit index signature only
 * aliases get (the session-meta pattern).
 */
export type CurationRun = {
	/** The curated user the run acts for (the store user). */
	readonly user: string;
	/** The review (or digest) the run belongs to. */
	readonly reviewId: string;
	/** The mutating action set the run may perform (P6 fills it). */
	readonly allow: string[];
	/** The reviewed conversation (a fork review's source). */
	readonly parent?: number;
	/** Skill names the run has viewed (the read-before-write ledger). */
	viewed: string[];
};

/** The `sigrun.curation.run` doc (latest-only singleton per conversation). */
export const CurationRunDoc = defineDoc<CurationRun>({
	kind: "sigrun.curation.run",
	version: 1,
	scope: "conversation",
	checkpointWhen: () => false,
	history: "latest",
	fork: "current",
	initial: () => ({ user: "", reviewId: "", allow: [], viewed: [] }),
});

/**
 * The run doc of one conversation, from any `DocumentReader` (a tool's
 * `ToolExecutionApi` carries one). `undefined` when the conversation
 * carries no run doc — an ordinary conversation, or a run conversation
 * before the creating commit. Fail closed: a read failure also reads
 * `undefined` (a mutating action then refuses, never guesses).
 */
export async function curationRun(
	read: DocumentReader,
	conversationId: ConversationId,
	ctx: Context,
): Promise<CurationRun | undefined> {
	try {
		return await read.snapshot(CurationRunDoc, conversationId, ctx);
	} catch {
		return undefined;
	}
}

/**
 * Append one skill name to the run doc's `viewed` ledger, through the
 * tool call's own `api.commit` — the read-before-write record the
 * mutating actions check. Idempotent per name; a no-op when the
 * conversation carries no run doc (nothing to record — `view` outside a
 * run has no ledger to feed).
 */
export async function markViewed(
	api: ToolExecutionApi,
	name: string,
	ctx: Context,
): Promise<void> {
	await api.commit(async (tx: Tx) => {
		const doc = await tx.doc(CurationRunDoc, api.conversationId);
		if (doc.user === "") return;
		if (!doc.viewed.includes(name)) doc.viewed = [...doc.viewed, name];
	}, ctx);
}
