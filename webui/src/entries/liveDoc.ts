/**
 * The webui's `pi.live` typing seam over the shared narrowing
 * (`@sigrun/shared/live`, gateway plan 1 Task 1): the doc reads live in
 * the shared package now — the gateway engine and every channel narrow
 * `pi.live` identically there — and this module keeps the webui's
 * narrowed view/message types (`MessageWire`-shaped partial, the
 * `ToolSlotWire` spelling) as casts over the shared results, plus the
 * webui-only entry↔slot join. `view.docs` is `Record<string, unknown>`
 * on the webui's narrowed view (the shared base narrows it further), so
 * each read passes the view through the shared base type.
 */

import type {
	ConversationEntryWire,
	ConversationViewWire,
	MessageWire,
	ToolSlotWire,
} from "../api";
import type { ConversationViewBase } from "@sigrun/shared/views";
import {
	liveCompactionFailure as sharedLiveCompactionFailure,
	liveCompactions as sharedLiveCompactions,
	liveGenerationPartial as sharedLiveGenerationPartial,
	liveToolSlots as sharedLiveToolSlots,
} from "@sigrun/shared/live";

/** The webui's narrowed view, as the shared readers take it. */
function asBase(view: ConversationViewWire): ConversationViewBase {
	// SAFETY: the webui's view is the same wire frame with a deliberately
	// looser `docs` value type — every shared read re-narrows per doc.
	return view as ConversationViewBase;
}

/** The live tool slots of the view's `pi.live` doc (empty when absent). */
export function liveToolSlots(
	view: ConversationViewWire,
): readonly ToolSlotWire[] {
	return sharedLiveToolSlots(asBase(view));
}

/**
 * The in-flight generation's committed partial message, or undefined when
 * idle (or the doc shape is unexpected — fail soft to absent; upstream
 * drift surfaces in the schema fixture first).
 */
export function liveGenerationPartial(
	view: ConversationViewWire,
): MessageWire | undefined {
	// SAFETY: the shared reader already guards `generation.message` to an
	// object; the wire partial is the assistant message shape.
	return sharedLiveGenerationPartial(asBase(view)) as
		| MessageWire
		| undefined;
}

/** How many compaction tasks are live right now (0 = none). */
export function liveCompactions(view: ConversationViewWire): number {
	return sharedLiveCompactions(asBase(view));
}

/** The newest compaction failure's error text, when one is surfaced. */
export function liveCompactionFailure(
	view: ConversationViewWire,
): string | undefined {
	return sharedLiveCompactionFailure(asBase(view));
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
