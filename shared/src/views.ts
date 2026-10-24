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
import type { JobWire } from "./jobs.js";
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
import type { EffectiveServerSetting, SettingsFile } from "./settings.js";

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
	 * The server-owned auto-generated name (A2), when written and no user
	 * `name` overrides it. Surfaced so `conversation.changed` events can
	 * report an auto-name landing without a user edit.
	 */
	readonly autoName?: string;
	/**
	 * The session-meta source — who created the session (spec §9.5):
	 * `"user"` for HTTP creates, the extension slug for channel-bridge
	 * creates through `host.conversations`. Absent when the doc was never
	 * written (defaults are free).
	 */
	readonly source?: string;
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

// ─── Jobs (W4 Task 4, spec §8.4) ────────────────────────────────────────────

/** `GET /v1/jobs`: the caller-visible jobs (`accessOf ≠ "none"`), each row
 *  carrying the caller's resolved `access`. */
export interface JobsResponse {
	readonly jobs: readonly JobWire[];
}

/** `POST /v1/jobs/:id/run`: the fire outcome plus the run's conversation
 *  when one exists (a skipped/blocked fire may have none). */
export interface JobRunResponse {
	readonly outcome: "running" | "skipped" | "blocked";
	readonly conversationId?: number;
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
 * The durable submission record on the wire (§7.1): the record as it
 * stands when read — `status` is `queued` | `placed` | `done` |
 * `unanswered`; `entry`/`answer`/`reason`/`detail` appear per status.
 */
export interface SubmissionRecordWire {
	readonly id: number;
	readonly conversationId: number;
	/** Host-provided deduplication key, scoped to the conversation. */
	readonly requestId?: string;
	readonly type: string;
	readonly status: string;
	readonly entry?: number;
	readonly answer?: number;
	readonly reason?: string;
	readonly detail?: unknown;
}

/**
 * The admit response of `POST /v1/conversations/:id/submissions` (§7.1):
 * `202 {submission}` AT ADMISSION — the record as it stands the moment
 * the submission is admitted. `?waitMs=<n>` (a positive int ≤ 60 000)
 * opts into a bounded settlement wait; `GET …/submissions/:submissionId`
 * polls the record later.
 */
export interface SubmissionResponse {
	readonly submission: SubmissionRecordWire;
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

/**
 * One pending interaction in the cross-conversation inbox (§7.5): the
 * record plus the conversation it waits in, so a client can answer
 * without opening each conversation (answers still go through the
 * per-conversation answer route).
 */
export type InboxInteraction = InteractionWire & {
	readonly conversationId: number;
};

/**
 * The response of `GET /v1/interactions?status=pending` (§7.5): every
 * pending interaction in a conversation the caller can see, sorted by
 * `createdAt` ascending. `pending` is the only indexed (and accepted)
 * status.
 */
export interface InboxResponse {
	readonly interactions: readonly InboxInteraction[];
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
	/**
	 * The resolved server section per flattened dotted key
	 * (`"server.port"`, `"server.compaction.reserveTokens"`, …), each
	 * with its resolved value and which tier supplied it — `"env"`,
	 * `"file"`, or `"default"` (spec §6.6: the generalization of the
	 * build spec's webui-key special case; since the bootstrap persists
	 * only env-set values, this block is where the full resolved section
	 * is visible). Computed per request, never persisted. NOT a settable
	 * key: the store's validation rejects it on PATCH (400
	 * `invalid_field`), and the wire patch type Omits it.
	 */
	readonly effective: Readonly<Record<string, EffectiveServerSetting>>;
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
	/** The sigrun server's own version (the package manifest). */
	readonly version: string;
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
		/**
		 * The declared surfaces (UI-blocks U3 Task 5): the flattened
		 * view + panel rows the channels register their rail/panel
		 * entries from. Absent when the extension declared none. The
		 * meta response carries the DECLARATION (id/title/icon/
		 * placement); access filtering is render-time (§6.5).
		 */
		readonly surfaces?: readonly ExtensionSurfaceInfo[];
	}[];
	/**
	 * §5 health: pure aggregation over boot-retained §3 producers (spec
	 * §3) — synchronous status reads, never network. The one deliberate
	 * exception is `backup` (§6.8): its §6.8 derivation reads the small
	 * `backup/last-success.json` marker from the state root per request
	 * (the CronJob is a separate process; the filesystem is the only
	 * fresh-enough view).
	 */
	readonly health: {
		/**
		 * §6.8 backup honesty: presence-derived when no target is
		 * configured ("unconfigured"); with a target, "configured" only
		 * while the last-success marker is present and younger than
		 * `server.backup.staleAfterHours` (default 36 h) — absent, corrupt,
		 * or stale all read "degraded".
		 */
		readonly backup: "configured" | "unconfigured" | "degraded";
		/** The memory extension's §3 producer, else "ok" (no-op default). */
		readonly memory: HealthStatus;
		/** Any contributor's §3 producer degraded → "degraded"; empty → "ok". */
		readonly providers: HealthStatus;
		/**
		 * The gateway engine's health (gateway C2): present ONLY when an
		 * engine loaded (a no-engine deploy reports NO gateway health —
		 * degenerate "ok" by absence, never a synthesized field); the
		 * wrapped engine health (a throwing `health()` reads "degraded";
		 * a rejected `start` latches degraded until restart).
		 */
		readonly gateway?: HealthStatus;
	};
	/**
	 * The auth block (core hardening W1 Task 6, spec §5.7): the effective
	 * authenticator list (`ctx.methods` — loopback-derived or explicit) and
	 * the onboarding state (`claimed` = the user directory has its first
	 * user). A pure boot+store derivation, like the rest of meta — clients
	 * may cache it only per boot, since the claim flips it.
	 */
	readonly auth: {
		readonly methods: readonly ("token" | "proxy")[];
		readonly claimed: boolean;
	};
	/**
	 * §6.8: the last successful backup's timestamp (the marker's `at`),
	 * surfaced whenever a readable marker exists against a configured
	 * target — including a STALE one (the degraded badge's "when was the
	 * last success"). Absent otherwise.
	 */
	readonly backup: { readonly lastSuccessAt?: string };
	readonly capabilities: {
		readonly backup: boolean;
		readonly channels: readonly string[];
	};
	/**
	 * The development flag (spec §14.2/§14.4): `server.dev` / `SIGRUN_DEV`,
	 * default `false`. Gates the U1 blocks gallery, U3's development
	 * error bodies (validation errors in `surface_failed` responses) and
	 * U4 — a boot constant, like the rest of meta.
	 */
	readonly dev: boolean;
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
	 * extension-contributed webui bundles, the provider-catalog merge sink,
	 * and extension COMMAND names (W5 Task 3). All three merges are
	 * last-registered-wins by design — the record is the operator's
	 * visibility into a co-installed replacement, never an error; empty
	 * arrays are the no-collision boot. A command colliding with a CORE
	 * name is DROPPED with a boot warning and deliberately NOT recorded
	 * here (core commands are reserved, not replaceable — there is no
	 * "winner" to report).
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
		readonly commands: readonly {
			readonly kind: "command";
			/** The command name that collided. */
			readonly name: string;
			/** Extension slug that previously owned the name. */
			readonly previous: string;
			/** Extension slug whose contribution won. */
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
 * One `GET /v1/providers` entry — provider id + status, never key
 * material. `detail` (provider plugins Task 6) is the optional
 * tracker-facing operator detail; the legacy derivations never set it.
 * Core hardening W3 Task 6 (spec §7.6) adds the catalog `models` count
 * and the owning extension `owner` (absent for the env-degenerate
 * provider) — the deprecated `/v1/auth/check` alias serves this same
 * entry, one shape for both routes.
 */
export interface AuthCheckProvider {
	readonly provider: string;
	readonly status: AuthStatus;
	/** How many models the provider currently serves (best-effort count). */
	readonly models: number;
	/** The owning contributor's name; absent for the env-degenerate provider. */
	readonly owner?: string;
	readonly detail?: string;
}

/**
 * The `GET /v1/providers` payload (core hardening W1 Task 6, spec
 * §5.7/§7.6): the auth-check derivation under its new home — `/v1/auth`
 * is API auth only, and the secret-free readiness report lives at
 * `/v1/providers`. `GET /v1/auth/check` serves this same payload as a
 * deprecated alias for one release (its responses carry a `Deprecation`
 * header).
 */
export interface ProvidersResponse {
	readonly providers: readonly AuthCheckProvider[];
}

/** The `GET /v1/auth/check` payload (Task 6): per-provider statuses, never credentials. */
export interface AuthCheckResponse {
	readonly providers: readonly AuthCheckProvider[];
}

// ─── Extensions (core hardening W3 Task 7, spec §7.7) ─────────────────────

/**
 * One `GET /v1/extensions` entry: a loaded outcome enriched with the
 * declared seam kinds, the idle-worker projection, the package
 * manifest `version` (absent when the entry carries no readable
 * manifest), and the declared HTTP routes (W5 Task 2 — present on
 * every served entry, empty when the extension declared none). The
 * webui's Extensions settings section renders this list.
 */
export interface ExtensionInfo {
	readonly name: string;
	readonly status: string;
	readonly error?: string;
	readonly version?: string;
	/** The interaction kinds the factory declared (empty when none). */
	readonly interactionKinds: readonly string[];
	/** The ambient surface keys the factory declared (empty when none). */
	readonly ambientKeys: readonly string[];
	/** The extension's idle workers (empty when it declared none). */
	readonly workers: readonly WorkerStatus[];
	/** The declared HTTP routes, one `{method, path, auth}` each (W5 Task 2). */
	routes?: readonly ExtensionRouteInfo[];
	/** The declared surfaces, one `{id, title, icon, placement}` each (U3 Task 1); absent when none. */
	surfaces?: readonly ExtensionSurfaceInfo[];
	/**
	 * The channel ids this extension contributes (gateway C1, spec §7):
	 * present only on rows of extensions whose factory result carried
	 * `channels`; unique across every loaded extension (a collision
	 * quarantines the later loader). Absent when the extension declared
	 * none.
	 */
	readonly channels?: readonly string[];
	/**
	 * The inert marker (gateway C2): `"no gateway"` on rows of
	 * extensions that contributed `channels` while NO gateway engine
	 * loaded — their adapters are inert (nothing drives them; one boot
	 * warning says so). Absent everywhere else.
	 */
	readonly inert?: "no gateway";
	/**
	 * Built-in extensions (Task 2, pi parity): `true` marks a core-shipped
	 * built-in (codemode / MCP / tool search); ABSENT on configured
	 * extensions. A replaced built-in reports its row with `builtin: true`
	 * and `replacedBy` (its status is the skip, never `"ok"`); a disabled
	 * built-in is absent from the list entirely.
	 */
	readonly builtin?: boolean;
	/** The configured specifier that replaced this built-in (replacement rule). */
	readonly replacedBy?: string;
}

/** One `GET /v1/extensions` entry's route rows (W5 Task 2, spec §9.2). */
export interface ExtensionRouteInfo {
	readonly method: string;
	/** The declared relative path — mounted at `/v1/ext/<slug>/<path>`. */
	readonly path: string;
	readonly auth: string;
}

/**
 * One `GET /v1/extensions` surface row (UI-blocks U3 Task 1, spec
 * §7.1): the extension-declared views and panels — what the channels'
 * rail (views) and right panel (panels) register from. One row per
 * declared surface, in declaration order (views before panels).
 */
export interface ExtensionSurfaceInfo {
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	/** The declared placement; `settings` sections (§13.3) are not in this workstream. */
	readonly placement: "view" | "panel";
	/** The declared refresh cadence (spec §7.1); channels refetch data on
	 *  this interval while the surface is visible. Absent → no cadence. */
	readonly refreshMs?: number;
	/** §7.3 shared-data flag: a sharedData surface's `since` fetches may
	 *  answer with `ops` and NO `data` — channels fall back to a full
	 *  fetch (ops folding is U1). Absent → per-instance data. */
	readonly sharedData?: boolean;
}

/** The `GET /v1/extensions` payload (spec §7.7). */
export interface ExtensionsResponse {
	readonly extensions: readonly ExtensionInfo[];
}

/**
 * A `GET /v1/extensions/:slug/secrets` entry: the key and its winning
 * source — NEVER the value (the API lists and writes secrets; it never
 * returns them).
 */
export interface ExtensionSecret {
	readonly key: string;
	readonly source: "stored" | "env";
}

/** The `GET`/`PUT`/`DELETE `/v1/extensions/:slug/secrets` payloads: the key list. */
export interface ExtensionSecretsResponse {
	readonly secrets: readonly ExtensionSecret[];
}

// ─── Sibling leaf re-exports ──────────────────────────────────────────────
// The slash-command catalog and session-meta wire shapes live in their own
// shared leaf modules; re-exported here (type-only, erased at compile) so
// this module is the single contract entry point for every §5 wire shape.
export type { CommandsResponse, CommandRunResponse, SlashCommand } from "./commands.js";
export type { SessionMeta, SessionMetaPatch } from "./session-meta.js";

/**
 * The `GET /v1/auth/whoami` payload (core hardening W1 Task 3, spec
 * §5.8): the resolved principal, verbatim. `user` is absent only under
 * the naive empty-method path with no `X-Sigrun-User` header;
 * `service` marks the env service token. `method` mirrors the extension
 * contract's `Principal.method` (gateway C4b added `"host"` — an
 * in-process host-built principal; no HTTP route ever resolves one, but
 * the two unions stay aligned so the whoami build from a principal can
 * never drift from the wire type).
 */
export interface WhoamiResponse {
	readonly user?: string;
	readonly name?: string;
	readonly email?: string;
	readonly admin: boolean;
	readonly service: boolean;
	readonly method: "none" | "token" | "proxy" | "host";
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
 *
 * `admin` is the STORED flag (the users-admin UI toggles it); the proxy
 * group grant rides separately as `groupAdmin` (gateway C8): effective
 * admin is `admin || groupAdmin === true`, and the last-admin guard
 * counts `admin` alone.
 */
export interface UserWire {
	readonly user: string;
	readonly name?: string;
	readonly email?: string;
	readonly admin: boolean;
	/** The persisted proxy-group grant — present only under `adminGroups`. */
	readonly groupAdmin?: boolean;
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

/**
 * One external identity linked to a directory user (multi-user §11.3):
 * the `accounts.json` record verbatim. `provider` is `chat:<channel>` or
 * `login:<slug>:<id>`; `subject` is the provider's stable subject
 * (numeric id, `+E.164`, email-shaped — opaque to sigrun).
 *
 * Served to extensions as `host.accounts` and to users as
 * `GET /v1/auth/accounts`.
 */
export interface AccountLinkWire {
	readonly provider: string;
	readonly subject: string;
	readonly user: string;
	readonly linkedAt: number;
	readonly via: "login" | "self" | "pairing" | "admin";
}

/**
 * The `GET /v1/auth/accounts` payload (multi-user §11.3): the caller's
 * links, or one named user's for an admin.
 */
export interface AccountsResponse {
	readonly accounts: readonly AccountLinkWire[];
}

// ─── Host events (GET /v1/events, core hardening W3 Task 4, spec §7.4) ───

/**
 * One host event on the `GET /v1/events` SSE wire: `event: <type>` plus
 * this object as the single-line `data:` JSON. Conversation-scoped
 * events are delivered only when the connecting principal's `accessOf`
 * against a FRESH SessionMeta snapshot is not `"none"` (per-event
 * re-check: share → delivered, un-share → withheld);
 * `providers.changed` reaches every authenticated principal;
 * `job.changed` carries the changed job's `JobWire` summary WITHOUT
 * `access` — the events stream computes and adds it per principal before
 * delivery (the hub's copy is access-neutral).
 * No replay: a client that reconnects refetches (the list GET); the
 * stream only nudges.
 */
export type HostEventWire =
	| { readonly type: "conversation.created"; readonly conversationId: number }
	| {
			readonly type: "conversation.changed";
			readonly conversationId: number;
			/** The summary fields that changed, with their new values. */
			readonly fields: Partial<ConversationSummary>;
		}
	| {
			readonly type: "run.admitted";
			readonly conversationId: number;
			readonly submissionId: number;
		}
	| {
			readonly type: "run.settled";
			readonly conversationId: number;
			readonly outcome: "answered" | "unanswered";
			readonly reason?: string;
		}
	| {
			readonly type: "interaction.pending" | "interaction.settled";
			readonly conversationId: number;
			readonly callId: string;
			readonly kind: string;
		}
	| {
			readonly type: "ambient.changed";
			readonly conversationId: number;
			readonly key: string;
		}
	| {
			readonly type: "providers.changed";
			readonly provider: string;
			readonly status: string;
		}
	| {
			/** A task table write with a TERMINAL status (jobs Task 3, §8.1): the jobs observer settles `task`-action run records from it — `completed` → `succeeded`, any other terminal → `failed` + `error`. Hub-side only (not an SSE wire event): the task table is host machinery, not principal-facing surface. */
			readonly type: "taskSettled";
			readonly taskId: number;
			readonly status: string;
			readonly error?: string;
		}
	| {
			/** W4 Task 4 (§8.4): the changed job's summary, WITHOUT `access` — the events stream computes `accessOf` per principal and adds it before delivery (a hidden job's event is withheld entirely). */
			readonly type: "job.changed";
			readonly job: Omit<JobWire, "access">;
		}
	| {
			/** UI-blocks U3 Task 4 (spec §7.3): one surface instance changed. `k` is the hashed instance key (sha256(slug + "\0" + id + "\0" + key) hex) — the event NEVER carries params or data (render/data are principal-specific; the watcher refetches as itself). Delivered only to streams in the watcher registry whose stored access is not `"none"`. */
			readonly type: "surface.changed";
			readonly slug: string;
			readonly id: string;
			readonly k: string;
			readonly rev: number;
			readonly treeRev: number;
		};
