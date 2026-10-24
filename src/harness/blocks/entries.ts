/**
 * The chat-blocks entry kinds (UI-blocks U5 Task 1, spec §8.2 storage):
 * typed pi-durable entries the transcript carries.
 *
 * - `sigrun.blocks` (`BlocksEntry`): one agent-authored block surface,
 *   `{title, tree, data}` EXACTLY as `show_blocks` created it. It never
 *   changes — the live state lives in the `sigrun.blocks.state` family
 *   (state.ts); the entry is the immutable definition the channels
 *   re-render from.
 * - `sigrun.blocks.note` (`BlocksNoteEntry`): the §8.3 change note — a
 *   `type: "write"` submission whose entry carries the note as a `model`
 *   user message. Declared here so the kind token exists in one place;
 *   the note WRITER is Task 3 (src/server/blocks/notes.ts).
 * - `sigrun.blocks.answer` (`BlocksAnswerEntry`, Task 3): a block answer
 *   as an input entry kind. Declared alongside for the same
 *   one-place-ness; Task 3 owns its writer.
 *
 * Payload typing: `Tree`'s block interfaces carry no implicit index
 * signatures, so the payload cannot satisfy pi-durable's
 * `D extends JsonValue` on its own — `tree` is typed `Tree & JsonValue`
 * (verified: a `Tree` literal satisfies the intersection), and the
 * runtime object pi-durable stores is exactly the validated tree.
 */

import { defineEntry } from "@earendil-works/pi-durable";
import type { Entry } from "@earendil-works/pi-durable";
import type { JsonObject, JsonValue, Tree } from "@sigrun/shared/blocks";

/** The payload a `sigrun.blocks` entry carries (spec §8.2): immutable once appended. */
export type BlocksPayload = {
	readonly title: string;
	/** The validated chat tree, as created (the `Tree & JsonValue` shape above). */
	readonly tree: Tree & JsonValue;
	readonly data: JsonObject;
};

/** One agent-authored block surface in chat (spec §8.2): never changes. */
export const BlocksEntry: Entry<BlocksPayload> =
	defineEntry<BlocksPayload>("sigrun.blocks");

/**
 * The §8.3 change note entry: `model` is `[UserMessage]` carrying the
 * note text (Task 3 writes it before every turn admission); no payload.
 */
export const BlocksNoteEntry: Entry<never> = defineEntry("sigrun.blocks.note");

/**
 * A block answer as a user-turn entry (Task 3): `model` is `[UserMessage]`
 * with the server-built answer projection; no payload — the answer's
 * `{entryId, action, payload, state}` ride the submission record.
 */
export const BlocksAnswerEntry: Entry<never> =
	defineEntry("sigrun.blocks.answer");
