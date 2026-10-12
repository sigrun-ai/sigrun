/**
 * §5 wire serializers (Tasks 9a–9d).
 *
 * Spec §5: the server serves pi-durable's NATIVE views, not a bespoke
 * endpoint list — so the conversation wire payload IS the `ConversationView`
 * (`{ conversation, entries, docs }`; JSON-safe by construction: JsonObject
 * docs, EntryRecords whose `model` messages are plain pi-ai JSON) PLUS the
 * sigrun-side `steer` field (T9d, below). The captured-schema fixture
 * (`schema-fixture.ts`, `view-schema.json`) pins the UPSTREAM shape only —
 * `steer` is a sigrun projection, not upstream drift — and
 * `test/schema-drift.test.ts` trips on upstream drift while asserting the
 * wire is exactly view + `steer`.
 *
 * `serializeConversationView` is the single chokepoint every §5 endpoint
 * that returns a conversation goes through — including each SSE watch
 * frame (T9d) — so the fixture continues to describe the wire.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ConversationView,
	JsonObject,
	ModelRef,
} from "@earendil-works/pi-durable";

/**
 * The per-conversation steer field (spec §5: "reflecting submit-while-busy
 * queue semantics"). `busy` = a run is live; `queued` = submissions waiting
 * in the inbox behind it.
 */
export interface SteerField {
	readonly busy: boolean;
	readonly queued: number;
}

/**
 * One conversation as served over the wire: the upstream view plus the
 * derived `steer` field (see {@link serializeConversationView}).
 */
export type ConversationViewWire = ConversationView & {
	readonly steer: SteerField;
};

/**
 * Derive the steer field from the view's own docs — no extra inspect()/
 * storage call per frame (the watch fires per revision; the docs are
 * already in the frame).
 *
 * - `busy`: `docs["pi.live"].run` present — LiveState's run control
 *   (taskId + inputs) exists "present exactly while busy"
 *   (pi-durable live.d.ts).
 * - `queued`: `docs["pi.inbox"].items` length — the built-in queue of
 *   submissions waiting for a boundary; absent doc = 0.
 */
function deriveSteer(view: ConversationView): SteerField {
	// docs is an untyped Record<string, JsonObject>; both shapes are
	// narrowed structurally (unexpected shapes fail soft to idle — upstream
	// drift would surface in the schema fixture first).
	const live = view.docs["pi.live"];
	const busy =
		typeof live === "object" &&
		live !== null &&
		typeof (live as { run?: unknown }).run === "object" &&
		(live as { run?: unknown }).run !== null;
	const inbox = view.docs["pi.inbox"];
	const items =
		typeof inbox === "object" && inbox !== null
			? (inbox as { items?: unknown }).items
			: undefined;
	const queued = Array.isArray(items) ? items.length : 0;
	return { busy, queued };
}

/**
 * Serialize one conversation view onto the wire: the upstream view plus the
 * derived `steer` field. A shallow spread (upstream frames are immutable
 * and JSON-safe; `conversation`/`entries`/`docs` are shared by reference —
 * the projection adds one key, it never rewrites upstream state).
 */
export function serializeConversationView(
	view: ConversationView,
): ConversationViewWire {
	return { ...view, steer: deriveSteer(view) };
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
	readonly view: ConversationViewWire;
}

/** The `Content-Type` of the JSONL export/import wire (Task 5b/5c). */
export const JSONL_CONTENT_TYPE = "application/x-ndjson";

/**
 * The fork response of `POST /v1/conversations/:id/fork` (Task 5a): the
 * create shape — a NEW conversation id plus its first view frame.
 */
export type ConversationForkResponse = ConversationCreateResponse;

/**
 * The import response of `POST /v1/conversations/import` (Task 5c): the
 * create shape — the new conversation id plus its view with the appended
 * entries in order.
 */
export type ConversationImportResponse = ConversationCreateResponse;

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

/** The configured agent surface `POST .../configure` returns (T9c-i). */
export interface ConfigureResponse {
	/** Absent when unset — no model means no generation. */
	readonly model?: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
}

/** The result mapping `POST .../abort` returns (T9c-i). */
export type AbortResponse =
	| { readonly result: "aborted"; readonly submissionId: number }
	| { readonly result: "already_placed"; readonly submissionId: number }
	| { readonly result: "settled"; readonly submissionId: number };

/**
 * The admit response of `POST /v1/conversations/:id/compact` (Task 4, pi
 * parity): the durable compaction task's id. The task is conversation-owned
 * (manual): it compacts even when idle and places its summary through a
 * write submission; the SSE stream carries the `pi.compaction` entry.
 */
export interface CompactResponse {
	readonly taskId: number;
}

/**
 * One pending approval in `GET /v1/conversations/:id/approvals` (T9c-ii),
 * joined from the LiveDoc tool slot (callId, toolName) and the
 * `ApprovalsDoc[callId]` record (status, arguments, requestedAt). A slot
 * live with no decision record yet is `pending` and carries no `arguments`
 * (the loader wires no `onPending` sink, so the record lands on first
 * decide).
 */
export interface ApprovalSummary {
	readonly callId: string;
	readonly toolName: string;
	readonly status: "pending";
	readonly arguments?: JsonObject;
	readonly requestedAt?: number;
}

/** The list response of `GET /v1/conversations/:id/approvals` (T9c-ii). */
export interface ApprovalList {
	readonly approvals: readonly ApprovalSummary[];
}

/** The response of `POST /v1/conversations/:id/approvals/:approvalId` (T9c-ii). */
export interface ApprovalDecideResponse {
	readonly callId: string;
	readonly status: "allow" | "deny";
}
