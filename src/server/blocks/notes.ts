/**
 * The §8.3 change note (UI-blocks U5 Task 3): before the agent's next
 * turn, core writes ONE `sigrun.blocks.note` entry covering every
 * surface with change records above `notedThrough`, then advances each
 * surface's `notedThrough` in one commit.
 *
 * The note is a `type: "write"` submission whose entry carries the note
 * as a `model` user message — when the conversation is idle pi-durable
 * appends it at once; when busy, both the note and the input queue in
 * `pi.inbox`, and pi-durable places every queued write before any queued
 * user item at each boundary (`harness/inbox.js` applyBoundary), so the
 * note always precedes its input, a steer included.
 *
 * Exactly once (§8.3): the write's `requestId` is
 * `blocks-note:<conversationId>:<sha256 of the sorted (entryId,
 * notedThrough) pairs BEFORE advancing>` — a key over the pre-advance
 * positions only, never the carried changes, so new edits arriving after
 * the note compute cannot change the key; a crash between the admission
 * and the advance re-sends under the SAME key and pi-durable returns the
 * existing submission (`submissionByRequest`).
 */

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	Harness,
} from "@earendil-works/pi-durable";
import type { UserMessage } from "@earendil-works/pi-ai";
import { toText } from "@sigrun/shared/blocks";
import {
	PROJECTION_LOCALE,
	PROJECTION_WIDTH,
} from "../../harness/blocks/tools.js";
import {
	BlocksEntry,
	BlocksNoteEntry,
	type BlocksPayload,
} from "../../harness/blocks/entries.js";
import {
	BlocksStateDoc,
	type BlocksState,
} from "../../harness/blocks/state.js";

/** The note's header line (spec §8.3, verbatim). */
export const NOTE_HEADER = "Changes made to your UI since your last turn:";

/** The per-surface change-line cap (spec §8.3): the oldest fold into "…and N earlier changes". */
export const MAX_NOTE_CHANGE_LINES = 50;

/**
 * The test seam for the crash-recovery case: when armed, the NEXT
 * `writePendingNote` throws right after the note's admission (before the
 * `notedThrough` advance) — the durable record of the crash window the
 * exactly-once key exists for. One-shot: the throw consumes the arm.
 */
let throwAfterNextAdmission = false;

/** Arm the crash seam (see the field above). Test-only. */
export function throwAfterNextNoteAdmissionForTesting(): void {
	throwAfterNextAdmission = true;
}

/** One surface's pending note contribution. */
interface PendingSurface {
	readonly entryId: string;
	readonly title: string;
	readonly state: BlocksState;
	/** The records above `notedThrough` this note covers. */
	readonly pending: BlocksState["changes"];
	/** The block's tree (the "Current state" projection's labels). */
	readonly tree: BlocksPayload["tree"];
}

/** What `pendingNote` computes: the note plus the advance to apply after admission. */
export interface PendingNote {
	readonly text: string;
	readonly requestId: string;
	/** The `notedThrough` advances (entryId → the covered top seq). */
	readonly advance: { entryId: string; through: number }[];
}

/**
 * Render one surface's note section (spec §8.3): the bullet line naming
 * the surface and each editor (`• <title> (<user>): <summaries joined by
 * "; ">` — one line per distinct author, in first-appearance order) then
 * `Current state of <title>: <toText of the surface at its CURRENT data>`.
 * Over {@link MAX_NOTE_CHANGE_LINES} change lines for a surface, the
 * oldest fold into "…and N earlier changes".
 */
function renderSurface(surface: PendingSurface): string {
	const lines: string[] = [];
	// Group the pending records by author, first-appearance order.
	const byAuthor = new Map<string, string[]>();
	for (const record of surface.pending) {
		const list = byAuthor.get(record.by) ?? [];
		list.push(record.summary);
		byAuthor.set(record.by, list);
	}
	for (const [author, summaries] of byAuthor) {
		if (summaries.length > MAX_NOTE_CHANGE_LINES) {
			const earlier = summaries.length - MAX_NOTE_CHANGE_LINES;
			const kept = summaries.slice(earlier);
			lines.push(
				`• ${surface.title} (${author}): …and ${earlier} earlier changes; ${kept.join("; ")}`,
			);
		} else {
			lines.push(`• ${surface.title} (${author}): ${summaries.join("; ")}`);
		}
	}
	const projection = toText(surface.tree, surface.state.data, {
		width: PROJECTION_WIDTH,
		locale: PROJECTION_LOCALE,
	});
	lines.push(`Current state of ${surface.title}: ${projection}`);
	return lines.join("\n");
}

/**
 * Compute the pending change note for one conversation (spec §8.3):
 * every `sigrun.blocks` entry in the conversation whose state carries
 * change records above `notedThrough`. `skipEntry` excludes ONE surface
 * (the block answer folds its own surface's changes into the answer
 * instead — §8.4). `undefined` when nothing is unnoted.
 */
export async function pendingNote(
	harness: Harness,
	conversationId: number,
	skipEntry: string | undefined,
	ctx: Context,
): Promise<PendingNote | undefined> {
	const conversation = await harness.conversation(
		conversationId as ConversationId,
		ctx,
	);
	if (conversation === undefined) return undefined;
	// Every block entry in the conversation (oldest first — the note
	// lists surfaces in transcript order).
	const page = await conversation.entries({}, 500, undefined, ctx);
	const blocks: { entryId: string; payload: BlocksPayload }[] = [];
	for (const entry of [...page.items].reverse()) {
		if (entry.kind !== BlocksEntry.kind) continue;
		blocks.push({
			entryId: String(entry.id),
			payload: entry.data as BlocksPayload,
		});
	}
	const surfaces: PendingSurface[] = [];
	for (const block of blocks) {
		if (block.entryId === skipEntry) continue;
		const state = await harness.snapshot(
			BlocksStateDoc,
			conversationId as ConversationId,
			block.entryId,
			ctx,
		);
		if (state === undefined) continue;
		const pending = state.changes.filter(
			(record) => record.seq > state.notedThrough,
		);
		if (pending.length === 0) continue;
		surfaces.push({
			entryId: block.entryId,
			title: block.payload.title,
			state,
			pending,
			tree: block.payload.tree,
		});
	}
	if (surfaces.length === 0) return undefined;
	// The exactly-once key: the sorted (entryId, notedThrough) pairs as
	// they stand BEFORE this note advances them (spec §8.3).
	const pairs = surfaces
		.map((surface) => [surface.entryId, String(surface.state.notedThrough)])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const digest = createHash("sha256")
		.update(JSON.stringify(pairs))
		.digest("hex");
	const text = [
		NOTE_HEADER,
		...surfaces.map((surface) => renderSurface(surface)),
	].join("\n");
	return {
		text,
		requestId: `blocks-note:${conversationId}:${digest}`,
		advance: surfaces.map((surface) => ({
			entryId: surface.entryId,
			// The covered top seq: the newest pending record. New edits
			// landing after this compute advance only as far as the note
			// covers — they stay pending for the NEXT note.
			through: surface.pending[surface.pending.length - 1]!.seq,
		})),
	};
}

/**
 * Write the pending change note for one conversation, when there is one:
 * compute it, admit the `sigrun.blocks.note` write (model-facing, so a
 * busy conversation queues it ahead of the input the caller submits
 * next), then advance each covered surface's `notedThrough` in ONE
 * commit. `skipEntry` excludes one surface (the block-answer fold,
 * §8.4).
 *
 * Order is the exactly-once contract (§8.3): admission FIRST (a crash
 * after it re-sends under the same requestId — `pendingNote` computes
 * the key from the pre-advance positions, which a crashed advance never
 * moved — and pi-durable returns the existing submission), the advance
 * SECOND. The caller submits the turn's input after this returns.
 */
export async function writePendingNote(
	harness: Harness,
	conversation: Conversation,
	skipEntry: string | undefined,
	ctx: Context,
): Promise<void> {
	const note = await pendingNote(
		harness,
		conversation.id as number,
		skipEntry,
		ctx,
	);
	if (note === undefined) return;
	const message: UserMessage = {
		role: "user",
		content: note.text,
		timestamp: Date.now(),
	};
	await conversation.submit(
		{
			type: "write",
			entry: { kind: BlocksNoteEntry.kind, model: [message] },
			requestId: note.requestId,
		},
		ctx,
	);
	// The crash seam (test-only, see the field's docblock): admission
	// landed, the advance never runs — the retry path's premise.
	if (throwAfterNextAdmission) {
		throwAfterNextAdmission = false;
		throw new Error("injected crash after note admission");
	}
	// Advance `notedThrough` per covered surface in ONE commit (the note
	// is durable; the advance just moves the watermark).
	await conversation.commit(async (tx) => {
		for (const { entryId, through } of note.advance) {
			const draft = await tx.doc(
				BlocksStateDoc,
				conversation.id,
				entryId,
				entryId,
			);
			// Never move the watermark BACKWARD (a retried note after a
			// newer advance is a no-op).
			if (draft.notedThrough < through) draft.notedThrough = through;
		}
	}, ctx);
}
