# Sigrun gateway: chat channels as extensions

Status: draft for review. Date: 2026-10-22.

Inputs:

- the gateway review of 2026-10-22: hermes-agent `gateway/` (adapter base
  class, `ADDING_A_PLATFORM.md`, session keys, pairing, delivery ledger,
  busy guards, streaming contract) and OpenClaw's channel SDK docs
  (`sdk-channel-plugins`, `-inbound`, `-ingress`, `-outbound`,
  `message-presentation`, `channel-routing`, `pairing`);
- the user rulings of 2026-10-22 (§3);
- the existing seams this builds on: `host.conversations` (core-hardening
  spec §9.5), extension `routes`/`commands`/`notifiers`/`jobs`/lifecycle
  events (`docs/extending.md`), interaction records
  (`docs/approval-ux-seams.md`, `shared/src/interactions.ts`), the
  built-in mechanism (`src/harness/builtins.ts`);
- the UI-blocks draft (`2026-10-19-sigrun-ui-blocks-design.md`), which
  this spec depends on for rich content later (§14).

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
- Access control: static allowlists and pairing-approval requests.
- One conversation per chat; `/new` starts a fresh one.
- Streaming replies, chunking, formatting, durable delivery.
- Interaction records (approvals, questions) answerable from chat.
- Chat commands (`/new`, `/stop`, `/model`, ...).
- Job output delivered to chats (cron-to-adapter).
- An agent `send_message` tool.
- The small core seams the above needs (§6).

**Non-goals (v1)**

- Multi-agent routing, broadcast groups, ACP bindings (OpenClaw): sigrun
  routes a chat to a conversation, never to one of several agents.
- Multi-profile multiplexing, relay transports, hosted rooms,
  scale-to-zero (Hermes).
- Speech-to-text and text-to-speech. Later as their own core
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
- An `open` DM policy (anyone may talk to the bot).

**Anti-goals** (failure even if everything else works)

- An unapproved sender's text reaching the model.
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

Each change is small and lands in the sigrun repo.

### C1. `channels` contribution field

`SigrunExtensionResult.channels?: readonly ChannelContribution[]` (types in
§7).

- **Load-time validation:** `id` matches `^[a-z][a-z0-9-]*$`; `label` is a
  non-empty string; `capabilities` passes the §7 shape check; `start` and
  `send` are functions; optional members are functions when present.
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
  stop(): Promise<void>;
}
interface GatewayEngineContext {
  /** Every loaded channel contribution, with its contributing extension's slug. */
  readonly channels: readonly { readonly extension: string; readonly channel: ChannelContribution }[];
  readonly signal: AbortSignal;
}
```

- **At most one engine:** a second extension declaring `gateway` is
  quarantined, naming both.
- **Start:** core calls `start` once, after the HTTP server is listening,
  so adapter webhook routes are live. The engine owns its own
  supervision; a rejected `start` is logged and degrades `/v1/meta`
  health. It never aborts boot.
- **Stop:** inserted in `shutdown()` after `app.close()` and before the
  event bus's workers-then-handlers sequence, bounded by the existing
  hook deadline (`SIGRUN_HOOK_DEADLINE`, 30 s). The harness is still open,
  so in-flight deliveries can finish.
- **No engine** (gateway disabled and not replaced) with channel
  contributions present: one boot warning, `/v1/extensions` marks those
  rows `inert: "no gateway"`, and the adapters load but nothing calls
  them.

### C3. Built-in #4

- `BUILTIN_EXTENSIONS` gains
  `{ key: "gateway", specifier: "@sigrun/ext-gateway", slug: "gateway" }`.
- `builtinExtensions.gateway` defaults to `true` and is restart-required.
- Replacement and quarantine behave exactly as for the other built-ins
  (Rulings 5–7 in `builtins.ts`).

### C4. `host.conversations` parity with HTTP

These are new host methods. Today the host bridge (`src/server/host-bridge.ts`)
exposes only `create/submit/watch/list/meta`, and the operations below exist
only as HTTP routes. The engine's chat commands (§8.5) run through them:

```ts
abort(id): Promise<void>;
configure(id, opts: { model?: string; thinking?: ThinkingLevelWire }): Promise<void>;
compact(id): Promise<void>;
fork(id, opts?: { at?: EntryId; owner?: string }): Promise<ConversationId>;
patchMeta(id, patch: { name?: string | null; archived?: boolean }): Promise<SessionMeta>;
upload(id, file: { name: string; mime?: string; bytes: Uint8Array }): Promise<{ path: string }>;
readFile(id, path: string): Promise<{ bytes: Uint8Array; mime?: string }>;
```

- Each runs the same op as its HTTP route (`conversation-ops.ts` style)
  and throws the same typed errors.
- `upload` returns the workspace-relative path that `submit` parts accept.
- `readFile` applies the files route's confinement.

Plus a host command surface:

```ts
readonly commands: {
  list(): Promise<readonly SlashCommand[]>;
  run(conversationId, name, args: string, opts: { user?: string }): Promise<{ notice?: string }>;
};
```

`run` executes extension commands server-side, the same path as `POST
/v1/conversations/:id/commands/<name>`. Core slash commands need no `run`
entry: the gateway's chat commands call the methods above directly.
`submit` is unchanged: it already runs `submitOp`, including the
served-model check.

### C5. Interaction answer attribution

`host.answerInteraction(conversationId, callId, answer, context, opts?: {
user?: string })`. With `user`, the record stamps `answeredBy: "human"` and
`answeredByUser: user`; without it, behavior is unchanged. Access checks
stay the caller's job (host code is trusted). The engine checks write
access before calling (§8.7).

### C6. `callId` on `interaction.pending`

`NotificationEvent` gains `callId?: string`, set on `interaction.pending`,
so a notifier can read the record via `host.snapshotInteraction`.

### C7. Job delivery targets

- `JobAction` (`kind: "prompt"`) gains `deliver?: string[]`: 1–8 strings,
  each 1–256 chars.
- **Core validates shape only;** the grammar belongs to the gateway
  (§8.8).
- `fire.ts` stamps it into the run conversation's `SessionMeta` as
  `deliver` alongside the existing `jobId`, for both `"new"` and
  existing-conversation actions. `SessionMeta` gains `deliver?: string[]`.
- It's part of `specHash`, so editing targets is a job revision.
- A run whose job has `deliver` while no engine is loaded logs one warning
  per run ("deliver targets ignored: no gateway").

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
  /** Resolves after the event is durably admitted or deliberately dropped; ack the platform after. */
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
  /** Lazy so oversized or unwanted media is never downloaded. */
  fetch(): Promise<Uint8Array>;
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

Rules for adapter authors:

- **Webhook transports** declare their own `routes` (mounted at
  `/v1/ext/<adapter-slug>/...`, `auth: "public"`, the adapter verifies
  signatures) and hand events to the `ChannelContext` captured in
  `start`. A webhook arriving before `start` or after `stop` answers
  `503`.
- **Socket/poll transports** run their loop from `start`, never from
  the factory body (the pi lifecycle lesson).
- **Credentials come from the adapter's own host stores**
  (`secrets.json` section, `SIGRUN_EXT_<SLUG>_<KEY>` env bootstrap).
  The engine never sees them.
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
| `gateway` | the C2 engine: supervision, inbound pipeline, outbound (§8.4–§8.6, §8.12) |
| `runSettled` | answer delivery to bound chats and `deliver` targets (§8.6, §8.8) |
| `notifiers` | `interaction.pending` rendering and home-chat notifications (§8.7, §8.8) |
| `commands` | `/pair` and `/link` for webui/TUI (§8.2) |
| `routes` | `GET status` (§8.12) |
| `health` | the §8.12 health rule, read synchronously from engine state |
| `userDeleted` | link and home-chat cleanup (§8.2) |

Each surface has exactly one job, so nothing is delivered twice:

- **`runSettled`** (fires for every settled run) delivers answers for
  bound conversations and for conversations whose meta carries `deliver`.
- **The notifier** handles `interaction.pending` everywhere, plus
  `run.settled` and `job.failed` for conversations that are NOT bound.
  It skips `run.settled` for bound conversations, which `runSettled`
  already delivered. Bound chats never get a "Reply ready" notice on top
  of the answer, even when the webui is closed.

**State** lives in the engine's own scoped directory,
`host.stores.paths.state` (= `<stateDir>/gateway/`). Core never reads or
writes gateway state. A replacement engine published under the same
package name keeps the slug and inherits the state; one under another
name starts empty.

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
      "allow": [{ "sender": "100000001", "user": "alice" }],
      "groups": [{ "chat": "-100000000002", "owner": "alice", "mention": "required" }],
      "busy": "followUp",
      "stream": true,
      "allowBots": false
    }
  },
  "media": { "maxBytes": 20971520 },
  "notify": { "home": true }
}
```

- A channel absent from `channels` is disabled.
- `enabled` is restart-required. Every other field is read per event
  (live).
- `dm` is `"pairing" | "allowlist" | "disabled"`. `busy` is `"followUp" |
  "steer"`. `mention` is `"required" | "always"`.
- Malformed config for one channel disables that channel with a status
  `failed` and the reason. Other channels are unaffected.

### 8.2 Identity and access

Every admitted sender maps to a sigrun directory user. The mapping
comes from three sources, in precedence order:

1. **Static allowlist** (`allow[]`): `{sender, user}`.
2. **Links** from approved pairing requests or self-linking, kept in
   `<stateDir>/gateway/identities.json` (mode 0600).
3. **Nothing:** the sender is unknown.

If the allowlist and a link disagree, the allowlist wins and the conflict
is logged once.

**DMs from unknown senders, by `dm` policy:**

- `disabled`: drop silently.
- `allowlist`: drop and log once per sender per day.
- `pairing`: create a pairing request.

Pairing requests, with Hermes/OpenClaw's shared parameters:

- **The code** is 8 characters from a 32-character unambiguous alphabet,
  via `crypto.randomInt`, and expires after 1 hour.
- **Limits:** at most 3 pending requests per channel, and at most 1 new
  request per sender per 10 minutes. Codes are never logged.
- **The sender** gets one reply with the code and a "waiting for
  approval" line. Their message is not processed, then or after
  approval.
- **Approving from sigrun:** the extension command `/pair`, admin only,
  usable in any webui/TUI conversation:
  - `/pair` lists pending requests;
  - `/pair approve <code> <user>` maps the sender to an existing
    directory user;
  - `/pair deny <code>` rejects the request.
- **Approving from chat:** each admin's home chat (§8.8) gets the request
  as text with the same commands. When the channel has buttons and the
  directory has at most `buttons.max - 1` users, it also gets one
  "Approve as <user>" button per user plus a Deny button.
- **Lockout:** 5 wrong codes within an hour lock `/pair approve` for that
  channel for an hour.

**Self-linking** (my call): this is how the first admin connects, and how
a user adds a channel without admin approval.

1. `/link <channel>` in the webui/TUI returns a single-use code (same
   alphabet and expiry, bound to the invoking user).
2. The user sends `/link <code>` to the bot from the platform.
3. That sender is linked to the user.

It's proof by holding both sessions.

**Groups:**

- Only groups listed in `groups[]` are served; others are ignored and
  logged once.
- A group's conversation is owned by its configured `owner`.
- With `mention: "required"`, only `mentioned` events are admitted.
- Any group member's message is admitted, attributed per §8.10.
- Only senders linked to a user with write access to the conversation can
  run chat commands or answer interactions in the group.

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
  - `name` = the chat title, or `"<Label> DM"` for DMs.
- **`/new`** creates a fresh conversation and rebinds the chat. The old
  conversation is untouched (not archived) and listed in `previous`.
- **`/attach <id>`** binds the chat to an existing conversation the linked
  user has write access to (`host.access.accessOf`). This is how a webui
  conversation continues from a phone.
- A conversation archived in the webui stays bound. A new message
  unarchives it via `patchMeta` (my call: archiving shouldn't silently
  break a chat).

### 8.4 Inbound pipeline

For each `receive(event)`, in order:

1. **Dedupe** on `(channel, account, chatId, messageId)` against a
   24-hour seen set persisted in state, so platform redelivery after a
   restart is a no-op.
2. **Drop** self and bot events (§8.2).
3. **Access** (§8.2). An unknown DM gets a pairing reply; an unlisted
   group is ignored.
4. **Merge albums:** events with the same `groupId` that arrive within
   1.5 s merge into one submission. There's no time-based burst merging
   otherwise (my call: no added latency on every message).
5. **Commands:** if the text is a gateway chat command, it's handled
   inline (§8.5), bypassing the busy queue.
6. **Interaction text answers** (§8.7).
7. **Attachments** (§8.11).
8. **Submit:** `host.conversations.submit` with the envelope text (§8.10)
   plus the attachment parts:
   - `user` = the mapped user, or the owner for unlinked group senders;
   - `requestId` = the binding key plus `messageId` (idempotent across a
     crash between admit and seen-set write);
   - `whenBusy` = the channel's `busy` setting.

`receive` resolves `"admitted"` once `submit` returns (admission is
durable). Adapters ack the platform after that, never before.

### 8.5 Chat commands

Gateway commands, reserved in chat:

| Command | Does |
|---|---|
| `/new` | fresh conversation, rebind (§8.3) |
| `/stop` | `abort` the live run |
| `/model [ref]` | no arg: show current and list served models; with arg: `configure` |
| `/thinking [level]` | same pattern, `configure` |
| `/compact` | `compact` |
| `/attach <id>` | bind to an existing conversation |
| `/status` | conversation name, model, busy/queued, bound conversation id |
| `/home` | make this chat the sender's home chat for this channel (§8.8) |
| `/link <code>` | self-linking (§8.2) |
| `/pair ...` | pairing admin, admins only |
| `/help` | lists the above plus extension commands |

- **Extension commands** (`host.commands.list()`) run through
  `host.commands.run` with the mapped user. Their `notice` is sent as the
  reply.
- **Anything else starting with `/`** is submitted as text, so prompt
  templates and `/skill:` expansion work through the normal admission
  path.
- **Who may run commands:** the linked user needs write access to the
  bound conversation. `/link` works for anyone; `/pair` is admin only.
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

**Answer content:**

- Text blocks are joined; thinking blocks and tool calls are not shown.
- Unanswered outcomes (model error, no model, reset) produce a short
  notice, to the originating chat only. An abort from `/stop` produces
  "Stopped.".

**Formatting and chunking:**

- `capabilities.format`: `markdown` sends markdown as-is; `native` passes
  it through `adapter.format`; `plain` uses the engine's markdown
  stripper.
- Finals longer than `maxMessageLength` split at paragraph, then line,
  then hard boundaries. A code fence cut by a split is closed and
  reopened.
- When streamed, the first chunk is the edited message and the rest are
  sends.

**Delivery ledger** (`<stateDir>/gateway/ledger.json` or sqlite, builder's
call). Each outbound final is recorded before the send:

- `pending` → `attempting` (just before the platform call) → `delivered`
  (receipt) or `failed`.
- `classifyError` decides what happens on error:
  - `transient` retries at 1 s, 5 s and 30 s, then `failed`;
  - `permanent` fails at once;
  - `chat_gone` marks the binding dead, skips future sends to it, and
    clears on the chat's next inbound message.
- **After a restart:** `pending` entries are re-sent; `attempting` entries
  are re-sent with a leading "(resent after restart)" line, because the
  platform may already have them.
- Every `failed` entry logs at error level and counts toward
  degraded health. Nothing is dropped silently.
- Delivered entries are pruned after 7 days.

### 8.7 Interactions in chat

The engine is a notifier (`notifiers: [{ name: "gateway", ... }]`). On
`interaction.pending` it reads the record via `snapshotInteraction` (using
C6's `callId`).

**Where it renders,** deduplicated on `(conversationId, callId)`:

- conversation bound → in every bound chat;
- not bound → in each recipient's home chat, so a webui conversation's
  approval can be answered from a phone. The message carries the
  conversation name and, when `server.publicUrl` is set, its link.

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
  write access to the conversation. Others get a short private-ish
  refusal reply.
- A numbered text answer is only matched while exactly one interaction is
  pending in that chat. With several pending, buttons or reply-to are
  required.

When the record settles from anywhere, the engine edits the prompt, if it
can, to show the outcome and removes its buttons. Interaction kinds are
not special-cased: the engine renders the generic record, so approvals,
ask-user and future kinds all work.

### 8.8 Home chats, notifications, and job delivery

**Home chat:** per user, per channel, the DM where the user was first
linked. `/home` changes it; it can be any chat the user may write to.

**Notifications** (when `notify.home`):

- `run.settled` for an unbound conversation goes to the recipient's home
  chats as "Reply ready — <name>" plus the link. It's skipped for bound
  conversations, which already got the answer.
- `job.failed` goes to the job owner's home chats.
- Which events core emits is still governed by core's
  `notifications.runSettled` setting.
- The engine's in-process `watch` is not an SSE `/stream` client, so
  `"unwatched"` behaves as intended.

**Jobs to chats** (ruling 4), two paths:

1. **A job targeting a conversation bound to a chat**
   (`action.conversation: <id>`): delivered by §8.6 with no extra
   configuration. Replies in the chat continue the same conversation, so
   this is the path for follow-up questions on job output.
2. **`deliver` targets** (C7), for any prompt job:
   - `"<channel>"` = the job owner's home chat on that channel;
   - `"<channel>:<chatId>"` = an explicit chat, which must be bound to a
     conversation the job owner can write, or be the owner's home chat.

   On `runSettled` for a conversation whose meta has `deliver`, the engine
   delivers the answer to each target with a header line naming the job.
   Unresolvable or disallowed targets are logged per run (the run still
   succeeds). A reply in that chat goes to the chat's own bound
   conversation, which doesn't contain the job run; that's documented,
   and path 1 is the remedy.

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
  - returns `{ delivered: true, messageIds }` or an error result.
- **`list_chats()`** returns the targets the acting user may use, with
  labels.

Both tools return an explanatory error when the acting user has no linked
chats, and never throw for policy refusals.

### 8.10 Prompt context and the input envelope

**A prompt section** keyed `gateway-channel`:

- It renders only for bound conversations (looked up via
  `PromptInput.conversationId`):

  > This conversation is connected to <Label> (<direct message | group "<title>">). <capabilities.promptHint>

  Groups add: "Messages are prefixed with the sender's name."
- It's static per binding, so it doesn't perturb the prompt cache.
- With several bound chats, it renders the first bound chat's line plus
  "(also connected to N more)".

**The envelope** (the submitted text):

- **Groups:** `[<sender name>] <text>`. Linked senders use their sigrun
  user's display name.
- **Replies:** a leading `> <quoted text>` block (truncated to 500 chars)
  with "(replying to <author>)".
- **DMs:** the text as-is.
- No timestamps in v1 (my call).

### 8.11 Media

**Inbound:**

- Attachments are fetched lazily. Anything over `media.maxBytes` (by
  declared `size`, else after fetch) becomes a note line
  ("[attachment skipped: too large]") and is never uploaded.
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

**Health:** `degraded` when any enabled, configured channel has been in
`backoff`/`failed` for over 5 minutes, or the ledger holds `failed`
entries from the last hour.

**Logs** carry channel id and binding key. Chat and sender ids are
replaced by an 8-hex sha256 prefix at info level, since phone-number
platforms make ids PII (my call).

### 8.13 Shutdown

`stop()`:

1. Abort every adapter's signal.
2. Await `adapter.stop()` in parallel, 10 s each.
3. Let in-flight ledger sends finish within the remaining core hook
   deadline.
4. Entries still `pending`/`attempting` stay in the ledger for the next
   boot.

Watches are released.

## 9. Security posture

- **Unknown senders never reach the model.** Access runs before any
  submit; pairing replies are the only output to unknown senders.
- **Secrets are never collected over chat** (§8.7).
- Pairing and link codes are never logged. State files are mode 0600.
- **Adapters are trusted in-process code,** the same trust level as every
  extension. They verify their own webhook signatures. The engine never
  holds platform credentials.
- **Linked identity is only as strong as the platform's sender id.** The
  docs state this. Approvals answered from chat carry `answeredByUser`
  for audit.
- **Unlinked senders can't control anything:** in groups they can't run
  commands or answer interactions.

## 10. Testing

**Core (sigrun repo):**

- C1 validation and quarantine cases, including id collision.
- C2: one engine, second quarantined; start after listen; stop ordering;
  no-engine inert marking.
- C3 toggle and replacement.
- C4 each host op against its HTTP twin (same fixture, same results).
- C5 attribution. C6 `callId` on the event.
- C7 validation, `specHash`, and meta stamping for both conversation
  modes.

**Engine (sigrun-ext-gateway repo):**

- A `loopback` fake adapter fixture: in-memory transport recording
  sends/edits, scriptable capabilities. All engine tests run through it,
  over a real sigrun boot (the e2e pattern of the provider plugins).
- **Required scenarios:**
  - unknown DM → pairing reply → `/pair approve` → next message admitted;
  - allowlisted sender admitted;
  - self-link round trip;
  - unlisted group ignored; mention gating;
  - streamed edits are prefix-stable and the final equals the
    `runSettled` answer;
  - no-edit adapter gets typing then final;
  - chunking with a split code fence;
  - busy `followUp` vs `steer`; `/stop` aborts;
  - `/new` and `/attach` rebinding;
  - approval via button, via number, refused for an unlinked group
    member; `fields` record renders the webui pointer;
  - unbound conversation's approval lands in the home chat;
  - job `deliver` to home chat; job targeting a bound conversation;
  - ledger recovery after a simulated crash in `attempting` (resent with
    the marker);
  - `chat_gone` marks the binding dead and clears on inbound;
  - dedupe across a restart;
  - supervisor backoff on `ctx.fail`.
- Fixtures follow the repo rules: synthetic ids, `example.invalid` hosts,
  no real tokens.

## 11. Packaging and disabling

- `@sigrun/ext-gateway` is a core `dependency`, resolved through core's
  tree like the other built-ins.
- **Off:** `builtinExtensions.gateway: false`. Adapters then load inert
  (C2) and the server carries no gateway code paths beyond the C1–C7
  seams.
- **Replacement:** a configured extension whose package name is
  `@sigrun/ext-gateway` replaces the built-in.
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
  by core; opaque transport-private button tokens.

**Dropped:** profiles/multiplexing, relay, hosted rooms, scale-to-zero,
multi-agent bindings and broadcast groups, OpenClaw's capability-proof
verification helpers and SDK compatibility layers, per-platform enum
edits across core (Hermes's 16-step built-in checklist is exactly what
the contract replaces).

## 13. Calls I made (marked in the text)

- One factory result carries every engine surface, with one delivery job
  per surface (§8.0).
- The `pi.live` narrowing moves into `@sigrun/shared`, shared by the webui
  and the engine.

- Self-linking (`/link`) in addition to pairing and allowlists.
- Groups share one conversation per group (not per member).
- Archived bound conversations unarchive on new chat messages.
- Album merging only, no time-based burst merging.
- No timestamps in the envelope.
- Final answers are text; outbound media only via `send_message`.
- Hashed chat/sender ids in info-level logs.
- Channel id collisions quarantine instead of last-wins.

## 14. Dependencies and left to the builder

**UI blocks:** when the UI-blocks spec lands, interaction records become
block trees. The gateway then renders through a shared plain/markdown
fallback renderer in `@sigrun/shared`, which the UI-blocks work should
provide. Until then it renders the current `InteractionBody` (§8.7).

**Left to the builder:**

- **Storage:** JSON files vs a single sqlite for gateway state;
  atomicity via temp-file + rename either way.
- **Markdown handling:** the stripper/splitter implementation and its
  edge cases.
- **Throttling:** exact first-send and edit thresholds within the stated
  bounds.
- **Wording** of the engine's own chat messages.
- **Plan phasing.** Suggested order:
  1. core C1–C7 plus the engine skeleton with the loopback fixture;
  2. the engine features;
  3. `sigrun-channel-telegram` (its own spec/plan).
