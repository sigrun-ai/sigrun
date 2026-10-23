# Sigrun gateway — engine (plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@sigrun/ext-gateway` (spec §8) in a new repo, register it as sigrun's fourth built-in (C3), and prove the spec §10 scenarios end to end over a real sigrun boot.

**Architecture:** One factory returns every engine surface (spec §8.0). Engine logic is split into small modules with a narrow dependency on the `SigrunHost` surface, unit-tested in the engine repo against an in-memory `FakeHost`. The spec §10 scenarios run in the sigrun repo against the real built-in plus a plain-JS loopback adapter fixture, because only the sigrun repo can boot sigrun (its internals are not exported, and it runs from `src/` via tsx).

**Tech Stack:** TypeScript (NodeNext), pi-durable 1.3.0 (`defineExtension`, `section`, tool registration as other core extensions do), vitest. Repo shape copied from `~/repos/sigrun-ext-codemode` (scripts/check-manifest.mjs, tsconfig.json + tsconfig.build.json, committed `dist/`).

**Spec:** `docs/superpowers/specs/2026-10-22-sigrun-gateway-design.md` (rev 2). Depends on plan 1 (`docs/superpowers/plans/2026-10-22-sigrun-gateway-core.md`) being merged: every type named below from `@sigrun/sigrun/extension` lands there.

## Coordination with UI blocks (interleaved, ruling 2026-10-22)

- **Order:** Tasks 1–8 and 10–12 run once plan 1 is merged, in any relation to the UI-blocks plans. **Task 9 waits for U6** (`docs/superpowers/plans/2026-10-19-ui-blocks-u6-interactions-ambient.md`) to merge: U6 replaces interaction bodies with block trees and answers with `{values}`, with no compatibility layer, so Task 9 is written against those shapes and renders through U0's `toText` (`@sigrun/shared/blocks`). This is the spec §14 successor path, applied up front.
- **If Task 9 runs after Task 12:** Task 9's last step re-runs Task 12's final gate and adds the interactions section to the engine README.
- **Sigrun-repo worktree:** the sigrun side of each task (C3, `test/gateway/*`, fixtures) runs in `.worktrees/gateway-engine` on `feat/gateway-engine`, cut from `main` after plan 1 merges. The plan 1 merge rule applies: the later merge rebases and re-runs its gate.
- **Shared sigrun files:** `src/harness/builtins.ts`, `src/harness/settings.ts`, `shared/src/settings.ts` (Task 1, `builtinExtensions.gateway`) overlap U4's settings work; additive, keep both sides. `test/fixtures/fixture-gate` (used by Task 9's e2e) is rewritten by U6 to a tree with a `choice` named `decision` (`allow`/`deny`) and a `longtext` named `reason`; Task 9's e2e expects that shape.


## Global Constraints

- Engine repo: `~/repos/sigrun-ext-gateway`, package `@sigrun/ext-gateway` 0.1.0, MIT, `engines.node >=22.19.0`, `main`/`types`/`exports` like codemode. `peerDependencies` and mirrored `devDependencies`: `@earendil-works/pi-durable` 1.3.0, `@earendil-works/chord` 1.3.0, `@sigrun/shared`. The published `@sigrun/shared` 0.1.0 lacks `./live` (plan 1) and `./blocks` (U0), so the dev shape is `"@sigrun/shared": "file:../sigrun/shared"` (the built-ins' `file:` convention); publishing the engine needs a `@sigrun/shared` release carrying both subpaths and swaps the specifier to that semver. `devDependencies` also `@sigrun/sigrun: "file:../sigrun"` (types only: every import from it is `import type`). `dependencies` empty.
- Commit `dist/` with every source change (`npm run build`, clean `git status -- dist`); sigrun resolves the built-in from `dist/index.js` through core's tree.
- Engine repo verification per task: `npm test && npm run typecheck && npm run build`. Sigrun repo verification when it moved: `npm test && npm run typecheck`. Sigrun e2e tests need the engine built first.
- Repo identity: set `git config user.name/user.email/user.signingkey` repo-locally in the new repo before the first commit (no remote yet, so includeIf does not fire); remote `https://github.com/sigrun-ai/sigrun-ext-gateway.git` is NOT added or pushed by this plan.
- State lives only under `host.stores.paths.state` (= `<stateDir>/gateway/`), created by the engine at `start`. Every state file is written temp-file + rename, mode `0600`.
- Logs: chat ids, sender ids and binding keys go through `hashId` at info level (8 hex of sha256); verbatim only at debug.
- Values pinned by the spec (use these exact numbers):
  - pairing/link code: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` via `crypto.randomInt`, TTL 3 600 000 ms;
  - pairing limits: 1 pending per sender, 1 request per sender per 600 000 ms, 3 pending per channel;
  - dedupe window 86 400 000 ms; album merge window 1 500 ms;
  - bot loop guard: 10 admitted bot messages per chat per 60 000 ms, then 300 000 ms cooldown;
  - streaming: first send at ≥ 20 visible chars, edits no faster than `capabilities.edit.minIntervalMs`;
  - retries: 1 000, 5 000, 30 000 ms then `failed`; delivered entries pruned after 604 800 000 ms;
  - supervisor backoff: 1 000 ms doubling to 300 000 ms plus jitter, reset after 600 000 ms running; degraded after 300 000 ms in `backoff`/`failed` or a `failed` ledger entry in the last 3 600 000 ms;
  - shutdown: delivery drain 10 000 ms total, adapter stop 5 000 ms;
  - `send_message` waits for its receipt up to 30 000 ms; reply-quote truncation 500 chars;
  - button token ≤ 64 bytes; `media.maxBytes` default 16 777 216.
- Engine copy (exact strings the spec fixes): `"Stopped."`; `"(resent after restart)"`; `"[attachment skipped: too large]"`; `"[voice note attached; transcription unavailable]"`; `"The model <ref> is not available. Use /model to pick another."`; `"run this as a named user"`; `"send this in a direct message"`; `"Answer this in the webui"`; `"Reply with a number."`. Every other engine message is the implementer's wording.
- Tests own their literals: synthetic ids (`"100000001"`, `"-100000000002"`), users `alice`/`bob`, `example.invalid`.

**Plan-time decisions (not in the spec, recorded here):**

1. The spec §10 scenarios live in the sigrun repo (`test/gateway/*.test.ts`) over the real built-in plus `test/fixtures/fixture-loopback-channel`; the engine repo carries module-level unit tests against `test/fake-host.ts`. Reason: only the sigrun repo can boot sigrun.
2. A channel block present in `channels` without `enabled` is enabled (`enabled` defaults to `true`).
3. `adapter.send`/`edit` calls are bounded at 60 000 ms; a timeout is classified `transient` (Review Focus 2).
4. An answered run whose text is empty after joining text blocks delivers a short "(no text reply)" notice instead of an empty message (Review Focus 4).

## Review Focus

1. **The same platform message delivered twice concurrently** (a webhook retry arriving before the first `receive` resolves) — exactly one submission; the second resolves `"dropped"`. The seen set must be in-flight-aware. Test owned by Task 3.
2. **An adapter `send` that never resolves** — the per-channel delivery worker must not wedge; the 60 s bound classifies it transient and later entries still go out. Test owned by Task 5.
3. **A group removed from `groups[]` while the gateway runs** — the next message from that group is ignored (logged once), and its bound conversation stays intact. Test owned by Task 8.
4. **A run that answers with no text** (tool calls / thinking only) — the chat gets the "(no text reply)" notice, never an empty send the platform would reject. Test owned by Task 5.
5. **An unterminated code fence in a model answer** (final and streamed) — the splitter terminates, the chunks are valid, and nothing throws. Test owned by Task 5 (final) and Task 6 (stream).

---

### Task 1: Repo scaffold, config, state files, FakeHost, built-in registration (C3), smoke e2e

**Files (engine repo):**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `scripts/check-manifest.mjs` (copied from codemode, name `@sigrun/ext-gateway`), `.gitignore` (dist tracked), `README.md`, `AGENTS.md` (codemode's shape, gateway layout), `LICENSE`, `CHANGELOG.md`
- Create: `src/index.ts` (factory), `src/engine.ts`, `src/config.ts`, `src/state/json-file.ts`, `src/log.ts`
- Test: `test/fake-host.ts`, `test/config.test.ts`, `test/json-file.test.ts`, `test/factory.test.ts`

**Files (sigrun repo):**
- Modify: `src/harness/builtins.ts` (`BUILTIN_EXTENSIONS` entry + `key` union), `src/harness/settings.ts:484-492` and `shared/src/settings.ts` `BuiltinExtensionsSettings` (add `gateway`), `package.json` (`"@sigrun/ext-gateway": "file:../sigrun-ext-gateway"`), `docs/extending.md` + `README.md` (built-in list)
- Create: `test/fixtures/fixture-loopback-channel/index.js`, `test/gateway/harness.ts`, `test/gateway/smoke.test.ts`
- Test: `test/builtins.test.ts` (extend)

**Interfaces:**
- Produces (`src/config.ts`):
  ```ts
  type DmPolicy = "pairing" | "allowlist" | "disabled";
  interface GroupConfig { readonly chat: string; readonly owner: string; readonly mention: "required" | "always"; readonly members: "linked" | "anyone"; readonly tools?: readonly string[]; readonly extensions?: readonly string[] }
  interface ChannelConfig { readonly enabled: boolean; readonly dm: DmPolicy; readonly selfLink: boolean; readonly allow: readonly { sender: string; user: string }[]; readonly groups: readonly (GroupConfig | { readonly chat: string; readonly failed: string })[]; readonly busy: "followUp" | "steer"; readonly stream: boolean; readonly allowBots: boolean }
  interface GatewayConfig { readonly channels: Readonly<Record<string, ChannelConfig | { readonly failed: string }>>; readonly media: { readonly maxBytes: number }; readonly notify: { readonly home: boolean } }
  function parseGatewayConfig(raw: Record<string, unknown>): GatewayConfig;
  function readConfig(host: SigrunHost): Promise<GatewayConfig>; // parse per call (live config)
  ```
  Defaults: `enabled: true`, `dm: "pairing"`, `selfLink: dm === "pairing"`, `allow: []`, `groups: []`, `busy: "followUp"`, `stream: true`, `allowBots: false`, group `mention: "required"`, `members: "linked"`, `media.maxBytes: 16777216`, `notify.home: true`. A `members: "anyone"` group without a non-empty `tools` array is `{chat, failed}`. When `extensions` is given for an `anyone` group, the parser appends `"gateway"` if absent (spec §8.10).
- Produces (`src/state/json-file.ts`): `class JsonFile<T> { constructor(path: string, initial: () => T); read(): Promise<T>; update(mutate: (draft: T) => void | Promise<void>): Promise<T> }` — serialized updates, atomic write, mode `0600`, a malformed file throws naming the path.
- Produces (`src/log.ts`): `hashId(id: string): string`; `createLog(scope: string): { info, warn, error, debug, once(key: string, level: "info" | "warn", msg: string) }`.
- Produces (`src/engine.ts`): `createEngine(host: SigrunHost, deps: EngineDeps): GatewayEngine & EngineInternals` — Task 1 implements `start` (mkdir state dir; records channels), `stopIntake`, `stop`, `health` returning `"ok"`; later tasks fill in.
- Produces (`src/index.ts`): `export default function createGateway(host: SigrunHost): SigrunExtensionResult` with `extension: defineExtension({ name: "gateway" })` and `gateway: engine`; later tasks add fields.
- Produces (`test/fake-host.ts`, engine repo): `createFakeHost(opts?): FakeHost` implementing every `SigrunHost` member the engine uses, in memory: conversations (records creates, submits with `SubmissionRecordWire`-shaped returns, `watch` driven by `fake.pushView(id, view)`, `meta`/`patchMeta`, `abort`, `configure`, `compact`, `fork`, `upload`/`readFile` over a Map), `models.list`, `commands.list/run`, `users` (seeded), `access.accessOf` (via `@sigrun/shared/access`), `identity.actingUser`, interactions (`seedInteraction`/`answerInteraction`/`snapshotInteraction`/`settleInteraction` with C5's `user`), `stores` over a temp dir; plus `fake.calls` (ordered call log) and `fake.setClaimed(boolean)` (backs `users.list().length`).
- Produces (sigrun `test/fixtures/fixture-loopback-channel/index.js`): contributor-only `{ name: "fixture-loopback-channel", channels: [loop] }` with id `loop`, label `Loop`; capabilities configurable through `globalThis.__loopCaps` (default `{chatTypes: ["dm","group","thread"], maxMessageLength: 200, format: "markdown", edit: {minIntervalMs: 10}, buttons: {max: 3}, media: ["image","document"], typing: {intervalMs: 50}, replyTo: true, commandMenu: true, promptHint: "Loop renders markdown."}`); `globalThis.__loop` exposes `{ ctx, sent: [], edits: [], typing: [], commands: [], failNext(kind), hangNext(), inbound(event), tap(event) }`; `configured()` returns `globalThis.__loopConfigured ?? {status: "ready"}`.
- Produces (sigrun `test/gateway/harness.ts`): `bootGateway(opts: { settings?: object; gatewaySettings?: object; users?: { user: string; admin?: boolean }[]; responses?: AssistantMessage[] }): Promise<GatewayBoot>` — the `host-conversations.test.ts` boot (faux provider, token auth, claimed directory) with the built-in gateway enabled, the loopback fixture loaded, `settings/gateway.json` written, `startGateway` started; `GatewayBoot { opened, app, loop, faux, tokens: Record<string, string>, shutdown(): Promise<void>, waitFor(pred, ms?): Promise<void> }`.

- [ ] **Step 1: Scaffold the engine repo** from codemode's files (names changed), `npm install`, set repo-local git identity, `git init` commit of the empty scaffold after Step 4.
- [ ] **Step 2: Write the failing engine tests:** `config.test.ts` (each default above; `anyone` without tools → `failed`; `extensions: ["x"]` → `["x","gateway"]`; a malformed channel block → `{failed}` while a sibling parses); `json-file.test.ts` (concurrent `update`s serialize; file mode `0o600`; malformed JSON throws naming the path); `factory.test.ts` (factory returns `extension.name === "gateway"` and a `gateway` with four functions; `start` creates the state dir).
- [ ] **Step 3: Run** `npx vitest run` — Expected: FAIL.
- [ ] **Step 4: Implement** the four modules and the skeleton; `npm test && npm run typecheck && npm run build` — Expected: PASS; commit `chore: scaffold @sigrun/ext-gateway` (dist included).
- [ ] **Step 5: Sigrun repo — write the failing tests:** `builtins.test.ts`: the gateway built-in loads by default with row `builtin: true`; `builtinExtensions: {gateway: false}` removes it and makes the loopback row `inert: "no gateway"`; settings validation accepts `gateway: false` and rejects `gateway: "no"`. `test/gateway/smoke.test.ts`: `bootGateway({gatewaySettings: {channels: {loop: {}}}})` → the engine's `start` ran once with the `loop` channel: `/v1/meta` `health.gateway === "ok"` and the `gateway` row in `/v1/extensions` is `ok` (the status route arrives in Task 2).
- [ ] **Step 6: Run** `npx vitest run test/builtins.test.ts test/gateway/smoke.test.ts` — Expected: FAIL. **Implement** the C3 entry (`{ key: "gateway", specifier: "@sigrun/ext-gateway", slug: "gateway" }`), the settings widening, the `file:` dependency (`npm install`), and the harness + fixture. **Run** again — Expected: PASS; `npm test && npm run typecheck`.
- [ ] **Step 7: Commit (sigrun)** `feat: gateway as the fourth built-in (gateway C3)`

### Task 2: Supervisor, status route, health

**Files (engine):** Create `src/supervisor.ts`, `src/status-route.ts`; modify `src/engine.ts`, `src/index.ts` (`routes`). Test `test/supervisor.test.ts`.
**Files (sigrun):** `test/gateway/supervisor.test.ts`.

**Interfaces:**
- Produces (`src/supervisor.ts`): `type ChannelState = "stopped" | "not_configured" | "connecting" | "running" | "backoff" | "failed"`; `class Supervisor { constructor(entry: { extension: string; channel: ChannelContribution }, deps: { makeContext(signal: AbortSignal, report: StatusSink): ChannelContext; now(): number; random(): number; setTimer(fn, ms): () => void; log }); start(): Promise<void>; stop(): Promise<void>; status(): ChannelStatus }` where `ChannelStatus { state: ChannelState; detail?: string; since: number; lastError?: string; counts: { admitted: number; dropped: number; delivered: number; failed: number } }`. Backoff per Global Constraints; `ctx.fail` and a rejected `start` both enter `backoff`; a config `failed` channel is never started.
- Produces: `engine.health()` per spec §8.12 (reads supervisor statuses and the ledger's failed-in-last-hour count — the ledger arrives in Task 5; until then the count reads 0 through a `failedRecently(): number` dependency the engine holds).
- Produces: route `{ method: "GET", path: "status", auth: "admin" }` → `{ channels: Record<string, ChannelStatus>, pairing: { channel: string; sender: string /* hashed */; createdAt: number }[] }` (pairing list empty until Task 4).

- [ ] **Step 1: Write the failing tests** (engine, fake timers): `not_configured` adapter never started; `start` reject → `backoff` with delays 1000, 2000, 4000 … capped 300000 (jitter via injected `random()`); running 600000 ms resets the delay; `ctx.fail` after running → `backoff`; `health()` `degraded` only after 300000 ms in `backoff`. Sigrun: `__loopConfigured = {status: "not_configured"}` → status route shows `not_configured`; a `failNext("start")` → `backoff` then `running`; `GET status` as a non-admin token → 403.
- [ ] **Step 2: Run** engine `npx vitest run test/supervisor.test.ts`, sigrun `npx vitest run test/gateway/supervisor.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: adapter supervision and status`; sigrun `test(gateway): supervision e2e`.

### Task 3: Bindings, inbound pipeline, submit (allowlisted DMs)

**Files (engine):** Create `src/state/bindings.ts`, `src/state/seen.ts`, `src/state/identities.ts`, `src/inbound/pipeline.ts`, `src/inbound/envelope.ts`, `src/inbound/albums.ts`; modify `src/engine.ts` (`makeContext.receive`). Tests `test/bindings.test.ts`, `test/pipeline.test.ts`, `test/envelope.test.ts`.
**Files (sigrun):** `test/gateway/inbound.test.ts`.

**Interfaces:**
- Produces (`src/state/bindings.ts`): `bindingKey(channel: string, chat: ChatRef): string` = `` `${channel}:default:${chat.chatType}:${chat.chatId}` `` plus `` `:${chat.threadId}` `` when present; `class BindingStore { get(key): Binding | undefined; bind(key, conversationId: number, chat: ChatRef): Promise<void>; unbind(key): Promise<void>; keysOf(conversationId: number): readonly string[]; markDead(key): Promise<void>; clearDead(key): Promise<void> }` with `Binding { conversationId: number; chat: ChatRef; boundAt: number; previous: number[]; dead?: boolean }`, persisted at `bindings.json`.
- Produces (`src/state/seen.ts`): `class SeenSet { claim(id: string, now: number): boolean /* false if seen or in flight */; release(id: string): void /* in-flight failure */; commit(id: string, now: number): Promise<void> }`, persisted at `seen.json`, entries older than 86 400 000 ms dropped on write.
- Produces (`src/state/identities.ts`): `class IdentityStore { userFor(config: ChannelConfig, channel: string, senderId: string): { user: string; via: "allow" | "link" } | undefined; link(channel, senderId, user, via: "pairing" | "self", dmChat: ChatRef): Promise<void>; unlinkUser(user): Promise<void>; homesOf(user): readonly { channel: string; chat: ChatRef }[]; setHome(user, channel, chat: ChatRef): Promise<void> }` — allowlist wins over a link (conflict logged once); first link sets the home chat; persisted at `identities.json`.
- Produces (`src/inbound/envelope.ts`): `buildEnvelope(event: InboundEvent, opts: { group: boolean; senderLabel: string }): string` — group `[<label>] <text>`; reply `> <quoted, ≤500 chars>\n(replying to <author>)\n\n` prefix; DM text as-is.
- Produces (`src/inbound/pipeline.ts`): `createPipeline(deps: PipelineDeps): (channelId: string, event: InboundEvent) => Promise<{ outcome: "admitted" | "dropped" | "command" }>` running spec §8.4 steps in order; Task 3 implements steps 2, 3 (self/bot without the loop guard), 5 (allowlist/link DMs only; everything else dropped), 6, 10 and the submit-error outcomes. Steps 1, 4, 7, 8, 9 are injectable stages filled by Tasks 4, 7, 9, 11 (`PipelineDeps.stages`). On admission the pipeline records `submissionId → { bindingKey, channel }` in `deps.origins` (an in-memory `Map` the outbound tasks consume) and returns `"admitted"`.
- Submit call: `host.conversations.submit(conversationId, parts, { user, requestId: \`${bindingKey}:${event.messageId}\`, whenBusy: channelConfig.busy })`. Creation of an unbound chat's conversation: `create({ owner: user, source: "gateway", name: chat.title ?? "<Label> DM" })`. A bound archived conversation is unarchived via `patchMeta({archived: false})` before submit.

- [ ] **Step 1: Write the failing tests.** Engine: binding key shapes (dm, group, thread); `SeenSet.claim` false for an in-flight id (Review Focus 1) and for a committed id inside 24 h, true again after; envelope cases incl. 500-char truncation; pipeline on FakeHost: allowlisted DM creates one conversation (owner `alice`, source `gateway`, name `"Loop DM"`), second message reuses it, `requestId` shape, `whenBusy` from config, unknown DM dropped, `fromSelf` dropped, `isBot` dropped unless `allowBots`, album of 3 events with one `groupId` within 1 500 ms → one submit, `UnservedModelError` → reply notice text exactly as pinned and `"dropped"`, other `ConversationOpError` → `"dropped"` with a notice, an unexpected throw rejects and `SeenSet.release`s the id. Sigrun e2e: allowlisted `loop` DM → conversation exists with `source: "gateway"`; the same `messageId` twice concurrently → one submission (Review Focus 1); redelivery after a gateway restart (shutdown + re-boot over the same dirs) → no second submission; archived bound conversation unarchives.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: bindings and inbound pipeline`; sigrun `test(gateway): inbound e2e`.

### Task 4: Access — claimed gate, DM policies, pairing, self-linking, `/pair` and `/link`, loop guard

**Files (engine):** Create `src/access/codes.ts`, `src/access/pairing.ts`, `src/access/link-codes.ts`, `src/access/loop-guard.ts`, `src/inbound/tokens.ts`, `src/commands/pair.ts`, `src/commands/link.ts`; modify `src/inbound/pipeline.ts` (stages 1, 4, 5), `src/index.ts` (`commands: [pair, link]`), `src/status-route.ts` (pairing list). Tests `test/codes.test.ts`, `test/pairing.test.ts`, `test/access.test.ts`.
**Files (sigrun):** `test/gateway/access.test.ts`.

**Interfaces:**
- Produces (`src/access/codes.ts`): `CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"`; `newCode(): string`; `normalizeCode(input: string): string` (uppercase, drop characters outside the alphabet).
- Produces (`src/access/pairing.ts`): `class PairingStore { request(channel, sender: { id: string; name?: string }, chat: ChatRef, now): { code: string } | { limited: "sender" | "cooldown" | "channel" }; pending(channel?: string): readonly PairingRequest[]; approve(code: string, now): PairingRequest | undefined; deny(code: string): boolean }`, `PairingRequest { code; channel; senderId; senderName?; chat: ChatRef; createdAt }`, persisted at `pairing.json`; expired entries dropped on read.
- Produces (`src/access/link-codes.ts`): `class LinkCodes { issue(user: string, channel: string, now): string; redeem(code: string, channel: string, now): string | undefined /* user, single use */; invalidate(code: string): void }` (in memory: a restart voids outstanding link codes).
- Produces (`src/commands/pair.ts`): `runPair(deps, args: string, caller: { user: string | undefined; admin: boolean }): Promise<string>` — `""` lists; `approve <code> <user>` links the requester (`via: "pairing"`, home = the requester's DM) and sends them a "linked" message; `deny <code>`; refuses a `user` absent from `host.users`; refuses non-admins; refuses `caller.user === undefined` with `"run this as a named user"`. Webui/TUI command: `{ name: "pair", description, args: "[approve <code> <user> | deny <code>]", run(ctx) }` using `ctx.principal`.
- Produces (`src/commands/link.ts`): webui/TUI command `link` with `args: "<channel>"` → notice with the code and the instruction to DM it to the bot; refuses an unknown or disabled channel and `"run this as a named user"`. Chat side `redeemLink(channel, event): Promise<string>` used by pipeline stage 4.
- Produces (`src/access/loop-guard.ts`): `class LoopGuard { admit(chatKey: string, now: number): boolean }` with the pinned window/cap/cooldown.
- Pipeline stages: 1 (claimed gate: `(await host.users.list()).length === 0` → drop, log once per channel); 4 (`/link <code>` before access when `selfLink`; in a group → reply `"send this in a direct message"`, invalidate, `"command"`); 5 (`dm` policy: `disabled` drop; `allowlist` drop + `log.once` per sender per day; `pairing` → `PairingStore.request` → one reply with the code on success, nothing when limited; pairing notices to every effective admin's home DMs with text commands, plus "Approve as <user>" buttons per user and Deny when `buttons` fit (`users.length <= buttons.max - 1`); button taps route through Task 9's token table, so Task 4 registers its tokens with the same `ButtonTokens` class defined here: `src/inbound/tokens.ts` `class ButtonTokens { issue(action: TokenAction): string; resolve(token: string): TokenAction | undefined }`, `TokenAction = { kind: "pair"; code: string; decision: "approve" | "deny"; user?: string } | { kind: "interaction"; conversationId: number; callId: string; optionId: string }`, tokens `t:` + 16 base32 chars).

- [ ] **Step 1: Write the failing tests.** Engine: code alphabet/length; `normalizeCode(" abcd-efgh ")` → `"ABCDEFGH"`; pairing limits (second pending per sender → `sender`; new request within 600 000 ms of the last → `cooldown`; fourth pending in a channel → `channel`; expiry at 3 600 000 ms); link codes single-use and channel-bound; `runPair` refusals; loop guard thresholds. Sigrun e2e (spec §10 list): unclaimed setup drops inbound (boot with an unclaimed directory); unknown DM → pairing reply → `/pair approve <code> bob` from alice-the-admin's webui token (`POST /v1/conversations/:id/commands/pair`) → bob's next message admitted with owner `bob`; the requester's first message was not submitted; pairing limits through the wire; self-link round trip (`/link loop` via HTTP → code → loop DM `/link <code>` → linked to `alice`); `/link <code>` in a group refused and the code then fails in a DM; `selfLink: false` on an `allowlist` channel drops `/link`; an admins-group proxy user (C8) can approve, a plain user cannot; pending pairing appears in `GET status` without the code.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: access control, pairing and self-linking`; sigrun `test(gateway): access e2e`.

### Task 5: Final delivery — formatting, ledger, delivery worker, `runSettled`

**Files (engine):** Create `src/outbound/markdown.ts`, `src/outbound/render.ts`, `src/state/ledger.ts`, `src/outbound/delivery.ts`, `src/outbound/settled.ts`; modify `src/index.ts` (`runSettled`), `src/engine.ts` (workers per channel; `failedRecently`). Tests `test/markdown.test.ts`, `test/ledger.test.ts`, `test/delivery.test.ts`, `test/settled.test.ts`.
**Files (sigrun):** `test/gateway/outbound.test.ts`.

**Interfaces:**
- Produces (`src/outbound/markdown.ts`): `splitMarkdown(text: string, limit: number): string[]` (paragraph, then line, then hard; a fence cut by a split is closed in the earlier chunk and reopened with its info string in the next; an unterminated fence in the input is treated as running to the end); `stripMarkdown(text: string): string` (headings, emphasis, links → `text (url)`, fences → plain blocks).
- Produces (`src/outbound/render.ts`): `renderChunks(markdown: string, caps: ChannelCapabilities, format?: (md: string) => string): string[]` — the spec §8.6 three-step order.
- Produces (`src/state/ledger.ts`): `LedgerEntry { id: string; channel: string; bindingKey?: string; chat: ChatRef; kind: "final" | "notice" | "interaction" | "edit"; message: SerializedOutbound; ref?: MessageRef; state: "pending" | "attempting" | "delivered" | "failed"; attempts: number; createdAt: number; receipt?: string[]; tag?: string /* dedupe key, e.g. "final:<conversationId>:<answerEntryId>:<bindingKey>" */ }`; `class Ledger { enqueue(e: Omit<LedgerEntry, "id"|"state"|"attempts"|"createdAt">): Promise<LedgerEntry | undefined /* undefined when tag exists */>; nextPending(channel: string): LedgerEntry | undefined; mark(id, state, receipt?): Promise<void>; recoverAfterRestart(): Promise<void> /* attempting → pending with recovered flag */; failedSince(ts: number): number; prune(now): Promise<void> }` persisted at `ledger.json` (files `bytes` are not ledgered: entries with files carry a workspace path and conversation id and re-read via `readFile`).
- Produces (`src/outbound/delivery.ts`): `class DeliveryWorker { constructor(channel: ChannelContribution, ledger, deps: { bindings: BindingStore; timeoutMs: 60000; delays: [1000, 5000, 30000]; setTimer; log }); kick(): void; drain(deadlineMs: number): Promise<void>; stop(): void }` — one in-flight send per channel; `classifyError` mapping per spec; `chat_gone` → `bindings.markDead(key)`; recovered entries prefix `"(resent after restart)\n"`; a send exceeding 60 000 ms → transient (Review Focus 2).
- Produces (`src/outbound/settled.ts`): `onRunSettled(event: RunSettledEvent, deps): Promise<void>` — only enqueues: for each key in `bindings.keysOf(event.conversationId)` not dead, re-check access (`meta` + `accessOf` for the binding's user: the linked user for DMs, the group owner for groups; failure → `unbind` + log, skip); `answered` → `renderChunks(text)` → `final` entries (origin chat streaming hand-off arrives in Task 6 via `deps.streams.finalize`, a no-op stub here); empty text → "(no text reply)" notice (Review Focus 4); `unanswered` → a short notice to the origin chat only (from `deps.origins`), `"Stopped."` when the reason is an abort.
- The engine's `health()` now reads `ledger.failedSince(now - 3600000) > 0`.

- [ ] **Step 1: Write the failing tests.** Engine: `splitMarkdown` (paragraph/line/hard splits at limit 40; fence split reopens with ```` ```ts ````; unterminated fence input terminates and every chunk ≤ limit — Review Focus 5); `renderChunks` for `plain`/`markdown`/`native` incl. a native formatter that doubles length → hard-split; ledger state machine + tag dedupe + restart recovery + prune; delivery worker retries at 1/5/30 s then `failed`, `permanent` fails at once, `chat_gone` marks dead, a hung send times out at 60 s and the next entry still sends (Review Focus 2); settled: empty answer → notice; revoked access → unbind and nothing enqueued. Sigrun e2e: allowlisted DM → faux answer → one `loop.sent` with the answer text; a 450-char answer with `maxMessageLength: 200` → 3 sends; a webui-originated submit into a bound conversation → final delivered to the chat (ruling 4); `failNext("chat_gone")` → binding dead, next inbound clears it; crash recovery: an `attempting` ledger entry written before boot is resent with the marker; revoking sharing on an `/attach`-bound conversation (Task 7 adds `/attach`; here bind through `BindingStore` in the harness) unbinds and stops delivery.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: final delivery with durable ledger`; sigrun `test(gateway): outbound e2e`.

### Task 6: Streaming and typing

**Files (engine):** Create `src/outbound/stream.ts`; modify `src/inbound/pipeline.ts` (open a stream on admission), `src/outbound/settled.ts` (`streams.finalize`). Test `test/stream.test.ts`.
**Files (sigrun):** `test/gateway/stream.test.ts`.

**Interfaces:**
- Consumes: `liveGenerationText` from `@sigrun/shared/live` (plan 1 Task 1).
- Produces (`src/outbound/stream.ts`): `class StreamRegistry { open(conversationId: number, origin: { channel: string; bindingKey: string; chat: ChatRef }): Promise<void>; finalize(conversationId: number, chunks: string[]): Promise<boolean /* true when the stream owned delivery */>; abandon(conversationId: number): void }`. With `stream` on and `caps.edit`: watch → first `send` once the visible (stripped, trimmed) text ≥ 20 chars → `edit` throttled by `edit.minIntervalMs`; a frame that is not a prefix extension of the last sent text is skipped until one is; the final replaces the streamed message via `edit` with chunk 1 and sends the rest; an edit failure stops streaming and `finalize` returns `false` so `settled.ts` enqueues fresh finals. Without `edit`: `typing(chat)` every `typing.intervalMs` until finalize. The watch is released after finalize/abandon. Stream frames are not ledgered.

- [ ] **Step 1: Write the failing tests.** Engine (FakeHost `pushView` frames "Hel", "Hello wor", "Hello world, this is", a non-prefix frame, "Hello world, this is long"): no send before 20 visible chars; every edit text is a prefix-extension of the next; the non-prefix frame produces no edit; finalize text equals the settled answer, not the last frame; edit failure → `finalize` false; no-edit caps → typing calls then nothing; an unterminated fence mid-stream does not throw (Review Focus 5). Sigrun e2e with a faux streamed response: `loop.edits` prefix-stable and the last edit equals the `runSettled` answer; `__loopCaps.edit` undefined → `loop.typing` non-empty then one send.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: streaming replies`; sigrun `test(gateway): streaming e2e`.

### Task 7: Chat commands

**Files (engine):** Create `src/commands/chat.ts`; modify `src/inbound/pipeline.ts` (stage 7), `src/engine.ts` (`setCommands` at start). Test `test/chat-commands.test.ts`.
**Files (sigrun):** `test/gateway/commands.test.ts`.

**Interfaces:**
- Produces (`src/commands/chat.ts`): `GATEWAY_COMMANDS: readonly { name: string; description: string; where: "any" | "dm" | "not-anyone-group"; admin?: true }[]` exactly the spec §8.5 table (`new`, `stop`, `model`, `thinking`, `compact`, `attach`, `status`, `home`, `link`, `pair`, `help`); `handleChatCommand(deps, ctx: { channel; event; bindingKey; user: string | undefined; binding?: Binding; group?: GroupConfig }): Promise<"command" | "not-a-command">`. Parsing: leading `/`, name `[a-z][a-z0-9-]*`, optional `@botname` suffix stripped, rest = args. Unknown names fall through as `"not-a-command"` unless they match an extension command from `host.commands.list()` (entries carrying `extension`), which run through `host.commands.run(conversationId, name, args, { user })` with the `notice` sent as the reply. Write-access check before every command except `link` and `pair`.
- Behaviors: `/new` (create + rebind, old id pushed to `previous`); `/stop` (`abort`, reply `"Stopped."` comes from Task 5's unanswered notice, so the command itself replies nothing when a run was live and "Nothing is running." otherwise); `/model` (no arg: current `provider/modelId` + `models.list()` one per line; arg: `configure({model})`); `/thinking`; `/compact`; `/attach <id>` (write access via `accessOf`, refused in `anyone` groups); `/status`; `/home` (DM only, `setHome`); `/help` (gateway commands + extension commands, colliding extension names omitted). `setCommands` at start with the merged list when `caps.commandMenu`.

- [ ] **Step 1: Write the failing tests.** Engine: parsing (`/model@MyBot foo/bar` → name `model`, args `foo/bar`); `where` refusals (`/home` in a group, `/attach` in an `anyone` group); unknown `/foo` falls through as text; an extension command runs with the mapped user; a sender without write access is refused. Sigrun e2e: `/new` rebinds and the next message lands in the new conversation, the old one untouched; `/stop` during a delayed faux run → run aborted and `"Stopped."` sent; `/model faux/m` → `configure` observed; `/attach <webui-conversation-id>` → a webui-originated answer in that conversation reaches the chat; `/compact`; `loop.commands` received the merged menu at start.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: chat commands`; sigrun `test(gateway): chat command e2e`.

### Task 8: Groups — mention gating, member modes, sharing, live group config

**Files (engine):** Create `src/inbound/groups.ts`; modify `src/inbound/pipeline.ts` (stage 5 group branch, envelope labels), `src/state/bindings.ts` (group creation path). Test `test/groups.test.ts`.
**Files (sigrun):** `test/gateway/groups.test.ts`.

**Interfaces:**
- Produces (`src/inbound/groups.ts`): `admitGroupEvent(config: ChannelConfig, channel: string, event: InboundEvent, identities: IdentityStore): { admit: false; reason: "unlisted" | "failed" | "mention" | "unlinked" } | { admit: true; group: GroupConfig; user: string /* linked user or group.owner */; linked: boolean; senderLabel: string }`; `ensureGroupShare(host, conversationId, user): Promise<void>` — adds `user` to `sharing` (`scope: "people"`, level `write`) via `patchMeta` when absent, preserving existing people; never for the owner.
- Group conversation creation: `create({ owner: group.owner, source: "gateway", name: chat.title ?? "<Label> group", ...(group.members === "anyone" ? { agent: { tools: group.tools, ...(group.extensions === undefined ? {} : { extensions: group.extensions }) } } : {}) })`. Envelope label: linked → directory display name (`users.get(user).name ?? user`); unlinked → platform name + `" (not linked)"`. Config is read per event, so a group removed from `groups[]` is `unlisted` on its next message (logged once) and its binding is kept (Review Focus 3).

- [ ] **Step 1: Write the failing tests.** Engine: every `admitGroupEvent` reason; `mention: "always"` admits unmentioned; `ensureGroupShare` merges with an existing people share and is idempotent. Sigrun e2e (spec §10): unlisted group ignored; `mention: "required"` drops unmentioned; `linked` group drops an unlinked member and admits a linked one (envelope `[Alice] …`); `anyone` group admits an unlinked member (`[Mallory (not linked)] …`), its conversation offers exactly the configured tools (read the conversation's resolved agent through the harness), `/attach` refused; a linked member speaking gains `write` sharing; Review Focus 3: rewrite `settings/gateway.json` without the group → the next group message is dropped and `bindings.json` still holds the key.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: group modes and sharing`; sigrun `test(gateway): groups e2e`.

### Task 9: Interactions in chat (after U6)

**Runs after U6 merges** (see Coordination). Spec §8.7's behavior, expressed over U6's block-tree records.

**Files (engine):** Create `src/interactions/render.ts`, `src/interactions/answer.ts`, `src/interactions/prompts.ts`; modify `src/index.ts` (`notifiers`, `interactionSettled`), `src/inbound/pipeline.ts` (stage 8; `action` routing through `ButtonTokens`). Tests `test/interactions.test.ts`.
**Files (sigrun):** `test/gateway/interactions.test.ts`.

**Interfaces:**
- Consumes: C5 `answerInteraction(..., { user })`, C6 `callId` + `interactionSettled` (plan 1 Task 7); `ButtonTokens` (Task 4); from U0/U6: `InteractionRecord` with `body: Tree`, `InteractionAnswer = { values: Readonly<Record<string, JsonValue>> }`, `toText(tree, data, opts: TextOptions)` and the `FormBlock`/`Field`/`ChoiceField`/`ChoiceOption` types from `@sigrun/shared/blocks`.
- Produces (`src/interactions/render.ts`): `planInteraction(record: InteractionRecord, caps: ChannelCapabilities): ChatAnswerPlan` where
  ```ts
  type ChatAnswerPlan =
    | { kind: "choice"; field: string; options: readonly ChoiceOption[]; buttons: boolean } // buttons when options.length <= caps.buttons?.max
    | { kind: "text"; field: string }   // reply-to free text
    | { kind: "webui" };                // answer in the webui
  ```
  Rules over the tree's root `form` (no root `form` → `webui`):
  - exactly one `choice` field that is not `multi`, has no `allowOther`, and has literal (non-binding) `options`, and every other field is optional and of type `text`/`longtext` → `choice` (the optional fields are left out of the answer; U6's fixture-gate `decision` + `reason` takes this path);
  - exactly one field, of type `text` or `longtext` → `text`;
  - anything else (a `secret`, `number`, `toggle`, multi or open choice, two required fields, binding-valued options) → `webui`.
  `renderInteraction(record, caps, opts: { conversationName: string; link?: string }): { text: string; buttons?: OutboundMessage["buttons"] }` — text is `toText(record.body, {}, { width: 60, locale: "en" })` with the form's own field rendering omitted when the plan is `choice` (the buttons or the numbered list replace it), formatted per spec §8.6 and truncated to `maxMessageLength` with a "full details in the webui" note; `choice` + `buttons` → one button per option (tone `bad` → `style: "danger"`, `recommended` first, labels truncated to `labelMax`); `choice` without room → a numbered list plus `"Reply with a number."`; `text` → a "Reply to this message to answer." line; `webui` → `"Answer this in the webui"` + link.
- Produces (`src/interactions/prompts.ts`): `class PromptStore { record(conversationId, callId, key: string, ref: MessageRef, plan: ChatAnswerPlan): Promise<void>; refsOf(conversationId, callId): readonly MessageRef[]; has(conversationId, callId, key): boolean; pendingInChat(bindingKey): readonly { conversationId: number; callId: string; plan: ChatAnswerPlan }[] }` persisted at `prompts.json`.
- Notifier `gateway` on `interaction.pending`: `snapshotInteraction(conversationId, event.callId)`; bound conversation → one prompt per bound chat (key = bindingKey); unbound → the recipient's home chats (key = `user:<recipient>`); dedupe via `PromptStore.has`; enqueue `interaction` ledger entries.
- Produces (`src/interactions/answer.ts`): `answerFromChat(deps, { conversationId, callId, values: Record<string, JsonValue>, user: string | undefined }): Promise<string /* reply text */>` — refuses unlinked/no-write users; snapshot first: already terminal → reply with the outcome; else `answerInteraction(conversationId, callId, { values }, ctx, { user })`. A button tap answers `{ [plan.field]: optionId }`; stage 8: a numbered reply (only when `pendingInChat(key).length === 1` and that plan is `choice`) answers the numbered option; a reply-to on a `text` prompt answers `{ [plan.field]: replyText }`.
- `interactionSettled` handler: enqueue `edit` entries for every `refsOf` ref (outcome text, no buttons) when `caps.edit`; else one outcome `notice` to bound chats only.

- [ ] **Step 1: Write the failing tests.** Engine (trees built with U0's builders or literal JSON): `planInteraction` table — fixture-gate's `decision`+`reason` form → `choice` on `decision`; a lone `longtext` → `text`; `secret` present → `webui`; `multi` choice → `webui`; two required fields → `webui`; no root form → `webui`; binding-valued options → `webui`; button/numbered threshold at `buttons.max`; `bad` tone → danger style; `recommended` first; long `toText` output truncated with the note; dedupe per recipient; numbered answer with one vs two pending; stale tap reply. Sigrun e2e (fixture-gate, scripted faux tool call to `guarded_write`): approval via button tap (`allow` → the tool runs); via number; refused for an unlinked group member; a form with a `secret` field renders the webui pointer (a test-local fixture seeding such a record); an unbound (webui) conversation's approval reaches every write-access user's home chat (two users); answered in the webui → the chat prompt is edited (buttons removed) and a later tap replies with the outcome.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo. If Task 12 already ran: re-run its final gate and add the interactions section to the engine README.
- [ ] **Step 5: Commit** engine `feat: interactions in chat`; sigrun `test(gateway): interactions e2e`.

### Task 10: Home-chat notifications and job delivery

**Files (engine):** Create `src/notify.ts`, `src/jobs.ts`; modify `src/outbound/settled.ts` (deliver targets), the notifier (run.settled / job.failed branches). Tests `test/jobs.test.ts`, `test/notify.test.ts`.
**Files (sigrun):** `test/gateway/jobs.test.ts`.

**Interfaces:**
- Consumes: C7 `SessionMeta.deliver`/`jobId` (plan 1 Task 8).
- Produces (`src/jobs.ts`): `parseTarget(target: string): { channel: string; chatId?: string } | undefined` (grammar `"<channel>"` | `"<channel>:<chatId>"`, channel matches `^[a-z][a-z0-9-]*$`); `resolveTargets(deps, owner: string, targets: readonly string[]): Promise<{ resolved: { channel: string; chat: ChatRef }[]; rejected: { target: string; reason: string }[] }>` — `"<channel>"` → the owner's home DM; `"<channel>:<chatId>"` → allowed only when bound to a conversation the owner can write or equal to the owner's home DM chat id.
- `settled.ts`: when `meta.deliver` is set and the ledger has no `job:<conversationId>` tag yet, enqueue one final per resolved target with a header line `"Job <name>"` (`name` from the meta `name`), tag `job:<conversationId>:<target>`; later runs in that conversation find the tag and skip. Rejected targets are logged per run.
- Notifier: `run.settled` for an unbound conversation → `"Reply ready — <name>"` (+ link when `server.publicUrl` set, read from `event.url`) to the recipient's home DMs when `notify.home`; bound conversations skipped; `job.failed` → the event's recipient's home DMs.

- [ ] **Step 1: Write the failing tests.** Engine: `parseTarget` accept/reject table; `resolveTargets` home and explicit-chat rules; job tag dedupe. Sigrun e2e: a `"new"` prompt job with `deliver: ["loop"]` run via `POST /v1/jobs/:id/run` → the owner's home DM gets `"Job <name>"` + the answer; a second submit into that run conversation is not delivered; a job targeting a bound conversation (`conversation: <id>`) delivers through the binding with no `deliver`; `deliver: ["loop:999"]` for an unbound foreign chat → not sent, logged; a failed job → home DM notice; an unbound conversation's `run.settled` (no stream attached) → `"Reply ready — …"`, a bound one → no extra notice.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: home-chat notifications and job delivery`; sigrun `test(gateway): jobs e2e`.

### Task 11: Media, agent tools, prompt section

**Files (engine):** Create `src/inbound/media.ts`, `src/tools.ts`, `src/section.ts`; modify `src/index.ts` (extension `tools` + `sections`), `src/inbound/pipeline.ts` (stage 9). Tests `test/media.test.ts`, `test/tools.test.ts`, `test/section.test.ts`.
**Files (sigrun):** `test/gateway/media-tools.test.ts`.

**Interfaces:**
- Produces (`src/inbound/media.ts`): `collectAttachments(deps, conversationId: number, attachments: readonly InboundAttachment[], maxBytes: number, signal: AbortSignal): Promise<{ parts: SubmissionInputPart[]; notes: string[] }>` — declared `size > maxBytes` never fetched; `fetch({maxBytes, signal})` throwing an error with `name === "AttachmentTooLarge"` → the too-large note; other fetch errors → a "[attachment failed]" note and a warn log; `image` → image part, others → file part (`upload` path); `voice` adds the pinned voice note line.
- Produces (`src/tools.ts`): tools `send_message` (`{ to: string; text: string; files?: string[] }`) and `list_chats` (`{}`), declared with pi-durable's `defineTool` the way `src/harness/tools.ts` declares `imageReadTool`, resolving the acting user via `host.identity.actingUser(conversationId)`; policy refusals return an error result (`isError: true`), never throw; `send_message` enqueues via the ledger and waits up to 30 000 ms for `delivered`, returning `{ delivered: true, messageIds }` or `{ delivered: false, queued: true }`; files capped by `media.maxBytes`, kind mapped against `caps.media` (fallback `document`, else error).
- Produces (`src/section.ts`): section key `gateway-channel` rendering spec §8.10's text for bound conversations only (`input.conversationId` → `bindings.keysOf`), including the group and `anyone` lines and "(also connected to N more)"; `undefined` for unbound.

- [ ] **Step 1: Write the failing tests.** Engine: media size rules both ways (declared and streamed — the throw), voice note line, media-only message; `send_message` target refusals, file kind fallback, receipt timeout → queued; section text for DM, group, anyone group, multi-bound, unbound. Sigrun e2e: an image attachment becomes an image part on the submitted entry; an oversized declared attachment is never fetched (`fetch` spy count 0); the agent's `send_message` tool call (scripted faux tool call) to `loop` delivers to the home DM; the `gateway-channel` section appears in the rendered system prompt of a bound conversation and not in a webui one.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; full verification per repo.
- [ ] **Step 5: Commit** engine `feat: media, send_message and the channel prompt section`; sigrun `test(gateway): media and tools e2e`.

### Task 12: Shutdown, user deletion, docs, final gate

**Files (engine):** modify `src/engine.ts` (`stopIntake`, `stop` per spec §8.13), `src/index.ts` (`userDeleted`), `README.md` (operator guide: config reference §8.1, pairing/self-link, groups, jobs `deliver`, disabling), `AGENTS.md`, `CHANGELOG.md` (0.1.0). Test `test/shutdown.test.ts`.
**Files (sigrun):** `test/gateway/shutdown.test.ts`; `docs/extending.md` (link to the engine README for operators, the adapter-author section already exists from plan 1); `CHANGELOG.md` (Unreleased: gateway built-in).

**Interfaces:**
- `stopIntake()`: every later `receive`/`action` resolves `"dropped"` (no state written); adapters stay connected.
- `stop()`: `worker.drain(10000)` across channels in parallel, then abort signals and `Promise.race(adapter.stop(), 5000 ms)` per channel, release watches; leftover `pending`/`attempting` stay in the ledger.
- `userDeleted({ user })`: `identities.unlinkUser(user)` (links and home chats).

- [ ] **Step 1: Write the failing tests.** Engine: after `stopIntake`, `receive` resolves `"dropped"` and FakeHost saw no submit; `stop` drains a pending entry before aborting; a hanging `adapter.stop` is abandoned at 5 s; `userDeleted` removes links and homes. Sigrun e2e: a run settling during shutdown is delivered before the adapter stops (`loop.sent` has it, then the fixture logs `stop`); after a user is deleted (`DELETE /v1/users/bob` with transfer), bob's linked sender is unknown again (next DM triggers pairing).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** + docs.
- [ ] **Step 4: Final gate.** Engine: `npm test && npm run typecheck && npm run build && git status -- dist` (clean after commit). Sigrun: `npm test && npm run typecheck && npm run typecheck:webui && npm run build:webui` — Expected: all green.
- [ ] **Step 5: Commit** engine `feat: shutdown and user cleanup; docs`; sigrun `docs: gateway built-in`.
