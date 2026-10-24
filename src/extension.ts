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
import type {
	AmbientPlace,
	AmbientRecord,
} from "@sigrun/shared/ambient";
import type { Action, DataOps, IconName, Tree } from "@sigrun/shared/blocks";
import type { InteractionAnswer, InteractionRecord } from "@sigrun/shared/interactions";
import type { JobSpec } from "@sigrun/shared/jobs";
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
	readonly inputs: readonly SubmissionId[];
	/** Text blocks of each input's entry (`pi.user`, or an expanded input's
	 *  `sigrun.user.expanded` — the ADMITTED text), concatenated;
	 *  unresolvable/withdrawn → "" at that position. */
	readonly inputTexts: readonly string[];
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
	conversationCreated: { readonly conversationId: ConversationId };
	conversationForked: {
		readonly childId: ConversationId;
		readonly parentId: ConversationId;
		readonly at: EntryId;
	};
	conversationArchived: {
		readonly conversationId: ConversationId;
		readonly archived: boolean;
	};
	conversationIdle: {
		readonly conversationId: ConversationId;
		readonly idleMs: number;
	};
	/** Gateway C6: one terminal interaction transition — the payload mirrors
	 *  the record's terminal envelope fields. */
	interactionSettled: {
		readonly conversationId: ConversationId;
		readonly callId: string;
		readonly kind: string;
		readonly status: "answered" | "skipped" | "expired" | "cancelled";
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

/** A factory-result `harnessShutdown` handler (no event payload — shutdown is conversation-less). */
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
	onSettingsChanged?(keys: readonly string[]): void | Promise<void>;
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
	readonly method: "none" | "token" | "proxy" | "host";
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

/** One notification core delivers to every registered notifier (best-effort). */
export interface NotificationEvent {
	readonly type: "interaction.pending" | "job.failed" | "run.settled";
	readonly conversationId?: number;
	readonly jobId?: string;
	/** Gateway C6: the pending record's id — set on `interaction.pending` only
	 *  (read the record via `host.snapshotInteraction`). */
	readonly callId?: string;
	/** The recipient. */
	readonly user: string | undefined;
	readonly title: string;
	readonly body: string;
	/** `${server.publicUrl}/#/c/<conversationId>` when `server.publicUrl` is set; absent otherwise. */
	readonly url?: string;
}

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
				readonly navigate?: Extract<Action, { type: "navigate" }>;
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
	/** Channels refetch data on this interval while visible (min 5000). */
	readonly refreshMs?: number;
	/** §7.3; default: canonical JSON of params. */
	instanceKey?(params: JsonParams): string;
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
	/** Only admins see and edit it; default true (settings writes are admin-only). */
	readonly admin?: boolean;
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
	/** The scoped extension-stores handle (your secrets/settings sections + raw data/cache/state paths). */
	readonly stores: {
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
	/** Read one interaction record (the poll loop's read). */
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
			opts: { readonly model?: string; readonly thinking?: ThinkingLevelWire },
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
	 * /v1/models` serves (picker entries — no provider internals).
	 */
	readonly models: {
		list(): Promise<readonly ModelEntry[]>;
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
	/** The pi-durable `Extension` to install; its declared name is the slug source. */
	readonly extension?: Extension;
	/** The contributor-only identity (required when contributing without an `extension`). */
	readonly name?: string;
	/** Provider contributions, merged into the boot model catalog (last-registered-wins, collisions recorded). */
	readonly providers?: readonly ProviderContribution[];
	/** Webui-bundle contributions; each `dir` anchors at the extension ENTRY's directory. */
	readonly webuiBundles?: readonly WebuiBundleContribution[];
	/** The surface's health producer, aggregated into `/v1/meta` `health` (any `"degraded"` degrades). */
	readonly health?: () => HealthStatus;
	/** Called once per settled run with the host-resolved input texts; deadline-bounded. */
	readonly runSettled?: ExtensionRunSettledHandler;
	/** Declared interaction kinds (the seam's write gate + capability inventory). */
	readonly interactionKinds?: readonly string[];
	/** Declared ambient surface keys (the seam's write gate + capability inventory). */
	readonly ambientKinds?: readonly string[];
	/** Idle workers (the curator contract — `wakeOn` only, `every` retired). */
	readonly workers?: readonly ExtensionWorker[];
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
