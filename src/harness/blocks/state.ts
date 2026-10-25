/**
 * The chat-block state family (UI-blocks U5 Task 1, spec §8.2): the live
 * state of one `sigrun.blocks` entry, a conversation-scoped document
 * family keyed by entry id.
 *
 * Shape `{rev, data, changes, notedThrough}`:
 * - `rev` — the monotonic data revision (both agent `update_blocks` and
 *   user edits advance it; every advance publishes `surface.changed`);
 * - `data` — the CURRENT data (the entry's `data` at `show_blocks` time,
 *   then whatever ops applied since);
 * - `changes` — the user's `ChangeRecord`s (agent updates record NONE:
 *   the agent made the change and already knows);
 * - `notedThrough` — the highest `seq` already sent to the agent in a
 *   §8.3 note. Records at or below it are trimmed once more than
 *   {@link MAX_CHANGES} have accumulated (the trim runs on append).
 *
 * Fork semantics (ruling 19): `history: "latest", fork: "current"` —
 * pi-durable copies the current document at fork creation, so the child
 * gets the block's current `data`, `rev`, records and `notedThrough`,
 * then diverges. Blocks created after the fork point copy too, but are
 * never addressable in the child (their entry is not in its history).
 */

import type { Context } from "@earendil-works/chord";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type {
	ConversationDocFamilyToken,
	ConversationId,
	Harness,
} from "@earendil-works/pi-durable";
import type { JsonObject } from "@sigrun/shared/blocks";

/** One user edit on a chat surface (spec §8.3). */
export type ChangeRecord = {
	/** Monotonic per surface (1, 2, 3…). */
	readonly seq: number;
	/** Epoch ms when the edit landed. */
	readonly at: number;
	/** Who made the edit (the acting user; conversations can be shared). */
	readonly by: string;
	/** The action kind: `reorder`, `edit`, `submit`… */
	readonly action: string;
	/** Core-written, from labels the user saw (Task 2's summarizeAction). */
	readonly summary: string;
};

/** The live state of one chat block (spec §8.2). A type alias (not an interface): pi-durable's `T extends JsonObject` needs the implicit index signature only aliases get. */
export type BlocksState = {
	readonly rev: number;
	readonly data: JsonObject;
	readonly changes: ChangeRecord[];
	readonly notedThrough: number;
};

/** The trim threshold (spec §8.2): trim at-or-below `notedThrough` once more than 50 accumulate. */
export const MAX_CHANGES = 50;

/** The `sigrun.blocks.state` family: one member per (conversation, entry id). */
export const BlocksStateDoc: ConversationDocFamilyToken<BlocksState, string> =
	defineDocFamily<BlocksState, string>({
		kind: "sigrun.blocks.state",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		family: true,
		// The seed only shapes a first touch; every real member is created by
		// show_blocks, which writes the full state in its append commit.
		initial: () => ({ rev: 0, data: {}, changes: [], notedThrough: 0 }),
	});

/**
 * Read one block's state (committed). `undefined` when the conversation
 * has no such member — the entry id is unknown here, or the block was
 * never created in this conversation.
 */
export async function readBlocksState(
	harness: Harness,
	conversationId: number,
	entryId: string,
	ctx: Context,
): Promise<BlocksState | undefined> {
	return await harness.snapshot(
		BlocksStateDoc,
		conversationId as ConversationId,
		entryId,
		ctx,
	);
}

/**
 * Trim change records at or below `notedThrough` once more than
 * {@link MAX_CHANGES} have accumulated (spec §8.2) — in the caller's
 * commit, on the draft the append already holds.
 */
export function trimChanges(state: {
	changes: ChangeRecord[];
	notedThrough: number;
}): void {
	if (state.changes.length <= MAX_CHANGES) return;
	const kept = state.changes.filter(
		(record) => record.seq > state.notedThrough,
	);
	// Keep the newest MAX_CHANGES of what remains (the trim is bounded, not
	// a wholesale wipe): a surge of edits above notedThrough keeps its tail.
	state.changes = kept.slice(Math.max(0, kept.length - MAX_CHANGES));
}
