# W3 — API shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the API fit phones and multiple tabs:
- submit returns at admission;
- the conversation list stops reading transcripts;
- streams send deltas instead of whole transcripts;
- one global events stream replaces client polling;
- a cross-conversation interactions inbox;
- provider credential and refresh endpoints;
- extension settings and secrets endpoints;
- a bounded raw file read.

**Architecture:**
- **Pure delta functions:** `diffViews` and `applyDelta` live in `@sigrun/shared/view-delta`. The server diffs and both clients fold.
- **The `EventHub`** (`src/server/events/hub.ts`) is an in-process fan-out fed by the existing event bus (extended with host-event reductions) and the provider scheduler. `/v1/events` subscribes per client and filters by W1's `accessOf`.

**Tech Stack:** TypeScript (NodeNext), Fastify 5 (hand-rolled SSE, the `/stream` pattern), vitest, React, pi-tui.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` §7.1–§7.8, plus the §10 W3 tests and ruling 11.

**Depends on:** W0 (route modules) and W1 (principal, `accessOf`, `loadConversation(ctx, need)`, `ConversationSummary.access`). The credential-precedence plan (`2026-10-19-credential-precedence.md`) is a prerequisite for Task 6.

## Global Constraints

- **Async submit:**
  - `202 {submission}` at admission;
  - `?waitMs` is capped at 60 000;
  - the status route reads `(await harness.submission(id))?.status(ctx)`.
- **Delta frames:**
  - `event: snapshot` (full view) on connect;
  - then `event: delta` with `{entries?:{append?,remove?}, docs?:{set?,unset?}, conversation?, steer?}`;
  - no `replace`;
  - when the next entry list is not "prev minus removed ids, plus an appended suffix", the server sends a fresh `event: snapshot` instead;
  - the `view` event name is retired: both clients move in the same task.
- **Events stream:**
  - `GET /v1/events`, SSE, `: ping` every 15 s (the `/stream` heartbeat);
  - no replay;
  - events are filtered per principal with `accessOf !== "none"`.
- **Inbox:** `GET /v1/interactions?status=pending` reads the session-singleton `InteractionsIndexDoc` with one snapshot per request. My call: the doc IS the commit-maintained index, so a per-request snapshot meets the spec's intent with no cache to invalidate.
- **Files raw:**
  - `server.maxFileReadBytes`, default 16 MiB (16 777 216), env `SIGRUN_MAX_FILE_READ_BYTES`;
  - over → `413 {error:"file_too_large", maxBytes}`;
  - chunked through `ExecutionEnv.openBinaryReader`.
- **Admin-only:** provider credential writes, extension settings PUT, extension secret PUT/DELETE.
- **Never return secret values** from any route.
- **Verification:**
  - per task `npm test` + `npm run typecheck`;
  - client tasks add `npm --workspace @sigrun/webui test`, `npm run typecheck:webui`, `npm --workspace @sigrun/tui test`;
  - the delta task adds `npm run test:e2e`.

## Review Focus

1. **A compaction mid-stream** rewrites the active entry list (a new head marker goes FIRST). It is not a suffix append, so the server must fall back to a snapshot. Task 3 pins it with a forced compaction (`reserveTokens` tiny, the battery's pattern).
2. **A tab that holds a stream across a server restart.** The reconnect gets a fresh snapshot, and the client reducer must REPLACE (not fold) on `snapshot`. Task 3's client tests pin snapshot-after-deltas.
3. **Events for a conversation whose sharing changes mid-stream.** Filtering is per event, so an un-share stops delivery immediately. Task 4 tests a share → event delivered → un-share → next event withheld.
4. **The webui composer double-sending** now that submit returns immediately. The guard must hold from click until the view reports `steer.busy` or the admission errors. Task 1's composer test clicks twice quickly and asserts one submission (the second is a steer only once busy is reported).
5. **A `files/raw` path that is a directory or a symlink outside the workspace.** `isConfinedPath` + `fileInfo` type check → 400 `invalid_path` for a directory. Task 7 pins the directory case; symlink policy is unchanged from `files/content`.

---

### Task 1: Async submit + submission status + composer guard

**Files:**
- Modify: `src/server/routes/submissions.ts`.
  - The submit route returns `202 {submission: await submission.status(ctx)}` right after `touchActivity`.
  - With `waitMs` (a positive int ≤ 60 000; otherwise 400 `invalid_field waitMs`), it races `submission.wait(ctx)` against a timer and returns whichever record is current.
  - New `GET /v1/conversations/:id/submissions/:submissionId` (`loadConversation(ctx, "read")`):
    - `harness.submission(id)` undefined, or a different `conversationId` → 404 `submission_not_found`;
    - else `{submission: record}`.
- Modify: `shared/src/views.ts`. `SubmissionResponse` becomes `{submission: SubmissionRecordWire}`. Check the current shape and keep the field name if it already is `submission`; adjust the clients' types.
- Modify:
  - `webui/src/composer/Composer.tsx`: the guard at `:589-596` becomes "block when `sending` (admission in flight); when `busy`, a click is a steer". Delete the false comment about awaiting settlement.
  - `webui/src/api.ts`, `tui/src/api.ts`: types only.
- Test: `test/server-submissions.test.ts`; `webui/src/composer/Composer.test.tsx`.

- [ ] **Step 1: Write failing tests:**
  - the faux provider scripted with a slow response (a `fauxAssistantMessage` behind a gated promise): `POST …/submissions` returns 202 BEFORE the gate releases, with `submission.status` in `queued|placed`;
  - `?waitMs=5000` after release → the settled record (`status:"done"`);
  - `?waitMs=70000` → 400;
  - `GET …/submissions/<id>` → the record;
  - an unknown id → 404;
  - the composer: two rapid clicks while not busy → `client.submit` called once.
- [ ] **Step 2: Run** `npx vitest run test/server-submissions.test.ts` + `npm --workspace @sigrun/webui test -- Composer`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui test && npm run typecheck:webui`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "submissions: 202 at admission, waitMs, submission status route; composer guard re-derived"`.

### Task 2: Lean conversation list

**Files:**
- Modify: `src/server/routes/conversations.ts`. The list route builds summaries from `record` (scan page) + the `SessionMetaDoc` snapshot only, with no `readView`.
  - `entryCount` is removed.
  - Filters: `?archived=true|false` (absent = all), and `?mine=true` (`owner === principal.user`).
  - Summary fields stay as W1 left them (`owner`, `name`, `lastActivityAt`, `parent`, `archived`, `pinned`, `sharing`, `access`).
- Modify: `shared/src/views.ts` (drop `entryCount` from `ConversationSummary`), plus every fixture carrying it. Find them with `grep -rln entryCount webui tui test shared`.
- Test: `test/conversation-list-meta.test.ts`, `test/conversation-enumeration.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - list summaries have no `entryCount` key;
  - `?archived=false` omits an archived conversation;
  - `?mine=true` returns only the caller's;
  - a spy on `Conversation.prototype.viewState` (or `harness.conversation(...).viewState`) records zero calls during `GET /v1/conversations`.
- [ ] **Step 2: Run** `npx vitest run test/conversation-list-meta.test.ts test/conversation-enumeration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and update the fixtures.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui test && npm --workspace @sigrun/tui test`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "conversations: list from records + session meta only (no view reads), archived/mine filters"`.

### Task 3: Delta view frames (server + both clients)

**Files:**
- Create: `shared/src/view-delta.ts` + `shared/package.json` `exports["./view-delta"]`.
- Modify: `src/server/routes/stream.ts`:
  - keep `prev` (the last sent wire view);
  - each watch revision → `diffViews(prev, next)`:
    - `undefined` (not representable) → `event: snapshot`;
    - an empty delta → skip;
    - else `event: delta`.
- Modify: `webui/src/stream.ts` + `webui/src/useConversationView.ts`, and `tui/src/sse.ts` + its consumer in `tui/src/ui/app.ts`:
  - `snapshot` REPLACES;
  - `delta` → `applyDelta(current, delta)`;
  - the `view` listener is removed.
- Modify: `test/fixtures/view-schema.json` / `src/server/schema-fixture.ts`, if the captured-schema fixture enumerates event shapes (`grep -n "event" src/server/schema-fixture.ts`). Add the delta shape and bump `SCHEMA_VERSION` per the fixture's own rule.
- Test: `test/view-delta.test.ts` (new, pure); `test/sse-view.test.ts`; `webui/src/stream.test.ts`; `tui/test/sse.test.ts` (or the TUI's existing SSE test file).

**Interfaces:**
- Produces, in `shared/src/view-delta.ts`:
  ```ts
  export interface ViewDelta {
    readonly entries?: { readonly append?: readonly ViewEntry[]; readonly remove?: readonly number[] };
    readonly docs?: { readonly set?: Readonly<Record<string, JsonObject>>; readonly unset?: readonly string[] };
    readonly conversation?: ViewConversation;
    readonly steer?: SteerField;
  }
  export function diffViews(prev: ConversationViewWire, next: ConversationViewWire): ViewDelta | undefined;
  export function applyDelta(view: ConversationViewWire, delta: ViewDelta): ConversationViewWire;
  export function isEmptyDelta(delta: ViewDelta): boolean;
  ```
- **`diffViews`:**
  - entries keyed by `id`: `remove` = prev ids absent from next; after removal, prev's remaining ids must be a prefix of next's, else return `undefined`; `append` = next's remainder;
  - docs compared by `===` then `JSON.stringify`;
  - `conversation` and `steer` are included only when they differ (`JSON.stringify`).
- **`applyDelta`:** filter removed ids, concat append, shallow-merge docs (set/unset), replace `conversation`/`steer` when present. It never mutates its input.

- [ ] **Step 1: Write failing tests:**
  - `test/view-delta.test.ts`:
    - a property test over generated sequences (hand-rolled, no new dependency: 200 seeded random sequences of append/remove-suffix/doc-set/doc-unset/steer-change steps) asserts `fold(applyDelta, snapshot, deltas)` deep-equals the final view;
    - when `diffViews` returns `undefined`, the generator's step was non-suffix;
    - a head-marker reorder → `undefined`;
    - identical views → an empty delta.
  - `test/sse-view.test.ts`:
    - a streaming reply produces `delta` frames whose `docs.set` has only `pi.live` (and no `entries`);
    - a forced compaction mid-stream produces a second `snapshot` frame;
    - folding every received frame equals a fresh `GET /v1/conversations/:id`.
  - webui/tui stream tests:
    - snapshot, then two deltas → the held view equals the folded view;
    - a later snapshot replaces it.
- [ ] **Step 2: Run** `npx vitest run test/view-delta.test.ts test/sse-view.test.ts` + the client suites. Expected: FAIL.
- [ ] **Step 3: Implement** shared → server → clients.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/shared run build && npm --workspace @sigrun/webui test && npm run typecheck:webui && npm --workspace @sigrun/tui test && npm run test:e2e`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "stream: delta frames (entry append/remove + changed docs) with snapshot fallback; shared reducer in both clients"`.

### Task 4: Global events stream

**Files:**
- Create:
  - `src/server/events/hub.ts` (`EventHub`);
  - `src/server/events/types.ts` (re-exporting the wire types);
  - `src/server/routes/events.ts`.
- Modify: `src/harness/event-bus.ts`. A new host-event surface: `onHostEvent(listener: (e: HostEvent) => void): () => void`, fed synchronously from the existing commit reduction (the listener contract: no blocking work):
  - `conversation.created` — the existing creation detection;
  - `conversation.changed` — ANY `SessionMetaDoc` change, with changed summary fields `name`/`autoName`/`archived`/`pinned`/`lastActivityAt`/`owner`/`sharing`, compared against the per-conversation baseline the bus already keeps for archive flips (generalize it to the summary fields);
  - `run.admitted` — the placed-input detection;
  - `run.settled` — the settle groups;
  - `interaction.pending` / `interaction.settled` — `InteractionDoc` family changes: status pending vs terminal, kind from the record;
  - `ambient.changed` — `AmbientDoc` changes.
- Modify: `src/harness/providers/scheduler.ts` + `refresh.ts`. After each refresh, compare per-provider readiness with the last snapshot and publish `providers.changed` through a callback the boot wiring passes (`onReadinessChange`).
- Modify: `src/harness/boot.ts`. Create one `EventHub`, wire `eventBus.onHostEvent` + the provider callback into it, and expose it as `OpenedHarness.events`.
- Modify:
  - `webui/src/sessions/useConversationList.ts`: delete the 10 s poll; subscribe to `/v1/events` with one `EventSource` shared per app, refetching the list on `conversation.*`;
  - `tui/src/launch.ts` + `tui/src/ui/interactions.ts` + `tui/src/ui/ambient.ts`: replace the list (10 s), interaction (2 s), and ambient timer polls with an events subscription (`tui/src/sse.ts` gains an events reader) that triggers the existing refetch functions.
- Modify: `shared/src/views.ts`, with `HostEventWire` the union below.
- Test: `test/events-stream.test.ts` (new); `webui/src/sessions/useConversationList.test.tsx`; the TUI interactions/ambient tests.

**Interfaces:**
- Produces:
  ```ts
  export type HostEventWire =
    | { type: "conversation.created"; conversationId: number }
    | { type: "conversation.changed"; conversationId: number; fields: Partial<ConversationSummary> }
    | { type: "run.admitted"; conversationId: number; submissionId: number }
    | { type: "run.settled"; conversationId: number; outcome: "answered" | "unanswered"; reason?: string }
    | { type: "interaction.pending" | "interaction.settled"; conversationId: number; callId: string; kind: string }
    | { type: "ambient.changed"; conversationId: number; key: string }
    | { type: "providers.changed"; provider: string; status: string }
    | { type: "job.changed"; job: unknown }; // W4 narrows to JobWire
  export class EventHub { publish(e: HostEventWire): void; subscribe(l: (e: HostEventWire) => void): () => void }
  ```
- **SSE framing:** `event: <type>\ndata: <json>\n\n`.
- **Filtering:**
  - a conversation-scoped event is delivered iff `accessOf(principal, meta)` ≠ `"none"`, re-snapshotting SessionMeta per event;
  - `providers.changed` → all authenticated principals;
  - `job.changed` → W4's job access rule.

- [ ] **Step 1: Write failing tests** in `test/events-stream.test.ts`, reading the stream via `app.inject` with `payloadAsStream: true` or a real listen + `fetch`, as `test/sse-view.test.ts` does:
  - creating a conversation → a `conversation.created` frame;
  - `PATCH …/meta {name:"x"}` → `conversation.changed` with `fields.name === "x"`;
  - a submission → `run.admitted`, then `run.settled outcome:"answered"`;
  - seeding an interaction via `fixture-seam` → `interaction.pending`; answering → `interaction.settled`;
  - **scoping** (W1 token users): bob's private conversation events are not delivered to dave's stream; after bob shares household-read, the next `conversation.changed` reaches dave; after un-share, the following one does not;
  - the webui list hook: no `setInterval` (fake timers advance 60 s and fetch count is unchanged), and a `conversation.changed` event → one refetch.
- [ ] **Step 2: Run** `npx vitest run test/events-stream.test.ts` + the client suites. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui test && npm --workspace @sigrun/tui test`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "events: /v1/events host-event stream (conversations, runs, interactions, ambient, providers); clients drop polling"`.

### Task 5: Interactions inbox

**Files:**
- Modify: `src/server/routes/interactions.ts`. New `GET /v1/interactions?status=pending`:
  - one `harness.snapshot(InteractionsIndexDoc)`;
  - for each conversation id in `pending`, check `accessOf` via its SessionMeta (skip `"none"`);
  - read each `InteractionDoc` record;
  - return `{interactions: (InteractionWire & {conversationId: number})[]}` sorted by `createdAt` ascending.

  `status` other than `pending` → 400 `invalid_field status` (only pending is indexed).
- Modify: `shared/src/views.ts` (`InboxResponse`).
- Test: `test/interactions-inbox.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - two conversations each with a pending interaction (`fixture-seam`) → both listed with their `conversationId`;
  - an answered one is absent;
  - another user's private conversation's interaction is absent;
  - after `opened.harness.close()` + `openHarness` on the same storage, the inbox still lists the pending ones (restart).
- [ ] **Step 2: Run** `npx vitest run test/interactions-inbox.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "interactions: cross-conversation pending inbox from InteractionsIndexDoc, access-filtered"`.

### Task 6: Providers — refresh and credentials

**Files:**
- Modify: `src/server/routes/providers.ts`:
  - `GET /v1/providers` entries gain `models: number` (count from `models.getModels(id)`) and `owner?: string` (from `providerOwnership`);
  - `POST /v1/providers/:id/refresh` → one bounded refresh via the existing `refreshProvider` helper in `src/harness/providers/refresh.ts` (or `models.refresh(id)` with `DEFAULT_REFRESH_TIMEOUT_MS`; reuse whatever `resolveServedModelRefreshing` calls), returning the provider's readiness entry; unknown provider → 404 `provider_not_found`;
  - `PUT /v1/providers/:id/credential {apiKey: string}` (admin) → writes `auth.json` (`opened.auth`), then refresh, then `200 {provider, status}`. For the default model's provider it writes `"default"` (spec §7.6); otherwise `<id>`;
  - `DELETE /v1/providers/:id/credential` (admin) → removes that same key, then refresh.
- Modify: `src/harness/auth.ts`. `AuthStore` gains `setApiKey(key: string, apiKey: string)` and `deleteApiKey(key: string)`, atomic and 0600 (`writeFileAtomic`). The bridge's `modify`/`delete` keep throwing; the route uses the store directly.
- Test: `test/providers-api.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - a provider-plugin fixture starting `not_configured` (no credential) → `PUT …/credential {apiKey:"sk-test"}` as admin → 200 and `status:"ready"` with no restart;
  - `auth.json` holds `sk-test` under the provider id;
  - a non-admin `PUT` → 403;
  - `DELETE` → `not_configured`;
  - `POST …/refresh` on an unknown id → 404;
  - no response body contains `sk-test`.
- [ ] **Step 2: Run** `npx vitest run test/providers-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "providers: refresh + credential PUT/DELETE (admin, restart-free), model counts and owners"`.

### Task 7: Extension settings/secrets endpoints + bounded raw file read

**Files:**
- Create: `src/server/routes/extensions.ts`:
  - `GET /v1/extensions` → `{extensions: [{name, status, error?, version?, interactionKinds, ambientKeys, workers}]}`. `version` comes from the package manifest: record it in the loader outcome as `ExtensionOutcome.version?`, read via `readPackageName`'s sibling helper on the entry's package.json. W4/W5 add jobs/routes/commands.
  - `GET /v1/extensions/:slug/settings` → the `settings/<slug>.json` object (`{}` when absent).
  - `PUT /v1/extensions/:slug/settings` (admin) → stored verbatim; the body must be a JSON object, else 400.
  - `GET /v1/extensions/:slug/secrets` → `{secrets: [{key, source: "stored"|"env"}]}`.
  - `PUT /v1/extensions/:slug/secrets/:key {value: string}` and `DELETE` (admin).
  - An unknown slug (not among loaded outcomes) → 404 `extension_not_found`.
- Modify: `src/harness/stores.ts`.
  - `SharedExtensionStores` gains slug-addressed admin operations:
    - `settingsFor(slug).get()/set(value)`;
    - `secretKeys(slug): {key, source}[]` — stored keys from `secrets.json`, plus env keys matching the `SIGRUN_EXT_<SLUG>_` prefix and not stored;
    - `setSecret(slug, key, value)`;
    - `deleteSecret(slug, key)`.
  - `OpenedHarness` exposes `extensionStores: SharedExtensionStores`.
- Modify: `src/server/routes/files.ts`. New `GET /v1/conversations/:id/files/raw?path=` (`"read"`):
  - `isConfinedPath` + `fileInfo`;
  - a directory → 400 `invalid_path`;
  - size > `config.maxFileReadBytes` → 413 `file_too_large`;
  - else stream chunks from `env.openBinaryReader(path, ctx)` into `reply.raw`, with `content-type` from a small extension→mime map (`.png .jpg .jpeg .gif .webp .svg .pdf .txt .md .json .html .css .js`, default `application/octet-stream`) and `content-length` = size.
- Modify: config/settings for `server.maxFileReadBytes` + env `SIGRUN_MAX_FILE_READ_BYTES`; `shared/src/views.ts` for the new wire types.
- Modify: the webui settings panel — one "Extensions" section listing `GET /v1/extensions`; per extension, a JSON textarea saving via PUT, and a key list with set/delete (write-only inputs). Files: `webui/src/settings/SettingsPanel.tsx` + `webui/src/api.ts`.
- Test: `test/extensions-api.test.ts`, `test/server-files-raw.test.ts` (new); `webui/src/settings/SettingsPanel.test.tsx`.

- [ ] **Step 1: Write failing tests:**
  - extensions API with `fixture-stores`:
    - a settings PUT → GET round-trip;
    - the file is `settings/<slug>.json`;
    - a secret PUT → `secrets` lists `{key:"api-key", source:"stored"}` and never the value;
    - with `SIGRUN_EXT_<SLUG>_TOKEN` in env, `{key:"token", source:"env"}`;
    - a non-admin PUT → 403;
    - an unknown slug → 404;
  - files raw:
    - a 3 MiB file streams back byte-equal with `content-length`;
    - with `SIGRUN_MAX_FILE_READ_BYTES=1024`, a 2 KiB file → 413;
    - a directory path → 400;
    - `../x` → 400;
  - webui: the Extensions section renders a row per extension, and the secret input sends `PUT` with the value while never displaying stored values.
- [ ] **Step 2: Run** `npx vitest run test/extensions-api.test.ts test/server-files-raw.test.ts` + `npm --workspace @sigrun/webui test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui test && npm run typecheck:webui`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "extensions: list + settings/secrets endpoints (admin writes, values never returned); bounded files/raw"`.
