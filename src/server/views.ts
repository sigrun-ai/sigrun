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

/**
 * The admit response of `POST /v1/conversations/:id/submissions` (Task 9b):
 * the durable submission record (`SubmissionRecord` — id, conversationId,
 * requestId?, type, status, entry?/answer?/reason?) after waiting for
 * settlement. v1 waits server-side (SSE watch is T9d); the record is the
 * wire shape.
 */
export interface SubmissionResponse {
	readonly id: number;
	readonly conversationId: number;
	readonly type: string;
	readonly status: string;
	readonly entry?: number;
	readonly answer?: number;
	readonly reason?: string;
}

/** The upload response of `POST /v1/conversations/:id/uploads` (Task 9b). */
export interface UploadResponse {
	/** The workspace-relative path to use in submission content parts. */
	readonly path: string;
}

/** One `GET /v1/conversations/:id/files` entry (upstream `FileInfo`). */
export interface FileEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number;
	readonly mtimeMs: number;
}

/** The list response of `GET /v1/conversations/:id/files` (Task 9b). */
export interface FileListResponse {
	readonly entries: readonly FileEntry[];
}

/** The read response of `GET /v1/conversations/:id/files/content`. */
export interface FileContentResponse {
	/** `"text"` (valid UTF-8) or `"base64"` (binary). */
	readonly encoding: "text" | "base64";
	readonly content: string;
	/** Size in bytes. */
	readonly size: number;
}

/** One `GET /v1/models` entry (Task 9b): picker fields, no provider internals. */
export interface ModelEntry {
	/** `"provider/modelId"` — the id submission/configure `model` takes. */
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly reasoning: boolean;
	readonly input: readonly string[];
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
}

/** The response of `GET /v1/models`. */
export interface ModelsResponse {
	readonly models: readonly ModelEntry[];
}
