/**
 * §5 wire types (Tasks 9a–9d) — THE channel contract.
 *
 * Every HTTP/SSE payload shape both clients (webui, tui) consume is
 * declared or re-exported here, and both import it directly (the tui
 * imports from `@sigrun/shared`, never from server source). It is the
 * intended basis for a generated OpenAPI schema later, so the purity
 * rules are enforced by `test/views-purity.test.ts`:
 *
 * - imports and re-exports are `import type`/`export type` from SIBLING
 *   shared modules only, and type-only — they erase at compile time and
 *   contribute no runtime (the only runtime exports here are local pure
 *   constants);
 * - no external package imports, no server/framework types, no route
 *   logic (the server's `src/server/views.ts` owns the RUNTIME
 *   serializer and re-exports this module);
 * - no `node:` imports (the webui compiles DOM-only against this file).
 *
 * Spec §5: the server serves pi-durable's NATIVE views, not a bespoke
 * endpoint list — so the conversation wire payload IS the view shape
 * (`{ conversation, entries, docs }`; JSON-safe by construction) PLUS
 * the sigrun-side `steer` field. The upstream view's inner shapes are
 * re-declared STRUCTURALLY below (`ViewConversation`, `ViewEntry`,
 * `ViewMessage`, `WireBlock`): deliberately loose where channels only
 * read a subset, and structurally compatible with the upstream types so
 * the server's serializer (which spreads an upstream
 * `ConversationView`) typechecks against this declaration — the
 * captured-schema fixture (`src/server/schema-fixture.ts`,
 * `view-schema.json`) pins the UPSTREAM shape, and
 * `test/schema-drift.test.ts` trips on upstream drift.
 *
 * `serializeConversationView` (src/server/views.ts) is the single
 * chokepoint every §5 endpoint that returns a conversation goes through
 * — including each SSE watch frame (T9d) — so the fixture continues to
 * describe the wire.
 */

import type { JsonObject } from "./json.js";
import type { Sharing } from "./access.js";
import type {
	InteractionAnswer,
	InteractionBody,
	InteractionDiff,
	InteractionField,
	InteractionOption,
	InteractionRecord,
	InteractionStatus,
} from "./interactions.js";
import type {
	AmbientBody,
	AmbientGauge,
	AmbientLedgerEntry,
	AmbientLine,
	AmbientMetrics,
	AmbientRecord,
	AmbientRow,
} from "./ambient.js";
import type { SettingsFile } from "./settings.js";

// ─── Upstream view shapes (structural) ───────────────────────────────────
// The pi-durable conversation view family, as the channel reads it. The
// server module holds the import-typed original; these declarations are
// assignment-compatible with it (the serializer's return type IS this
// module's ConversationViewWire).

/** A model reference as served on the wire (pi-durable `ModelRef`). */
export interface ModelRefWire {
	readonly provider: string;
	readonly modelId: string;
}

/** A model's thinking level (pi-ai `ModelThinkingLevel` union). */
export type ThinkingLevelWire =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/** One content block of a message (`{type: "text", text}`, `{type:
 * "thinking", thinking}`, image/file parts, tool calls) — the loose
 * block shape every renderer dispatches on. */
export interface WireBlock {
	readonly type: string;
	readonly text?: string;
	/** The thinking text on `{type: "thinking"}` blocks. */
	readonly thinking?: string;
	/** Tool-call identity on `{type: "toolCall"}` blocks. */
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

/** One model message carried by a view entry (pi-ai JSON shape). */
export interface ViewMessage {
	readonly role: string;
	readonly content: string | readonly WireBlock[];
	/** Tool correlation — present on `toolResult`-role messages. */
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly isError?: boolean;
}

/** One entry of the view's entry list. */
export interface ViewEntry {
	readonly id: number;
	readonly conversationId?: number;
	/** Application-defined entry discriminator (`pi.user`, `pi.assistant`, …). */
	readonly kind: string;
	/** Messages contributed to model context; absent on display/bookkeeping entries. */
	readonly model?: readonly ViewMessage[];
	/** The entry's kind-specific JSON payload, when it carries one. */
	readonly data?: unknown;
}

/** One conversation as pi-durable serves it (the upstream view). */
export interface ViewConversation {
	readonly id: number;
	/** Fork lineage (the upstream `parent`), when this conversation is a fork. */
	readonly parent?: { readonly conversationId?: number; readonly at?: number };
	/** Creator edge, when the conversation was produced by durable work. */
	readonly owner?: unknown;
}

/** The upstream view, as the channel reads it. */
export interface ConversationViewBase {
	readonly conversation: ViewConversation;
	readonly entries: readonly ViewEntry[];
	/** Built-in conversation documents keyed by kind; absent documents are absent. */
	readonly docs: Readonly<Record<string, JsonObject>>;
}

/**
 * The per-conversation steer field (spec §5: "reflecting submit-while-busy
 * queue semantics"). `busy` = a run is live; `queued` = submissions
 * waiting in the inbox behind it.
 */
export interface SteerField {
	readonly busy: boolean;
	readonly queued: number;
}

/**
 * One conversation as served over the wire: the upstream view plus the
 * derived `steer` field (see the server's
 * `serializeConversationView` — every §5 endpoint that returns a
 * conversation, including each SSE watch frame, goes through it).
 */
export type ConversationViewWire = ConversationViewBase & {
	readonly steer: SteerField;
};

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
	/**
	 * The display name: the user's `meta.name`, else the server-owned
	 * `meta.autoName` (A2's auto-namer). Absent when neither was written.
	 */
	readonly name?: string;
	/**
	 * The last activity instant, ISO 8601 (activity.ts stamps it at
	 * submission admission and run settlement). Absent on a conversation
	 * that was never used.
	 */
	readonly lastActivityAt?: string;
	/**
	 * Fork lineage: the source conversation id and the entry the history
	 * was forked at, when this conversation is a fork. Absent on a root
	 * or plainly created conversation.
	 */
	readonly parent?: { readonly id: number; readonly at: number };
	/** The session-meta archive flag (the sidebar's hide), default false. */
	readonly archived: boolean;
	/** The session-meta pin flag (pinned conversations float to top), default false. */
	readonly pinned: boolean;
	/**
	 * The §5.9 sharing state, when the conversation carries one (absent =
	 * private). Surfaced so a picker can show what is shared.
	 */
	readonly sharing?: Sharing;
	/**
	 * THIS caller's resolved access to the conversation (§5.9 `accessOf`):
	 * conversations the caller cannot see are filtered from the list
	 * entirely, so every listed row is at least `read`.
	 */
	readonly access: "read" | "write";
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
	readonly model?: ModelRefWire;
	readonly thinkingLevel: ThinkingLevelWire;
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
// the seam modules directly.
export type {
	InteractionAnswer,
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

/** Spec §3 health status: ok unless the surface knows it is degraded. */
export type HealthStatus = "ok" | "degraded";

/**
 * One idle worker an extension declared (memory-seam Task 5): the bus's
 * per-worker observability record as `/v1/meta` serves it.
 */
export type WorkerStatus = {
	readonly name: string;
	readonly lastRunAt?: number;
	readonly lastError?: string;
};

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
	/**
	 * Boot-merge collisions (build-and-webui Task 6): name collisions among
	 * extension-contributed webui bundles, plus the provider-catalog merge
	 * sink. Both merges are last-registered-wins by design — the record is
	 * the operator's visibility into a co-installed replacement, never an
	 * error; empty arrays are the no-collision boot.
	 */
	readonly collisions: {
		readonly webui: readonly {
			readonly kind: "webui-bundle";
			/** The bundle name that collided. */
			readonly name: string;
			/** Extension slug that previously owned the name. */
			readonly previous: string;
			/** Extension slug whose contribution won. */
			readonly contributor: string;
		}[];
		readonly providers: readonly {
			readonly kind: "provider";
			/** The provider id that collided. */
			readonly provider: string;
			/** Model ids present in both the previous and replacing catalog. */
			readonly modelIds: readonly string[];
			/** Contributor name that previously owned the provider. */
			readonly previous: string;
			/** Contributor name whose contribution won. */
			readonly contributor: string;
		}[];
	};
}

/**
 * Provider auth readiness statuses (Task 6, spec §6.4 + provider plugins
 * Task 6): statuses only. The legacy vocabulary (`ready` | `not_ready` |
 * `invalid`) is preserved VERBATIM for every derivation that exists today
 * — the legacy producer mapping (tracker-less contributors) and the
 * degenerate env-presence mapping — so old consumers keep working; the
 * provider-plugins three-state vocabulary (`not_configured` |
 * `degraded` | `ready`) is ADDED for tracker-backed providers, where
 * `ready` is the shared spelling.
 */
export type AuthStatus =
	| "ready"
	| "not_ready"
	| "invalid"
	| "not_configured"
	| "degraded";

/**
 * One `GET /v1/auth/check` provider entry — provider id + status, nothing
 * else. `detail` (provider plugins Task 6) is the optional tracker-facing
 * operator detail; the legacy derivations never set it.
 */
export interface AuthCheckProvider {
	readonly provider: string;
	readonly status: AuthStatus;
	readonly detail?: string;
}

/** The `GET /v1/auth/check` payload (Task 6): per-provider statuses, never credentials. */
export interface AuthCheckResponse {
	readonly providers: readonly AuthCheckProvider[];
}

// ─── Sibling leaf re-exports ──────────────────────────────────────────────
// The slash-command catalog and session-meta wire shapes live in their own
// shared leaf modules; re-exported here (type-only, erased at compile) so
// this module is the single contract entry point for every §5 wire shape.
export type { CommandsResponse, SlashCommand } from "./commands.js";
export type { SessionMeta, SessionMetaPatch } from "./session-meta.js";

/**
 * The `GET /v1/auth/whoami` payload (core hardening W1 Task 3, spec
 * §5.8): the resolved principal, verbatim. `user` is absent only under
 * the naive empty-method path with no `X-Sigrun-User` header;
 * `service` marks the env service token.
 */
export interface WhoamiResponse {
	readonly user?: string;
	readonly name?: string;
	readonly email?: string;
	readonly admin: boolean;
	readonly service: boolean;
	readonly method: "none" | "token" | "proxy";
}

// ─── Onboarding, users, invites, tokens (core hardening W1 Task 4) ────────

/**
 * The `GET /v1/onboarding` payload (core hardening W1 Task 4, spec
 * §5.8): what an unauthenticated client needs to drive the claim flow.
 * `codeRequired` is false on a loopback bind or when the request itself
 * carries a trusted proxy identity (either is trust enough — no code);
 * `proxyIdentity` is present exactly then, carrying what the headers
 * vouch for so the webui can render its confirm screen.
 */
export interface OnboardingState {
	readonly state: "unclaimed" | "claimed";
	readonly methods: readonly ("token" | "proxy")[];
	readonly codeRequired: boolean;
	readonly proxyIdentity?: {
		readonly user: string;
		readonly name?: string;
		readonly email?: string;
	};
}

/**
 * One directory user on the wire (Task 4): the full record — emails are
 * admin-visible material and the routes that serve this type are
 * admin-gated. `createdAt` is epoch ms.
 */
export interface UserWire {
	readonly user: string;
	readonly name?: string;
	readonly email?: string;
	readonly admin: boolean;
	readonly createdAt: number;
	readonly source: "proxy" | "invite" | "cli";
}

/** The `POST /v1/onboarding/claim` payload (Task 4): the user (plus the
 * minted token when `issueToken` was requested — shown once, never
 * persisted). */
export interface ClaimResponse {
	readonly user: UserWire;
	readonly token?: string;
}

/** The `POST /v1/users/invites` payload (Task 4): the one-time code is
 * shown once, never stored in the clear. */
export interface InviteResponse {
	readonly id: string;
	readonly code: string;
	readonly expiresAt: number;
}

/**
 * One API token on the wire (Task 4): the token store's record minus the
 * `sha256` digest — digests never leave the server. Created by the
 * claim route (`issueToken`) and `POST /v1/auth/tokens`.
 */
export interface TokenWire {
	readonly id: string;
	readonly name: string;
	readonly user: string;
	readonly createdAt: number;
}

/** The `POST /v1/auth/tokens` payload (Task 4): the secret once, the
 * digest-free record alongside it. */
export interface TokenCreateResponse {
	readonly token: string;
	readonly record: TokenWire;
}
