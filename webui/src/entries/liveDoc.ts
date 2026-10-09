/**
 * The `docs["pi.live"]` LiveState narrowing the entry renderers need
 * (Task 22): the live tool slots (running/pending state per call) and the
 * entry↔slot join by tool-call id. `view.docs` is `Record<string, unknown>`
 * on the wire (named LiveDocs are narrowed by their consumers) — this module
 * is the hand-mirror seam for `pi.live`.
 */

import type {
	ConversationEntryWire,
	ConversationViewWire,
	LiveDocWire,
	ToolSlotWire,
} from "../api";

/** The live tool slots of the view's `pi.live` doc (empty when absent). */
export function liveToolSlots(
	view: ConversationViewWire,
): readonly ToolSlotWire[] {
	const live = view.docs["pi.live"] as LiveDocWire | undefined;
	return live?.tools ?? [];
}

/**
 * The live slot matching a `pi.tool-result` entry (joined by
 * `toolCallId === callId`), or undefined when the tool has no live slot
 * (a committed, finished tool result — the steady state of history).
 */
export function slotForEntry(
	entry: ConversationEntryWire,
	slots: readonly ToolSlotWire[],
): ToolSlotWire | undefined {
	for (const message of entry.model ?? []) {
		if (typeof message.toolCallId === "string") {
			const match = slots.find(
				(slot) => slot.callId === message.toolCallId,
			);
			if (match !== undefined) return match;
		}
	}
	return undefined;
}
