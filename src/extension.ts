/**
 * The documented extension contract (core hardening W5 Task 1, spec
 * §9.1): the ONE type surface an extension package programs against —
 * `@sigrun/sigrun/extension`, a TYPES-ONLY subpath of the main package (the
 * 2026-10-13 types-in-main-package ruling; there is no separate
 * contract package).
 *
 * Authors consume it with `import type` only:
 *
 * ```ts
 * import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
 * ```
 *
 * The subpath has NO runtime entry: nothing loads when an extension is
 * imported, and importing it at runtime fails loud by design. See
 * docs/extending.md ("The factory result") for the field table and the
 * host rule.
 *
 * Module discipline (load-bearing, pinned by test/extension-contract.test.ts):
 *
 * - TYPES-ONLY and self-contained — no runtime code, no re-exported
 *   values. The emitted `dist/extension.d.ts` must stand alone.
 * - `import type` from EXACTLY three roots: `@earendil-works/pi-durable`,
 *   `@earendil-works/pi-ai`, and `@sigrun/shared/*`. These are the
 *   packages an extension declares as devDependencies (the loader links
 *   the first two's host copies into the packages dir); anything else
 *   would leak a new dependency onto every contract consumer. Notably
 *   the invocation `Context` is NOT imported from
 *   `@earendil-works/chord` — the contract spells its own structural
 *   {@link HandlerContext} instead.
 * - The loader (src/harness/loader.ts) references these types for its
 *   validated candidate shape and a compile-time key assertion, so the
 *   implementation and this contract cannot drift silently.
 */

import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type {
	ConversationDocToken,
	ConversationId,
	Cursor,
	EntryId,
	EntryQuery,
	EntryRecord,
	Extension,
	InputSubmissionDraft,
	JsonObject,
	ModelRef,
	Page,
	SubmissionId,
} from "@earendil-works/pi-durable";
import type { Access, Sharing } from "@sigrun/shared/access";
import type { EmbeddingResult } from "@sigrun/shared/embeddings";
import type {
	DecisionAnswers,
	DecisionLimits,
	DecisionRequest,
	DecisionResult,
} from "@sigrun/shared/decisions";
import type {
	AmbientPlace,
	AmbientRecord,
} from "@sigrun/shared/ambient";
import type { Action, CoreTarget, DataOps, IconName, Tree } from "@sigrun/shared/blocks";
import type {
	UserNotice,
	UserNoticeInput,
} from "@sigrun/shared/notices";

// The per-user notices channel (notices Task 3): the shared wire types,
// re-exported so extensions import them from the ONE contract module.
export type {
	NoticeActionResponse,
	NoticesResponse,
	UserNotice,
	UserNoticeAction,
	UserNoticeInput,
} from "@sigrun/shared/notices";
import type { InteractionAnswer, InteractionRecord } from "@sigrun/shared/interactions";
import type { JobSpec, JobWire } from "@sigrun/shared/jobs";
import type {
	AccountLinkWire,
	ConversationSummary,
	ConversationViewWire,
	HealthStatus,
	ModelEntry,
	SessionMeta,
	SlashCommand,
	SubmissionRecordWire,
	ThinkingLevelWire,
	UserWire as DirectoryUserWire,
} from "@sigrun/shared/views";

// ---------------------------------------------------------------------------
// Re-exported field types (one spelling per concept: the shared leaf
// package owns these shapes; the contract only names them).
// ---------------------------------------------------------------------------

export type {
	Access,
	AccountLinkWire,
	AmbientRecord,
	DirectoryUserWire,
	InteractionRecord,
	JobSpec,
	ModelEntry,
	Sharing,
	SlashCommand,
};

// The JSON mirror the surfaces contract uses (spec §7.1): the shared
// leaf's local declaration — STRUCTURALLY IDENTICAL to pi-durable's
// `JsonObject` (the chord `JsonValue` mirror), so params and payloads
// built from these types flow into every host API unchanged. Declared
// as a local alias so the contract names ONE spelling of the concept
// per import site (the shared leaf owns the shape).
type JsonParams = JsonObject;
type JsonParamValue = JsonParams[string];

// ---------------------------------------------------------------------------
// The invocation context
// ---------------------------------------------------------------------------

/**
 * The invocation-scoped context handlers and host APIs receive: a
 * structural view of the runtime context (its cancellation signal).
 * Declared structurally — not imported from `@earendil-works/chord` —
 * so this module stays inside the contract allowlist; the value the
 * host passes is the full runtime context, which satisfies this shape.
 */
export interface HandlerContext {
	/** Aborts with the caller's cancellation; observe it in long work. */
	readonly abortSignal: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Settled-run + lifecycle events (the memory-seam payloads)
// ---------------------------------------------------------------------------

/**
 * The extension-facing settled-run event: one per settled run, with the
 * run's input texts host-resolved from the durable transcript.
 * `inputTexts` is position-paired with `inputs` — an input whose entry
 * is unresolvable (withdrawn while queued, withdrawn entry, read
 * failure) contributes `""` at its position, never a reorder.
 */
export type RunSettledEvent = {
	readonly conversationId: ConversationId;
	/** The conversation owner at delivery; absent when the conversation is ownerless. */
	readonly owner?: string;
	readonly inputs: readonly SubmissionId[];
	/** Text blocks of each input's entry (`pi.user`, or an expanded input's
	 *  `sigrun.user.expanded` — the ADMITTED text), concatenated;
	 *  unresolvable/withdrawn → "" at that position. */
	readonly inputTexts: readonly string[];
	/** True when a Continue submission belongs to the run. */
	readonly continued?: boolean;
	/** Present only on a startup-replayed event (durable run-settled). */
	readonly replayed?: true;
	readonly outcome:
		| {
				readonly status: "answered";
				readonly answerEntryId: EntryId;
				readonly answer: AssistantMessage;
		  }
		| { readonly status: "unanswered"; readonly reason: string };
};

/**
 * The narrowed read surface a `runSettled` handler receives: exactly
 * `entry` / `entries` / `document` over the settled conversation — no
 * `taskId`, no `memo`, no `conversationId` (the event carries those).
 * `entries` mirrors the conversation's entry history (the conversation
 * is implicit); `document` is the committed conversation-doc read.
 */
export type MemoryEventApi = {
	/** One visible entry of the settled conversation by exact id (`undefined` when absent). */
	entry(id: EntryId, context: HandlerContext): Promise<EntryRecord | undefined>;
	/** Fork-aware entry history of the settled conversation. */
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: HandlerContext,
	): Promise<Page<EntryRecord, Cursor>>;
	/** Committed conversation-document read. */
	document<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: HandlerContext,
	): Promise<Readonly<T> | undefined>;
};

/**
 * The extension-facing payloads of the lifecycle events: the handler
 * NAME discriminates (like pi-durable hooks), so the payloads carry no
 * `type` field.
 */
export type ExtensionLifecyclePayload = {
	conversationCreated: {
		readonly conversationId: ConversationId;
		readonly owner?: string;
	};
	conversationForked: {
		readonly childId: ConversationId;
		readonly parentId: ConversationId;
		readonly at: EntryId;
		/** The CHILD's owner at delivery; absent when the child is ownerless. */
		readonly owner?: string;
	};
	conversationArchived: {
		readonly conversationId: ConversationId;
		readonly archived: boolean;
		readonly owner?: string;
	};
	conversationIdle: {
		readonly conversationId: ConversationId;
		readonly idleMs: number;
		readonly owner?: string;
	};
	/** Gateway C6: one terminal interaction transition — the payload mirrors
	 *  the record's terminal envelope fields. */
	interactionSettled: {
		readonly conversationId: ConversationId;
		readonly callId: string;
		readonly kind: string;
		readonly status: "answered" | "skipped" | "expired" | "cancelled";
		/** The answering user (C5 attribution), when a human answered. */
		readonly answeredByUser?: string;
		/** How a DECLINE landed (ask-user Task 1/2): "button" via the decline
		 *  route/host method, "message" via an admitted decline message. Set
		 *  only on a declined ("skipped") record. */
		readonly declinedVia?: "button" | "message";
		/** The STORED (masked-by-construction) answer values — render-safe. */
		readonly answer?: Readonly<Record<string, unknown>>;
		readonly owner?: string;
	};
};

/** A factory-result `runSettled` handler: called once per settled run, deadline-bounded. */
export type ExtensionRunSettledHandler = (
	event: RunSettledEvent,
	api: MemoryEventApi,
	context: HandlerContext,
) => void | Promise<void>;

/** A factory-result lifecycle handler for one event, deadline-bounded. */
export type ExtensionLifecycleHandler<K extends keyof ExtensionLifecyclePayload> = (
	event: ExtensionLifecyclePayload[K],
	api: MemoryEventApi,
	context: HandlerContext,
) => void | Promise<void>;

/**
 * A factory-result `harnessShutdown` handler (no event payload — shutdown is
 * conversation-less). All extension handlers run CONCURRENTLY under one
 * shared hook deadline, in no guaranteed relative execution or commit order.
 * Handlers may still commit; a wedged handler is abandoned without undoing
 * other handlers' durable commits.
 */
export type ExtensionHarnessShutdownHandler = (
	api: MemoryEventApi,
	context: HandlerContext,
) => void | Promise<void>;

/**
 * The `userDeleted` payload (core hardening W1): which directory user
 * left and who received their resources. Emitted after the ownership
 * transfer, token revocation, and record removal have landed.
 */
export interface UserDeletedPayload {
	readonly user: string;
	readonly transferTo: string;
}

/** A factory-result `userDeleted` handler (the transfer counterpart of harnessShutdown). */
export type ExtensionUserDeletedHandler = (
	event: UserDeletedPayload,
	api: MemoryEventApi,
	context: HandlerContext,
) => void | Promise<void>;

/** The lifecycle handler fields of the factory result, one per event. */
export type SigrunLifecycleHandlers = {
	readonly conversationCreated?: ExtensionLifecycleHandler<"conversationCreated">;
	readonly conversationForked?: ExtensionLifecycleHandler<"conversationForked">;
	readonly conversationArchived?: ExtensionLifecycleHandler<"conversationArchived">;
	readonly conversationIdle?: ExtensionLifecycleHandler<"conversationIdle">;
	/** Terminal interaction transitions from ANY writer (gateway C6). */
	readonly interactionSettled?: ExtensionLifecycleHandler<"interactionSettled">;
	readonly harnessShutdown?: ExtensionHarnessShutdownHandler;
	/** The user-removal transfer event; direct fan-out, not commit-derived. */
	readonly userDeleted?: ExtensionUserDeletedHandler;
	/**
	 * UI-blocks U4 (spec §13.2): called after a settings write COMMITS —
	 * the keys are the flattened paths the write touched (core keys in
	 * the §13.1 dotted vocabulary, this extension's own top-level keys
	 * for a `settings/<slug>.json` write). Fired for BOTH scopes: a
	 * server-scope write notifies every loaded extension; an extension's
	 * own write notifies it (and every other extension — settings are
	 * shared operator surface). Errors are caught and logged; the write
	 * already succeeded and stays successful.
	 */
	onSettingsChanged?(keys: readonly string[], user?: string): void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Idle workers (the curator contract — `wakeOn` only)
// ---------------------------------------------------------------------------

/**
 * The lifecycle event names a worker's `wakeOn` may declare.
 * `harnessShutdown` is excluded — workers stop BEFORE the shutdown
 * handlers run (the shutdown ordering), so waking on it is meaningless.
 */
export type WorkerWakeEvent = keyof ExtensionLifecyclePayload;

/** The wake argument of an event-triggered worker run. */
export type WorkerWake = {
	readonly event: string;
	readonly conversationId: ConversationId;
};

/**
 * One factory-declared idle worker (the curator contract). Host-owned
 * lifecycle: sigrun taps the lifecycle fan-out for `wakeOn` matches.
 * One run at a time per worker; a wake during an in-flight run is
 * queued + coalesced (one pending-wake slot, last wins) and delivered
 * as the next run's `wake`.
 *
 * `every` is RETIRED (ruling 12, 2026-10-19): this type has NO `every`
 * field — jobs are the only time-based scheduler; an extension that
 * needs a timer declares a job with a `task` action.
 */
export interface ExtensionWorker {
	/** Unique within the extension; surfaces in /v1/meta. */
	readonly name: string;
	/** Lifecycle events that wake the worker (REQUIRED, non-empty). */
	readonly wakeOn: readonly WorkerWakeEvent[];
	/** The work; rejects (or overruns the worker deadline) to fail the run. */
	run(context: HandlerContext, wake?: WorkerWake): Promise<void>;
}

// ---------------------------------------------------------------------------
// Curation targets (the curator contract — P7)
// ---------------------------------------------------------------------------

/**
 * The outcome of one curator-run driven call (a fork review or a digest
 * run): the final text (so a target can ask for operations as text and
 * apply them itself), the changes its tools reported, and how it ended.
 */
export type CurationRunResult = {
	/** How the run ended: answered, human-cancelled, failed, or deadlined. */
	readonly status: "completed" | "cancelled" | "failed" | "deadline";
	/** The run's final assistant text ("" when it produced none). */
	readonly text: string;
	/** Changes the run's tools reported, in tool-result order. */
	readonly changes: readonly {
		readonly changeId: string;
		readonly summary: string;
		/** The qualified target id the change belongs to. */
		readonly target: string;
	}[];
	/** Why a non-completed run ended (the failure/cancellation reason). */
	readonly error?: string;
};

/**
 * The budget one `maintain` call runs under: a wall-clock deadline, a
 * digest-run allowance, and the `run` entry point that starts one
 * bounded internal digest run on the user's curator model and RETURNS
 * its result (including the final text) — so the target can ask for
 * operations as text and apply them itself.
 */
export interface MaintenanceBudget {
	/** Wall-clock deadline (epoch ms); work past it is abandoned. */
	readonly deadline: number;
	/** Internal runs the target may start (P6 digest runs). */
	readonly runs: number;
	/**
	 * Start one internal digest run on the user's curator model, bounded
	 * to the listed tools; resolves with the run's result.
	 */
	run(input: string, tools: readonly string[]): Promise<CurationRunResult>;
}

/** One change a maintenance pass reports, undoable through `undo`. */
export type MaintenanceReport = {
	/** Changes made, each undoable through the target's `undo`. */
	readonly changes: readonly { readonly changeId: string; readonly summary: string }[];
	/** True when the target stopped early and wants the next pass. */
	readonly more?: boolean;
};

/**
 * One curation target (the curator contract, spec P7): an extension's
 * writable per-user surface the curator learns into. The `tools` list is
 * the interception surface — every LISTED tool call outside a curator
 * run becomes a review hint (A8's wrapping), while an unlisted direct
 * write tool stays the extension's own. `undo` is REQUIRED: a target
 * without it fails the load (no undo, no magic).
 */
export interface CurationTarget {
	/** Unique within the extension; core qualifies it as `<slug>:<name>`. */
	readonly name: string;
	/** Tools the review may call to write this target; registered by this extension. */
	readonly tools: readonly string[];
	/**
	 * Read-only tools the review may call (knowledge C5): model-visible
	 * for serving and allowed inside a review, but NEVER wrapped into a
	 * review hint and never gated — the loader's wrap feed grows from
	 * `tools` only. Registered by this extension; disjoint from `tools`.
	 */
	readonly readTools?: readonly string[];
	/** Routing guidance for one user; `[]` = unavailable for this user. */
	guidance(user: string): readonly string[] | Promise<readonly string[]>;
	/**
	 * Whether this target wants the conversation reviewed (the fork path
	 * only — mixed-authorship conversations go to the idle digest). Core
	 * bounds each call at 2 s; a throw or timeout counts as `false`.
	 */
	wantsReview?(user: string, conversationId: ConversationId): boolean | Promise<boolean>;
	/**
	 * Called after a fork review of the conversation COMPLETED (after
	 * the result is recorded) — the target's signal that the review
	 * consumed its hints. Not called for any other status. Errors are
	 * caught and logged; a target must not rely on being called.
	 */
	reviewed?(user: string, conversationId: ConversationId): void | Promise<void>;
	/** Revert one change this target reported. Required. */
	undo(user: string, changeId: string, ctx: HandlerContext): Promise<void>;
	/** Optional idle maintenance, called by the curator's idle pass. */
	maintain?(
		user: string,
		ctx: HandlerContext,
		budget: MaintenanceBudget,
	): Promise<MaintenanceReport>;
}

/**
 * The `details.curation` shape every target tool's mutating result
 * carries: the change id for the undo surface and a one-line summary
 * for the UI. A type alias (not an interface): the structural JSON
 * mirror of the tool-result details field.
 */
export type CurationChangeDetails = {
	readonly changeId: string;
	readonly summary: string;
};

/**
 * One recorded review hint (P9): an owner-authored call to a curation
 * tool outside a curator run, captured by A8's wrapper for the next
 * review. `args` is the verbatim tool arguments; `at` is the capture
 * instant (ISO).
 */
export type CurationHint = {
	readonly id: string;
	readonly tool: string;
	readonly args: JsonObject;
	readonly at: string;
};

// ---------------------------------------------------------------------------
// The curation host surface (curator P6, A9)
// ---------------------------------------------------------------------------

/**
 * One change to a learned skill (the `skill_manage` mutating union,
 * structural mirror of the store's `SkillChange`). A type alias (not
 * an interface): the implicit index signature the JSON doc shapes need.
 */
export type CurationSkillChange =
	| { readonly kind: "create"; readonly content: string }
	| { readonly kind: "patch"; readonly old: string; readonly new: string; readonly file?: string }
	| { readonly kind: "write_file"; readonly file: string; readonly content: string }
	| { readonly kind: "remove_file"; readonly file: string }
	| { readonly kind: "archive"; readonly absorbedInto?: string }
	| { readonly kind: "restore"; readonly version?: string };

/**
 * One change-feed entry (structural mirror of the store's `FeedEntry`).
 * `id`, `before` and `after` are commit SHAs in the user's curation
 * history repo (tabs+skills Task 9); `actor` widens to include
 * `"outside"` for catch-up commits the store itself did not author.
 */
export type CurationFeedEntry = {
	readonly id: string;
	readonly at: string;
	readonly actor: "curator" | "agent" | "user" | "outside";
	readonly action: string;
	readonly skill: string;
	readonly reason?: string;
	readonly reviewId?: string;
	readonly conversationId?: number;
	readonly before?: string;
	readonly after?: string;
};

/** One learned skill's listing row (structural mirror). */
export type CurationSkillInfo = {
	readonly name: string;
	readonly description: string;
	readonly archived: boolean;
	readonly pinned: boolean;
	readonly bytes: number;
	readonly createdAt: string;
};

/** Identifies one upstream skill an overlay attaches to (structural mirror). */
export type CurationOverlayKey = {
	readonly root: "workspace" | "user dir" | "package";
	readonly skill: string;
	/** The canonical workspace root path; required for workspace keys only. */
	readonly workspace?: string;
};

/** One stored overlay (structural mirror). */
export type CurationOverlay = {
	readonly key: CurationOverlayKey;
	readonly text: string;
	readonly upstreamHash: string;
	readonly orphanedSince?: string;
};

/** The actor-side metadata an overlay change records in the feed. */
export type CurationOverlayMeta = {
	readonly actor: "curator" | "agent" | "user";
	readonly reason?: string;
	readonly reviewId?: string;
	readonly conversationId?: number;
};

/** The bounds and identity one curator run drives under. */
export type CurationRunOpts = {
	/** The instruction the run submits as its only input. */
	readonly instruction: string;
	/** The tools the run's gate allows (non-empty — the gate's message names them). */
	readonly allow: readonly string[];
	/** The tool-result budget: the run aborts at this many tool results. */
	readonly maxToolCalls: number;
	/** The output-token budget (advisory; see the run-driver docs). */
	readonly maxOutputTokens: number;
	/** The wall-clock budget in milliseconds. */
	readonly deadlineMs: number;
	/** The review (or digest) identity stamped on every feed entry. */
	readonly reviewId: string;
	/** Caller cancellation: fires → the run aborts as cancelled. */
	readonly signal?: AbortSignal;
};

/** What a review's `eligibility` read answers. */
export type CurationEligibility = {
	readonly owner?: string;
	readonly internal: boolean;
	/** Deleted marker; consumed by the curator extension to gate loop-2 digests. */
	readonly deleted: boolean;
	/** Every user entry attributed to the owner. */
	readonly ownerOnly: boolean;
	/** Unattributed user entries. */
	readonly unattributed: number;
	readonly newestEntry?: EntryId;
};

/** One served curation target, projected for the caller. */
export type CurationTargetInfo = {
	readonly id: string;
	readonly tools: readonly string[];
	/** The target's declared read tools (C5; absent when it has none). */
	readonly readTools?: readonly string[];
	readonly guidance: readonly string[];
	readonly maintain: boolean;
};

/** The per-user skill-store subset the curation host serves. */
export type CurationSkillStore = {
	list(): Promise<readonly CurationSkillInfo[]>;
	view(name: string, file?: string): Promise<string>;
	feed(limit: number, before?: string): Promise<readonly CurationFeedEntry[]>;
	pin(name: string, pinned: boolean): Promise<void>;
	undo(entryIds: readonly string[]): Promise<readonly CurationFeedEntry[]>;
	/** Apply one change as the curator (actor "curator"). */
	apply(
		name: string,
		change: CurationSkillChange,
		meta: { readonly reviewId?: string; readonly reason?: string },
	): Promise<CurationFeedEntry>;
};

/** The per-user overlay-store subset the curation host serves. */
export type CurationOverlayStore = {
	list(): Promise<readonly CurationOverlay[]>;
	get(key: CurationOverlayKey): Promise<CurationOverlay | undefined>;
	put(
		key: CurationOverlayKey,
		text: string,
		upstreamHash: string,
		meta: CurationOverlayMeta,
	): Promise<CurationFeedEntry>;
	remove(key: CurationOverlayKey, meta: CurationOverlayMeta): Promise<CurationFeedEntry>;
	markOrphans(
		present: (key: CurationOverlayKey) => boolean,
		now: string,
	): Promise<void>;
};

/**
 * The curation surface (curator P6, A9): the curator's read APIs and
 * run producers over the curated user's per-user stores. The host
 * owns the internals; this is the extension-facing projection — the
 * run driver, the stores and the registry stay server-side.
 */
export type SigrunCurationHost = {
	eligibility(id: ConversationId): Promise<CurationEligibility>;
	/**
	 * Every user-input entry in the ACTIVE context mapped to its author
	 * (P1). An entry admitted before attribution existed, or by an
	 * unidentified caller, is present with `undefined` — unattributed,
	 * never guessed (fail closed: unattributed entries are never curation
	 * input).
	 */
	authors(id: ConversationId): Promise<ReadonlyMap<EntryId, string | undefined>>;
	/** Count the conversation's assistant entries after (or all without) an anchor entry. */
	modelCallsSince(id: ConversationId, entryId?: EntryId): Promise<number>;
	/** Read and clear the conversation's pending review hints (A8's doc). */
	takeHints(id: ConversationId): Promise<readonly CurationHint[]>;
	/** Targets whose tools (and readTools) are all in the conversation's selection (no id: all). */
	targets(user: string, id?: ConversationId): Promise<readonly CurationTargetInfo[]>;
	/**
	 * Whether any target served for `(user, id)` requests a review (C5):
	 * `true` when at least one served target's `wantsReview` answers
	 * true. Each target's call is bounded (2 s); a throw or timeout
	 * counts as `false`. Fork-path only — the idle digest never asks.
	 */
	wantsReview(user: string, id: ConversationId): Promise<boolean>;
	/** The conversation's model-visible tool names (for the allow-list). */
	tools(id: ConversationId): Promise<readonly string[]>;
	/** Fork the conversation at its newest entry and drive the review run. */
	forkReview(
		id: ConversationId,
		opts: CurationRunOpts,
	): Promise<CurationRunResult>;
	/** A fresh internal digest conversation for `user`, driven the same way. */
	digestRun(
		user: string,
		opts: CurationRunOpts & { readonly input: string; readonly model?: string },
	): Promise<CurationRunResult>;
	/** Run one target's maintenance pass with a digest-run budget. */
	maintain(
		user: string,
		targetId: string,
		budget: Omit<MaintenanceBudget, "run">,
	): Promise<MaintenanceReport>;
	/** The curated user's skill store (apply = actor "curator"). */
	skills(user: string): CurationSkillStore;
	/** The curated user's overlay store. */
	overlays(user: string): CurationOverlayStore;
	/** The current upstream body + hash for one overlay key. */
	upstream(
		user: string,
		key: CurationOverlayKey,
	): Promise<{ readonly body: string; readonly hash: string } | undefined>;
	/** Skill names in the user's job prompts, paused jobs included. */
	jobSkillRefs(user: string): Promise<ReadonlySet<string>>;
	/** Revert every change one review made; the number of reverts. */
	undoReview(user: string, reviewId: string): Promise<number>;
	/** The skill → lastUsed ISO map (P4's counters). */
	usage(user: string): Promise<Readonly<Record<string, string | undefined>>>;
};

// ---------------------------------------------------------------------------
// Per-user services (multi-user M2, spec §10.3)
// ---------------------------------------------------------------------------

/** The command and extra environment/read rights for one per-user process. */
export interface ServiceSpec {
	readonly command: string;
	readonly args: string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly readPaths?: string[];
}

/** One factory-declared long-lived per-user service. */
export interface UserService {
	readonly name: string;
	start(user: string, ctx: HandlerContext): Promise<ServiceSpec | undefined>;
	readonly idleMinutes?: number;
}

/** A shared-stdio attachment to a running per-user service. */
export interface ServiceHandle {
	readonly stdin: WritableStream<Uint8Array>;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<{ code: number | null; signal: string | null }>;
	release(): void;
}

// ---------------------------------------------------------------------------
// Provider + webui-bundle contributions
// ---------------------------------------------------------------------------

/** Three-state per-provider readiness: not configured, degraded, or ready. */
export type ProviderReadinessStatus = "not_configured" | "degraded" | "ready";

/** One readiness report: the status plus optional operator-facing detail. */
export interface ProviderReadiness {
	readonly status: ProviderReadinessStatus;
	readonly detail?: string;
}

/**
 * A plugin's per-provider readiness tracker: a synchronous per-request
 * read over plugin-owned state (never network, never storage) — the
 * three-state source `/v1/auth/check` reports verbatim.
 */
export type ReadinessTracker = () => ProviderReadiness;

// ---------------------------------------------------------------------------
// Decision providers (warden Task 5 — the decision-providers spec)
// ---------------------------------------------------------------------------

/** One decision model: a bare id plus optional limits narrower than the built-in caps. */
export interface DecisionModelInfo {
	readonly id: string;
	readonly limits?: DecisionLimits;
}

/** The context core stamps on every decision-provider call. */
export interface DecisionContext {
	/** The bare model id (the `"<provider>/<model>"` spec's second half). */
	readonly model: string;
	/** auth.json[id].apiKey, else the ambient `credentialEnv`; never `"default"`. */
	readonly credential: string | undefined;
	readonly signal: AbortSignal;
	/** The calling extension's slug, core-stamped (`"sigrun"` for the core tool). */
	readonly caller: string;
}

/**
 * One decision-provider contribution: typed questions (noul / choice /
 * score) answered over a JSON state. A factory result carrying only
 * `decisionProviders` is a valid contributor-only result.
 */
export interface DecisionProviderContribution {
	/** `^[a-z][a-z0-9-]*$`; the auth.json key and the model prefix. */
	readonly id: string;
	/** Display name. */
	readonly label?: string;
	/** Ambient env fallback core reads when auth.json has no key. */
	readonly credentialEnv?: string;
	/** The fixed model list (restart-required). */
	readonly models: readonly DecisionModelInfo[];
	/** The chat providers' three-state readiness tracker. */
	readonly readiness?: ReadinessTracker;
	/** May throw; core maps a throw to `failed`. */
	evaluate(request: DecisionRequest, ctx: DecisionContext): Promise<DecisionAnswers>;
}

// ---------------------------------------------------------------------------
// Embedding providers (embedding-providers Task 1, spec §1)
// ---------------------------------------------------------------------------

/** One embedding model: a bare id plus the vector length it returns. */
export interface EmbeddingModelInfo {
	/** Bare model id, e.g. "text-embedding-3-small". */
	readonly id: string;
	/** The vector length the model returns. */
	readonly dimensions: number;
	/** Inputs per provider request (core splits a call above it). */
	readonly maxBatch?: number;
	/** The provider's own view of where this model runs. `false` vetoes local-only use even if the admin lists the model (§2). */
	readonly local?: boolean;
}

/** One embedding request: the bare model id plus the input texts. */
export interface EmbeddingRequest {
	readonly model: string;
	readonly input: readonly string[];
}

/** The context core stamps on every embedding-provider call. */
export interface EmbeddingContext {
	/** auth.json[id].apiKey, else the ambient `credentialEnv`; may be absent. */
	readonly credential: string | undefined;
	readonly signal: AbortSignal;
}

/** One embedding response: one vector per input, in input order. */
export interface EmbeddingResponse {
	readonly vectors: readonly (readonly number[])[];
	readonly usage?: { readonly inputTokens: number };
}

/**
 * One embedding-provider contribution: vectors for input texts. A
 * factory result carrying only `embeddingProviders` is a valid
 * contributor-only result.
 */
export interface EmbeddingProviderContribution {
	/** `^[a-z][a-z0-9-]*$`; the auth.json key and the model prefix. */
	readonly id: string;
	/** Display name. */
	readonly label?: string;
	/** Ambient env fallback when auth.json has no key. */
	readonly credentialEnv?: string;
	/** The fixed model list (restart-required). */
	readonly models: readonly EmbeddingModelInfo[];
	/** The chat providers' three-state readiness tracker. */
	readonly readiness?: ReadinessTracker;
	/** May throw; core maps a throw to `failed`. */
	embed(request: EmbeddingRequest, ctx: EmbeddingContext): Promise<EmbeddingResponse>;
}

/** One provider contribution: a pi-ai `createProvider()` result plus optional boot hints. */
export interface ProviderContribution {
	readonly provider: Provider;
	/**
	 * This contributor's proposed default model. Ignored when a default
	 * model is configured; the last contributor to propose one wins
	 * otherwise.
	 */
	readonly defaultModel?: ModelRef;
	/** The per-provider readiness tracker (`/v1/auth/check` reports it verbatim). */
	readonly readiness?: ReadinessTracker;
}

/** Core-owned state for one external login, with provider-private scratch data. */
export type LoginFlow = {
	state: string;
	callbackUrl: string;
	data: Record<string, string>;
}

/** The identity proof a login provider returns after its callback. */
export type LoginResult = {
	subject: string;
	profile: { username?: string; name?: string; email?: string; emailVerified?: boolean };
	groups?: string[];
}

/** One extension identity provider; core owns the flow, state and callback. */
export interface LoginProviderContribution {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	/** Provider-declared provisioning policy, enforced by core. */
	readonly policy?: {
		readonly autoProvision?: boolean;
		readonly allowedGroups?: string[];
		readonly allowedDomains?: string[];
	};
	begin(flow: LoginFlow, ctx: HandlerContext): Promise<{ redirectUrl: string }>;
	complete(
		flow: LoginFlow,
		callback: { query: Record<string, string>; body?: unknown },
		ctx: HandlerContext,
	): Promise<LoginResult>;
}

/** One contributed webui bundle: a selection name plus the bundle root directory. */
export interface WebuiBundleContribution {
	/** The selection key (`server.webui.bundle`); must match `^[a-z][a-z0-9_-]*$`. */
	readonly name: string;
	/** The bundle root (the directory containing `index.html`); relative values anchor at the extension ENTRY's directory. */
	readonly dir: string;
}

// ---------------------------------------------------------------------------
// Routes, commands, notifications (W5 Tasks 2, 3, 6)
// ---------------------------------------------------------------------------

/**
 * The resolved caller (core hardening W1): what the auth pipeline
 * stamps on every request. `method` names the proof — the empty-method
 * naive path (`"none"`), a verified token (`"token"`), a trusted
 * forward-auth header set (`"proxy"`), or an IN-PROCESS host-built
 * principal (`"host"`, gateway C4b: `commands.run` builds it from the
 * directory — no request ever carries one, but a command run through
 * the host sees exactly which proof its caller had).
 */
export interface Principal {
	/** The directory username; `undefined` under the naive method with no header. */
	readonly user: string | undefined;
	readonly name?: string;
	readonly email?: string;
	readonly admin: boolean;
	/** True for the `SIGRUN_API_TOKEN` service principal. */
	readonly service: boolean;
	readonly method: "none" | "token" | "session" | "proxy" | "host";
	/** The login provider that issued a session principal. */
	readonly provider?: string;
}

/** One extension HTTP route, mounted at `/v1/ext/<slug>/<path>`. */
export interface ExtensionRouteContribution {
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Relative; mounted at `/v1/ext/<slug>/<path>`. */
	readonly path: string;
	readonly auth: "user" | "admin" | "public";
	/** Request body ceiling in bytes (default 1 MiB). */
	readonly bodyLimit?: number;
	/** Web-standard `Request`/`Response` (Node ≥ 22) — no server type crosses the contract. */
	handler(
		request: Request,
		ctx: { readonly principal?: Principal; readonly host: SigrunHost },
	): Promise<Response>;
}

/** One extension slash command, invoked via `POST /v1/conversations/:id/commands/:name`. */
export interface ExtensionCommandContribution {
	/** Must match `^[a-z][a-z0-9-]*$`; core command names are reserved. */
	readonly name: string;
	readonly description: string;
	/** Argument hint for the composer's `/` menu. */
	readonly args?: string;
	run(ctx: {
		readonly conversationId: ConversationId;
		readonly args: string;
		readonly principal: Principal;
		readonly host: SigrunHost;
	}): Promise<{ readonly notice?: string } | void>;
}

/** The settled-run outcome: the notification-safe projection of the host
 *  event's `outcome`/`reason` (status and reason only — no answer text). */
export type RunSettledOutcome =
	| { readonly status: "answered" }
	| { readonly status: "unanswered"; readonly reason: string };

// ---------------------------------------------------------------------------
// Per-user notices (notices Task 3 — the `host.notices` surface + the
// `noticeActions` factory field)
// ---------------------------------------------------------------------------

/**
 * The context a `noticeActions` handler runs with: who clicked, the notice
 * as stored (its `owner` is the handler's own slug), and the dispatch
 * deadline's signal (the 10 s action timeout).
 */
export interface UserNoticeActionContext {
	readonly principal: Principal;
	readonly notice: UserNotice;
	readonly signal: AbortSignal;
}

/**
 * What a notice action answers (notices spec §4): `ok` clears the notice
 * unless `keep: true`; `message` shows in the client, `navigate` moves it
 * to a core target. A failure keeps the notice and shows the error.
 */
export type UserNoticeActionResult =
	| {
			readonly ok: true;
			readonly keep?: boolean;
			readonly message?: string;
			readonly navigate?: CoreTarget;
	  }
	| { readonly ok: false; readonly error: { readonly message: string } };

/** One declared notice action handler (the `noticeActions` value shape). */
export type UserNoticeActionHandler = (
	ctx: UserNoticeActionContext,
	payload: JsonObject,
) => Promise<UserNoticeActionResult>;

/** One explicit notification an extension sends through `host.notify`. */
export interface ExtensionNoticeInput {
	/** A directory user; `undefined` only when the directory is empty. */
	readonly user: string | undefined;
	/** 1..200 characters. */
	readonly title: string;
	/** 0..2000 characters. */
	readonly body: string;
	/** 1..64 characters, each `[a-z0-9.-]`. */
	readonly kind: string;
	readonly target?:
		| { readonly view: string; readonly params?: JsonObject }
		| { readonly conversation: number };
}

/** Fields shared by every notification variant. */
interface NotificationEventBase {
	readonly conversationId?: number;
	readonly jobId?: string;
	/** The recipient. */
	readonly user: string | undefined;
	readonly title: string;
	readonly body: string;
	/**
	 * A deep link into the webui, only ever set when `server.publicUrl` is
	 * configured: `${server.publicUrl}/#/c/<conversationId>` for
	 * conversation-carrying events, or the
	 * `${server.publicUrl}/#/ext/<slug>/<view>` link for an extension
	 * notice whose target is a declared view (with `?params=` when the
	 * target carries params). Absent otherwise.
	 */
	readonly url?: string;
}

/** One notification core delivers to every registered notifier (best-effort). */
export type NotificationEvent = NotificationEventBase &
	(
		| {
				readonly type: "interaction.pending";
				/** Gateway C6: the pending record's id — set on `interaction.pending` only
				 *  (inspect it via `host.peekInteraction`; the OWNING extension's
				 *  delivery read is `host.snapshotInteraction`). */
				readonly callId?: string;
		  }
		| { readonly type: "job.failed" }
		| {
				readonly type: "extension";
				/** The calling extension's slug. */
				readonly extension: string;
				/** The extension-defined notice kind. */
				readonly kind: string;
		  }
		| {
				readonly type: "run.settled";
				/** Whether the run answered or not (model error, abort, …), with
				 *  the wire reason verbatim. Never infer success from the body. */
				readonly outcome: RunSettledOutcome;
		  }
	);

/** One notifier transport (ntfy, Signal, web push — core ships none). */
export interface NotifierContribution {
	readonly name: string;
	notify(
		event: NotificationEvent,
		ctx: { readonly host: SigrunHost },
	): Promise<void>;
}

// ---------------------------------------------------------------------------
// Channel adapters (gateway C1 — the `channels` contribution, spec §7)
// ---------------------------------------------------------------------------

/** Whether an adapter's credentials/config are present; unconfigured adapters are never started. */
export type ChannelReadiness = {
	readonly status: "not_configured" | "ready";
	readonly detail?: string;
};

/** What a chat platform can render — the engine formats against these. */
export interface ChannelCapabilities {
	readonly chatTypes: readonly ("dm" | "group" | "thread")[];
	readonly maxMessageLength: number;
	readonly format: "plain" | "markdown" | "native";
	/** Edit-in-place streaming; `minIntervalMs` is the platform's safe edit rate. */
	readonly edit?: { readonly minIntervalMs: number };
	/** `labelMax` bounds button text; the engine truncates, never the adapter. */
	readonly buttons?: {
		readonly max: number;
		readonly perRow?: number;
		readonly labelMax?: number;
	};
	readonly media?: readonly ("image" | "audio" | "video" | "document")[];
	readonly typing?: { readonly intervalMs: number };
	readonly replyTo?: boolean;
	readonly commandMenu?: boolean;
	/** One short paragraph for the prompt: what renders, what doesn't. */
	readonly promptHint?: string;
}

/** One chat on a platform — where a conversation lives. */
export interface ChatRef {
	readonly chatId: string;
	readonly chatType: "dm" | "group" | "thread";
	readonly threadId?: string;
}

/** One platform message — the edit/delete target. */
export interface MessageRef {
	readonly chat: ChatRef;
	readonly messageId: string;
}

/**
 * One inbound media attachment. `fetch` is lazy so unwanted media is
 * never downloaded; the adapter stops reading and throws once `maxBytes`
 * is exceeded, so an undeclared-size file is never fully downloaded
 * either.
 *
 * The size-limit error is an error whose `name` is
 * {@link AttachmentTooLargeName} (`"AttachmentTooLarge"`): the engine
 * matches it by NAME, never `instanceof` — this types-only contract
 * ships no runtime subpath, so class identity could never line up across
 * an adapter's own dependency tree.
 */
export interface InboundAttachment {
	readonly kind: "image" | "audio" | "voice" | "video" | "document" | "sticker";
	readonly mime?: string;
	readonly filename?: string;
	readonly size?: number;
	fetch(opts: { maxBytes: number; signal: AbortSignal }): Promise<Uint8Array>;
}

/** One inbound chat message, handed to the engine through `ChannelContext.receive`. */
export interface InboundEvent {
	readonly messageId: string;
	readonly chat: ChatRef & { readonly title?: string };
	readonly sender: { readonly id: string; readonly name?: string; readonly isBot?: boolean };
	/** The bot's own message echoed back; the engine drops it. */
	readonly fromSelf?: boolean;
	readonly text: string;
	/** Group messages: the bot was @-mentioned or replied to. */
	readonly mentioned?: boolean;
	readonly replyTo?: {
		readonly messageId: string;
		readonly text?: string;
		readonly authorName?: string;
		readonly fromSelf?: boolean;
	};
	readonly attachments?: readonly InboundAttachment[];
	/** Platform album/batch id (e.g. a media group); events sharing it merge into one submission. */
	readonly groupId?: string;
}

/** A button tap: `data` is the opaque token the engine put on the button. */
export interface ActionEvent {
	readonly chat: ChatRef;
	readonly sender: { readonly id: string; readonly name?: string };
	readonly message?: MessageRef;
	readonly data: string;
}

/** One message to send: already formatted per `capabilities.format` and within `maxMessageLength`. */
export interface OutboundMessage {
	readonly chat: ChatRef;
	readonly text: string;
	readonly replyTo?: string;
	readonly buttons?: readonly (readonly {
		readonly label: string;
		readonly data: string;
		readonly style?: "primary" | "danger" | "neutral";
	}[])[];
	readonly files?: readonly { readonly name: string; readonly mime?: string; readonly bytes: Uint8Array }[];
}

/** Which platform messages one `send` produced (a media group, a split message). */
export interface SendReceipt {
	readonly messageIds: readonly string[];
}

/** The engine-side context handed to a started adapter. */
export interface ChannelContext {
	readonly signal: AbortSignal;
	/**
	 * Resolves once the event is durably admitted, handled as a command,
	 * or deliberately dropped: the adapter acks the platform on any
	 * resolution. A rejection means the engine failed; the adapter does
	 * not ack, the platform redelivers, and dedupe makes the retry safe.
	 */
	receive(event: InboundEvent): Promise<{
		readonly outcome: "admitted" | "dropped" | "command";
	}>;
	/** A button tap. `data` is the opaque token the engine put on the button. */
	action(event: ActionEvent): Promise<void>;
	status(state: { readonly state: "connecting" | "running"; readonly detail?: string }): void;
	fail(error: unknown): void;
	readonly log: {
		info(msg: string): void;
		warn(msg: string): void;
		error(msg: string, error?: unknown): void;
	};
}

/**
 * One channel adapter: one chat platform's transport. The engine owns
 * supervision and delivery; the adapter owns the platform.
 */
export interface ChannelContribution {
	/** Must match `^[a-z][a-z0-9-]*$`; unique across every loaded extension. */
	readonly id: string;
	readonly label: string;
	readonly capabilities: ChannelCapabilities;
	/** Whether credentials/config are present. Unconfigured adapters are never started. */
	configured(): ChannelReadiness | Promise<ChannelReadiness>;
	/**
	 * Connect and begin receiving. Resolves once connected; any receive
	 * loop keeps running until `ctx.signal` aborts. Post-connect failures
	 * go through `ctx.fail` so the engine's supervisor owns restarts
	 * (adapters never self-reconnect forever).
	 */
	start(ctx: ChannelContext): Promise<void>;
	stop?(): Promise<void>;
	send(message: OutboundMessage): Promise<SendReceipt>;
	edit?(ref: MessageRef, message: OutboundMessage): Promise<void>;
	delete?(ref: MessageRef): Promise<void>;
	typing?(chat: ChatRef): Promise<void>;
	setCommands?(
		commands: readonly { readonly name: string; readonly description: string }[],
	): Promise<void>;
	/** Markdown → the platform's native markup. Required when `capabilities.format` is `"native"`. */
	format?(markdown: string): string;
	/** Without it every send error is `"transient"`. */
	classifyError?(error: unknown): "transient" | "permanent" | "chat_gone";
}

/**
 * The `name` an adapter's size-limit error carries: the engine matches
 * `error.name === "AttachmentTooLarge"`, never `instanceof` (no runtime
 * subpath ships with the types-only contract — see
 * {@link InboundAttachment.fetch}).
 */
export type AttachmentTooLargeName = "AttachmentTooLarge";

// ---------------------------------------------------------------------------
// Gateway engines (gateway C2 — the `gateway` factory-result field)
// ---------------------------------------------------------------------------

/**
 * The context sigrun hands the loaded engine's `start`: the flat,
 * slug-attributed channel set (every loaded adapter's contribution —
 * `{extension, channel}` pairs) and the shutdown signal. The signal is
 * the `AbortController` the host's `gateway.stop()` aborts — an engine's
 * receive loops observe it, exactly like an adapter's `ChannelContext.signal`.
 */
export interface GatewayEngineContext {
	readonly channels: readonly {
		readonly extension: string;
		readonly channel: ChannelContribution;
	}[];
	/** Aborted by the host's `gateway.stop()` — the engine's shutdown signal. */
	readonly signal: AbortSignal;
}

/**
 * One gateway engine: the chat-transport supervisor the `gateway`
 * factory-result field names. ONE engine per boot (a second declarer
 * quarantines at load — the one-engine rule); core ships none. `start`
 * runs after the server listens; `stopIntake` runs before the event bus's
 * shutdown drain (intake closes first — the drain is the last admission
 * window); `stop` runs after it (adapters stop only once every settle has
 * been delivered). Health is reported through `health()` — NEVER the
 * factory-result `health` field (that field is the provider-contributor
 * surface; a result carrying both quarantines).
 */
export interface GatewayEngine {
	/** Start supervision over the channels; resolves once started. */
	start(ctx: GatewayEngineContext): Promise<void>;
	/** Close inbound intake (admissions stop) — before the shutdown drain. */
	stopIntake(): Promise<void>;
	/** Stop the engine and its adapters — after the shutdown drain. */
	stop(): Promise<void>;
	/** The engine's synchronous health read ("ok" | "degraded"). */
	health(): "ok" | "degraded";
}

// ---------------------------------------------------------------------------
// Extension surfaces (UI-blocks U3 Task 1, spec §7.1)
// ---------------------------------------------------------------------------

/**
 * The render/data access verdict a surface reports for one principal
 * (spec §6.5): `none` hides the surface entirely (404 on every route).
 */
export type SurfaceAccessLevel = "none" | "read" | "write";

/** The per-principal, per-instance context `render`/`data` receive. */
export interface SurfaceContext {
	/** Who is looking; the access verdict is this principal's. */
	readonly principal: Principal;
	/** From `navigate(params)`; validated as JSON, size-capped at 4 KiB. */
	readonly params: JsonParams;
	/** The instance identity: `instanceKey(params)` of this instance. */
	readonly key: string;
	/** Aborts when the request is abandoned; observe it in long work. */
	readonly signal: AbortSignal;
}

/** The full render result: the tree, its data, and the access verdict. */
export interface SurfaceRenderResult {
	readonly tree: Tree;
	readonly data: JsonObject;
	readonly access: SurfaceAccessLevel;
}

/** The lighter `data()` result: refreshed data plus the access verdict. */
export interface SurfaceDataResult {
	readonly data: JsonObject;
	readonly access: SurfaceAccessLevel;
}

/** The payload of an `onUpload` handler (spec §7.1 — snif... never trusted). */
export interface UploadedFile {
	/** The file field's name (the `file` field that carried the upload). */
	readonly field: string;
	/** Client-supplied filename, sanitised to a basename. */
	readonly name: string;
	/** Sniffed from the bytes, never trusted from the client. */
	readonly mime: string;
	/** Capped by the field's `maxBytes` and `server.maxUploadBytes`. */
	readonly bytes: Uint8Array;
}

/**
 * What an action handler returns (spec §6.3/§7.1): accepted (with an
 * optional data update, a navigation, and a toast) or rejected (an
 * operator-facing error, optionally field-scoped).
 */
export type ActionResult =
	| {
				readonly ok: true;
				/** Data ops the server applies to the instance's data (sharedData only keeps them; §7.3). */
				readonly update?: DataOps;
				/** A `navigate` action (spec §6.1): the channel routes it through the normal navigation paths. */
				readonly navigate?: {
					readonly type: "navigate";
					readonly params?: JsonObject;
					readonly target?: CoreTarget;
				};
				readonly toast?: string;
		  }
	| {
				readonly ok: false;
				readonly error: { readonly message: string; readonly field?: string };
		  };

/**
 * One declared surface (spec §7.1, verbatim shape): the placement is
 * the generic parameter — `"view"`, `"panel"`, or `"settings"` (the
 * §13.3 settings sections adapt to settings-placement surfaces; the
 * host builds those — extensions declare `SettingsSectionDef`s, never
 * `SurfaceDef<"settings">` directly).
 */
export interface SurfaceDef<P extends "view" | "panel" | "settings"> {
	/** Unique within the extension. */
	readonly id: string;
	readonly title: string;
	readonly icon: IconName;
	readonly placement: P;
	/** Data is identical for every principal with access (§7.3). */
	readonly sharedData?: boolean;
	/** Panels only: the channels attach this panel with
	 *  `params: { conversationId }` of the OPEN conversation, so one
	 *  instance follows the conversation the user is in. The id is
	 *  client-supplied — the extension must check the caller's access to
	 *  that conversation before rendering or acting on it. */
	readonly perConversation?: boolean;
	/** Channels refetch data on this interval while visible (min 5000). */
	readonly refreshMs?: number;
	/** §7.3; default: canonical JSON of params. The principal argument
	 *  lets principal-owned surfaces isolate their revision/action identity. */
	instanceKey?(params: JsonParams, principal: Principal): string;
	render(ctx: SurfaceContext): Promise<SurfaceRenderResult>;
	data?(ctx: SurfaceContext): Promise<SurfaceDataResult>;
	readonly actions?: Readonly<
		Record<string, (ctx: SurfaceContext, payload: JsonParamValue) => Promise<ActionResult>>
	>;
}

// ---------------------------------------------------------------------------
// Settings sections (UI-blocks U4 Task 3, spec §13.3)
// ---------------------------------------------------------------------------

/**
 * One declared settings section (spec §13.3, verbatim shape): a static
 * `settings`-placement form bound to the extension's settings object
 * (`settings/<slug>.json`). The host adapts it to a surface under the
 * extension's own `/v1/ext/<slug>/surfaces/` mount — core's own
 * sections use the same renderer, under the reserved `core` slug.
 */
export interface SettingsSectionDef {
	/** Unique within the extension. */
	readonly id: string;
	readonly title: string;
	readonly icon?: IconName;
	/** A root `form` block; the placement is `settings` (spec §5.7). */
	readonly form: Tree;
	/** Declared secrets, rendered as `secret` fields backed by the §7.7 secrets routes. */
	readonly secrets?: readonly { key: string; label: string; help?: string }[];
	/** Only admins see and edit it; default true for shared sections.
	 *  A user-scope section is visible to every signed-in user unless this
	 *  is explicitly true. */
	readonly admin?: boolean;
	/** `"user"` reads/writes the calling user's settings; absent/`"server"`
	 *  keeps the extension's shared settings file. */
	readonly scope?: "server" | "user";
}

/**
 * The `surfaces` field of a factory result (spec §7.1): declared views,
 * panels, and settings sections. Ids are unique across ALL THREE lists
 * (one namespace — the loader enforces it).
 */
export interface SurfacesContribution {
	readonly views?: readonly SurfaceDef<"view">[];
	readonly panels?: readonly SurfaceDef<"panel">[];
	/** §13.3 settings sections (UI-blocks U4 Task 3). */
	readonly settings?: readonly SettingsSectionDef[];
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/** One wire part of a `host.conversations.submit` input array. */
export type SubmissionInputPart =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly path: string;
			readonly mime?: string;
	  }
	| {
			readonly type: "file";
			readonly path: string;
			readonly mime?: string;
	  };

/** How a submit behaves when a run is already live (pi-durable's `whenBusy`). */
export type WhenBusyMode = NonNullable<InputSubmissionDraft["whenBusy"]>;

/** The extension-facing, read-only projection of one live job. */
export interface HostJobInfo {
	readonly id: string;
	readonly name: string;
	/** The effective owner (ownerless jobs resolve to the primary admin). */
	readonly owner?: string;
	readonly enabled: boolean;
	readonly state: JobWire["state"];
}

/**
 * The host context sigrun hands an extension factory: the scoped
 * extension stores, the interaction/ambient seam surfaces, and the
 * conversation/identity/access APIs.
 *
 * The store surface is safe at any time (plain file I/O); the seam and
 * conversation surfaces bind the harness lazily — call them from tool
 * execute, hooks, routes, commands, workers, and jobs, never from a
 * factory body.
 */
export interface SigrunHost {
	/**
	 * Publish tools for ONE user (multi-user M2). Only factory results that
	 * declared `perUserTools: true` may call this; other extensions throw
	 * `perUserTools not declared`. An empty list uninstalls the user's entry.
	 * Core wraps every tool with a committed-owner check at execute time.
	 */
	readonly tools: {
		setUserTools(user: string, tools: readonly import("@earendil-works/pi-durable").ToolRegistration[]): void;
	};

	/** Connect to one declared per-user service; core owns its process lifecycle. */
	readonly services: {
		connect(name: string, user: string, ctx: HandlerContext): Promise<ServiceHandle>;
	};

	/** The scoped extension-stores handle (your secrets/settings sections + raw data/cache/state paths). */
	readonly stores: {
		/** One directory user's secrets/settings/paths, still scoped to your slug. */
		user(user: string): {
			readonly secrets: {
				get(key: string): Promise<string | undefined>;
				set(key: string, value: string): Promise<void>;
				delete(key: string): Promise<void>;
			};
			readonly settings: {
				get(): Promise<Record<string, unknown>>;
				set(value: Record<string, unknown>): Promise<void>;
			};
			readonly paths: {
				readonly data: string;
				readonly state: string;
				readonly cache: string;
			};
		};
		/** Your section of secrets.json. */
		readonly secrets: {
			get(key: string): Promise<string | undefined>;
			set(key: string, value: string): Promise<void>;
		};
		/** Your settings/<slug>.json (absent reads as {}). */
		readonly settings: {
			get(): Promise<Record<string, unknown>>;
			set(value: Record<string, unknown>): Promise<void>;
		};
		/** Your raw directories under the data/state/cache roots. */
		readonly paths: {
			readonly data: string;
			readonly cache: string;
			readonly state: string;
		};
	};

	/** Seed (or fully replace) one interaction record; seeding a terminal record is a no-op. */
	seedInteraction(
		conversationId: ConversationId,
		record: InteractionRecord,
		context: HandlerContext,
	): Promise<void>;
	/**
	 * Answer a pending interaction from the extension side. `opts.user`
	 * (gateway C5) stamps the answer HUMAN and names the user — who
	 * answered matters to every participant a conversation is shared
	 * with; access checks stay the caller's job (host code is trusted).
	 * Without it the answer is the extension's own (`"extension"`).
	 */
	answerInteraction(
		conversationId: ConversationId,
		callId: string,
		answer: InteractionAnswer,
		context: HandlerContext,
		opts?: { readonly user?: string },
	): Promise<boolean>;
	/** Mark a pending interaction expired/cancelled/skipped (extension-owned semantics). */
	settleInteraction(
		conversationId: ConversationId,
		callId: string,
		status: "skipped" | "expired" | "cancelled",
		context: HandlerContext,
	): Promise<boolean>;
	/**
	 * Decline a pending DECLINABLE interaction as a human (ask-user Task
	 * 1): status "skipped", `declinedVia: "button"`. `opts.user` names
	 * the declining human (the same attribution `answerInteraction`
	 * stamps); false when the record is not pending or not declinable.
	 */
	declineInteraction(
		conversationId: ConversationId,
		callId: string,
		context: HandlerContext,
		opts?: { readonly user?: string },
	): Promise<boolean>;
	/**
	 * Inspect one interaction record WITHOUT consuming anything: returns
	 * the same stored projection as {@link SigrunHost.snapshotInteraction}
	 * (secret values stay `SECRET_MASK`), but never touches the one-shot
	 * secret-delivery `take` path. Safe to repeat; neither extends nor
	 * shortens secret TTL; creates, settles, and mutates nothing. Use for
	 * inspection/rendering (notifiers, outcome edits, correlation).
	 */
	peekInteraction(
		conversationId: ConversationId,
		callId: string,
		context: HandlerContext,
	): Promise<Readonly<InteractionRecord> | undefined>;
	/**
	 * The OWNING extension's delivery read: the first applicable read of
	 * an answered secret record merges its raw secret values back ONCE;
	 * subsequent reads see the stored mask. Inspection-only callers must
	 * use {@link SigrunHost.peekInteraction} instead — a consuming read
	 * by a non-owner silently destroys the owner's one-shot delivery.
	 */
	snapshotInteraction(
		conversationId: ConversationId,
		callId: string,
		context: HandlerContext,
	): Promise<Readonly<InteractionRecord> | undefined>;
	/** Fully replace one ambient surface's state (write = replacement); the key must be unowned or yours. */
	setAmbient(
		conversationId: ConversationId,
		record: {
			readonly key: string;
			readonly place: AmbientPlace;
			readonly maxRows?: number;
			readonly overflow?: "drop" | "wrap" | "summarize";
			readonly refreshMs?: number;
			readonly body?: Tree;
			readonly details?: JsonObject;
		},
		context: HandlerContext,
	): Promise<void>;
	/** Clear one ambient surface (empty replacement; keeps ownership). */
	clearAmbient(
		conversationId: ConversationId,
		key: string,
		context: HandlerContext,
	): Promise<void>;

	/**
	 * Publish a change for one surface instance (spec §7.3).
	 * `changed(id, key, update?)` tells the server that instance `key`
	 * of surface `id` changed: watching streams receive a `surface.changed`
	 * event and refetch. `key` is the string `instanceKey(params)` returned
	 * for that instance — params NEVER appear here. `update` carries data
	 * ops (kept only for `sharedData` surfaces, §7.3). Fire-and-forget:
	 * never awaited, and calling it for a surface without `data()` (a
	 * load-time contract violation) is rejected by the host.
	 */
	readonly surfaces: {
		changed(id: string, key: string, update?: DataOps): void;
	};

	/**
	 * Drive conversations in-process (channel bridges, jobs) over the
	 * same code paths as the HTTP API. Extensions are trusted in-process
	 * code: they may act for any user, and mapping a channel's users to
	 * sigrun users is the extension's own config.
	 */
	readonly conversations: {
		create(opts: {
			readonly owner?: string;
			readonly sharing?: Sharing;
			readonly name?: string;
			readonly source?: string;
			/**
			 * Associate this new conversation with one live job. The requested
			 * owner must equal the job's effective owner (including both absent).
			 * Unknown, retired, or mismatched jobs throw `ConversationOpError`
			 * with `{error: "invalid_field", field: "job"}` before any write.
			 * Success stamps `jobId`; it does not create a job run or `lastRun`.
			 */
			readonly job?: string;
			/**
			 * Pin the conversation's extension/tool selection (gateway C4):
			 * names resolved against the registry — an unknown name throws a
			 * `ConversationOpError` naming `agent.extensions`/`agent.tools`.
			 */
			readonly agent?: {
				readonly extensions?: readonly string[];
				readonly tools?: readonly string[];
			};
		}): Promise<ConversationId>;
		submit(
			id: ConversationId,
			input: readonly SubmissionInputPart[],
			opts?: {
				readonly user?: string;
				readonly requestId?: string;
				readonly whenBusy?: WhenBusyMode;
			},
		): Promise<SubmissionRecordWire>;
		watch(
			id: ConversationId,
			listener: (view: ConversationViewWire) => void,
		): Promise<() => Promise<void>>;
		list(opts?: {
			readonly owner?: string;
			readonly archived?: boolean;
		}): Promise<readonly ConversationSummary[]>;
		meta(id: ConversationId): Promise<SessionMeta>;
		/** The fork-aware transcript read (trusted; enforce access yourself with `host.access.accessOf`). */
		entries(
			id: ConversationId,
			query: Omit<EntryQuery, "conversationId">,
			limit: number,
			cursor?: Cursor,
		): Promise<Page<EntryRecord, Cursor>>;
		entry(id: ConversationId, entryId: EntryId): Promise<EntryRecord | undefined>;
		/**
		 * Withdraw/settle the conversation's active submission (gateway
		 * C4, the abort route's op). On an idle conversation it RESOLVES
		 * (chat `/stop` on an idle chat is not an error) — the HTTP route
		 * keeps its 404 `no_active_submission`.
		 */
		abort(id: ConversationId): Promise<void>;
		/**
		 * Change the model and/or thinking level (gateway C4, the configure
		 * route's op). The inputs are typed but validated like the route's
		 * body — an unknown key or malformed model is a
		 * `ConversationOpError`.
		 */
		configure(
			id: ConversationId,
			opts: {
				readonly model?: string;
				readonly thinking?: ThinkingLevelWire;
				/** Exact extension selection; another user's `<slug>@<user>` entry is rejected. */
				readonly extensions?: readonly string[];
			},
		): Promise<void>;
		/** Admit one manual compaction task (gateway C4, the compact route's op). */
		compact(id: ConversationId): Promise<void>;
		/**
		 * Fork the history at one entry (gateway C4, the fork route's op):
		 * absent `at` = the newest entry; `owner` stamps the fork's session
		 * owner (absent = the owner key removed). Returns the new id.
		 */
		fork(
			id: ConversationId,
			opts?: { readonly at?: EntryId; readonly owner?: string },
		): Promise<ConversationId>;
		/**
		 * Patch the session meta (gateway C4, the meta PATCH route's op).
		 * Host callers are TRUSTED: the sharing patch runs with no
		 * owner-or-superuser gate (the HTTP route keeps its 403).
		 */
		patchMeta(
			id: ConversationId,
			patch: {
				readonly name?: string | null;
				readonly archived?: boolean;
				readonly sharing?: Sharing | null;
			},
		): Promise<SessionMeta>;
		/**
		 * Upload one file into the conversation's upload namespace (gateway
		 * C4b, the raw-upload route's op): `uploads/<conversationId>/<name>`,
		 * the exact path a `file`/`image` submission part takes. The NAME is
		 * the one rule (no `/` or `\\`, not `.`/`..`, non-empty) — a bad
		 * name throws a `ConversationOpError` (`invalid_field` `name`).
		 */
		upload(
			id: ConversationId,
			file: { readonly name: string; readonly mime?: string; readonly bytes: Uint8Array },
		): Promise<{ readonly path: string }>;
		/**
		 * Read one workspace file raw (gateway C4b, the files/raw route's
		 * op): workspace-confined, capped at `server.maxFileReadBytes`, with
		 * the extension-derived mime. Over the cap throws
		 * `ConversationOpError({error: "too_large"}, 413)`; a bad path
		 * `invalid_path`; an absent file `not_found`.
		 */
		readFile(
			id: ConversationId,
			path: string,
		): Promise<{ readonly bytes: Uint8Array; readonly mime?: string }>;
	};

	/** Read-only job lookup; retired and unknown ids resolve to `undefined`. */
	readonly jobs: {
		get(id: string): Promise<HostJobInfo | undefined>;
		/**
		 * The job whose fire is CURRENTLY running in this conversation:
		 * the job with `lastRun.outcome === "running"` and
		 * `lastRun.conversationId === conversationId` — `undefined` when no
		 * job fire is running there. `owner` is the EFFECTIVE owner (the
		 * same value `get` returns: an ownerless or orphaned job resolves
		 * to the primary admin). Two matching runs resolve to the newest
		 * `startedAt`.
		 */
		activeRun(
			conversationId: ConversationId,
		): Promise<
			{ readonly jobId: string; readonly owner: string | undefined } | undefined
		>;

		/**
		 * Whether the conversation's CURRENT run is job-driven (ask-user
		 * Task 3, spec §6): true when the session meta carries a `jobId`
		 * (a `conversation: "new"` run), or any input of the conversation's
		 * current run (`LiveDoc` `run.inputs`, present exactly while busy)
		 * resolves to a submission whose requestId carries the job prefix
		 * (`job:<fireKey>`, the prefix `jobs/fire.ts` stamps on both fire
		 * shapes). Interactive tools call this in execute and refuse with an
		 * error telling the model to escalate instead — the execute-time
		 * guard for the conversations the creation-time filter cannot reach
		 * (a job firing into an existing conversation; defence in depth
		 * should the filter ever miss).
		 */
		isJobRun(
			conversationId: ConversationId,
			context: HandlerContext,
		): Promise<boolean>;
	};

	/**
	 * Send one explicit notice through every registered notifier. Validation
	 * failures throw; once accepted, delivery is enqueued on the bounded side
	 * lane and this resolves without awaiting notifier completion.
	 */
	notify(input: ExtensionNoticeInput): Promise<void>;

	/**
	 * The per-user notices channel (notices spec §2): post, clear and list
	 * THIS extension's notices. `post` validates the input (fail-loud — a
	 * rejection throws `Error("<field>: <message>")` naming the offending
	 * field), checks the recipient exists and can see every conversation
	 * the notice names (`conversationId` and any `navigate` conversation
	 * target), and stores it. `clear` is owner-scoped: another extension's
	 * notice is never touched. `list` reads only this extension's notices
	 * for the user.
	 */
	readonly notices: {
		post(input: UserNoticeInput): Promise<{ id: string }>;
		clear(
			selector: { user: string; key: string } | { user: string; id: string },
		): Promise<void>;
		list(user: string): Promise<readonly UserNotice[]>;
	};

	/** The user directory (admin wire form; emails are admin material). */
	readonly users: {
		list(): Promise<readonly DirectoryUserWire[]>;
		get(user: string): Promise<DirectoryUserWire | undefined>;
	};

	/**
	 * External identities linked to directory users (multi-user §11.3): the
	 * one table for chat senders (`chat:<channel>`) and login subjects
	 * (`login:<slug>:<id>`), shared with the gateway.
	 *
	 * Core owns the file — extensions go through this surface, never
	 * `accounts.json` directly. One link per `(provider, subject)`: a
	 * re-link to the same user is a no-op returning the existing record, a
	 * link to a DIFFERENT user rejects with an `Error` whose message starts
	 * `account_link_conflict:` (the message never names the current
	 * holder — extensions match the prefix, as they do `command_not_found:`).
	 * An unknown user rejects `unknown user "<user>"`.
	 */
	readonly accounts: {
		lookup(
			provider: string,
			subject: string,
		): Promise<AccountLinkWire | undefined>;
		link(
			provider: string,
			subject: string,
			user: string,
			via: AccountLinkWire["via"],
		): Promise<AccountLinkWire>;
		unlink(provider: string, subject: string): Promise<boolean>;
		listForUser(user: string): Promise<readonly AccountLinkWire[]>;
	};

	/**
	 * Resolve one principal's access to one shared resource (the whole
	 * sharing contract for extension-owned records — core stores nothing
	 * for them).
	 */
	readonly access: {
		accessOf(
			principal: Principal | { readonly user: string },
			resource: { readonly owner?: string; readonly sharing?: Sharing },
		): Promise<Access>;
	};

	/** The conversation's owner — who the agent acts for. */
	readonly identity: {
		actingUser(conversationId: ConversationId): Promise<string | undefined>;
	};

	/**
	 * The served model catalog (gateway C4b): the SAME list `GET
	 * /v1/models` serves (picker entries — no provider internals), plus
	 * one-shot completions with NO conversation (warden Task 4 —
	 * skill-card generation is the first consumer).
	 */
	readonly models: {
		list(): Promise<readonly ModelEntry[]>;
		/**
		 * Run ONE one-shot completion and return its concatenated text
		 * parts (non-text parts skipped) plus the `provider/id` of the
		 * model actually used. Model resolution: `input.model` wins;
		 * else the live settings' `namingModel` when it is a string
		 * (`false` counts as unset — the utility role's binding); else
		 * the boot default model. THROWS (never resolves silently) on an
		 * unserved model (naming it), a timeout (default 60 000 ms), or
		 * a `stopReason` of `error`/`aborted`.
		 */
		complete(input: {
			readonly model?: string;
			readonly role?: "utility";
			readonly systemPrompt?: string;
			readonly prompt: string;
			readonly timeoutMs?: number;
			readonly signal?: AbortSignal;
		}): Promise<{ readonly text: string; readonly model: string }>;
	};

	/**
	 * Decision providers (warden Task 5 — the decision-providers spec):
	 * typed questions (noul / choice / score) answered over a JSON state.
	 * `evaluate` NEVER throws; failures arrive as the `ok: false` half of
	 * {@link DecisionResult}. Model resolution: `opts.model` wins; else
	 * the live `decisionModel` setting; else the first model of the
	 * first-registered decision provider.
	 */
	readonly decisions: {
		evaluate(
			request: DecisionRequest,
			opts?: { model?: string; signal?: AbortSignal; timeoutMs?: number },
		): Promise<DecisionResult>;
		/** Every decision model, with its provider's readiness status. */
		list(): Promise<readonly { model: string; provider: string; status: ProviderReadiness["status"] }[]>;
	};

	/**
	 * Embedding providers: vectorize texts through the configured model.
	 * `embed` NEVER throws; failures use {@link EmbeddingResult}. Model
	 * resolution: `opts.model` wins; else the live `embeddingModel`
	 * setting. There is no silent default when neither is configured.
	 */
	readonly embeddings: {
		embed(
			texts: readonly string[],
			opts?: {
				model?: string;
				confidentiality?: "normal" | "local-only";
				signal?: AbortSignal;
				timeoutMs?: number;
			},
		): Promise<EmbeddingResult>;
		/** Every embedding model, its locality and readiness. */
		list(): Promise<readonly {
			model: string;
			provider: string;
			dimensions: number;
			local: boolean;
			status: ProviderReadiness["status"];
		}[]>;
	};

	/**
	 * The slash-command surface (gateway C4b): the merged catalog for
	 * listing, and the invoke route's run for driving an extension
	 * command in-process (chat `/command` handling).
	 */
	readonly commands: {
		/** The merged catalog rows (core table + extension entries). */
		list(): Promise<readonly SlashCommand[]>;
		/**
		 * Run one EXTENSION command (the invoke route's resolution): an
		 * unknown/core name throws `command_not_found: <name>`; `opts.user`
		 * must name a directory user (absent → `unknown user "<user>"`) and
		 * becomes the run's principal with EFFECTIVE admin (the stored flag
		 * OR the persisted group grant) and `method: "host"`. A throwing
		 * run propagates (no HTTP 500 mapping — the caller is in-process).
		 */
		run(
			conversationId: ConversationId,
			name: string,
			args: string,
			opts: { readonly user: string },
		): Promise<{ readonly notice?: string }>;
	};

	/**
	 * The curation surface (curator P6, A9): the curator's read APIs
	 * (eligibility, hints, targets, tools, skills, overlays, usage, job
	 * references) and the run producers (fork review, digest, maintain).
	 * Binds lazily like every bridged member — a factory-body call WAITS
	 * for the bridge, never a silent drop.
	 */
	readonly curation: SigrunCurationHost;

	/**
	 * The published-hook surface (knowledge C7): look up a hook another
	 * extension published (`get` returns `undefined` while loading is
	 * still running and for unowned names) or call it through the core
	 * registry. `call` NEVER throws: an unowned name is `absent`, a
	 * payload the owner's schema rejects is `rejected`, and a provider
	 * failure is `failed` with a reason. A call issued before loading
	 * finishes waits for it — never `await` one inside a factory body
	 * (stash the host; call from a tool, handler, worker, or job).
	 */
	readonly publishedHooks: {
		get(name: string): { provider: string; input: TSchema; output?: TSchema } | undefined;
		call(
			name: string,
			payload: unknown,
			opts?: {
				user?: string;
				conversationId?: ConversationId;
				abortSignal?: AbortSignal;
			},
		): Promise<PublishedHookResult>;
	};
}

// ---------------------------------------------------------------------------
// The factory result
// ---------------------------------------------------------------------------

/**
 * The documented factory-result contract: EVERY field an extension may
 * return from its default-export factory. Every field is optional —
 * a minimal extension returns only `extension`; a contributor-only
 * result (`providers`/`webuiBundles`/`channels` without `extension`)
 * identifies itself by `name`.
 *
 * `routes`, `commands`, `skills`, and `notifiers` are declared here
 * ahead of their implementations (W5 Tasks 2, 3, 4, and 6); the loader
 * begins reading each when its task lands.
 */
export interface SigrunExtensionResult extends SigrunLifecycleHandlers {
	/** Long-lived per-user sibling processes, launched and supervised by core. */
	readonly userServices?: readonly UserService[];
	/** Declare the per-user tool surface (`host.tools.setUserTools`). */
	readonly perUserTools?: boolean;
	/** The pi-durable `Extension` to install; its declared name is the slug source. */
	readonly extension?: Extension;
	/** The contributor-only identity (required when contributing without an `extension`). */
	readonly name?: string;
	/** Provider contributions, merged into the boot model catalog (last-registered-wins, collisions recorded). */
	readonly providers?: readonly ProviderContribution[];
	/** Decision-provider contributions (warden Task 5); last-registered wins per id. */
	readonly decisionProviders?: readonly DecisionProviderContribution[];
	/** Embedding-provider contributions (embedding-providers Task 1); last-registered wins per id. */
	readonly embeddingProviders?: readonly EmbeddingProviderContribution[];
	/** External identity providers; core qualifies ids as `login:<slug>:<id>`. */
	readonly loginProviders?: readonly LoginProviderContribution[];
	/** Webui-bundle contributions; each `dir` anchors at the extension ENTRY's directory. */
	readonly webuiBundles?: readonly WebuiBundleContribution[];
	/** The surface's health producer, aggregated into `/v1/meta` `health` (any `"degraded"` degrades). */
	readonly health?: () => HealthStatus;
	/** Called once per settled run with the host-resolved input texts; deadline-bounded. */
	readonly runSettled?: ExtensionRunSettledHandler;
	/** Declared interaction kinds (the seam's write gate + capability inventory). */
	readonly interactionKinds?: readonly string[];
	/**
	 * Tool names this extension registers that need a human present
	 * (ask-user Task 3, spec §6). Validated at load like
	 * `interactionKinds` (each name must name a tool this extension's
	 * `extension.tools` registers; a bad declaration quarantines). Core
	 * hides the named tools in every non-interactive run (job run
	 * conversations, curator runs); in a job-fired EXISTING conversation
	 * the tool stays listed and must refuse at execute time — guard with
	 * `host.jobs.isJobRun`.
	 */
	readonly interactiveTools?: readonly string[];
	/** Declared ambient surface keys (the seam's write gate + capability inventory). */
	readonly ambientKinds?: readonly string[];
	/** Idle workers (the curator contract — `wakeOn` only, `every` retired). */
	readonly workers?: readonly ExtensionWorker[];
	/**
	 * Curation targets (the curator contract, spec P7): this extension's
	 * writable per-user surfaces the curator learns into. Every listed
	 * tool's outside-run calls become review hints (A8's wrapping); a
	 * target without `undo` fails the load.
	 */
	readonly curationTargets?: readonly CurationTarget[];
	/**
	 * Declared notice action handlers (notices Task 3): the names a posted
	 * notice's `extension` actions may name, keyed by handler name
	 * (`/^[A-Za-z][A-Za-z0-9-]{0,31}$/`). A malformed entry quarantines the
	 * extension at load.
	 */
	readonly noticeActions?: {
		readonly [name: string]: UserNoticeActionHandler;
	};
	/** Declared jobs (the only time-based scheduler); read-only through the API under `ext:<slug>:<name>` ids. */
	readonly jobs?: readonly JobSpec[];
	/** HTTP routes mounted at `/v1/ext/<slug>/<path>` (lands in Task 2). */
	readonly routes?: readonly ExtensionRouteContribution[];
	/** Slash commands merged into `/v1/commands` (lands in Task 3). */
	readonly commands?: readonly ExtensionCommandContribution[];
	/** Absolute skill directories contributed by this extension (lands in Task 4). */
	readonly skills?: readonly string[];
	/** Notification transports (lands in Task 6). */
	readonly notifiers?: readonly NotifierContribution[];
	/**
	 * Channel adapters (gateway C1, spec §7): one per chat platform. A
	 * `channels`-only result is a valid contributor identified by `name`;
	 * channel-id collisions across extensions quarantine the later
	 * loader (chat bindings are keyed by channel id — never last-wins).
	 */
	readonly channels?: readonly ChannelContribution[];
	/**
	 * The gateway engine (gateway C2, spec §8.0): ONE per boot — a second
	 * declarer quarantines at load naming the first. Always carried on a
	 * result WITH an `extension` (an engine owns pi-durable surface); a
	 * contributor-only `gateway` result is not a contract form. Report
	 * health through `gateway.health()`, never the `health` field.
	 */
	readonly gateway?: GatewayEngine;
	/** Declared surfaces — views and panels (UI-blocks U3, spec §7.1; the service lands in Task 2). */
	readonly surfaces?: SurfacesContribution;
	/**
	 * Published hooks (knowledge C7): named, schema-validated calls this
	 * extension offers OTHER extensions through `host.publishedHooks`.
	 * Core compiles each schema once at load; a malformed declaration
	 * (bad name, duplicate within the extension, non-object input,
	 * non-function `run`, a schema that fails to compile) quarantines
	 * the extension. The first configured provider of a name owns it;
	 * configured providers beat built-ins.
	 */
	readonly publishedHooks?: readonly PublishedHook[];
}

/**
 * A published hook (knowledge plan, Task 1): a named, schema-validated
 * call one extension publishes for OTHER extensions to invoke through
 * the core registry (the extension-to-extension seam). `name` must
 * match `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/` (at least one dot,
 * at most 128 chars). `run` receives the validated payload plus the
 * {@link PublishedHookCall} context and resolves with the result.
 */
export interface PublishedHook {
	readonly name: string;
	readonly description?: string;
	readonly input: TSchema;
	readonly output?: TSchema;
	run(payload: unknown, call: PublishedHookCall): Promise<unknown>;
}

/**
 * The call context a published hook's `run` sees: the calling extension's
 * name plus the resolved identity. `user` comes from the conversation's
 * acting user when a `conversationId` is given, else the caller's
 * declared user; a caller-declared user that disagrees with the
 * conversation owner is rejected before the provider ever runs.
 */
export interface PublishedHookCall {
	readonly caller: string;
	readonly user: string | undefined;
	readonly conversationId: ConversationId | undefined;
	readonly abortSignal: AbortSignal | undefined;
}

/**
 * The outcome of one registry call. `absent` — no provider owns the
 * name. `ok` — the provider ran and produced a valid result. `rejected`
 * — the call never ran (oversize/unstringifiable payload, schema
 * mismatch, or identity disagreement). `failed` — the provider ran (or
 * was interrupted) and could not deliver: `threw`, `timeout`, `aborted`,
 * `bad-output`, `too-large`, or `too-deep` (depth bound).
 */
export type PublishedHookResult =
	| { status: "absent" }
	| { status: "ok"; provider: string; value: unknown }
	| {
			status: "rejected";
			provider: string;
			errors: { path: string; message: string }[];
	  }
	| {
			status: "failed";
			provider: string;
			reason:
				| "threw"
				| "timeout"
				| "aborted"
				| "bad-output"
				| "too-large"
				| "too-deep";
			error: string;
	  };

/**
 * One extension's declaration of a published hook, in loader order.
 * `builtin` marks core-bundled extensions: when a configured extension
 * shadows a built-in the warning names replacing the built-in instead
 * of reordering the extension list.
 */
export interface PublishedHookDeclaration {
	readonly extension: string;
	readonly builtin: boolean;
	readonly hook: PublishedHook;
}

/**
 * The extension factory: sigrun calls it at load, passing the host
 * context. THE HOST RULE: the first parameter is the host, never a
 * defaulted options object — sigrun passes the host only when
 * `factory.length > 0`, so a factory that wants the host must DECLARE
 * the parameter (a length-0 factory may carry a defaulted first
 * parameter that would consume the host as a real dependency).
 */
export type SigrunExtensionFactory = (
	host: SigrunHost,
) => SigrunExtensionResult | Promise<SigrunExtensionResult>;
