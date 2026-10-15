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
	MessageWire,
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
 * The in-flight generation's committed partial message, or undefined when
 * idle (or the doc shape is unexpected — fail soft to absent; upstream
 * drift surfaces in the schema fixture first).
 */
export function liveGenerationPartial(
	view: ConversationViewWire,
): MessageWire | undefined {
	const live = view.docs["pi.live"] as LiveDocWire | undefined;
	const message = live?.generation?.message;
	if (typeof message !== "object" || message === null) return undefined;
	return message as MessageWire;
}

/** How many compaction tasks are live right now (0 = none). */
export function liveCompactions(view: ConversationViewWire): number {
	const live = view.docs["pi.live"] as LiveDocWire | undefined;
	return live?.compactions?.length ?? 0;
}

/** The newest compaction failure's error text, when one is surfaced. */
export function liveCompactionFailure(
	view: ConversationViewWire,
): string | undefined {
	const live = view.docs["pi.live"] as LiveDocWire | undefined;
	const failure = live?.compactionFailure;
	if (typeof failure !== "object" || failure === null) return undefined;
	const error = failure.error;
	return typeof error === "string" && error !== "" ? error : undefined;
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
