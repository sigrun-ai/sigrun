/**
 * §5 wire serializers (Tasks 9a–9d) — THE channel contract.
 *
 * This module is sigrun's sole wire-type leaf: every HTTP/SSE payload
 * shape both clients (webui, tui) consume is declared or re-exported
 * here, and both import it directly. It is the intended basis for a
 * generated OpenAPI schema later, so the purity rule is enforced by
 * `test/views-purity.test.ts`:
 *
 * - wire types + pure serializers/constants ONLY — no server/framework
 *   types, no route logic;
 * - imports must be `import type` from leaf modules; the only runtime
 *   code is local pure serializers/constants (type re-exports erase at
 *   compile time and contribute no runtime);
 * - no `node:` imports (the webui compiles DOM-only against this file);
 * - never import the route module (`src/server/index.ts`) — types move
 *   FROM the route module TO here, never the reverse.
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
import type {
	AmbientBody,
	AmbientGauge,
	AmbientLedgerEntry,
	AmbientLine,
	AmbientMetrics,
	AmbientRecord,
	AmbientRow,
} from "../harness/ambient.js";
import type {
	InteractionAnswer,
	InteractionBody,
	InteractionDiff,
	InteractionField,
	InteractionOption,
	InteractionRecord,
	InteractionStatus,
} from "../harness/interactions.js";
import type { SettingsFile } from "../harness/settings.js";
import type { HealthStatus } from "../harness/health.js";
import type { WorkerStatus } from "../harness/event-bus.js";

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
	/**
	 * The conversation's session-meta owner, when stamped (Task 2's
	 * `X-Sigrun-User` seam — Task 3 surfaced it here so a picker can show
	 * who owns what). Absent when the doc never carried one.
	 */
	readonly owner?: string;
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


// ─── Interaction seam wire types (docs/approval-ux-seams.md) ─────────────
// The record rides as-is: envelope + body + details are already JSON-safe
// by construction (the doc stores JSON). Channels render generically.

/** One interaction record on the wire (the envelope + body + details). */
export type InteractionWire = InteractionRecord;

/** The response of `GET /v1/conversations/:id/interactions`. */
export interface InteractionList {
	readonly interactions: readonly InteractionWire[];
}

/** The response of `POST .../interactions/:callId/answer`. */
export interface InteractionAnswered {
	readonly callId: string;
	readonly status: "answered";
	readonly answer: InteractionAnswer;
}

// ─── Ambient seam wire types ─────────────────────────────────────────────

/** One ambient surface on the wire (envelope + body + details). */
export type AmbientWire = AmbientRecord;

/** The response of `GET /v1/conversations/:id/ambient`. */
export interface AmbientList {
	readonly ambient: readonly AmbientWire[];
}

// The seam records ride the wire as-is, so their sub-shapes are the
// contract too — re-exported here so channels (and a future generated
// schema) resolve every wire shape from this one module without importing
// the harness leaf modules.
export type {
	InteractionBody,
	InteractionDiff,
	InteractionField,
	InteractionOption,
	InteractionStatus,
};
export type {
	AmbientBody,
	AmbientGauge,
	AmbientLedgerEntry,
	AmbientLine,
	AmbientMetrics,
	AmbientRow,
};

// ─── Settings / meta / auth wire types ────────────────────────────────────

/**
 * The `GET/PATCH /v1/settings` payload (Task 8b): the settings file's
 * effective contents — the `HarnessSettings` pass-throughs plus the
 * sigrun-resolved fields — plus `toolRoster`, the registry-driven roster
 * the settings panel renders `defaultTools` over (Task 3, codemode
 * parity). Absent file = every default; the roster is SERVER-COMPUTED
 * from the live registry snapshot per request (never persisted, never
 * snapshotted at boot), so extension tools installed later — codemode,
 * tool_search — appear without panel changes. `toolRoster` is NOT a
 * settable key: the store's validation rejects it on PATCH (400
 * `invalid_field`), and the wire patch type Omits it.
 */
export interface SettingsResponse extends SettingsFile {
	/** The live registry snapshot's composed tool names, deduplicated. */
	readonly toolRoster: readonly string[];
}

/** The `GET /v1/meta` payload (spec §5; the health block is Task 9e). */
export interface MetaResponse {
	readonly harnessVersion: string;
	readonly schemaVersion: string;
	readonly extensions: readonly {
		readonly name: string;
		readonly status: string;
		readonly error?: string;
		/**
		 * The extension's idle workers (memory-seam Task 5), when it
		 * declared any; `lastRunAt`/`lastError` stay absent until the
		 * worker's first run.
		 */
		readonly workers?: readonly WorkerStatus[];
	}[];
	/**
	 * §5 health: pure aggregation over boot-retained §3 producers (spec
	 * §3) — synchronous status reads, never network or storage.
	 */
	readonly health: {
		/**
		 * Derived from `config.backup` presence. T11 deliberately emits only
		 * "configured"/"unconfigured" (no runtime backup health signal exists
		 * in v1 — the CronJob is an external process); the "degraded" literal
		 * stays in the spec §5 union for a future runtime signal.
		 */
		readonly backup: "configured" | "unconfigured" | "degraded";
		/** The memory extension's §3 producer, else "ok" (no-op default). */
		readonly memory: HealthStatus;
		/** Any contributor's §3 producer degraded → "degraded"; empty → "ok". */
		readonly providers: HealthStatus;
	};
	readonly capabilities: {
		readonly backup: boolean;
		readonly channels: readonly string[];
	};
	/**
	 * The seam inventory (docs/approval-ux-seams.md): per extension, the
	 * interaction kinds / ambient surface keys its factory declared.
	 * Extensions that declared nothing are absent — an absent entry means
	 * the extension writes no seam records, which is exactly the fail-open
	 * posture (channels render what is declared, nothing more).
	 */
	readonly seam: {
		readonly interactions: readonly {
			readonly extension: string;
			readonly kinds: readonly string[];
		}[];
		readonly ambient: readonly {
			readonly extension: string;
			readonly keys: readonly string[];
		}[];
	};
}

/** Provider auth readiness (Task 6, spec §6.4): statuses only. */
export type AuthStatus = "ready" | "not_ready" | "invalid";

/** One `GET /v1/auth/check` provider entry — provider id + status, nothing else. */
export interface AuthCheckProvider {
	readonly provider: string;
	readonly status: AuthStatus;
}

/** The `GET /v1/auth/check` payload (Task 6): per-provider statuses, never credentials. */
export interface AuthCheckResponse {
	readonly providers: readonly AuthCheckProvider[];
}

// ─── Sibling leaf re-exports ──────────────────────────────────────────────
// The slash-command catalog and session-meta wire shapes live in their own
// leaf modules; re-exported here (type-only, erased at compile) so this
// module is the single contract entry point for every §5 wire shape.
export type { CommandsResponse, SlashCommand } from "./commands.js";
export type { SessionMeta, SessionMetaPatch } from "./session-meta.js";
