/**
 * Activity-time stamping (UI refresh Task A1): the `lastActivityAt` seam.
 *
 * One server-owned session-meta field, stamped at exactly two moments —
 * submission admission (the submissions route, so a sidebar sorts by
 * activity the moment a prompt lands, before the run settles) and run
 * settlement (the event bus's settled hook, so background runs — tasks,
 * tools, other processes — stamp too). Both write through ONE
 * `conversation.commit` setting `lastActivityAt = now().toISOString()`;
 * the `now` seam is injectable so tests pin the instant.
 *
 * The stamp's only reader is the conversation listing
 * (`ConversationSummary.lastActivityAt`) — never the wire view (the view
 * mounts pi-durable's built-in docs only, so the schema fixture is
 * unaffected by this write).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { SessionMetaDoc } from "../server/session-meta.js";
import type { EventBus } from "./event-bus.js";

/**
 * Stamp `lastActivityAt` on one conversation's session-meta doc. A missing
 * conversation is a no-op (the bus observes settles for conversations this
 * process may no longer resolve — a dropped-elsewhere id must not fault
 * the drain loop).
 */
export async function touchActivity(
	harness: Harness,
	conversationId: ConversationId,
	now: () => Date,
	context: Context,
): Promise<void> {
	const conversation = await harness.conversation(conversationId, context);
	if (conversation === undefined) return;
	await conversation.commit(async (tx) => {
		const draft = await tx.doc(SessionMetaDoc, conversationId);
		draft.lastActivityAt = now().toISOString();
	}, context);
}

/**
 * Wire the settle-side stamping: every settled run stamps its
 * conversation. Registered right after `EventBus.open` (before extension
 * registrations — host-owned machinery runs first); returns the
 * unsubscribe (the bus's own close stops delivery regardless).
 */
export function wireActivity(
	bus: EventBus,
	harness: Harness,
	now: () => Date = () => new Date(),
): () => void {
	return bus.onSettled((group) =>
		touchActivity(harness, group.conversationId, now, BACKGROUND_CONTEXT),
	);
}
