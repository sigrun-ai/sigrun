/**
 * The `docs["pi.live"]` LiveState narrowing (gateway plan 1, Task 1).
 *
 * `pi.live` is the harness's live-run document — `run` while a generation
 * is in flight, `generation.message` (the committed throttled partial of
 * the response), `tools` (live tool slots), `compactions`, and
 * `compactionFailure` (shape per pi-durable dist/harness/live.d.ts).
 * `ConversationViewBase` types `docs` values as `JsonObject`: named
 * LiveDocs are narrowed by their consumers, and this module is that
 * narrowing for `pi.live` — shared by the webui, the tui and the gateway
 * engine so every reader narrows the doc identically.
 *
 * Purity: a shared wire module — `import type` sibling-only (the purity
 * guard in test/views-purity.test.ts); the runtime functions below are
 * dependency-free so both clients (DOM-only webui, NodeNext tui) and the
 * server read the same doc the same way.
 */

import type { ConversationViewBase } from "./views.js";

/** One live tool slot of `docs["pi.live"]` (the LiveState tools list). */
export interface LiveToolSlotWire {
	readonly callId: string;
	readonly name: string;
	readonly status: string;
	readonly output?: string;
}

/**
 * The `docs["pi.live"]` LiveState doc, narrowed to what the channels read:
 * `run` (present exactly while busy — the steer field derives from it
 * server-side), `generation.message` (the committed throttled partial of
 * the in-flight response), `tools` (live tool slots), `compactions` (live
 * compaction tasks), `compactionFailure` (the newest failure — a
 * completed compaction clears it; nothing-to-compact or a fault leaves
 * it).
 */
export interface LiveDocWire {
	readonly run?: unknown;
	readonly generation?: { readonly message?: unknown };
	readonly tools?: readonly LiveToolSlotWire[];
	readonly compactions?: readonly unknown[];
	readonly compactionFailure?: { readonly error?: unknown };
}

/**
 * The view's `pi.live` doc, or undefined when absent (idle and never-run
 * conversations carry no doc). A cast, not a validation: the shape is
 * pinned by the harness writer and the fail-soft reads below absorb
 * drift.
 */
export function liveDoc(view: ConversationViewBase): LiveDocWire | undefined {
	// SAFETY: `docs` values are `JsonObject` by wire contract; `pi.live` is
	// the harness's own LiveState document. The cast narrows the wire type,
	// it does not validate — every reader below is fail-soft against drift.
	return view.docs["pi.live"] as unknown as LiveDocWire | undefined;
}

/** The live tool slots of the view's `pi.live` doc (empty when absent). */
export function liveToolSlots(
	view: ConversationViewBase,
): readonly LiveToolSlotWire[] {
	return liveDoc(view)?.tools ?? [];
}

/**
 * The in-flight generation's committed partial message, or undefined when
 * idle (or the doc shape is unexpected — fail soft to absent; upstream
 * drift surfaces in the schema fixture first).
 */
export function liveGenerationPartial(
	view: ConversationViewBase,
): object | undefined {
	const message = liveDoc(view)?.generation?.message;
	if (typeof message !== "object" || message === null) return undefined;
	return message;
}

/** The partial-message slots the text join reads. */
type PartialMessage = { readonly content?: unknown };

/** One content block of the partial, as the join reads it. */
type PartialBlock = { readonly type?: unknown; readonly text?: unknown };

/**
 * The in-flight generation's visible text: the partial's text blocks
 * (`{type: "text"}`) joined with `""` — thinking and tool-call blocks
 * contribute nothing. `""` when idle or the content is not an array; a
 * string `content` returns as-is.
 */
export function liveGenerationText(view: ConversationViewBase): string {
	const partial = liveGenerationPartial(view);
	if (partial === undefined) return "";
	const content = (partial as PartialMessage).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content as readonly unknown[]) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as PartialBlock;
		if (typed.type !== "text" || typeof typed.text !== "string") continue;
		text += typed.text;
	}
	return text;
}

/** How many compaction tasks are live right now (0 = none). */
export function liveCompactions(view: ConversationViewBase): number {
	return liveDoc(view)?.compactions?.length ?? 0;
}

/** The newest compaction failure's error text, when one is surfaced. */
export function liveCompactionFailure(
	view: ConversationViewBase,
): string | undefined {
	const failure = liveDoc(view)?.compactionFailure;
	if (typeof failure !== "object" || failure === null) return undefined;
	const error = failure.error;
	return typeof error === "string" && error !== "" ? error : undefined;
}
