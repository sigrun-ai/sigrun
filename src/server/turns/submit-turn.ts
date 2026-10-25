/**
 * The turn-admission helper (UI-blocks U5 Task 3, spec §8.3 "Where"):
 * the one prelude every turn starter runs BEFORE its input submission —
 * the §8.3 change note.
 *
 * `submitOp` (src/server/conversation-ops.ts — the composer route and
 * `host.conversations.submit`) inlines this prelude itself; `fireJob`
 * (src/jobs/fire.ts) submits directly and calls {@link noteThen} at both
 * prompt-action sites. The grep-style pin in
 * test/submit-turn-callers.test.ts keeps the `type: "input"` call-site
 * list to exactly those three, so a new turn starter can never skip the
 * note silently.
 */

import type { Context } from "@earendil-works/chord";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { writePendingNote } from "../blocks/notes.js";

/**
 * Write the conversation's pending change note, if any, then run
 * `submitInput` (the caller's input admission). The note precedes the
 * input: when the conversation is busy both queue in `pi.inbox`, and
 * pi-durable places every queued write before any queued user item at
 * each boundary — the note reaches the model first, a steer included.
 * Jobs never pass `skipEntry` (a job never answers a block).
 */
export async function noteThen<T>(
	harness: Harness,
	conversation: Conversation,
	submitInput: () => Promise<T>,
	ctx: Context,
): Promise<T> {
	await writePendingNote(harness, conversation, undefined, ctx);
	return await submitInput();
}
