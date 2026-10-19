# W0 — Server restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the ~1,935-line `createServer` in `src/server/index.ts` into per-resource route modules behind one shared conversation pre-handler, with **zero behavior change**.

**Architecture:**
- `createServer` keeps three jobs: build the Fastify app, compute the boot-time shared state (root id, webui bundle), and call each module's `register…Routes(app, ctx)`.
- Every `/v1/conversations/:id/*` route uses one `preHandler` (`loadConversation`) that resolves the id, 404s unknown ones, and decorates `request.conversation`. W1 adds its visibility check to exactly this hook.

**Tech Stack:** TypeScript (NodeNext), Fastify 5, vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` §4 (W0). The executor reads the spec's §4 and this plan.

## Global Constraints

- **No behavior change.** Every existing test passes with only import-path edits. Status codes, error bodies (`{error: "conversation_not_found"}` etc.), and route order (explicit routes before the static wildcard) are byte-identical.
- `/v1/meta` keeps the build spec's `capabilities.channels` (the selected bundle name) and `collisions` behavior exactly.
- Wire types stay imported from `src/server/views.ts`, which re-exports `@sigrun/shared/views`. No module imports `@sigrun/shared` directly for wire types.
- Comments state what the code does. Task-history labels ("T9b", "Task 26a", "review M2") are dropped in every file this plan moves.
- Verification per task: `npm test` + `npm run typecheck` clean.

## Review Focus

1. **Route-registration order:** the webui static wildcard (`serveWebuiBundle`) is registered before the routes today, and explicit routes still win (Fastify's router prefers static paths). The split must not move a `/v1` route behind a hook that changes this. Task 1's route-table test pins every path → method.
2. **The JSONL content-type parser** (`application/x-ndjson` + `text/plain` → raw string, used by import) must still be registered on the same app before `listen`. Task 2's import test already exercises it; keep it in `conversations.ts` with the import route.
3. **The pre-handler on the SSE route:** `/stream` must 404 as plain JSON *before* `reply.hijack()`. The pre-handler runs before the handler, so this holds; Task 1's 404 table includes `/stream`.
4. **`rootId` capture:** the list route's `root: true` flag and `/readyz`'s storage read both use the root id computed once in `createServer`. It moves to `ctx.rootId`, never recomputed per request.
5. **Fastify request augmentation** (`declare module "fastify"`) must live in one module that every route module imports (type-only), or `request.conversation` / `request.sigrunUser` type-error in modules that don't see it.

---

### Task 1: Server context, shared helpers, conversation pre-handler, probes + meta modules

**Files:**
- Create: `src/server/context.ts`, which holds:
  - the `ServerContext` interface;
  - the `declare module "fastify"` augmentation, moved from `index.ts:141-150`, gaining `conversation: Conversation` (see Interfaces).
- Create: `src/server/helpers.ts`, moved verbatim from `index.ts`:
  - `THINKING_LEVELS`, `WHEN_BUSY_MODES`, `WhenBusyMode`;
  - `storeAgentChange`, `ID_PARAMS_SCHEMA`, `settingsResponse`, `conversationId`, `readView`, `stampSessionOwner`, `conversationEnv`;
  - `FILE_CONTENT_MAX_BYTES`, `SCAN_PAGE_SIZE`, `decodeBase64Strict`.
- Create: `src/server/conversation-handler.ts`, holding `loadConversation`.
- Create: `src/server/routes/probes.ts` (`/healthz`, `/readyz`) and `src/server/routes/meta.ts` (`/v1/meta`, `/v1/commands`).
- Modify: `src/server/index.ts`. `createServer` builds the `ServerContext`, registers the identity hook (unchanged), the webui bundle, then `registerProbeRoutes` + `registerMetaRoutes`. All other routes stay inline for now.
- Test: `test/server-routes.test.ts` (new).

**Interfaces:**
- Produces, in `src/server/context.ts`:
  ```ts
  export interface ServerContext {
    readonly opened: OpenedHarness;
    readonly config: SigrunConfig;
    readonly rootId: ConversationId;
    readonly webuiBundle: WebuiBundle | undefined; // from ./static.js
  }
  declare module "fastify" { interface FastifyRequest {
    sigrunUser: string | undefined;
    conversation: Conversation; // set by loadConversation; only read on routes that use it
  } }
  ```
- Produces: `export function loadConversation(ctx: ServerContext): preHandlerAsyncHookHandler` in `src/server/conversation-handler.ts`.
  - Validates `params.id` through the existing `ID_PARAMS_SCHEMA` (routes keep `schema: { params: ID_PARAMS_SCHEMA }`).
  - Calls `ctx.opened.harness.conversation(conversationId(id), BACKGROUND_CONTEXT)`.
  - On `undefined`, replies `404 {error: "conversation_not_found"}`.
  - Otherwise sets `request.conversation`.
- Produces: `export function registerProbeRoutes(app: FastifyInstance, ctx: ServerContext): void` and `registerMetaRoutes(app, ctx)`. The same signature shape is used by every module in Tasks 2–3.

- [ ] **Step 1: Write the failing tests** in `test/server-routes.test.ts`. Boot a hermetic server with the `bootServer` shape from `test/server-submissions.test.ts`: faux provider contributor, tmp workspace, `loadConfig`.
  - `test("route table is unchanged")`:
    - `app.printRoutes({ commonPrefix: false })` contains every path in a literal array copied from today's routes (the 22 `/v1` paths + `/healthz` + `/readyz`);
    - each path is checked with `app.hasRoute({ method, url })` for its method.
  - `test("every /v1/conversations/:id route 404s an unknown id")`: a table of `[method, url]` with every `:id` route (`GET /v1/conversations/999999`, `GET …/stream`, `POST …/submissions`, `POST …/configure`, `POST …/abort`, `GET …/interactions`, `POST …/interactions/x/answer`, `GET …/ambient`, `POST …/compact`, `POST …/fork`, `GET …/export`, `GET/PATCH …/meta`, `POST …/uploads`, `GET …/files`, `GET …/files/content?path=a`).
    - Each answers 404 with `{error: "conversation_not_found"}`.
    - Bodies are sent where the route requires one (`{}` / `{input:[{type:"text",text:"x"}]}`) so validation order cannot mask the 404.
    - The test passes on today's code (it is the regression net) EXCEPT where today's route validates the body before the lookup. Record any such row as a known difference: the pre-handler makes lookup-first uniform, so a 400-before-404 becomes 404. That is the only sanctioned behavior change. List the affected rows in the commit message.

- [ ] **Step 2: Run the tests**

  Run: `npx vitest run test/server-routes.test.ts`
  Expected: the route-table test PASSES on the unsplit server; the 404 table PASSES for every row whose lookup already precedes validation. Note any row that fails (a 400) — those flip in Step 4.

- [ ] **Step 3: Create `context.ts`, `helpers.ts`, `conversation-handler.ts`, `routes/probes.ts`, `routes/meta.ts`** with the interfaces above. Move code; do not edit logic. `index.ts` imports the moved helpers instead of defining them.

- [ ] **Step 4: Run the full suite**

  Run: `npm test && npm run typecheck`
  Expected: all green, `server-routes.test.ts` included.

- [ ] **Step 5: Commit**

```bash
git add src/server/context.ts src/server/helpers.ts src/server/conversation-handler.ts \
  src/server/routes/probes.ts src/server/routes/meta.ts src/server/index.ts test/server-routes.test.ts
git commit -m "server: context + shared helpers + conversation pre-handler; probes/meta route modules"
```

### Task 2: Conversation and submission route modules

**Files:**
- Create: `src/server/routes/conversations.ts`. It takes these routes from `index.ts`:
  - `POST /v1/conversations`, `GET /v1/conversations`;
  - `GET …/:id`, `POST …/:id/fork`, `GET …/:id/export`, `POST /v1/conversations/import`;
  - `GET`/`PATCH …/:id/meta`;
  - the JSONL `addContentTypeParser` loop.
- Create: `src/server/routes/stream.ts`, holding `GET …/:id/stream`.
- Create: `src/server/routes/submissions.ts`, holding `POST …/:id/submissions`, `…/configure`, `…/abort`, `…/compact`.
- Modify: `src/server/index.ts`, which registers the three modules.
- Test: no new file. `test/server-routes.test.ts` + the existing suites (`server*.test.ts`, `sse-view.test.ts`, `session-management.test.ts`, `session-meta.test.ts`, `conversation-*.test.ts`) are the net.

**Interfaces:**
- Consumes: `ServerContext`, `loadConversation`, and the helpers from Task 1.
- Produces: `registerConversationRoutes`, `registerStreamRoutes`, `registerSubmissionRoutes`, each `(app, ctx) => void`.

- [ ] **Step 1: Move each route's handler into its module.**
  - Every `:id` route declares `{ schema: { params: ID_PARAMS_SCHEMA }, preHandler: loadConversation(ctx) }`.
  - It reads `request.conversation`, deleting its inline `harness.conversation(...)` + 404 block.
  - Routes without `:id` (create, list, import) take no pre-handler.
- [ ] **Step 2: Run** `npx vitest run test/server-routes.test.ts test/sse-view.test.ts test/server-submissions.test.ts test/session-management.test.ts test/session-meta.test.ts test/conversation-enumeration.test.ts test/conversation-list-meta.test.ts`
  Expected: PASS.
- [ ] **Step 3: Full verification** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 4: Commit** `git commit -m "server: conversation, stream, and submission route modules behind loadConversation"` (adding the new files + `index.ts`).

### Task 3: Interaction, file, provider, and settings modules; comment cleanup

**Files:**
- Create: `src/server/routes/interactions.ts`, holding `GET …/:id/interactions`, `POST …/:id/interactions/:callId/answer`, `GET …/:id/ambient`.
- Create: `src/server/routes/files.ts`, holding `POST …/:id/uploads`, `GET …/:id/files`, `GET …/:id/files/content`.
- Create: `src/server/routes/providers.ts`, holding `GET /v1/models` and `GET /v1/auth/check` (W1 adds `/v1/providers` here).
- Create: `src/server/routes/settings.ts`, holding `GET`/`PATCH /v1/settings`.
- Modify: `src/server/index.ts`. After this task it contains only:
  - `createServer` (Fastify instance, identity hook, webui mount, root ensure, `ServerContext`, the register calls);
  - re-exports any symbol tests import from `../src/server/index.js` — check with `grep -rn "server/index.js" test`.
- Modify (comments only):
  - `src/harness/loader.ts` — the header's "Zero-arg factories keep working (extra arguments are inert in JS)" becomes the true rule: the host is passed only to factories with `factory.length > 0`;
  - `src/backup/run-backup.ts` lines 6-11 — "VACUUM-into API" becomes "sqlite3's online backup API (`.backup`)".

**Interfaces:**
- Produces: `registerInteractionRoutes`, `registerFileRoutes`, `registerProviderRoutes`, `registerSettingsRoutes`, each `(app, ctx) => void`.

- [ ] **Step 1: Move the routes** exactly as in Task 2: `:id` routes use `loadConversation(ctx)`.
- [ ] **Step 2: Fix the two comments** listed above. Grep `grep -n "inert" src/harness/loader.ts` and `grep -n "VACUUM" src/backup/run-backup.ts`; both must return nothing afterwards except the corrected sentences.
- [ ] **Step 3: Size check:** `wc -l src/server/index.ts` is under 200 lines; no route handler remains in it (`grep -c "app\.\(get\|post\|patch\)(" src/server/index.ts` → 0).
- [ ] **Step 4: Full verification** `npm test && npm run typecheck && npm run build`. Expected: green, and `dist/server/routes/*.js` emitted.
- [ ] **Step 5: Commit** `git commit -m "server: interaction, file, provider, settings route modules; index.ts composes only"`.
