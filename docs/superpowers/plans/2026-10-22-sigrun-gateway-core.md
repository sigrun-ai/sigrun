# Sigrun gateway — core seams (plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the core seams C1, C2, C4–C8 of the gateway spec in the sigrun repo, so a gateway engine and channel adapters can be built as extensions.

**Architecture:** Every change follows an existing core pattern: new factory-result fields are validated in `src/harness/loader.ts` and collected into `*Bindings` (like `notifiers`); new host methods extract the HTTP route bodies into `src/server/conversation-ops.ts` ops that both the route and `src/server/host-bridge.ts` call (like `submitOp`); new lifecycle handlers ride the event bus (like `userDeleted`). C3 (the built-in entry) is NOT here: it needs the engine package, so it lands in plan 2.

**Tech Stack:** TypeScript (NodeNext, run from `src/` via tsx), Fastify 5, pi-durable 1.3.0, vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-sigrun-gateway-design.md` (rev 2). Section refs below (§7, C4, …) point into it. Plan 2: `docs/superpowers/plans/2026-10-22-sigrun-gateway-engine.md`.

## Coordination with UI blocks (interleaved, ruling 2026-10-22)

This plan runs beside the UI-blocks workstream (U0–U7, `docs/superpowers/plans/2026-10-19-ui-blocks-u*.md`), not after it.

- **Where:** worktree `.worktrees/gateway-core` on branch `feat/gateway-core`, cut from `main`. U0 runs in `.worktrees/ui-blocks-u0`; one writer per worktree.
- **Merge rule:** whichever branch merges second rebases onto `main` and re-runs its full gate before merging. Conflicts below are additive: keep both sides.
- **Shared files (expect textual conflicts only):**

  | file | this plan | UI blocks |
  |---|---|---|
  | `shared/package.json` exports, `test/views-purity.test.ts` | Task 1 (`./live`) | U0 (`./blocks`, recursive purity scan) |
  | `src/harness/loader.ts` (`CandidateFactoryResult`, `LoaderReadKeys`, validators, bindings), `src/extension.ts` | Tasks 2, 3, 7 | U0, U3 (surfaces), U4 (settings sections) |
  | `shared/src/views.ts`, `src/server/routes/extensions.ts`, `src/server/routes/meta.ts` | Tasks 2, 3, 5, 6 | U0, U3, U4, U5, U6 |
  | `src/serve.ts` | Task 3 (shutdown extraction) | U4 (restart) |
  | `src/server/conversation-ops.ts`, `src/jobs/fire.ts` | Tasks 4, 6 (op extraction), 8 (`deliver` stamp) | U5 (`writePendingNote`, `submitOp` `entry`) — U5 changes only `submitOp` and the two `conversation.submit` sites; the extracted ops never call `submitOp` |
  | `src/harness/seam-host.ts`, `src/extension.ts` interaction types, `shared/src/interactions.ts` | Task 7 (C5, C6) | U6 (bodies → block trees, `InteractionAnswer` → `{values}`) |

- **Task 7 vs U6:** C5 and C6 do not depend on the interaction body or answer shape (`answerInteraction` takes the `InteractionAnswer` alias; `interactionSettled` carries `kind` and `status` only). Task 7's tests use whichever `InteractionAnswer` shape `main` has when the task runs; if U6 merges after Task 7, U6's test rewrite (its Task 1/2 "rewrite to trees") covers the attribution and `interactionSettled` cases too.

## Global Constraints

- Verification per task: `npm test` and `npm run typecheck` green; `npm --workspace @sigrun/shared run build` when `shared/` moved; `npm run typecheck:webui` and `npm run build:webui` when `webui/` moved.
- Contract types live in `src/extension.ts` (types-only, `import type` from `@sigrun/sigrun/extension`); no runtime code there.
- A malformed factory-result field quarantines the extension at load with a message naming the field (the existing loader rule).
- Host APIs are trusted in-process code: no per-principal gating in `host-bridge.ts`.
- Each host conversation method runs the SAME op as its HTTP route and throws the same `ConversationOpError` codes. An unknown conversation id throws `conversation <id> not found` (the bridge's `conversationOf`).
- Tests own their literals: synthetic users (`alice`, `tester`), `example.invalid` hosts, no real tokens; fixture packages are plain JS under `test/fixtures/`.
- Commits are signed (repo default) and small: one per task minimum.

**Plan-time deviations from the spec (recorded, not silent):**

1. §7's `AttachmentTooLarge` is identified by `error.name === "AttachmentTooLarge"` only. No `@sigrun/sigrun/extension-runtime` subpath ships: the spec already says the engine matches by name, and a runtime subpath would need core to self-link its own package into the packages dir. `src/extension.ts` exports `type AttachmentTooLargeName = "AttachmentTooLarge"` and documents the rule on `InboundAttachment.fetch`.
2. C8's "DirectoryUserWire exposes effective admin" is split: the host surface (`host.users.get/list`) returns `admin: record.admin || groupAdmin` plus `groupAdmin`; the HTTP `UserWire` keeps `admin` as the stored flag (the users-admin UI toggles it) and adds `groupAdmin?: boolean`. The last-admin guard keeps counting stored `admin` only.

## Review Focus

1. **A throwing engine** (`health()` throws, `start()` throws synchronously or rejects) — `/v1/meta` must still answer 200 with `health.gateway: "degraded"`, and boot must finish. Test owned by Task 3.
2. **Unknown conversation ids on every new host method** — each throws `conversation <id> not found`, never a silent no-op. Test owned by Task 4 (and Task 6 for upload/readFile).
3. **Upload names with path segments** (`"../x"`, `"a/b"`) through `host.conversations.upload` — rejected exactly like the HTTP route (`invalid_field: name`). Test owned by Task 6.
4. **`host.commands.run` with a user missing from the directory, or a core command name** — throws (`unknown user "<u>"` / `command_not_found`), never runs with a synthesized admin. Test owned by Task 6.
5. **`patchMeta` with `sharing` from the host** — succeeds with no owner principal (trusted host), unlike the HTTP route's owner gate. Test owned by Task 4.

---

### Task 1: `@sigrun/shared/live` — the `pi.live` narrowing

**Files:**
- Create: `shared/src/live.ts`
- Modify: `shared/package.json` (exports `./live`), `webui/src/entries/liveDoc.ts` (re-implement on top of shared), `webui/src/api.ts:336-351` (`LiveDocWire` becomes a re-export)
- Test: `test/shared-live.test.ts`

**Interfaces:**
- Produces (`@sigrun/shared/live`):
  - `interface LiveToolSlotWire { readonly callId: string; readonly name: string; readonly status: string; readonly output?: string }`
  - `interface LiveDocWire` — the current webui shape verbatim (`run?`, `generation?.message?`, `tools?`, `compactions?`, `compactionFailure?`), `tools` typed `readonly LiveToolSlotWire[]`
  - `liveDoc(view: ConversationViewBase): LiveDocWire | undefined`
  - `liveGenerationPartial(view): object | undefined` (object `generation.message`, else undefined)
  - `liveGenerationText(view): string` — the partial's `content` text blocks (`{type:"text"}`) joined with `""`; `""` when idle or content is not an array; a string `content` returns as-is
  - `liveToolSlots(view)`, `liveCompactions(view)`, `liveCompactionFailure(view)` — moved verbatim from webui

- [ ] **Step 1: Write the failing test** `test/shared-live.test.ts`: `liveGenerationText` returns `"Hello world"` for a view whose `docs["pi.live"].generation.message.content` is `[{type:"text",text:"Hello "},{type:"thinking",thinking:"x"},{type:"text",text:"world"}]`; returns `""` for `docs: {}`; `liveToolSlots` returns `[]` when `pi.live` is absent; `liveCompactionFailure` returns `undefined` for `{error: ""}`.
- [ ] **Step 2: Run** `npx vitest run test/shared-live.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `shared/src/live.ts` (imports only `type ConversationViewBase` from `./views.js`, the purity rule), add the `./live` export (`types` + `default` from `dist/live.*`), and make `webui/src/entries/liveDoc.ts` delegate to it (webui keeps its `MessageWire`-typed wrappers as casts over the shared results).
- [ ] **Step 4: Run** `npm --workspace @sigrun/shared run build && npx vitest run test/shared-live.test.ts test/views-purity.test.ts && npm run typecheck:webui && npm --workspace @sigrun/webui run test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): live-doc narrowing moves to @sigrun/shared/live`

### Task 2: C1 — the `channels` contribution field

**Files:**
- Modify: `src/extension.ts` (types of spec §7 + `channels` on `SigrunExtensionResult`), `src/harness/loader.ts` (validate, collide, collect), `src/harness/boot.ts` (thread `channelBindings`), `src/server/routes/extensions.ts` + `shared/src/views.ts` `ExtensionInfo` (`channels?: readonly string[]`), `docs/extending.md` (new "Channel adapters" section + factory-result table row)
- Create: `test/fixtures/fixture-channel-adapter/index.js` (contributor-only: `{name: "fixture-channel-adapter", channels: [loopback-shaped channel id "loop"]}`), `test/fixtures/fixture-channel-twin/index.js` (also declares id `loop`), `test/fixtures/fixture-channel-bad/index.js` (channel whose `send` is a string)
- Test: `test/loader-channels.test.ts`

**Interfaces:**
- Produces (`src/extension.ts`, exact names from spec §7): `ChannelContribution`, `ChannelReadiness`, `ChannelCapabilities`, `ChannelContext`, `ChatRef`, `MessageRef`, `InboundEvent`, `InboundAttachment` (with `fetch(opts: { maxBytes: number; signal: AbortSignal })`), `ActionEvent`, `OutboundMessage`, `SendReceipt`, `type AttachmentTooLargeName = "AttachmentTooLarge"`; `SigrunExtensionResult.channels?: readonly ChannelContribution[]`.
- Produces (`src/harness/loader.ts`): `interface ExtensionChannelBinding { readonly extension: string; readonly channels: readonly ChannelContribution[] }`; `LoadResult.channelBindings: readonly ExtensionChannelBinding[]`; `ExtensionOutcome.channels?: readonly string[]`.
- Produces (`src/harness/boot.ts`): `OpenedHarness.channelBindings: readonly ExtensionChannelBinding[]`.

- [ ] **Step 1: Write the failing tests** in `test/loader-channels.test.ts` (the `loader-providers.test.ts` boot pattern):
  - `fixture-channel-adapter` loads `status: "ok"`, `channelBindings` is `[{extension: "fixture-channel-adapter", channels: [<id "loop">]}]`, and its `/v1/extensions` row has `channels: ["loop"]`;
  - loading adapter then twin: twin row is `status: "quarantined"` with error containing `channel "loop" is already contributed by "fixture-channel-adapter"`, and `channelBindings` has one entry;
  - `fixture-channel-bad` quarantines with an error containing `channel "loop"` and `send is not a function`;
  - each validation rule rejects (table-driven over an in-memory factory): id `"Loop"`, empty `label`, `capabilities.maxMessageLength: 0`, `capabilities.chatTypes: []`, `capabilities.format: "html"`, missing `configured`, `edit` present but not a function.
- [ ] **Step 2: Run** `npx vitest run test/loader-channels.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `validateChannels(value: unknown): readonly ChannelContribution[] | undefined` beside `validateNotifiers`. Rules: array; `id` matches `^[a-z][a-z0-9-]*$`; `label` non-empty string; `capabilities` object with `chatTypes` a non-empty array over `dm|group|thread`, `maxMessageLength` a positive integer, `format` one of `plain|markdown|native`, optional `edit.minIntervalMs`/`typing.intervalMs` positive integers, optional `buttons.max` positive integer; `configured`, `start`, `send` functions; `stop`/`edit`/`delete`/`typing`/`setCommands`/`format`/`classifyError` functions when present; `format` required when `capabilities.format === "native"`; duplicate ids within one result reject. Extend the contributor-only acceptance (`providers === undefined && webuiBundles === undefined`) to include `channels`. Cross-extension id collisions are checked in the load loop before `registry.install`, with a `Map<channelId, slug>` claimed only by LOADED extensions (the `slugs` pattern).
- [ ] **Step 4: Run** `npx vitest run test/loader-channels.test.ts test/loader.test.ts test/extension-contract.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Docs** — `docs/extending.md`: factory-result table row `channels`, and a "Channel adapters" section with the §7 rules for authors (webhook vs socket transports, credentials stored-then-env resolved by the adapter, 64-byte button tokens, the `AttachmentTooLarge` name rule, collision = quarantine).
- [ ] **Step 6: Commit** `feat(loader): channels contribution field (gateway C1)`

### Task 3: C2 — the `gateway` engine field, lifecycle, shutdown order, health

**Files:**
- Modify: `src/extension.ts` (`GatewayEngine`, `GatewayEngineContext`, `SigrunExtensionResult.gateway?`), `src/harness/loader.ts` (validate + one-engine rule), `src/harness/boot.ts` (`OpenedHarness.gatewayEngine`), `src/serve.ts` (start after listen; shutdown via the new module), `src/server/routes/meta.ts` + `shared/src/views.ts` `MetaResponse.health.gateway?`, `src/server/routes/extensions.ts` (`inert: "no gateway"`), `docs/extending.md`
- Create: `src/server/gateway.ts`, `src/server/shutdown.ts`, `test/fixtures/fixture-gateway-engine/index.js` (records `start`/`stopIntake`/`stop` calls and the `runSettled` it receives into `globalThis.__fixtureGatewayLog`; `health()` returns `globalThis.__fixtureGatewayHealth ?? "ok"`), `test/fixtures/fixture-gateway-engine-twin/index.js`
- Test: `test/gateway-engine.test.ts`, `test/shutdown-order.test.ts`

**Interfaces:**
- Consumes: `OpenedHarness.channelBindings` (Task 2).
- Produces (`src/extension.ts`): `GatewayEngine { start(ctx: GatewayEngineContext): Promise<void>; stopIntake(): Promise<void>; stop(): Promise<void>; health(): "ok" | "degraded" }`, `GatewayEngineContext { readonly channels: readonly { readonly extension: string; readonly channel: ChannelContribution }[]; readonly signal: AbortSignal }`.
- Produces (`src/harness/boot.ts`): `OpenedHarness.gatewayEngine: { readonly extension: string; readonly engine: GatewayEngine } | undefined`.
- Produces (`src/server/gateway.ts`): `startGateway(opened: OpenedHarness): GatewayHandle` where `GatewayHandle { readonly started: Promise<void>; health(): HealthStatus; stopIntake(): Promise<void>; stop(): Promise<void> }`; with no engine it returns a handle whose methods resolve immediately and whose `health()` is never consulted (meta omits the field).
- Produces (`src/server/shutdown.ts`): `createShutdown(steps: ShutdownSteps): () => Promise<void>` where `ShutdownSteps { endStreams(): void; closeApp(): Promise<void>; gateway: GatewayHandle; eventBusShutdown(): Promise<void>; stopProviderRefresh(): Promise<void>; closeHarness(): Promise<void> }` — runs in exactly this order: `endStreams`, `closeApp`, `gateway.stopIntake`, `eventBusShutdown`, `gateway.stop`, `stopProviderRefresh`, `closeHarness`; collects failures and throws `AggregateError(failures, "sigrun shutdown failed")` after running every step (today's semantics).

- [ ] **Step 1: Write the failing tests.**
  - `test/gateway-engine.test.ts`:
    - one engine loaded → `startGateway(opened).started` resolves after calling `start` once with `channels` = the loaded `fixture-channel-adapter`'s channel tagged `extension: "fixture-channel-adapter"`;
    - twin engine → quarantined with `gateway engine already declared by "fixture-gateway-engine"`;
    - `/v1/meta` `health.gateway` is `"ok"`, then `"degraded"` after setting `__fixtureGatewayHealth = "degraded"`;
    - Review Focus 1: an engine whose `health()` throws → meta 200 with `health.gateway: "degraded"`; an engine whose `start()` rejects → `started` resolves (never rejects), one console.error, `health.gateway: "degraded"` until restart;
    - no engine + adapter loaded → `/v1/meta` has no `health.gateway`, the adapter's `/v1/extensions` row has `inert: "no gateway"`, one boot warning `channels contributed but no gateway engine is loaded`;
    - an engine factory result also carrying `health` → quarantined with `a gateway engine reports health through gateway.health(), not the health field`.
  - `test/shutdown-order.test.ts`: `createShutdown` with recording fakes asserts the seven-step order; a throwing `closeApp` still runs the remaining six and the AggregateError carries it; an integration case over a real boot (fixture engine + faux provider, the `host-conversations.test.ts` boot) submits a message, triggers `createShutdown`, and asserts `__fixtureGatewayLog` shows `stopIntake` → the run's `runSettled` → `stop`.
- [ ] **Step 2: Run** `npx vitest run test/gateway-engine.test.ts test/shutdown-order.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Loader: `validateGateway(value)` — object with `start`/`stopIntake`/`stop`/`health` functions; a result with both `gateway` and `health` throws the message above; the one-engine check runs in the load loop (first loaded wins; later ones quarantine naming the first slug). Collected as `gatewayEngine`.
  - `startGateway`: builds `GatewayEngineContext` from `channelBindings`, an `AbortController` aborted by `stop()`; wraps `engine.health()` in try/catch → `"degraded"` on throw (logged once per process); a `start` rejection is logged with `console.error("gateway: engine start failed", error)` and latches `degraded`.
  - `serve.ts`: call `startGateway(opened)` right after `app.listen`; replace the inline shutdown with `createShutdown(...)` (behavior otherwise identical, incl. the 2 s boot-refresh join inside `stopProviderRefresh`).
  - Meta: `health.gateway` present iff `opened.gatewayEngine !== undefined`; the handle is reachable from the route through `ServerContext` (add `gateway?: GatewayHandle` to `ServerContext`, set by `createServer`'s new optional `gateway` option; `serve.ts` creates the handle before `createServer` and starts it after listen).
- [ ] **Step 4: Run** `npx vitest run test/gateway-engine.test.ts test/shutdown-order.test.ts test/deploy-entry.test.ts test/server-meta-health.test.ts && npm run typecheck` — Expected: PASS (the pre-existing deploy-entry SIGTERM baseline failure, if still present on main, fails identically before and after; note it in the report rather than fixing it here).
- [ ] **Step 5: Docs** — `docs/extending.md`: `gateway` row and a short "Gateway engines" section (one engine; start after listen; the shutdown order; `health()` not the `health` field; inert adapters).
- [ ] **Step 6: Commit** `feat: gateway engine field, lifecycle and shutdown order (gateway C2)`

### Task 4: C4a — host conversation ops (abort, configure, compact, fork, patchMeta, widened create)

**Files:**
- Modify: `src/server/conversation-ops.ts` (new ops), `src/server/routes/submissions.ts:145-334` and `src/server/routes/conversations.ts:138-253,409-457` (routes become thin over the ops), `src/server/host-bridge.ts`, `src/extension.ts` (`SigrunHost["conversations"]` additions), `docs/extending.md`
- Test: `test/host-conversations.test.ts` (extend)

**Interfaces:**
- Produces (`src/server/conversation-ops.ts`, every op throws `ConversationOpError` with the route's existing error bodies):
  - `configureOp(ctx, conversation, body: { model?: unknown; thinking?: unknown }): Promise<ConfigureResponse>`
  - `abortOp(ctx, conversation): Promise<AbortResponse>` (404 `no_active_submission` becomes `ConversationOpError({error: "no_active_submission"}, 404)`)
  - `compactOp(ctx, conversation, instructions?: string): Promise<CompactResponse>`
  - `forkOp(ctx, conversation, opts: { at?: unknown; owner?: string }): Promise<ConversationCreateResponse>`
  - `patchMetaOp(ctx, conversation, body: unknown, opts: { principal?: Principal }): Promise<SessionMeta>` — the owner-or-superuser `sharing` gate runs only when `principal` is given (the route passes it; the host passes none).
  - `CreateConversationInput.agent?: { readonly extensions?: readonly string[]; readonly tools?: readonly string[] }` — resolved by name against `opened.registry.snapshot()` (`extension(name)`, `tools()`), merged over `storeAgentChange` as `AgentChange.extensions` / `.tools` arrays; an unknown name throws `ConversationOpError({error: "invalid_field", field: "agent.extensions" | "agent.tools"})`. The store's `modelTools` narrowing still applies.
  - `ConversationOpError` gains an optional HTTP status (default 400) so routes map one way.
- Produces (`SigrunHost["conversations"]`, spec C4 signatures): `abort(id): Promise<void>`, `configure(id, opts: { model?: string; thinking?: ThinkingLevelWire }): Promise<void>`, `compact(id): Promise<void>`, `fork(id, opts?: { at?: EntryId; owner?: string }): Promise<ConversationId>`, `patchMeta(id, patch: { name?: string | null; archived?: boolean; sharing?: Sharing | null }): Promise<SessionMeta>`, `create(opts)` gains `agent`. `abort` on an idle conversation resolves (no throw): chat `/stop` on an idle chat is not an error.

- [ ] **Step 1: Write the failing tests** (extend `test/host-conversations.test.ts`; each host call's observable result equals its HTTP twin on a twin conversation):
  - `configure` model + thinking → `GET .../agent`-equivalent read shows the same values as `POST .../configure`;
  - `abort` during a faux run settles it `aborted` (the faux handle's `setResponses` with a delayed message, the server-submissions pattern); on an idle conversation resolves;
  - `compact` creates the manual compaction task (`pi.live.compactions` non-empty or the task id observable as in `test/compaction.test.ts`);
  - `fork` returns a new id whose meta `name` is `"<source> (fork)"` and `owner` honors `opts.owner`;
  - `patchMeta({name: "x", archived: true})` then `meta` reads both; Review Focus 5: `patchMeta({sharing: {scope: "people", users: ["tester"], level: "write"}})` succeeds from the host with no principal, while the same body over HTTP as `tester` (non-owner) is 403;
  - `create({owner: "alice", agent: {tools: ["read"]}})` → the conversation's resolved agent offers exactly `["read"]`; `agent: {tools: ["nope"]}` throws `invalid_field` `agent.tools`; `agent: {tools: []}` succeeds with zero enabled tools;
  - Review Focus 2: each of `abort`/`configure`/`compact`/`fork`/`patchMeta` on id `999999` throws `conversation 999999 not found`;
  - the existing route tests (`server-configure`, `session-meta`, `compaction`, `session-management`) stay green unchanged.
- [ ] **Step 2: Run** `npx vitest run test/host-conversations.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the ops by moving each route body into `conversation-ops.ts` verbatim (validation order and error bodies unchanged), the routes calling them and mapping `ConversationOpError` to `reply.code(status).send(body)`, and the bridge methods calling them through `conversationOf`.
- [ ] **Step 4: Run** `npx vitest run test/host-conversations.test.ts test/server-configure.test.ts test/session-meta.test.ts test/compaction.test.ts test/session-management.test.ts test/server-submissions.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Docs** — `docs/extending.md` host-surface section lists the new methods and the trusted-host sharing note.
- [ ] **Step 6: Commit** `feat(host): conversation ops on the host surface (gateway C4a)`

### Task 5: C8 — effective admin from proxy groups

**Files:**
- Modify: `src/harness/identity/users.ts` (`DirectoryUser.groupAdmin?: boolean`; `update` patch accepts it), `src/server/auth/pipeline.ts` `resolveProxy` (write-through when changed), `src/server/host-bridge.ts` `users`, `src/server/routes/users.ts` + `shared/src/views.ts` `UserWire.groupAdmin?`, `docs/extending.md` (host users note + the lag), `README.md` auth section (one paragraph)
- Test: `test/auth-pipeline.test.ts` (extend), `test/host-conversations.test.ts` (users block)

**Interfaces:**
- Produces: `DirectoryUser.groupAdmin?: boolean`; host `users.get/list` return `{ ...record, admin: record.admin || record.groupAdmin === true, groupAdmin: record.groupAdmin === true }`; `/v1/users` rows add `groupAdmin` and keep `admin` = stored flag; `recordAdminCount()` unchanged.

- [ ] **Step 1: Write the failing tests:**
  - proxy request as `bob` with `Remote-Groups: admins` and `adminGroups: ["admins"]` → `users.get("bob").groupAdmin === true`; a later request without the group → `false`; with `adminGroups: []` the field is never written (C8 inactive);
  - write-through only on change: two identical requests → one directory write (spy `writeJson` via the file mtime, or count `update` calls through a spy);
  - host `users.get("bob").admin === true` while `/v1/users` shows `admin: false, groupAdmin: true`;
  - the last-admin guard still refuses demoting the only stored admin even when a group admin exists.
- [ ] **Step 2: Run** `npx vitest run test/auth-pipeline.test.ts test/host-conversations.test.ts test/users-api.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the write-through after `record` resolves in `resolveProxy` (`await users.update(user, { groupAdmin })` only when `adminGroups.length > 0` and the stored value differs; auto-provisioned records are added with it set).
- [ ] **Step 4: Run** the same command — Expected: PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(auth): persist group-derived admin for host-side checks (gateway C8)`

### Task 6: C4b — upload, readFile, models, commands

**Files:**
- Modify: `src/server/conversation-ops.ts` (`uploadOp`, `readFileOp`), `src/server/routes/files.ts:104-195,295-378` (thin over the ops), `src/server/host-bridge.ts`, `src/extension.ts` (`SigrunHost.models`, `SigrunHost.commands`, `upload`/`readFile`; `Principal.method` adds `"host"`), `shared/src/views.ts:733` (`method` union adds `"host"`), `docs/extending.md`
- Test: `test/host-conversations.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's effective admin.
- Produces:
  - `uploadOp(ctx, conversation, file: { name: string; mime?: string; bytes: Uint8Array }): Promise<{ path: string }>` — the raw-upload route's name validation and `uploads/<conversationId>/<name>` path;
  - `readFileOp(ctx, conversation, path: string): Promise<{ bytes: Uint8Array; mime?: string }>` — `files/raw` confinement (`isConfinedPath`) and the `server.maxFileReadBytes` cap; over the cap throws `ConversationOpError({error: "too_large"}, 413)`;
  - host `conversations.upload(id, file)`, `conversations.readFile(id, path)`;
  - `SigrunHost.models: { list(): Promise<readonly ModelRefWire[]> }` — the `GET /v1/models` list (same source function, extracted if inline);
  - `SigrunHost.commands: { list(): Promise<readonly SlashCommand[]>; run(conversationId: ConversationId, name: string, args: string, opts: { user: string }): Promise<{ notice?: string }> }` — `list` returns `ctx.commandCatalog.commands`; `run` resolves `ctx.commandCatalog.runnable.get(name)` (absent → throws `Error("command_not_found: <name>")`), builds the principal `{ user, name?, email?, admin: <effective>, service: false, method: "host" }` from `opened.identity.users.get(user)` (absent → throws `unknown user "<user>"`), and calls `merged.run` with the extension's seam host exactly as the invoke route does (a throw propagates).

- [ ] **Step 1: Write the failing tests:**
  - `upload(id, {name: "a.txt", bytes})` returns `{path: "uploads/<id>/a.txt"}` and `submit` with that file part admits; `readFile` of it returns the bytes;
  - Review Focus 3: names `"../x"`, `"a/b"`, `""` throw `invalid_field` `name`; `readFile` of `"../outside"` throws the route's confinement error;
  - `readFile` over `server.maxFileReadBytes` (set to 8 in the test config) throws `too_large`;
  - `models.list()` deep-equals `GET /v1/models` `.models`;
  - `commands.run` with `fixture-commands`' command as `alice` returns its notice and the command saw `principal.method === "host"`, `admin === false`; as a group-admin user (Task 5 fixture) sees `admin === true`;
  - Review Focus 4: `run(..., "new", ...)` throws `command_not_found`; `run` as `"ghost"` throws `unknown user "ghost"`;
  - unknown conversation id on `upload`/`readFile` throws `not found`.
- [ ] **Step 2: Run** `npx vitest run test/host-conversations.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as specified; the routes keep their exact responses (`server-uploads`, `server-files-raw`, `extension-commands` suites unchanged).
- [ ] **Step 4: Run** `npx vitest run test/host-conversations.test.ts test/server-uploads.test.ts test/server-files-raw.test.ts test/extension-commands.test.ts test/providers-api.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(host): upload, readFile, models and commands on the host surface (gateway C4b)`

### Task 7: C5 + C6 — answer attribution and interaction events

**Files:**
- Modify: `src/harness/seam-host.ts:271-288` (`answerInteraction` opts), `src/extension.ts` (`answerInteraction` signature; `NotificationEvent.callId?`; `interactionSettled` handler type + `SigrunLifecycleHandlers.interactionSettled?`), `src/server/notifications.ts` (`callId` on `interaction.pending`), `src/harness/event-bus.ts` (payload type `interactionSettled` + fan-out from the existing `interaction.settled` emit site), `src/harness/loader.ts` (`LIFECYCLE_FIELDS` gains `interactionSettled`), `docs/extending.md`, `docs/approval-ux-seams.md`
- Test: `test/seam.test.ts` (attribution), `test/notifications.test.ts` (callId), `test/event-bus.test.ts` (interactionSettled)

**Interfaces:**
- Produces: `answerInteraction(conversationId, callId, answer, context, opts?: { readonly user?: string }): Promise<boolean>`; `NotificationEvent.callId?: string`; `ExtensionLifecyclePayload.interactionSettled: { readonly conversationId: ConversationId; readonly callId: string; readonly kind: string; readonly status: "answered" | "skipped" | "expired" | "cancelled" }`; handler `interactionSettled?: ExtensionLifecycleHandler<"interactionSettled">` on the factory result.

- [ ] **Step 1: Write the failing tests** (answers in `main`'s current `InteractionAnswer` shape — see Coordination):
  - `answerInteraction(..., {user: "alice"})` → record `answeredBy: "human"`, `answeredByUser: "alice"`; without opts → `answeredBy: "extension"`, no `answeredByUser`;
  - a notifier fixture receives `interaction.pending` with `callId` equal to the seeded record's `callId`;
  - an extension declaring `interactionSettled` (extend `test/fixtures/fixture-user-events`) receives exactly one call per terminal transition for: an answer via the HTTP route, an answer via the host, a host `settleInteraction(..., "expired")`; the payload's `status` matches; seeding (pending) fires nothing;
  - a non-function `interactionSettled` quarantines the extension.
- [ ] **Step 2: Run** `npx vitest run test/seam.test.ts test/notifications.test.ts test/event-bus.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — the bus reads `record.status` at the same commit-observation site that emits the host `interaction.settled` event and enqueues a `lifecycle` item `{type: "interactionSettled", ...}` for terminal statuses only, dispatched by the existing lifecycle fan-out (deadline-bounded).
- [ ] **Step 4: Run** the same command plus `test/interaction-decide.test.ts test/seam-guarantees.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: interaction answer attribution and interactionSettled (gateway C5, C6)`

### Task 8: C7 — job `deliver` targets

**Files:**
- Modify: `shared/src/jobs.ts` (`JobAction` prompt variant `deliver?: string[]`), `src/jobs/spec.ts` (validation), `src/jobs/fire.ts:316-335` (stamp), `shared/src/session-meta.ts` (`SessionMeta.deliver?: string[]`, `jobId?: string`), `src/server/session-meta.ts` (both server-owned: rejected by the PATCH validator), `docs/extending.md` jobs section, `README.md` jobs section
- Test: `test/jobs-api.test.ts` (validation), `test/jobs-task.test.ts` or the fire tests (stamp), `test/session-meta.test.ts` (PATCH rejection)

**Interfaces:**
- Produces: `JobAction.deliver?: string[]` (prompt kind); `SessionMeta.deliver?: string[]`, `SessionMeta.jobId?: string`; a "deliver ignored" warning hook `fire.ts` calls when `opened.gatewayEngine === undefined` (thread a boolean `gatewayLoaded` into the fire deps).

- [ ] **Step 1: Write the failing tests:**
  - `validateJobSpec` accepts `deliver: ["telegram"]` with `conversation: "new"`; rejects with field `action.deliver` for: `deliver` with `conversation: 5`, `[]`, 9 entries, a `""` entry, a 257-char entry, a non-array;
  - `specHash` differs between two specs differing only in `deliver`;
  - firing a `"new"` job with `deliver: ["telegram:42"]` stamps the run conversation's meta `deliver: ["telegram:42"]` and `jobId: <id>` (typed fields now, no cast);
  - `PATCH .../meta` with `{deliver: []}` or `{jobId: "x"}` → 400 `invalid_field`;
  - with no engine loaded, the fire logs one `deliver targets ignored: no gateway` warning per run.
- [ ] **Step 2: Run** `npx vitest run test/jobs-api.test.ts test/jobs-task.test.ts test/session-meta.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — validation inside the prompt branch of `validateJobSpec` after `runSharing`; stamping in the `"new"` path's `init` beside `meta.jobId`.
- [ ] **Step 4: Run** the same command plus `test/jobs-reconcile.test.ts test/jobs-schedule.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Final gate for plan 1:** `npm test && npm run typecheck && npm run typecheck:webui && npm run build:webui && npm --workspace @sigrun/tui run typecheck` — Expected: all green (record the deploy-entry baseline if it still fails on clean main).
- [ ] **Step 6: Commit** `feat(jobs): deliver targets on new-conversation prompt jobs (gateway C7)`
