# Sigrun gateway: chat channels as extensions

Status: draft for review, revision 2. Date: 2026-10-22.

Inputs:

- the gateway review of 2026-10-22: hermes-agent `gateway/` (adapter base
  class, `ADDING_A_PLATFORM.md`, session keys, pairing, delivery ledger,
  busy guards, streaming contract) and OpenClaw's channel SDK docs
  (`sdk-channel-plugins`, `-inbound`, `-ingress`, `-outbound`,
  `message-presentation`, `channel-routing`, `pairing`);
- the user rulings of 2026-10-22 (§3);
- the reviews: the builder check (folded into revision 1) and the
  deepseek-v4.1-flash review
  (`reviews/2026-10-22-gateway-review-deepseek.md`, folded into
  revision 2; finding ids like B2 or M7 refer to it);
- the existing seams this builds on: `host.conversations` (core-hardening
  spec §9.5), extension `routes`/`commands`/`notifiers`/`jobs`/lifecycle
  events (`docs/extending.md`), interaction records
  (`docs/approval-ux-seams.md`, `shared/src/interactions.ts`), the
  built-in mechanism (`src/harness/builtins.ts`), trusted-proxy auth
  (`src/server/auth/pipeline.ts`);
- the UI-blocks draft (`2026-10-19-sigrun-ui-blocks-design.md`), which
  this spec depends on for rich content (§14).

## 1. Intent

Hermes and OpenClaw both let you talk to the agent from Telegram, WhatsApp,
Signal, Discord, Slack and twenty-odd other chat platforms. Sigrun has the
in-process plumbing for that (`host.conversations` was built for "channel
bridges") but no shared layer, so every bridge author would rebuild access
control, routing, streaming, delivery, approvals and chat commands
themselves.

The gateway is that shared layer. Platform knowledge stays out of core and
out of the gateway: a WhatsApp adapter is a transport (connect, receive,
send) and nothing else. Everything both prior-art projects rebuilt per
platform is built once here.

Success: a new adapter is a few hundred lines of transport code against a
typed contract; the user can message sigrun from a phone, approve a tool
call with a button tap, and receive a nightly job's output in a chat.

## 2. Goals, non-goals, anti-goals

**Goals**

- A typed channel-adapter contract in `@sigrun/sigrun/extension`.
- A gateway engine shipped as the fourth built-in extension,
  `@sigrun/ext-gateway`, fully disabled by `builtinExtensions.gateway:
  false` and replaceable like the other built-ins.
- Access control: static allowlists, pairing-approval requests, and
  self-linking.
- One conversation per chat; `/new` starts a fresh one.
- Groups in two modes: linked members only, or anyone under a fixed tool
  set (§8.2).
- Streaming replies, chunking, formatting, durable delivery.
- Interaction records (approvals, questions) answerable from chat.
- Chat commands (`/new`, `/stop`, `/model`, ...).
- Job output delivered to chats (cron-to-adapter).
- An agent `send_message` tool.
- The core seams the above needs (§6).

**Non-goals (v1)**

- Multi-agent routing, broadcast groups, ACP bindings (OpenClaw): sigrun
  routes a chat to a conversation, never to one of several agents.
- Multi-profile multiplexing, relay transports, hosted rooms,
  scale-to-zero (Hermes).
- Speech-to-text and text-to-speech. They come as their own core
  contribution fields (`transcribers`, `speakers`), the same pattern as
  `channels`.
- Reactions, polls, pins, message effects.
- Enumerating a platform's chats. The chat directory is chats the gateway
  has already seen.
- Creating jobs from chat.
- More than one account per channel (the binding key reserves the slot,
  §8.3).
- An OpenAI-compatible API server and a generic inbound-webhook adapter.
  Extension `routes` plus jobs already cover webhook-to-prompt.
- A webui settings section for the gateway. It waits on
  extension-extensible settings sections (deferred 2026-10-15).
- Rendering arbitrary UI-block trees in chat before UI blocks land (§14).
- A generic long-running `services` lifecycle for non-channel
  extensions.
- An `open` DM policy (anyone may DM the bot).
- Self-linking started from the chat side (ruling 6).

**Anti-goals** (failure even if everything else works)

- An unknown DM sender's text reaching the model.
- An unlinked group member's message reaching a conversation that has the
  owner's full tool set.
- A final reply lost without a ledger state and a log line.
- An adapter implementing policy (access, routing, chunking, busy
  handling, command parsing). If an adapter has to, the contract is wrong.
- Core growing platform knowledge.

## 3. User rulings (2026-10-22)

1. **Packaging: approach A** (§4). Core reads a `channels` factory-result
   field; the gateway engine is a built-in that consumes it.
2. **One conversation per chat** (the Hermes direction), not one shared
   main conversation per user.
3. **Both access paths**: static allowlists and approval requests
   (pairing).
4. **Cron-to-adapter is in scope**: job output reaches chats. Answers in a
   conversation bound to a chat are delivered to that chat whoever
   started the run (webui, job, chat).
5. **Groups (M3): both modes in v1.** By default only linked users drive
   a group's conversation. A group may instead admit anyone, in which
   case the conversation runs with a configured tool whitelist and sees
   only its own group's context.
6. **Self-linking is one-directional:** the code is issued by sigrun and
   sent to the bot from the chat. No chat-initiated variant.
7. **Forward-auth users are directory users (M14).** A user who signs in
   through the trusted proxy (Authelia) gets a directory record. This is
   already the behavior (`autoProvision`, default `true`); the gateway
   relies on it (§8.2, C8).

## 4. Approaches

| | How | Trade-off |
|---|---|---|
| **A (picked)** | Adapters return `channels: [...]`. Core validates and collects them and hands them to the one loaded gateway engine through a `gateway` factory-result field. | Same shape as `providers`/`notifiers`: core validates at load, quarantines malformed declarations, lists them in `/v1/extensions`, and handles built-in replacement. Adapters depend only on core types. |
| B | A general registry: the gateway provides `gateway@1`, adapters `require` it and fetch it via `host.services.get()`. | Reusable for optional dependencies between extensions, but a bigger loader change. Core can't validate what crosses the seam, and versioning becomes a convention between packages. No second concrete case exists today. |
| C | Gateway inside core (`src/gateway/`), toggled by a setting. | Least wiring, but not replaceable as a package. It grows core and isn't the bundled extension asked for. |

A doesn't preclude B. If a second real cross-extension case appears,
B can be added and `channels` re-expressed on top of it.

## 5. Shape

Three layers:

```
adapter extensions          sigrun-channel-telegram, -whatsapp, ...   (separate repos)
   │ channels: ChannelContribution[]        transport only
   ▼
core (sigrun)               validates + collects channels; starts/stops the one engine;
   │                        host APIs the engine drives (§6)
   ▼ gateway: GatewayEngine
gateway engine              @sigrun/ext-gateway (built-in #4, repo sigrun-ext-gateway)
                            access, routing, bindings, streaming, delivery,
                            interactions, chat commands, jobs delivery, tools
```

- Repos follow the 2026-10-06 ruling: the engine lives in its own repo,
  `sigrun-ext-gateway`. It's a core `dependency` like the other three
  built-ins.
- Adapters are separate packages named `sigrun-channel-<platform>`.
- The reference adapter is `sigrun-channel-telegram`, written after the
  engine, out of this spec's scope. It's the simplest platform that
  exercises every capability: edits, buttons, command menus, media,
  threads.

## 6. Core changes

Each change lands in the sigrun repo.

### C1. `channels` contribution field

`SigrunExtensionResult.channels?: readonly ChannelContribution[]` (types in
§7).

- **Load-time validation:** `id` matches `^[a-z][a-z0-9-]*$`; `label` is a
  non-empty string; `capabilities` passes the §7 shape check;
  `configured`, `start` and `send` are functions; optional members are
  functions when present.
- A malformed entry quarantines the extension. This is the existing rule:
  a package that thinks it declared something must never silently lose
  it.
- **Id collisions quarantine the later extension**, naming both. This
  deliberately differs from the last-registered-wins rule for
  commands/bundles: chat bindings are keyed by channel id, so a shadowing
  adapter would inherit another adapter's chats.
- A contributor-only result (`channels` without `extension`) is valid and
  identifies itself by `name`, as with `providers`.
- `/v1/extensions` rows list the channel ids an extension contributes.

### C2. `gateway` engine field

```ts
interface GatewayEngine {
  start(ctx: GatewayEngineContext): Promise<void>;
  /** Stop accepting inbound events. Deliveries keep flowing. */
  stopIntake(): Promise<void>;
  /** Drain pending deliveries (bounded by the engine, 10 s), then stop adapters. */
  stop(): Promise<void>;
  /** Synchronous read over engine state; never network, never storage. */
  health(): "ok" | "degraded";
}
interface GatewayEngineContext {
  /** Every loaded channel contribution, with its contributing extension's slug. */
  readonly channels: readonly { readonly extension: string; readonly channel: ChannelContribution }[];
  readonly signal: AbortSignal;
}
```

- **At most one engine loads.** A second extension declaring `gateway` is
  quarantined, naming both. The built-in counts as a declarer unless it
  was replaced (C3) or disabled, so a differently-named engine needs
  `builtinExtensions.gateway: false`.
- **Start:** core calls `start` once, after `app.listen`, so adapter
  webhook routes are live. The engine owns its own supervision; a
  rejected `start` is logged and makes `health.gateway` `degraded`. It
  never aborts boot.
- **Shutdown ordering (M5)**, in `src/serve.ts`'s `shutdown()`:
  1. `app.sse.endAll()` and `app.close()` (as today);
  2. `engine.stopIntake()`;
  3. `eventBus.shutdownSequence()` (as today: workers stop, pending
     settles drain to `runSettled`, `harnessShutdown` runs);
  4. `engine.stop()`;
  5. the provider-refresh stop and `harness.close()` (as today).

  So a run that settles during shutdown still reaches the engine's
  delivery queue, and the harness is open while the queue drains.
- **Health (M1):** `/v1/meta` `health` gains `gateway: "ok" | "degraded"`,
  present only when an engine is loaded, read from `engine.health()`.
  The engine's factory result must not use the generic `health` field,
  which core folds into `health.providers`.
- **No engine** (gateway disabled and not replaced) with channel
  contributions present: one boot warning, `/v1/extensions` marks those
  rows `inert: "no gateway"`, and the adapters load but nothing calls
  them.

### C3. Built-in #4

- `BUILTIN_EXTENSIONS` gains
  `{ key: "gateway", specifier: "@sigrun/ext-gateway", slug: "gateway" }`.
- `builtinExtensions.gateway` defaults to `true` and is restart-required.
  The settings validator's key list (`src/harness/settings.ts`) and
  `BuiltinExtensionsSettings` (`shared/src/settings.ts`) both widen.
- Replacement and quarantine behave exactly as for the other built-ins
  (Rulings 5–7 in `builtins.ts`): a configured extension whose package
  name is `@sigrun/ext-gateway` replaces the built-in and keeps the
  `gateway` slug, so it inherits the gateway's state directory.

### C4. Host conversation, model and command APIs

These are new host methods. Today the host bridge (`src/server/host-bridge.ts`)
exposes only `create/submit/watch/list/meta`, and the operations below exist
only as HTTP routes. The engine's chat commands (§8.5) run through them.

```ts
// host.conversations — additions
abort(id): Promise<void>;
configure(id, opts: { model?: string; thinking?: ThinkingLevelWire }): Promise<void>;
compact(id): Promise<void>;
fork(id, opts?: { at?: EntryId; owner?: string }): Promise<ConversationId>;
patchMeta(id, patch: { name?: string | null; archived?: boolean; sharing?: Sharing | null }): Promise<SessionMeta>;
upload(id, file: { name: string; mime?: string; bytes: Uint8Array }): Promise<{ path: string }>;
readFile(id, path: string): Promise<{ bytes: Uint8Array; mime?: string }>;

// host.conversations.create — widened options
create(opts: {
  owner?: string; sharing?: Sharing; name?: string; source?: string;
  /** Pins the conversation's extension and tool filter (pi-durable AgentChange). */
  agent?: { readonly extensions?: readonly string[]; readonly tools?: readonly string[] };
}): Promise<ConversationId>;

// host.models
readonly models: { list(): Promise<readonly ModelRefWire[]> };

// host.commands
readonly commands: {
  list(): Promise<readonly SlashCommand[]>;
  run(conversationId, name, args: string, opts: { user: string }): Promise<{ notice?: string }>;
};
```

- Each conversation method runs the same op as its HTTP route
  (`conversation-ops.ts` style) and throws the same typed errors.
- `create` with `sharing` already exists in `createConversationOp`; the
  host surface gains the field. `agent` maps onto pi-durable's
  `AgentChange.extensions` / `.tools` arrays, which select exactly those
  names. Unknown names fail loud with `ConversationOpError`.
- `upload` returns the workspace-relative path that `submit` parts accept.
- `readFile` applies the files route's confinement and the
  `server.maxFileReadBytes` cap (16 MiB default).
- `models.list` returns the served catalog, the same list as `GET
  /v1/models` (B1).
- **`commands.run` principal (M11):** core builds it from the directory:
  `{ user, name, email, admin: <effective admin, C8>, service: false,
  method: "host" }`. `Principal.method` widens with `"host"` in both
  `src/extension.ts` and `shared/src/views.ts`. A `user` not in the
  directory throws.
- `submit` is unchanged: it already runs `submitOp`, including the
  served-model check.

### C5. Interaction answer attribution

`host.answerInteraction(conversationId, callId, answer, context, opts?: {
user?: string })`. With `user`, the record stamps `answeredBy: "human"` and
`answeredByUser: user`; without it, behavior is unchanged. Access checks
stay the caller's job (host code is trusted). The engine checks write
access before calling (§8.7).

### C6. Interaction events for extensions

- `NotificationEvent` gains `callId?: string`, set on
  `interaction.pending`, so a notifier can read the record via
  `host.snapshotInteraction`.
- **New lifecycle handler (B2):** `interactionSettled?(payload, api,
  context)` with payload `{ conversationId, callId, kind, status }`. It is
  fed from the event bus's existing `interaction.settled` host event
  (`src/harness/event-bus.ts`), deadline-bounded like the other lifecycle
  handlers, and fires for every terminal transition from any writer.

### C7. Job delivery targets

- `JobAction` (`kind: "prompt"`) gains `deliver?: string[]`: 1–8 strings,
  each 1–256 chars.
- **Only valid with `conversation: "new"` (B3).** A `deliver` on a job
  targeting an existing conversation fails validation with field
  `action.deliver`. Delivering into an existing conversation's chats
  needs no field: a conversation bound to a chat already delivers there
  (§8.8, path 1).
- **Core validates shape only;** the target grammar belongs to the
  gateway (§8.8).
- `fire.ts` stamps it into the run conversation's `SessionMeta` as
  `deliver`. `SessionMeta` declares both `deliver?: string[]` and the
  existing `jobId?: string` (written today through a cast). Both are
  server-owned and rejected by the meta PATCH route, like `autoName`.
- It's part of `specHash`, so editing targets is a job revision.
- A run whose job has `deliver` while no engine is loaded logs one warning
  per run ("deliver targets ignored: no gateway").

### C8. Effective admin for host-side checks

Trusted-proxy auth computes group-derived admin per request
(`groupAdmin` from `adminGroups`, `pipeline.ts`) and never stores it, so
the directory record of an Authelia `admins`-group user says `admin:
false`. Host-side code (chat commands, `/pair`) has no request headers,
so it would see that user as a non-admin.

- On every proxy-authenticated request, core writes the computed
  `groupAdmin` onto the directory record when it differs from the stored
  value.
- `DirectoryUserWire` and `host.users.get/list` expose
  `admin: record.admin || record.groupAdmin`.
- Removal from the admin group takes effect for host-side checks at that
  user's next web request. The docs state this lag.

With `adminGroups` empty (the default), no group grants admin and C8 is
inactive: admin is the stored directory flag alone, which the first user
receives when claiming setup (`src/server/routes/onboarding.ts`) and later
admins receive by grant.

Rulings 7 and C8 together mean every person who can use sigrun is a
directory user, with the same admin answer on the web and in chat.

## 7. Adapter contract

The types live in `@sigrun/sigrun/extension` (types-only, like the rest
of the contract):

```ts
interface ChannelContribution {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ChannelCapabilities;
  /** Whether credentials/config are present. Unconfigured adapters are never started. */
  configured(): ChannelReadiness | Promise<ChannelReadiness>;
  /**
   * Connect and begin receiving. Resolves once connected; any receive loop keeps
   * running until ctx.signal aborts. Post-connect failures go through ctx.fail so
   * the engine's supervisor owns restarts (adapters never self-reconnect forever).
   */
  start(ctx: ChannelContext): Promise<void>;
  stop?(): Promise<void>;
  send(message: OutboundMessage): Promise<SendReceipt>;
  edit?(ref: MessageRef, message: OutboundMessage): Promise<void>;
  delete?(ref: MessageRef): Promise<void>;
  typing?(chat: ChatRef): Promise<void>;
  setCommands?(commands: readonly { name: string; description: string }[]): Promise<void>;
  /** Markdown → the platform's native markup. Required when capabilities.format is "native". */
  format?(markdown: string): string;
  /** Without it every send error is "transient". */
  classifyError?(error: unknown): "transient" | "permanent" | "chat_gone";
}

type ChannelReadiness = { status: "not_configured" | "ready"; detail?: string };

interface ChannelCapabilities {
  readonly chatTypes: readonly ("dm" | "group" | "thread")[];
  readonly maxMessageLength: number;
  readonly format: "plain" | "markdown" | "native";
  /** Edit-in-place streaming; minIntervalMs is the platform's safe edit rate. */
  readonly edit?: { readonly minIntervalMs: number };
  /** labelMax bounds button text; the engine truncates, never the adapter. */
  readonly buttons?: { readonly max: number; readonly perRow?: number; readonly labelMax?: number };
  readonly media?: readonly ("image" | "audio" | "video" | "document")[];
  readonly typing?: { readonly intervalMs: number };
  readonly replyTo?: boolean;
  readonly commandMenu?: boolean;
  /** One short paragraph for the prompt: what renders, what doesn't. */
  readonly promptHint?: string;
}

interface ChannelContext {
  readonly signal: AbortSignal;
  /**
   * Resolves once the event is durably admitted, handled as a command, or
   * deliberately dropped: the adapter acks the platform on any resolution.
   * A rejection means the engine failed; the adapter does not ack, the
   * platform redelivers, and dedupe (§8.4) makes the retry safe.
   */
  receive(event: InboundEvent): Promise<{ outcome: "admitted" | "dropped" | "command" }>;
  /** A button tap. `data` is the opaque token the engine put on the button. */
  action(event: ActionEvent): Promise<void>;
  status(state: { state: "connecting" | "running"; detail?: string }): void;
  fail(error: unknown): void;
  readonly log: { info(msg: string): void; warn(msg: string): void; error(msg: string, error?: unknown): void };
}

interface ChatRef { readonly chatId: string; readonly chatType: "dm" | "group" | "thread"; readonly threadId?: string }
interface MessageRef { readonly chat: ChatRef; readonly messageId: string }

interface InboundEvent {
  readonly messageId: string;
  readonly chat: ChatRef & { readonly title?: string };
  readonly sender: { readonly id: string; readonly name?: string; readonly isBot?: boolean };
  /** The bot's own message echoed back; the engine drops it. */
  readonly fromSelf?: boolean;
  readonly text: string;
  /** Group messages: the bot was @-mentioned or replied to. */
  readonly mentioned?: boolean;
  readonly replyTo?: { readonly messageId: string; readonly text?: string; readonly authorName?: string; readonly fromSelf?: boolean };
  readonly attachments?: readonly InboundAttachment[];
  /** Platform album/batch id (e.g. a media group); events sharing it merge into one submission. */
  readonly groupId?: string;
}

interface InboundAttachment {
  readonly kind: "image" | "audio" | "voice" | "video" | "document" | "sticker";
  readonly mime?: string;
  readonly filename?: string;
  readonly size?: number;
  /**
   * Lazy so unwanted media is never downloaded. The adapter stops reading
   * and throws AttachmentTooLarge once maxBytes is exceeded, so an
   * undeclared-size file is never fully downloaded either.
   */
  fetch(opts: { maxBytes: number; signal: AbortSignal }): Promise<Uint8Array>;
}

interface ActionEvent {
  readonly chat: ChatRef;
  readonly sender: { readonly id: string; readonly name?: string };
  readonly message?: MessageRef;
  readonly data: string;
}

interface OutboundMessage {
  readonly chat: ChatRef;
  /** Already formatted per capabilities.format and within maxMessageLength. */
  readonly text: string;
  readonly replyTo?: string;
  readonly buttons?: readonly (readonly { label: string; data: string; style?: "primary" | "danger" | "neutral" }[])[];
  readonly files?: readonly { name: string; mime?: string; bytes: Uint8Array }[];
}

interface SendReceipt { readonly messageIds: readonly string[] }
```

`AttachmentTooLarge` is a named error class exported by value from a
small runtime subpath, `@sigrun/sigrun/extension-runtime`, which core links
into the packages dir like the other host modules. The engine matches it by
`name`, never `instanceof`.

Rules for adapter authors:

- **Webhook transports** declare their own `routes` (mounted at
  `/v1/ext/<adapter-slug>/...`, `auth: "public"`, the adapter verifies
  signatures) and hand events to the `ChannelContext` captured in
  `start`. A webhook arriving before `start` or after `stop` answers
  `503`.
- **Socket/poll transports** run their loop from `start`, never from
  the factory body (the pi lifecycle lesson).
- **Credentials come from the adapter's own host stores.** The adapter
  resolves stored-then-env itself: `host.stores.secrets.get(key)`, else
  `SIGRUN_EXT_<SLUG>_<KEY>` from `process.env`, per `docs/extending.md`.
  The engine never sees credentials.
- **Button `data` is an engine-issued token of at most 64 bytes**
  (Telegram's callback limit, the tightest seen). Adapters pass it
  through and never interpret it.
- **Login flows** (WhatsApp QR, Signal linking) are adapter-owned, via the
  adapter's own admin routes. The engine has no login abstraction in v1.

## 8. Gateway engine

### 8.0 Package shape

`@sigrun/ext-gateway`'s default export is one factory (it declares the
host parameter). It returns ONE `SigrunExtensionResult` carrying:

| field | for |
|---|---|
| `extension` | the pi-durable extension, declared name `gateway` (slug `gateway`), with the `gateway-channel` section (§8.10) and the `send_message`/`list_chats` tools (§8.9) |
| `gateway` | the C2 engine: supervision, inbound pipeline, delivery queue, health (§8.4–§8.6, §8.12) |
| `runSettled` | enqueues answer deliveries for bound chats and `deliver` targets (§8.6, §8.8) |
| `interactionSettled` | edits delivered prompts to show the outcome (§8.7) |
| `notifiers` | `interaction.pending` rendering and home-chat notifications (§8.7, §8.8) |
| `commands` | `/pair` and `/link` for webui/TUI (§8.2) |
| `routes` | `GET status` (§8.12) |
| `userDeleted` | link and home-chat cleanup (§8.2) |

Each surface has exactly one job, so nothing is delivered twice:

- **`runSettled`** (fires for every settled run) enqueues answers for
  bound conversations and for conversations whose meta carries `deliver`.
- **The notifier** handles `interaction.pending` everywhere, plus
  `run.settled` and `job.failed` for conversations that are NOT bound.
  It skips `run.settled` for bound conversations, which `runSettled`
  already handled. Bound chats never get a "Reply ready" notice on top
  of the answer, even when the webui is closed.
- **Handlers only enqueue (M6).** `runSettled`, `interactionSettled` and
  the notifier write a ledger entry and return; the engine's delivery
  worker does the platform I/O. No handler ever outlives
  `SIGRUN_HOOK_DEADLINE`.

`/pair` and `/link` have one implementation each. The webui/TUI command
and the chat command (§8.5) call the same function with the resolved user.

**State** lives in the engine's own scoped directory,
`host.stores.paths.state` (= `<stateDir>/gateway/`). Core ensures only the
root, so the engine creates that directory at `start`. Core never reads
or writes gateway state.

**The live-text read** (§8.6) uses `docs["pi.live"]`, the same upstream
live-state layout the webui reads (`webui/src/entries/liveDoc.ts`).
My call: move that narrowing into `@sigrun/shared` so the webui and the
engine share one hand-mirror. The schema fixture already pins the
upstream shape, so pi-durable drift fails there first, for both.

### 8.1 Configuration

`settings/gateway.json`, through the engine's scoped settings store:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "dm": "pairing",
      "selfLink": true,
      "allow": [{ "sender": "100000001", "user": "alice" }],
      "groups": [
        { "chat": "-100000000002", "owner": "alice", "mention": "required", "members": "linked" },
        {
          "chat": "-100000000003", "owner": "alice", "mention": "required", "members": "anyone",
          "tools": ["web_search", "web_fetch"]
        }
      ],
      "busy": "followUp",
      "stream": true,
      "allowBots": false
    }
  },
  "media": { "maxBytes": 16777216 },
  "notify": { "home": true }
}
```

- A channel absent from `channels` is disabled.
- `enabled` is restart-required. Every other field is read per event
  (live), except a group's `tools`/`extensions`, which apply when the
  group's conversation is created (§8.3).
- `dm`: `"pairing" | "allowlist" | "disabled"`.
- `selfLink`: boolean. Default `true` for `pairing` channels, `false`
  otherwise (my call: an allowlist channel's operator chose a closed
  list).
- `busy`: `"followUp" | "steer"`.
- `mention`: `"required"` (only `mentioned` events are admitted) or
  `"always"` (every message from an admitted sender is admitted).
- `members`: `"linked"` (default) or `"anyone"`. `"anyone"` requires a
  non-empty `tools` array; `extensions` is optional (§8.2).
- `media.maxBytes` defaults to 16 MiB, the `readFile` cap.
- Malformed config for one channel or group disables that channel or
  group with a status `failed` and the reason. Others are unaffected.

### 8.2 Identity and access

Every DM sender the engine acts for maps to a sigrun directory user. The
mapping comes from three sources, in precedence order:

1. **Static allowlist** (`allow[]`): `{sender, user}`.
2. **Links** from approved pairing requests or self-linking, kept in
   core's account-link table through `host.accounts` (provider
   `chat:<channel>`; multi-user spec §11.3, plan M3a). The engine keeps
   only home chats, in `<stateDir>/gateway/homes.json` (mode 0600). A
   self-link or pairing approval for a sender already linked to another
   user is refused, never silently re-pointed.
3. **Nothing:** the sender is unknown.

If the allowlist and a link disagree, the allowlist wins and the conflict
is logged once.

**Before setup is claimed** (an empty directory, `isClaimed()` false), every
channel drops every inbound event with one log line per channel. Ruling 7
means a claimed deployment always has at least one user. On the no-auth
loopback method a webui caller may carry no user; `/link` and `/pair`
refuse that caller with "run this as a named user".

Users who sign in through forward auth exist in the directory only after
their first web request. `/pair approve <code> <user>` names an existing
directory user, so a user who has never opened the webui must do so once
(or be invited) before being paired.

**DMs from unknown senders, by `dm` policy:**

- `disabled`: drop silently.
- `allowlist`: drop and log once per sender per day.
- `pairing`: create a pairing request.

Self-linking (`/link <code>`, below) is handled before this check when the
channel's `selfLink` is on (§8.4).

Pairing requests, with Hermes/OpenClaw's shared parameters:

- **The code** is 8 characters from a 32-character unambiguous alphabet,
  via `crypto.randomInt`, and expires after 1 hour.
- **Limits:** at most 1 pending request per sender, created at most once
  per 10 minutes, and at most 3 pending per channel. A sender over a limit
  gets no reply; the drop is logged. A full channel queue is a visible
  denial of service for new senders; the status route (§8.12) shows the
  queue so an admin can clear it. Codes are never logged.
- **The sender** gets one reply with the code and a "waiting for
  approval" line. Their message is not processed, then or after
  approval.
- **Approving from sigrun:** the extension command `/pair`, admin only
  (effective admin, C8), usable in any webui/TUI conversation:
  - `/pair` lists pending requests;
  - `/pair approve <code> <user>` maps the sender to an existing
    directory user;
  - `/pair deny <code>` rejects the request.
- **Approving from chat:** each admin's home chats (§8.8, always DMs) get
  the request as text with the same commands. When the channel has
  buttons and the directory has at most `buttons.max - 1` users, it also
  gets one "Approve as <user>" button per user plus a Deny button.

There is no wrong-code lockout: only admins can submit codes, and codes
only ever go to the requesting sender and to admins' DMs.

**Self-linking** (ruling 6) connects a chat account to a sigrun user with
no admin involved. It is how the first admin connects.

1. `/link <channel>` in the webui/TUI returns a single-use code (same
   alphabet and expiry), bound to the invoking user and that channel.
2. The user sends `/link <code>` to the bot, in a DM.
3. That sender is linked to the user, and the bot replies with the
   sigrun username it linked to.

It is proof by holding both sessions. `/link <code>` in a group is refused
with "send this in a direct message" and the code is invalidated, since
other members saw it (M9). Self-linking from the chat side (sending a
username to the bot) is out of scope: it is the phishable direction of the
device-code pattern (RFC 8628 §5.4).

**Groups:**

- Only groups listed in `groups[]` are served; others are ignored and
  logged once.
- A group's conversation is owned by its configured `owner`, and the model
  acts as that owner (`host.identity.actingUser`).
- `mention` gates admission (§8.1).
- **`members: "linked"` (default):** only senders linked to a sigrun user
  are admitted. Others' messages are dropped (logged once per sender per
  day). pi-durable has no way to add a message as context without
  starting a run, so the agent never sees unlinked members' messages,
  except text a linked member quotes in a reply.
- **`members: "anyone"`:** every member's message is admitted. The
  group's conversation is created with the group's `tools` and optional
  `extensions` as its fixed filter (C4 `create.agent`), so every run in it
  uses exactly that set, whoever wrote the message. Tools outside the list,
  including file access, memory recall and other conversations' context,
  are unavailable to that conversation.
- **Sharing (M10):** in both modes the engine adds each linked user who
  speaks in the group to the conversation's sharing (`scope: "people"`,
  level `write`) through `patchMeta`, so core's `accessOf` agrees with the
  gateway (my call). Removing a member from the platform group doesn't
  remove the share; the group's owner manages it in the webui.
- **Control:** only linked users with write access run chat commands,
  answer interactions, or `/attach`. Unlinked members never control
  anything, in either mode.

**Bots and loops:**

- Events with `fromSelf` are dropped.
- `sender.isBot` is dropped unless `allowBots`.
- Admitted bot messages are capped at 10 per chat per 60 s, then a
  5-minute cooldown (Hermes's loop guard).

**Deleted users:** on `userDeleted`, the engine removes the deleted user's
links and home chats. Core already transfers conversation ownership.

### 8.3 Routing and bindings

- **Binding key:** `<channel>:<account>:<chatType>:<chatId>[:<threadId>]`.
  `account` is always `default` in v1; it reserves the multi-account slot
  so keys never need migrating.
- DMs bind per chat. Groups bind per group, shared by all members; threads
  per thread.
- **The binding store** (`<stateDir>/gateway/bindings.json`) maps key →
  `{conversationId, boundAt, previous: ConversationId[]}`, with a reverse
  index conversationId → keys. A conversation may be bound to several
  chats (via `/attach`); delivery fans out to all of them.
- **Creation:** the first admitted message in an unbound chat creates a
  conversation through `host.conversations.create`, with:
  - `owner` = the mapped user (the group's `owner` for groups);
  - `source: "gateway"`;
  - `name` = the chat title, or `"<Label> DM"` for DMs;
  - for `members: "anyone"` groups, `agent: { tools, extensions }`.
- **`/new`** creates a fresh conversation the same way and rebinds the
  chat. The old conversation is untouched (not archived) and listed in
  `previous`.
- **`/attach <id>`** binds the chat to an existing conversation the linked
  user has write access to (`host.access.accessOf`). This is how a webui
  conversation continues from a phone. `/attach` is refused in
  `members: "anyone"` groups, since it would swap the restricted
  conversation for one with the full tool set.
- A conversation archived in the webui stays bound. A new message
  unarchives it via `patchMeta` (my call: archiving shouldn't silently
  break a chat).

### 8.4 Inbound pipeline

For each `receive(event)`, in order:

1. **Claimed gate:** drop if setup is unclaimed (§8.2).
2. **Dedupe** on `(channel, account, chatId, messageId)` against a
   24-hour seen set persisted in state, so platform redelivery after a
   restart is a no-op.
3. **Drop** self and bot events (§8.2).
4. **Self-link:** `/link <code>` when the channel's `selfLink` is on
   (§8.2). Handled here, before access, and resolves `"command"`.
5. **Access** (§8.2). An unknown DM gets a pairing reply (or nothing); an
   unlisted group is ignored; an unlinked sender in a `linked` group is
   dropped.
6. **Merge albums:** events with the same `groupId` that arrive within
   1.5 s merge into one submission. There's no time-based burst merging
   otherwise (my call: no added latency on every message).
7. **Commands:** if the text is a gateway chat command, it's handled
   inline (§8.5), bypassing the busy queue.
8. **Interaction text answers** (§8.7).
9. **Attachments** (§8.11).
10. **Submit:** `host.conversations.submit` with the envelope text (§8.10)
    plus the attachment parts:
    - `user` = the mapped user, or the group owner for unlinked senders in
      `anyone` groups;
    - `requestId` = the binding key plus `messageId` (idempotent across a
      crash between admit and seen-set write);
    - `whenBusy` = the channel's `busy` setting.

**Outcomes:**

- `"admitted"` once `submit` returns (admission is durable).
- **Submit errors (M12):** `UnservedModelError` replies "The model <ref> is
  not available. Use /model to pick another."; any other
  `ConversationOpError` replies with a short notice and logs the error
  code. Both resolve `"dropped"`. Any other throw rejects `receive`
  (engine failure; the platform redelivers).

### 8.5 Chat commands

Gateway commands, reserved in chat:

| Command | Does | Where |
|---|---|---|
| `/new` | fresh conversation, rebind (§8.3) | any |
| `/stop` | `abort` the live run | any |
| `/model [ref]` | no arg: show current and list `host.models.list()`; with arg: `configure` | any |
| `/thinking [level]` | same pattern, `configure` | any |
| `/compact` | `compact` | any |
| `/attach <id>` | bind to an existing conversation | not in `anyone` groups |
| `/status` | conversation name, model, busy/queued, bound conversation id | any |
| `/home` | make this DM the sender's home chat for this channel (§8.8) | DM only (M8) |
| `/link <code>` | self-linking (§8.2) | DM only |
| `/pair ...` | pairing admin | DM only, effective admins |
| `/help` | lists the above plus extension commands | any |

- **Extension commands** (`host.commands.list()`) run through
  `host.commands.run` with the mapped user. Their `notice` is sent as the
  reply.
- **Anything else starting with `/`** is submitted as text, so prompt
  templates and `/skill:` expansion work through the normal admission
  path.
- **Who may run commands:** the linked user needs write access to the
  bound conversation. `/link` needs no link; `/pair` needs effective
  admin.
- A command used where the table forbids it gets a one-line refusal.
- **Native command menus:** when `capabilities.commandMenu`, the engine
  calls `setCommands` at start with the merged list. Extension commands
  whose names collide with gateway commands are omitted in chat.

### 8.6 Outbound

**Which runs deliver:**

- Every settled run in a bound conversation delivers to every chat bound
  to it, whoever started the run (ruling 4).
- **Chat-originated runs** (the engine saw the admission) stream to the
  originating chat. All other bound chats get the final answer only.
- **Runs started elsewhere** (webui, a job targeting the conversation)
  deliver final-only. The engine learns of them from `runSettled`.

**Access re-check (M7):** before each delivery to a bound chat, the engine
re-reads `host.conversations.meta` and checks the chat's user still has at
least read access (`accessOf`). For DMs that user is the linked user; for
groups it is the group owner. A failed check unbinds that chat, logs it,
and sends nothing.

**Streaming:**

- When `stream` is on and `capabilities.edit` is present, the engine opens
  `host.conversations.watch` on admission and reads the partial answer
  text from `docs["pi.live"]`.
- It sends the first message once there are at least 20 visible
  characters, then edits no faster than `edit.minIntervalMs`.
- **Updates are prefix-stable** (Hermes's invariant): each streamed frame
  extends the previous one and is never reshaped mid-stream.
- **The final text comes from `runSettled`'s answer, never from the
  accumulated preview.** It replaces the streamed message.
- If an edit fails, the engine stops streaming and delivers the final as a
  fresh send.
- Without `edit`, the engine sends a typing indicator every
  `typing.intervalMs` until settle, then the final.
- The watch is released after delivery.
- Streaming edits are not ledgered; only finals are.

**Answer content:**

- Text blocks are joined; thinking blocks and tool calls are not shown.
- Unanswered outcomes (model error, no model, reset) produce a short
  notice, to the originating chat only. An abort from `/stop` produces
  "Stopped.".

**Formatting and chunking:**

1. Split the markdown final: if it exceeds `maxMessageLength`, split at
   paragraph, then line, then hard boundaries. A code fence cut by a
   split is closed and reopened.
2. Format each chunk per `capabilities.format`: `markdown` as-is,
   `native` through `adapter.format`, `plain` through the engine's
   markdown stripper.
3. If a formatted chunk still exceeds `maxMessageLength` (native markup
   grew it), hard-split that chunk.

When streamed, the first chunk is the edited message and the rest are
sends.

**Delivery queue and ledger** (`<stateDir>/gateway/ledger`, JSON or
sqlite: builder's call). Handlers enqueue (§8.0); one delivery worker per
channel sends in enqueue order.

- States: `pending` → `attempting` (just before the platform call) →
  `delivered` (receipt) or `failed`.
- `classifyError` decides what happens on error:
  - `transient` retries at 1 s, 5 s and 30 s, then `failed`;
  - `permanent` fails at once;
  - `chat_gone` marks the binding dead, skips future sends to it, and
    clears on the chat's next inbound message.
- **After a restart:** `pending` entries are sent; `attempting` entries
  are re-sent with a leading "(resent after restart)" line, because the
  platform may already have them.
- Every `failed` entry logs at error level and feeds `health()`. Nothing
  is dropped silently.
- Delivered entries are pruned after 7 days.

### 8.7 Interactions in chat

The engine is a notifier (`notifiers: [{ name: "gateway", ... }]`). On
`interaction.pending` it reads the record via `snapshotInteraction` (using
C6's `callId`).

**Where it renders:**

- conversation bound → in every bound chat, deduplicated on
  `(conversationId, callId, bindingKey)` (core emits one event per
  recipient; the bound branch renders once per chat);
- not bound → in the recipient's home chats, deduplicated on
  `(conversationId, callId, recipient)` (M4), so each approver gets it.
  The message carries the conversation name and, when `server.publicUrl`
  is set, its link.

**How it renders:**

- `body.text` is formatted per §8.6.
- `body.options` become buttons when they fit `buttons.max`. `tone:
  "danger"` maps to `style: "danger"`, and `recommended` comes first.
- Otherwise the options become a numbered list with "Reply with a
  number."
- A `body.diff` renders as a fenced diff, truncated to fit one message
  with a "full diff in the webui" note.
- **Records with `fields` are never collected over chat.** That includes
  `secret`-typed fields. They render as "Answer this in the webui" plus
  the link. Free-text answers to option-less records are accepted via a
  reply to the prompt message (`replyTo`).

**Answering:**

- A button tap (`ctx.action`) or a numbered or reply-to text answer calls
  `answerInteraction(..., { user })`.
- Only after the engine verifies the answerer is linked to a user with
  write access to the conversation. Others get a short refusal reply.
- A numbered text answer is only matched while exactly one interaction is
  pending in that chat. With several pending, buttons or reply-to are
  required.
- A tap on a prompt whose record already settled replies with the outcome
  ("Already answered in the webui: approved").

**Settlement (B2):** on `interactionSettled`, the engine enqueues an edit
of every prompt message it delivered for that `(conversationId, callId)`
to show the outcome and remove its buttons. Without `edit`, it sends one
short outcome line to bound chats only.

Interaction kinds are not special-cased: the engine renders the generic
record, so approvals, ask-user and future kinds all work.

### 8.8 Home chats, notifications, and job delivery

**Home chat:** per user, per channel, always a DM. It is set to the DM
where the user was first linked. `/home` (DM only) moves it to another DM
of the same user.

**Notifications** (when `notify.home`):

- `run.settled` for an unbound conversation goes to the recipient's home
  chats as "Reply ready — <name>" plus the link.
- `job.failed` goes to the job owner's home chats.
- Which events core emits is still governed by core's
  `notifications.runSettled` setting. The engine's in-process `watch` is
  not an SSE `/stream` client, so `"unwatched"` keeps its meaning.

**Jobs to chats** (ruling 4), two paths:

1. **A job targeting a conversation bound to a chat**
   (`action.conversation: <id>`): delivered by §8.6 with no extra
   configuration. Replies in the chat continue the same conversation, so
   this is the path for follow-up questions on job output.
2. **`deliver` targets** (C7) on `conversation: "new"` jobs:
   - `"<channel>"` = the job owner's home chat on that channel;
   - `"<channel>:<chatId>"` = an explicit chat, which must be bound to a
     conversation the job owner can write, or be the owner's home chat.

   The engine delivers **the run conversation's first settled run only**,
   recording it in the ledger. Later runs in that conversation (someone
   continuing it in the webui) are not delivered. Each delivery carries a
   header line naming the job. Unresolvable or disallowed targets are
   logged per run (the run still succeeds). A reply in that chat goes to
   the chat's own bound conversation, which doesn't contain the job run;
   that's documented, and path 1 is the remedy.

### 8.9 Agent tools

The engine's extension contributes two tools:

- **`send_message({ to, text, files? })`**:
  - `to` uses the `deliver` grammar;
  - `files` are workspace paths, read via `readFile`, capped by
    `media.maxBytes`, and sent only when the channel's `media` includes
    the kind (otherwise as a document if `document` is supported, else
    the tool errors);
  - the target must be the acting user's home chat or a chat bound to a
    conversation the acting user can write (`host.identity.actingUser`);
  - the send goes through the delivery queue and the tool waits for the
    receipt up to 30 s;
  - returns `{ delivered: true, messageIds }`, `{ delivered: false,
    queued: true }` on timeout, or an error result.
- **`list_chats()`** returns the targets the acting user may use, with
  labels.

Both tools return an explanatory error when the acting user has no linked
chats, and never throw for policy refusals. A `members: "anyone"` group
gets them only if its `tools` list names them.

### 8.10 Prompt context and the input envelope

**A prompt section** keyed `gateway-channel`:

- It renders only for bound conversations (looked up via
  `PromptInput.conversationId`):

  > This conversation is connected to <Label> (<direct message | group "<title>">). <capabilities.promptHint>

- Groups add: "Messages are prefixed with the sender's name. You act for
  <owner name>; senders other than <owner name> are not the account
  owner." `members: "anyone"` groups add: "Anyone in the group can
  message you."
- It's static per binding, so it doesn't perturb the prompt cache.
- With several bound chats, it renders the first bound chat's line plus
  "(also connected to N more)".
- In `anyone` groups the section is present only when the group's
  `extensions` list includes `gateway` or omits `extensions` entirely (the
  engine adds `gateway` to a configured `extensions` list itself, my call:
  the channel context must never drop out).

**The envelope** (the submitted text):

- **Groups:** `[<sender name>] <text>`. Linked senders use their sigrun
  user's display name; unlinked ones use the platform name plus
  "(not linked)".
- **Replies:** a leading `> <quoted text>` block (truncated to 500 chars)
  with "(replying to <author>)".
- **DMs:** the text as-is.
- No timestamps in v1 (my call).

### 8.11 Media

**Inbound:**

- Attachments over `media.maxBytes` by declared `size` are never fetched.
  Others are fetched with `fetch({ maxBytes: media.maxBytes, signal })`;
  an `AttachmentTooLarge` throw is treated the same. Both become a note
  line ("[attachment skipped: too large]").
- Fitting ones go through `host.conversations.upload`. `image` becomes an
  image part; everything else becomes a file part.
- Voice notes add "[voice note attached; transcription unavailable]"
  until `transcribers` exist.
- A media-only message submits the notes and parts with no text.

**Outbound:** media goes out only via `send_message`. Final answers are
text (my call: answers that embed files have no settled shape yet).

### 8.12 Supervision, status, health

**Per enabled channel:**

1. If `configured()` reports `not_configured`, the status is
   `not_configured` and the adapter is not started.
2. Otherwise the engine calls `start(ctx)`.
3. If `start` rejects, or `ctx.fail` fires later, the adapter restarts
   with exponential backoff plus jitter: 1 s doubling to 5 min, reset
   after 10 min running.

**Status values:** `stopped | not_configured | connecting | running |
backoff | failed` (config error).

**Admin route** `GET /v1/ext/gateway/status`:

- per channel: state, detail, since, last error, and counts (admitted,
  dropped, delivered, failed);
- pending pairing requests, without codes.

**Health** (`engine.health()`, C2): `degraded` when any enabled, configured
channel has been in `backoff`/`failed` for over 5 minutes, or the ledger
holds `failed` entries from the last hour.

**Logs:** chat ids, sender ids, and binding keys (which contain the chat
id) are logged as an 8-hex sha256 prefix at info level and verbatim at
debug level. Phone-number platforms make these ids PII (my call).

### 8.13 Shutdown

`stopIntake()` (C2 step 2): every subsequent `receive`/`action` resolves
`"dropped"` without acking work; webhook routes answer `503`. Adapter
connections stay up so deliveries can still go out.

`stop()` (C2 step 4):

1. Let the delivery workers drain, bounded at 10 s total.
2. Abort every adapter's signal and await `adapter.stop()` in parallel,
   bounded at 5 s.
3. Release watches. Entries still `pending`/`attempting` stay in the
   ledger for the next boot.

## 9. Security posture

- **Unknown DM senders never reach the model.** Access runs before any
  submit; pairing replies are the only output to them.
- **Groups (M3):** listing a group in `groups[]` is the owner's approval
  of that group. In `linked` groups only linked users' messages reach
  the model. In `anyone` groups any member's message reaches the model,
  attributed to the group owner, but only inside a conversation pinned to
  the group's tool whitelist. The prompt tells the model who the owner is
  and that senders differ.
- **Unlinked senders control nothing:** no commands, no interaction
  answers, no `/attach`, in any group mode.
- **Secrets are never collected over chat** (§8.7).
- **Codes travel only through DMs:** pairing codes go to the requester and
  admins' home DMs; link codes are accepted only in DMs and invalidated
  when posted in a group.
- Pairing and link codes are never logged. State files are mode 0600.
- **Delivery re-checks access** (§8.6), so a revoked share stops
  delivery.
- **Adapters are trusted in-process code,** the same trust level as every
  extension. They verify their own webhook signatures. The engine never
  holds platform credentials.
- **Linked identity is only as strong as the platform's sender id.** The
  docs state this. Approvals answered from chat carry `answeredByUser`
  for audit.

## 10. Testing

**Core (sigrun repo):**

- C1 validation and quarantine cases, including id collision.
- C2: one engine, second quarantined; start after listen; the shutdown
  order (a run settling during `shutdownSequence` reaches the engine's
  queue before `stop`); no-engine inert marking; `health.gateway`.
- C3 toggle, settings validation, and replacement.
- C4 each host op against its HTTP twin (same fixture, same results),
  including `create` with `sharing` and `agent`, `patchMeta` sharing,
  `models.list`, and the `commands.run` principal (admin from C8).
- C5 attribution.
- C6 `callId` on the event; `interactionSettled` fires for answers from
  the route and from the host, and for expiry.
- C7 validation (rejected with an existing conversation), `specHash`, and
  meta stamping; `deliver` and `jobId` rejected by the meta PATCH route.
- C8: an admins-group proxy login writes `groupAdmin`; host-side admin
  reflects it; leaving the group clears it at the next login.

**Engine (sigrun-ext-gateway repo):**

- A `loopback` fake adapter fixture: in-memory transport recording
  sends/edits, scriptable capabilities. All engine tests run through it,
  over a real sigrun boot (the e2e pattern of the provider plugins).
- **Required scenarios:**
  - unclaimed setup drops inbound;
  - unknown DM → pairing reply → `/pair approve` → next message admitted;
  - pairing limits: second request from one sender, fourth on a channel;
  - allowlisted sender admitted;
  - self-link round trip; `/link <code>` in a group refused and the code
    invalidated; `selfLink: false` on an allowlist channel;
  - unlisted group ignored; mention gating (`required` and `always`);
  - `linked` group drops an unlinked member; `anyone` group admits them
    and the conversation offers exactly the configured tools;
    `/attach` refused in an `anyone` group;
  - a linked member speaking in a group gains write sharing;
  - streamed edits are prefix-stable and the final equals the
    `runSettled` answer;
  - no-edit adapter gets typing then final;
  - chunking with a split code fence, and a native chunk that grows past
    the limit after formatting;
  - busy `followUp` vs `steer`; `/stop` aborts;
  - `/new` and `/attach` rebinding;
  - unserved model at submit replies with the notice and resolves
    `"dropped"`;
  - approval via button, via number, refused for an unlinked group
    member; `fields` record renders the webui pointer;
  - unbound conversation's approval reaches every approver's home chat;
  - an approval answered in the webui edits the chat prompt
    (`interactionSettled`), and a later tap gets the outcome;
  - job `deliver` to home chat; a second run in that conversation is not
    delivered; job targeting a bound conversation;
  - revoked sharing unbinds the chat and stops delivery;
  - retries run past `SIGRUN_HOOK_DEADLINE` without blocking the
    handler;
  - ledger recovery after a simulated crash in `attempting` (resent with
    the marker);
  - `chat_gone` marks the binding dead and clears on inbound;
  - dedupe across a restart;
  - supervisor backoff on `ctx.fail`;
  - oversized attachment by declared size (no fetch) and by streamed size
    (`AttachmentTooLarge`).
- Fixtures follow the repo rules: synthetic ids, `example.invalid` hosts,
  no real tokens.

## 11. Packaging and disabling

- `@sigrun/ext-gateway` is a core `dependency`, resolved through core's
  tree like the other built-ins.
- **Off:** `builtinExtensions.gateway: false`. Adapters then load inert
  (C2) and the server carries no gateway code paths beyond the C1–C8
  seams.
- **Replacement:** a configured extension whose package name is
  `@sigrun/ext-gateway` replaces the built-in and inherits its state. An
  engine under another package name needs the built-in disabled and
  starts with its own empty state directory.
- Adapters install like any extension (`extensions[]` in settings).

## 12. Prior art: kept and dropped

**Kept:**

- From both: the pairing parameters; a thin adapter under a fat shared
  layer; prefix-stable streaming with an authoritative final; buttons
  that degrade to text.
- From Hermes: the session-key shape and per-chat sessions; control
  commands bypassing the busy queue; the delivery-ledger states and
  crash semantics; the dead-target registry; the bot-loop guard;
  home-channel delivery for jobs.
- From OpenClaw: core-owned send tool and prompt wiring; ack after
  durable admission; formatting hints owned by the channel but injected
  by core; opaque transport-private button tokens; per-group tool policy
  (here as a conversation-level whitelist).

**Dropped:** profiles/multiplexing, relay, hosted rooms, scale-to-zero,
multi-agent bindings and broadcast groups, OpenClaw's capability-proof
verification helpers and SDK compatibility layers, per-platform enum
edits across core (Hermes's 16-step built-in checklist is exactly what
the contract replaces).

## 13. Calls I made (marked in the text)

- One factory result carries every engine surface, with one delivery job
  per surface; handlers only enqueue (§8.0).
- The `pi.live` narrowing moves into `@sigrun/shared`, shared by the webui
  and the engine.
- `selfLink` defaults on for pairing channels, off otherwise.
- Groups share one conversation per group (not per member).
- Linked members who speak in a group gain write sharing on its
  conversation.
- The engine keeps `gateway` in an `anyone` group's extension list.
- Archived bound conversations unarchive on new chat messages.
- Album merging only, no time-based burst merging.
- No timestamps in the envelope.
- Final answers are text; outbound media only via `send_message`.
- Hashed chat/sender ids and binding keys in info-level logs.
- Channel id collisions quarantine instead of last-wins.
- No wrong-code lockout on `/pair`.
- C8: group-derived admin is persisted on the directory record.

## 14. Dependencies and left to the builder

**UI blocks:** when the UI-blocks spec lands, interaction records become
block trees. The gateway then renders through a shared plain/markdown
fallback renderer in `@sigrun/shared`, which the UI-blocks work should
provide. Until then it renders the current `InteractionBody` (§8.7).

**Sequencing ruling (2026-10-22):** the gateway is built interleaved with
UI blocks, and its interaction rendering is built after U6, directly against
block-tree records and `{values}` answers through U0's `toText`. §8.7's
mapping translates to the root `form`: a single closed `choice` field
becomes buttons or a numbered list, a lone `text`/`longtext` field takes a
reply, and anything else (including any `secret` field) is answered in the
webui. Details: plan 2, Task 9.

**Left to the builder:**

- **Storage:** JSON files vs a single sqlite for gateway state;
  atomicity via temp-file + rename either way.
- **Markdown handling:** the stripper/splitter implementation and its
  edge cases.
- **Throttling:** exact first-send and edit thresholds within the stated
  bounds.
- **Wording** of the engine's own chat messages.
- **Plan phasing.** Suggested order:
  1. core C1–C8 plus the engine skeleton with the loopback fixture;
  2. the engine features;
  3. `sigrun-channel-telegram` (its own spec/plan).
