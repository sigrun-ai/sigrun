/**
 * Message attribution (curator P1, spec §6.1): every user input records
 * the submitting user through every admission path — HTTP submit (the
 * resolved principal), the extension host bridge (`opts.user`, recorded
 * verbatim; extensions own their user mapping), a block answer (the
 * acting user), and a job fire (the job's owner).
 *
 * The carrier is a SIDE record, the `sigrun.authors` conversation doc:
 * `pi.user` entries are `Entry<never>` (they cannot carry data), and a
 * new input entry kind would have to be taught to every `UserEntry.is`
 * consumer. The doc keys the author two ways:
 *
 * - `byRequest` — written BEFORE `conversation.submit` (the requestId
 *   exists pre-admission, so this never races). An orphan record from a
 *   failed submit is harmless.
 * - `bySubmission` — written right after admission returns: the key the
 *   live run's input ids resolve against, readable from a tool through
 *   any `DocumentReader`. A tool call that lands before this write reads
 *   "unattributed" and fails closed.
 *
 * An `undefined` user (an unidentified caller) records nothing: its
 * entries read unattributed, exactly like every entry admitted before
 * this doc existed — unattributed entries are never curation input.
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, UserEntry } from "@earendil-works/pi-durable";
import type {
	Conversation,
	ConversationId,
	DocumentReader,
	EntryId,
	EntryRecord,
	Harness,
	SubmissionId,
} from "@earendil-works/pi-durable";
import { EXPANDED_ENTRY_KIND } from "../commands/expand.js";
import { BlocksAnswerEntry } from "../harness/blocks/entries.js";

/**
 * The authors of a conversation's inputs. A type alias (not an
 * interface): pi-durable's `T extends JsonObject` needs the implicit
 * index signature only aliases get (the session-meta pattern).
 */
export type Authors = {
	/** Pre-admission records, keyed by the submission's `requestId`. */
	readonly byRequest: Record<string, string>;
	/** Post-admission records, keyed by the submission id (as a string). */
	readonly bySubmission: Record<string, string>;
};

/** The `sigrun.authors` doc (latest-only singleton per conversation). */
export const AuthorsDoc = defineDoc<Authors>({
	kind: "sigrun.authors",
	version: 1,
	scope: "conversation",
	checkpointWhen: () => false,
	history: "latest",
	fork: "current",
	initial: () => ({ byRequest: {}, bySubmission: {} }),
});

/** The entry kinds an input submission places (the author carriers). */
const INPUT_KINDS: ReadonlySet<string> = new Set([
	UserEntry.kind,
	EXPANDED_ENTRY_KIND,
	BlocksAnswerEntry.kind,
]);

/** Whether one entry is a placed user input (any of {@link INPUT_KINDS}). */
function isInputEntry(entry: EntryRecord): boolean {
	return INPUT_KINDS.has(entry.kind);
}

/**
 * The requestId an input is admitted under: the caller's own id, or a
 * generated `sigrun:`-prefixed UUID when the caller passed none — every
 * input submission carries one, so `byRequest` can key every admission.
 */
export function ensureRequestId(requestId?: string): string {
	return requestId ?? `sigrun:${randomUUID()}`;
}

/**
 * Record `user` as the author of one input, keyed by its requestId
 * (pre-admission) or its submission id (post-admission). A no-op for an
 * `undefined` user: an unidentified caller leaves no record and its
 * entries read unattributed.
 */
export async function recordAuthor(
	conversation: Conversation,
	key: { readonly requestId: string } | { readonly submissionId: SubmissionId },
	user: string | undefined,
	ctx: Context,
): Promise<void> {
	if (user === undefined) return;
	await conversation.commit(async (tx) => {
		const doc = await tx.doc(AuthorsDoc, conversation.id);
		if ("requestId" in key) doc.byRequest[key.requestId] = user;
		else doc.bySubmission[String(key.submissionId)] = user;
	}, ctx);
}

/**
 * The author of one submission, from any `DocumentReader` — including the
 * `ToolExecutionApi` a tool runs with. Reads `bySubmission` only, so a
 * tool call that lands before the post-admission write resolves
 * `undefined` (unattributed — fail closed, never guess).
 */
export async function authorOfSubmission(
	read: DocumentReader,
	conversationId: ConversationId,
	submissionId: SubmissionId,
	ctx: Context,
): Promise<string | undefined> {
	const doc = await read.snapshot(AuthorsDoc, conversationId, ctx);
	return doc?.bySubmission[String(submissionId)];
}

/**
 * Every user-input entry in the conversation's ACTIVE context mapped to
 * its author — host-side (full `Session` access; the harness resolves
 * both record keys through the submission's `entry` link and its
 * `requestId`). Entries with no attribution (everything admitted before
 * this doc, or by an unidentified caller) are present with `undefined`:
 * the map's presence set is the input entries, the values are authors.
 */
export async function authorsOfEntries(
	harness: Harness,
	conversationId: ConversationId,
	ctx: Context,
): Promise<ReadonlyMap<EntryId, string | undefined>> {
	const result = new Map<EntryId, string | undefined>();
	const conversation = await harness.conversation(conversationId, ctx);
	if (conversation === undefined) return result;
	const view = await conversation.context(ctx);
	for (const entry of view.entries) {
		if (isInputEntry(entry)) result.set(entry.id, undefined);
	}
	const doc = await harness.snapshot(AuthorsDoc, conversationId, ctx);
	if (doc === undefined) return result;
	// The byRequest join: the requestId resolves to the submission (and
	// its placed entry) through the transaction's conversation-scoped
	// lookup — the one typed path from a requestId to the record.
	const byRequest = await harness.commit(async (tx) => {
		const resolved: { readonly entry: EntryId; readonly user: string }[] = [];
		for (const [requestId, user] of Object.entries(doc.byRequest)) {
			const submission = await tx.submissionByRequest(
				conversationId,
				requestId,
			);
			if (submission?.entry !== undefined) {
				resolved.push({ entry: submission.entry, user });
			}
		}
		return resolved;
	}, ctx);
	for (const { entry, user } of byRequest) {
		if (result.has(entry)) result.set(entry, user);
	}
	// The bySubmission join (authoritative: keyed by the exact id). The
	// submission handle re-reads the live record, so a still-queued input
	// joins once its entry places.
	for (const [id, user] of Object.entries(doc.bySubmission)) {
		const submission = await harness.submission(
			Number(id) as SubmissionId,
			ctx,
		);
		if (submission === undefined) continue;
		const record = await submission.status(ctx);
		if (record.entry !== undefined && result.has(record.entry)) {
			result.set(record.entry, user);
		}
	}
	return result;
}
