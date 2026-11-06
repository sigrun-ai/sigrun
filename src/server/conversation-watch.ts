/**
 * The full-history conversation watch (pi-durable 1.5.0 Task 2, D1-A).
 *
 * D1-A: a conversation view's `entries` is the append-only, fork-aware RAW
 * HISTORY keyed by entry id — never the model's context — and nothing in
 * core cuts entries at a `pi.compaction`/`pi.reset` head marker. Upstream
 * windows DEFAULT to sliding (`{min: 50, max: 100}`), which would drop the
 * oldest entries once a conversation outgrows 100; pinning the window to
 * {@link FULL_HISTORY_WINDOW} makes the watch never slide.
 *
 * One window for every server-side watch: the SSE view stream
 * (`routes/stream.ts`), the host bridge's `conversations.watch`
 * (`host-bridge.ts`), and one-shot reads (`helpers.ts` `readView`).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationView,
	ConversationWatch,
	ConversationWindow,
} from "@earendil-works/pi-durable";

/**
 * The never-sliding window: `min`/`max` at the upstream cap (`2 ** 31`
 * validation ceiling), so the watch holds every entry the transcript ever
 * gains and never drops its oldest.
 */
export const FULL_HISTORY_WINDOW: ConversationWindow = {
	min: 2 ** 30,
	max: 2 ** 31,
};

/**
 * Watch a conversation's full history. The returned handle's `value` is the
 * acquisition revision (every entry so far); later revisions keep the whole
 * history because the window never slides.
 */
export function watchFullHistory(
	conversation: Conversation,
	context: Context,
): Promise<ConversationWatch> {
	return conversation.watch(context, FULL_HISTORY_WINDOW);
}

/**
 * Read one conversation's current full-history view; disposes the watch
 * handle (the temporary Task-1 `readView` shape, now never-sliding).
 */
export async function readFullView(
	conversation: Conversation,
	context: Context,
): Promise<ConversationView> {
	const watch = await watchFullHistory(conversation, context);
	try {
		return watch.value;
	} finally {
		await watch.stop();
	}
}

/** Convenience: the background-context read (helpers.ts `readView`). */
export function readFullConversationView(
	conversation: Conversation,
): Promise<ConversationView> {
	return readFullView(conversation, BACKGROUND_CONTEXT);
}
