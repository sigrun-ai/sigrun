/**
 * Internal runs (curator P5, spec §6.1): conversations created for curator
 * work are invisible on every owner-keyed path.
 *
 * The marker is the server-owned `SessionMeta.internal: true`, stamped by
 * {@link markInternal} in the conversation's CREATING commit — alongside
 * the curated user as `owner`, so the env, the acting user, and the
 * target tools resolve to them. The flag never changes after creation
 * (there is no writer besides the creating commit), which every consumer
 * may rely on for caching.
 *
 * Host paths that check it (each hidden from internal conversations):
 * the HTTP listing, the host bridge's `conversations.list`, the `:id`
 * route loader (404 for every caller, superuser included), the SSE
 * per-principal event stream, the notifications surface, the auto-namer,
 * and the event bus's idle clock, `run.settled` host emit, and extension
 * `runSettled`/lifecycle delivery.
 *
 * Internal conversations are NOT purged: pi-durable 1.4.0 has no
 * conversation deletion, and a fork reads its parent's history through
 * ancestry, so each review costs only its own turn's rows. Backup copies
 * the whole database; nothing per-conversation can be excluded (accepted
 * per spec §6.1 P5 — the audit record is the change feed).
 */

import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	DocumentReader,
	Tx,
} from "@earendil-works/pi-durable";
import { SessionMetaDoc } from "../server/session-meta.js";

/**
 * Mark one conversation internal and owned by `owner`, in the creating
 * commit: the P6 fork-review/digest producers call this from
 * `createConversation`'s `init` (the conversation's first commit, so the
 * marker predates every observer). Stamps `owner` too — the curated user
 * the run acts for.
 */
export async function markInternal(
	tx: Tx,
	conversationId: ConversationId,
	owner: string,
): Promise<void> {
	const meta = await tx.doc(SessionMetaDoc, conversationId);
	meta.owner = owner;
	meta.internal = true;
}

/**
 * Whether one conversation is internal, from any `DocumentReader`
 * (including the narrowed reader an extension handler receives). Absent
 * doc or absent flag → false: an ordinary conversation is the default,
 * and a read failure must never hide an ordinary conversation from its
 * owner (fail open on the LISTING side only; the emit-side gates live in
 * the event bus, which resolves once per settle group and caches).
 */
export async function isInternal(
	read: DocumentReader,
	conversationId: ConversationId,
	ctx: Context,
): Promise<boolean> {
	try {
		const meta = await read.snapshot(
			SessionMetaDoc,
			conversationId,
			ctx,
		);
		return meta?.internal === true;
	} catch {
		return false;
	}
}
