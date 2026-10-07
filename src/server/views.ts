/**
 * §5 wire serializers (Task 9a).
 *
 * Spec §5: the server serves pi-durable's NATIVE views, not a bespoke
 * endpoint list — so the conversation wire payload IS the `ConversationView`
 * (`{ conversation, entries, docs }`; JSON-safe by construction: JsonObject
 * docs, EntryRecords whose `model` messages are plain pi-ai JSON). The
 * captured-schema fixture (`schema-fixture.ts`, `view-schema.json`) pins this
 * shape; `test/schema-drift.test.ts` trips on upstream drift.
 *
 * `serializeConversationView` is therefore a structural passthrough today —
 * the single chokepoint where per-conversation projections land in later
 * slices (T9d adds the `steer` field, T9b/T9c surface submissions and
 * approvals). Every §5 endpoint that returns a conversation goes through it,
 * so the fixture continues to describe the wire.
 */

import type { ConversationView } from "@earendil-works/pi-durable";

/**
 * One conversation as served over the wire. Returned as-is: upstream view
 * frames are immutable and JSON-safe, so Fastify's JSON serialization of the
 * reference is exact — no copy, no projection, nothing to drift from the
 * fixture.
 */
export function serializeConversationView(view: ConversationView): ConversationView {
	return view;
}

/** One list item of `GET /v1/conversations` (Task 9a: ids, not full views). */
export interface ConversationSummary {
	readonly id: number;
	/** The conversation this summary describes is the reserved root. */
	readonly root: boolean;
	/** Live active-entry count at list time (a cheap liveness signal). */
	readonly entryCount: number;
}

/** The list response of `GET /v1/conversations`. */
export interface ConversationList {
	readonly conversations: readonly ConversationSummary[];
}

/** The create response of `POST /v1/conversations`. */
export interface ConversationCreateResponse {
	readonly id: number;
	readonly view: ConversationView;
}
