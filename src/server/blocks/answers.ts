/**
 * The block answer (UI-blocks U5 Task 3, spec §8.4): a turn action
 * (`submit`, default `turn: true`; any action with `turn: true`) makes
 * core submit a user message for the acting user through the normal
 * submission path (`submitOp`):
 *
 *   { type: "input",
 *     content: textProjection,             // "Submitted 'Ranking': 1. …"
 *     entry: { kind: "sigrun.blocks.answer",
 *              data: { entryId, action, payload, state } },
 *     requestId: "blocks:" + actionId }
 *
 * The surface's unnoted change records fold into `content` first and
 * `notedThrough` advances BEFORE the §8.3 note step runs — so the turn
 * sends no separate note for this surface, while changes on OTHER
 * surfaces still note. `requestId` makes a double click one turn.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";
import { toText } from "@sigrun/shared/blocks";
import type { ServerContext } from "../context.js";
import { submitOp } from "../conversation-ops.js";
import { readChatBlock } from "./chat-surfaces.js";
import { NOTE_HEADER } from "./notes.js";
import {
	PROJECTION_LOCALE,
	PROJECTION_WIDTH,
} from "../../harness/blocks/tools.js";
import { BlocksAnswerEntry } from "../../harness/blocks/entries.js";
import { BlocksStateDoc } from "../../harness/blocks/state.js";

/** The `sigrun.blocks.answer` entry data (spec §8.4). */
export type BlocksAnswerData = {
	readonly entryId: string;
	readonly action: string;
	readonly payload: JsonValue;
	/** The surface's post-edit data the answer carries. */
	readonly state: JsonObject;
};

/**
 * Submit one block answer: fold the surface's unnoted changes and its
 * current projection into the user-visible content, advance the
 * surface's `notedThrough`, then admit the input through `submitOp` with
 * `skipNoteFor` (this surface notes no further this turn) and the
 * answer entry. The route owns access gating and actionId dedup; this
 * caller runs only for a located, write-accessible block whose handler
 * starts a turn.
 *
 * The fold and the `notedThrough` advance run in ONE commit BEFORE the
 * note step (§8.4: "The surface's unnoted change records are folded into
 * `content` first, and `notedThrough` advances, before the §8.3 note
 * step runs"), so the answer turn never double-reports its surface.
 */
export async function answerBlock(
	ctx: ServerContext,
	conversationId: number,
	entryId: string,
	action: string,
	payload: JsonValue,
	actionId: string | undefined,
): Promise<void> {
	const { opened } = ctx;
	const block = await readChatBlock(opened.harness, conversationId, entryId);
	if (block === undefined) {
		throw new Error(`answerBlock: block ${entryId} not found`);
	}
	const conversation = await opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) {
		throw new Error(`answerBlock: conversation ${conversationId} not found`);
	}
	// The fold (one commit): read the CURRENT state, build the content
	// (changes + projection), advance notedThrough past every record the
	// fold covers.
	const folded = await conversation.commit(async (tx) => {
		const draft = await tx.doc(
			BlocksStateDoc,
			conversationId as ConversationId,
			entryId,
			entryId,
		);
		const pending = draft.changes.filter(
			(record) => record.seq > draft.notedThrough,
		);
		const lines: string[] = [];
		if (pending.length > 0) {
			const byAuthor = new Map<string, string[]>();
			for (const record of pending) {
				const list = byAuthor.get(record.by) ?? [];
				list.push(record.summary);
				byAuthor.set(record.by, list);
			}
			lines.push(NOTE_HEADER);
			for (const [author, summaries] of byAuthor) {
				lines.push(`• ${block.title} (${author}): ${summaries.join("; ")}`);
			}
		}
		lines.push(
			`Submitted '${block.title}': ${toText(block.tree, draft.data, {
				width: PROJECTION_WIDTH,
				locale: PROJECTION_LOCALE,
			})}`,
		);
		if (pending.length > 0) {
			draft.notedThrough = pending[pending.length - 1]!.seq;
		}
		return {
			content: lines.join("\n"),
			state: JSON.parse(JSON.stringify(draft.data)) as JsonObject,
		};
	}, BACKGROUND_CONTEXT);
	await submitOp(ctx, conversation, folded.content, {
		...(actionId === undefined ? {} : { requestId: `blocks:${actionId}` }),
		skipNoteFor: entryId,
		entry: {
			kind: BlocksAnswerEntry.kind,
			data: {
				entryId,
				action,
				payload,
				state: folded.state,
			} satisfies BlocksAnswerData,
		},
	});
}
