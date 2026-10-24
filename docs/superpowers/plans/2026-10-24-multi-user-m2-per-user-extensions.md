# M2 — Per-User Extension Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An extension can keep per-user secrets, settings and data, run per-user processes in each user's jail, and publish per-user tools that only that user's conversations can see or call, with core doing the scoping, lifecycle and enforcement.

**Architecture:** Core adds `owner` to every event, `host.stores.user(u)`, `host.services.connect(name, u)` (processes started through M1's helper in their own Landlock domain), and `host.tools.setUserTools(u, tools)` (registry entries named `<slug>@<user>`, selected per conversation from its owner and guarded by a wrapper inside each tool). User deletion stops and removes all of it.

**Tech Stack:** TypeScript (NodeNext), pi-durable 1.3.0 registry/agent selection, Fastify, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-sigrun-multi-user-design.md` §10 (all), §6 (service credentials), §16 (B2, M3, m4, m5).

**Waits for:** M1 merged to `main` (services launch through `src/sandbox/`); UI-blocks U4 and U6 merged (both edit `src/extension.ts`; Task 6 extends U4's settings sections).

## Global Constraints

- Per-user layout: secrets `<configDir>/user-secrets/<user>.json` (mode 0600, one section per slug); settings `<configDir>/user-settings/<user>/<slug>.json`; paths `<dataDir>/<slug>/users/<user>/`, `<stateDir>/<slug>/users/<user>/`, `<cacheDir>/<slug>/users/<user>/`, created on first access.
- `stores.user(u)` throws `unknown user "<u>"` for a non-directory user, except for `u` during its own `userDeleted` fan-out.
- Per-user secrets and settings are self-only on the HTTP surface: admins get 404 for another user's.
- Registry entry names: `<slug>@<user>`. Core's default selection excludes every installed name containing `@`.
- Service crash policy: three exits within 300 000 ms → `failed` for that (extension, name, user) until that user's settings for the extension change or sigrun restarts. Default `idleMinutes` 10.
- Service env: the M1 worker env plus `ServiceSpec.env`; never `process.env`.
- Shared-file note: as in M1.

## Review Focus

1. **A conversation whose stored selection is an array names another user's `<slug>@<other>` entry** — the call returns the wrapper's error, never runs (the B2 finding). Owner: Task 3.
2. **A forked conversation by another user** keeps none of the old owner's per-user tools in either selection shape. Owner: Task 3.
3. **Two conversations of one user connect to the same service at once** — one process, two handles; releasing one keeps it running. Owner: Task 4.
4. **A user deleted while their service is mid-request** — the service is stopped before `userDeleted` handlers run, and handlers can still read that user's secrets. Owner: Task 5.
5. **An extension quarantined after boot** (its factory throws on a re-key or similar) — its services stop and its per-user entries are uninstalled. Owner: Task 4.

---

### Task 1: `owner` on events

**Files:**
- Modify: `src/harness/event-bus.ts` (stamp `owner`), `src/extension.ts` (`RunSettledEvent.owner?`, every `ExtensionLifecyclePayload` member with a conversation id gains `owner?`)
- Test: `test/memory-seam.test.ts`, `test/event-bus.test.ts`

**Interfaces:**
- `owner` = `SessionMetaDoc.owner` read through the bus's document reader when the event is produced (fork: the child's owner; archive/idle: the current owner). Ownerless → absent.
- Spec §10.1's job bullet is moot: jobs are declarative specs whose runs create conversations with a stamped owner, so their events already carry it.

- [ ] **Step 1: Write the failing tests:** `runSettled` for alice's conversation carries `owner: "alice"`; `conversationForked` carries the child's owner; an ownerless root carries no `owner`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "events: owner on runSettled and lifecycle payloads (multi-user M2)"`

### Task 2: Per-user stores and `/v1/me` routes

**Files:**
- Modify: `src/harness/stores.ts` (`UserSecretsStore`, `userExtensionStores`), `src/extension.ts` (`SigrunHost.stores.user`), `src/harness/seam-host.ts`, `src/harness/reserved-sections.ts` (already reserves `user-secrets`, `user-settings` from M1; assert)
- Create: `src/server/routes/me.ts`
- Test: `test/user-stores.test.ts`, `test/me-routes.test.ts`

**Interfaces:**
- Produces (`SigrunHost.stores.user`): `user(user: string): { secrets: { get(key): Promise<string | undefined>; set(key, value): Promise<void>; delete(key): Promise<void> }; settings: { get(): Promise<Record<string, unknown>>; set(value): Promise<void> }; paths: { readonly data: string; readonly state: string; readonly cache: string } }` per Global Constraints. Writes are atomic (`writeFileAtomic`), secrets 0600.
- Produces (`src/server/routes/me.ts`): `GET`/`PUT /v1/me/extensions/:slug/settings`; `GET /v1/me/extensions/:slug/secrets` → `{ keys: string[] }`; `PUT /v1/me/extensions/:slug/secrets/:key {value}` → 204; `DELETE` same → 204. Caller = `principal.user`; a userless principal → 400 `{error: "named_user_required"}`; an unknown slug → 404.
- Deletion exception: the bus sets an in-memory "deleting" marker for the user for the duration of its `userDeleted` fan-out; `stores.user` honors it (Task 5 sets it).

- [ ] **Step 1: Write the failing tests:** layout paths for `alice` and slug `acme`; secrets file mode 0600; `stores.user("ghost")` throws `unknown user "ghost"`; bob's `GET /v1/me/extensions/acme/secrets` never shows alice's keys; values are never returned; an admin cannot reach alice's through any route (404); PUT then GET settings round-trips.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "stores: per-user secrets, settings, paths; /v1/me routes (multi-user M2)"`

### Task 3: Per-user tools

**Files:**
- Create: `src/harness/user-tools.ts`
- Modify: `src/extension.ts` (`SigrunHost.tools.setUserTools`; factory result `perUserTools?: boolean`), `src/harness/loader.ts` (collect `perUserTools` slugs), `src/harness/boot.ts` (`HarnessSettings.extensions` getter; boot sweep), `src/server/conversation-ops.ts` (create, fork, configure), `src/server/helpers.ts` (`stampSessionOwner`), `src/server/ownership.ts` (transfer), `src/server/host-bridge.ts` (`conversations.configure` rejection)
- Test: `test/user-tools.test.ts`

**Interfaces:**
- Produces (`src/harness/user-tools.ts`):
  - `userEntryName(slug: string, user: string): string` = `` `${slug}@${user}` ``; `isUserEntryName(name): boolean` (contains `@`).
  - `class UserToolRegistry { constructor(registry: Registry, perUserSlugs: () => readonly string[]); set(slug: string, user: string, tools: readonly ToolRegistration[]): void /* [] uninstalls */; removeUser(user: string): void; removeSlug(slug: string): void }` — every installed tool is wrapped: `execute(args, api, ctx)` reads `api.snapshot(SessionMetaDoc, api.conversationId, ctx)`; when `owner !== user` it returns `{ output: [{ type: "text", text: "This tool belongs to another user." }], isError: true }` without calling the inner tool (Review Focus 1).
  - `rewriteSelection(tx: Tx, conversationId: ConversationId, from: string | undefined, to: string | undefined, perUserSlugs: readonly string[]): Promise<void>` — reads `tx.doc(AgentDoc, id).extensions`; object or absent: remove `*@<from>`, add `<slug>@<to>` for every slug (`configure(tx, id, { extensions: { add, remove } })` with names); array: remove every `*@<from>` and add nothing.
- Wiring (one call per owner write, in the same commit): create (`conversation-ops.ts` create op, `from: undefined`), fork (`forkOp`, `from: source owner`, `to: fork owner`), `stampSessionOwner`, transfer participant (`from`, `to`).
- `HarnessSettings.extensions` getter: `callerSettings?.extensions ?? registry.snapshot().installed().filter((e) => !isUserEntryName(e.name))`.
- Rejection: a configure (route or `host.conversations.configure`) whose `extensions` names `<slug>@<u>` with `u` ≠ the conversation's owner → 400 `{error: "invalid_field", field: "extensions"}` / thrown `ConversationOpError`.
- Boot sweep: after the loader runs, every conversation (`scanConversations`, paged) whose selection is not an array and lacks its owner's entries gets them (idempotent; logged as a count).
- `SigrunHost.tools.setUserTools(user, tools)` → `UserToolRegistry.set(<calling slug>, user, tools)`; only for an extension that declared `perUserTools: true` (otherwise throws `perUserTools not declared`).

- [ ] **Step 1: Write the failing tests:** default selection excludes `acme@alice`; alice's new conversation offers `acme@alice` tools and not `acme@bob`; an entry installed after the conversation was created appears without editing the conversation (pi-durable resolves by name); a conversation with array selection `["acme@bob"]` owned by alice: calling the tool returns the wrapper error and the inner `execute` spy is not called (Review Focus 1); bob forks alice's conversation → neither shape keeps `*@alice` and the object shape gains `acme@bob` (Review Focus 2); transfer alice → bob rewrites the same way; configure with `acme@bob` on alice's conversation → 400; the boot sweep adds missing entries once and a second boot changes nothing; `setUserTools` without `perUserTools: true` throws.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "tools: per-user registry entries, owner-driven selection, wrapper enforcement (multi-user M2)"`

### Task 4: Per-user services

**Files:**
- Create: `src/harness/user-services.ts`
- Modify: `src/extension.ts` (`userServices?` factory field, `ServiceSpec`, `ServiceHandle`, `SigrunHost.services.connect`), `src/harness/loader.ts` (validate + collect; quarantine stops the extension's services), `src/sandbox/pool.ts` or a sibling `src/sandbox/launch.ts` (a shared `launchInJail(policy, command, args, env)` the worker pool and services both use), `src/server/routes/extensions.ts` (`GET /v1/extensions` gains `services`), `src/server/routes/me.ts` (`GET /v1/me/services`), `src/server/shutdown.ts` (services stop in the same step as sandbox workers), `shared/src/views.ts`
- Test: `test/user-services.test.ts`, `test/fixtures/fixture-user-service/index.js` (+ a tiny echo child script)

**Interfaces:**
- Produces (contract, spec §10.3 verbatim): `userServices?: { name: string; start(user: string, ctx: HandlerContext): Promise<ServiceSpec | undefined>; idleMinutes?: number }[]`; `ServiceSpec { command; args; env?; cwd?; readPaths? }`; `host.services.connect(name, user, ctx): Promise<ServiceHandle>`; `ServiceHandle { stdin: WritableStream<Uint8Array>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<{ code: number | null; signal: string | null }>; release(): void }`.
- Produces (`user-services.ts`): `class UserServices { constructor(deps: { launch: typeof launchInJail; policyFor(user: string): UserPolicy | { reason: string }; isolationActive(): boolean; now(): number }); connect(slug, name, user, ctx): Promise<ServiceHandle>; stopUser(user): Promise<void>; stopSlug(slug): Promise<void>; stopAll(): Promise<void>; statuses(): { slug: string; name: string; user: string; state: "running" | "idle" | "failed"; lastError?: string }[] }`.
- Launch: isolation active → the helper with the user's policy plus `readPaths` (validated like grants) plus the extension's resolved package directory (exempt from the "not inside `configDir`" rule for exactly that directory, spec m4), as its **own** process, never inside the user's worker. Inactive → a plain child with the M1 worker env (no `SSH_AUTH_SOCK`) + `spec.env`.
- `start` returning `undefined` → `connect` rejects `service not available for this user`. `failed` → `connect` rejects with the last 20 stderr lines.

- [ ] **Step 1: Write the failing tests** (the M1 test launcher stands in for the helper): first `connect` starts one process; a second concurrent `connect` reuses it (one pid) and releasing one keeps it (Review Focus 3); idle stop after fake-timer `idleMinutes` with no handles; three crashes in 300 000 ms → `failed` and the stderr tail in the rejection; a settings PUT for that user clears `failed`; `stopUser` and quarantine stop processes (Review Focus 5); `/v1/me/services` shows only the caller's; `/v1/extensions` (admin) shows all; the env holds `spec.env` and no non-allowlisted variable.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS. The kernel suite (`test/sandbox-it/`) gains one case: a jailed agent shell cannot read a service's `/proc/<pid>/environ` (sibling domains).
- [ ] **Step 5: Commit** `git commit -m "services: per-user processes in their own jail, core-owned lifecycle (multi-user M2)"`

### Task 5: User deletion order

**Files:**
- Modify: `src/server/routes/users.ts` (`DELETE /v1/users/:user`), `src/harness/event-bus.ts` (`emitUserDeleted` sets and clears the deleting marker), `src/harness/stores.ts` (delete per-user secrets file, settings dir, cache dirs)
- Test: `test/users-api.test.ts`

**Interfaces:** the order, exactly (spec §10.6): (1) ownership transfer (with M1's cwd/grant and Task 3's selection rewrites), token revocation, account-link removal (M3a); (2) stop the user's sandbox worker and services, uninstall every `*@<user>` entry; (3) `userDeleted {user, transferTo}` with the deleting marker set; (4) remove the directory record; (5) delete the per-user secrets file, `<configDir>/user-settings/<user>/`, and every `<cacheDir>/<slug>/users/<user>/`. Data and state directories stay (the extension's call in step 3).

- [ ] **Step 1: Write the failing tests:** a fixture `userDeleted` handler reads the deleted user's per-user secret successfully (Review Focus 4); after the route returns, the secrets file and settings dir are gone, the data dir remains; the user's service pid is gone before the handler runs (the handler records `statuses()`); `*@<user>` entries are uninstalled.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "users: deletion stops services, then userDeleted, then removes the record and per-user secrets (multi-user M2)"`

### Task 6: Per-user settings sections

**Files:**
- Modify: U4's `SettingsSectionDef` in `src/extension.ts` (`scope?: "server" | "user"`, default `"server"` = U4's behavior), U4's `src/server/surfaces/settings-surfaces.ts` (a `user` section renders and saves `stores.user(principal.user).settings`, secrets through Task 2's routes, `access` = `write` for every signed-in user on their own values), U4's `onSettingsChanged` (gains `user?: string` for user-scope saves), the webui and TUI settings panels ("My settings" group for user sections)
- Test: U4's settings-surface tests, extended

- [ ] **Step 1: Write the failing tests:** a fixture extension's `scope: "user"` section shows each user their own values; bob's save does not change alice's file; `onSettingsChanged(keys, "bob")`; an admin sees their own values, not others'; both panels list user sections under "My settings".
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test`, webui test + build, tui test + typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "settings: per-user sections (multi-user M2)"`

### Task 7: Docs

**Files:** `docs/extending.md` — a "Per-user extensions" section: system-level extensions need none of this; `stores.user`, `userServices` + `services.connect`, `perUserTools` + `setUserTools`, `scope: "user"` sections; credentials go to services through `ServiceSpec.env` or a file under the user's data path, never into the agent's workspace; the deletion order. `CHANGELOG.md`.

- [ ] **Step 1: Write**; examples use `acme` names only.
- [ ] **Step 2: Commit** `git commit -m "docs: per-user extension surface (multi-user M2)"`
