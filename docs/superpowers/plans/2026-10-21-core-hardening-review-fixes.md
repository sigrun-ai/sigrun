# Core-Hardening Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five findings from the post-merge review of core-hardening (main `1bf7dc8`): an encoded-path auth bypass, a jobs test race disguised as a load-bearing dynamic import, a test suite that needs sibling repos, an events filter that delivers unknown event types to everyone, and a storage failure that pages nobody.

**Architecture:** Five independent fixes on one branch, `fix/hardening-review`. Each task has its own failing test first. Task 1 is a security fix and lands first; the others can follow in any order.

**Tech Stack:** TypeScript (NodeNext), Fastify 5, vitest, pi-durable 1.2.0, the Helm chart under `charts/sigrun`.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` (§5.2–§5.3 request pipeline, §6.1 readiness, §6.9 metrics and alerts, §7.4 events, §8 jobs). The findings and their evidence are in this plan; there is no separate review file.

**Baseline:** main `1bf7dc8`, root 1064/1064, webui 289/289, TUI 292/292, all typechecks and `build:webui` clean (verified 2026-10-21).

## Global Constraints

- Gate per task: `npm test && npm run typecheck`. Task 5 adds `helm template` through `test/manifests.test.ts` (already in `npm test`).
- No behaviour change outside the finding being fixed. In particular, the browser surface (GET outside `/v1/`) stays public, and the SPA fallback still serves `index.html` for unknown non-`/v1` paths.
- Tests own their literals: synthetic users (`alice`, `bob`), `example.invalid` hosts.
- Commits are SSH-signed with the repo-local identity. Don't push.

## Review Focus

1. **Every encoding of the `/v1` prefix** — `%76`, `%31`, `%2F`-adjacent forms, mixed case of the escape (`%76` vs `%56` is `V`, which doesn't route), dot segments (`/./v1/…`, which Fastify normalises). Any form that *routes* to a `/v1` handler must authenticate. Owner: Task 1.
2. **The SPA fallback for odd paths** — `/%761/nope` (no matching route) must still get either the SPA HTML or a 404, never a 500 and never API data. Owner: Task 1.
3. **Disable then immediately re-enable a job** — exactly one live (non-aborting) schedule task afterwards; a task whose abort is still pending must not count as the job's executor. Owner: Task 2.
4. **A new `HostEventWire` member added without an events branch** — the typecheck fails, rather than the event silently going to everyone. Owner: Task 4.
5. **Storage failing while the process stays up** — `sigrun_ready 0` on `/metrics` and the `SigrunNotReady` alert fires; recovery clears both. Owner: Task 5.

---

### Task 1: Decide "public" from the matched route, not the raw URL

**Finding:** `isPublicPath` (`src/server/auth/pipeline.ts`) treats any GET whose raw URL doesn't start with `/v1/` as the public browser surface. Fastify decodes the path before routing, so `GET /%761/settings` (`%76` = `v`) routes to `/v1/settings` with no principal. Verified against a real server with no credentials: `/%761/settings`, `/%761/extensions`, `/%761/providers`, `/%761/meta` and `/%761/interactions` return 200 with data; `/%761/users`, `/%761/jobs`, `/%761/conversations`, `/%761/auth/whoami` return 500. Extension GET routes declared `auth: "user"` run with no principal. Writes are unaffected (only GET/HEAD are in the public branch).

**Files:**
- Modify: `src/server/auth/pipeline.ts` (`isPublicPath`; stage 4b's `request.url.startsWith("/v1/ext/")`)
- Test: `test/auth-pipeline.test.ts` (new `describe("encoded paths")`), `test/server-routes.test.ts` (a route-table sweep)

**Interfaces:**
- Produces: `function isPublicPath(request: FastifyRequest, ctx: ServerContext): boolean` with unchanged meaning, now computed from `request.routeOptions.url` (the matched route pattern, e.g. `/v1/settings`, `/v1/conversations/:id`, `/*`), which Fastify sets before `onRequest` hooks run (stage 4b already relies on `routeOptions.config`).

Rule, in order:
1. pattern `/healthz` or `/readyz` → public;
2. pattern `/metrics` and `config.metricsPublic` → public;
3. pattern `/v1/auth/login` or `/v1/auth/logout` with `POST` → public;
4. pattern `/v1/onboarding` or starting `/v1/onboarding/` → public;
5. GET/HEAD and the pattern is the static plugin's wildcard (`/*`) **or there is no matched route** (the not-found handler serves the SPA) → public;
6. otherwise → not public.

Stage 4b uses `request.routeOptions.url?.startsWith("/v1/ext/")` instead of the raw URL.

- [ ] **Step 1: Write the failing tests.**
  - In `test/auth-pipeline.test.ts`, boot the `SIGRUN_AUTH: "token"` server with alice (admin) and bob seeded (reuse `bootServer`/`seededIdentity` as `test/users-api.test.ts` does). With **no** credentials, each of these returns `401 {"error":"unauthenticated"}`:
    `GET /%761/settings`, `/%761/extensions`, `/%761/providers`, `/%761/meta`, `/%761/interactions`, `/%761/users`, `/%761/jobs`, `/%761/conversations`, `/%761/auth/whoami`, `/v1/%73ettings`, `/./v1/settings`.
  - Review Focus 2: `GET /%761/nope` returns either 200 `text/html` (bundle mounted) or 404 JSON, never 500 and never a JSON body containing `"effective"`.
  - Still public: `GET /`, `GET /assets/<a real bundle file>`, `GET /some/spa/route` (SPA HTML), `/healthz`, `/readyz`, `POST /v1/auth/login`, `GET /v1/onboarding`.
  - An extension route declared `auth: "user"` (reuse `test/extension-routes.test.ts`'s fixture) requested as `/%761/ext/<slug>/<path>` without credentials → 401; declared `auth: "public"` → still reachable.
  - In `test/server-routes.test.ts`: for every registered `GET` route whose pattern starts `/v1/` and is not in the public list, request it with its first character after `/` percent-encoded (`/v1/x` → `/%761/x`, filling `:params` with `1`) and no credentials; expect 401. This sweep keeps future routes covered.
- [ ] **Step 2: Run** `npx vitest run test/auth-pipeline.test.ts test/server-routes.test.ts` — expect FAIL (200s and 500s).
- [ ] **Step 3: Implement** the rule above in `isPublicPath` and the stage 4b change. Confirm the static plugin's wildcard pattern by logging `request.routeOptions.url` for `GET /` in a test (expected `/*`), and match exactly that.
- [ ] **Step 4: Run** the two files, then `npm test && npm run typecheck`, then `npm run test:e2e` (the browser surface must still load) — PASS.
- [ ] **Step 5: Commit** `git commit -m "auth: decide the public surface from the matched route, not the raw URL (encoded /v1 bypass)"`.

### Task 2: Replace the jobs dynamic imports; fix the task-liveness race they hid

**Finding:** `src/jobs/reconcile.ts:305,347` and `src/jobs/observe.ts:171` use `await import("./docs.js")` although `reconcile.ts` already imports `./docs.js` statically. Replacing them with static imports fails `test/jobs-reconcile.test.ts` "deleteApi → final disabled revision, record retired, task aborted" (one live task remains). Measured: replacing the import with `await Promise.resolve()` still fails; `await new Promise(r => setImmediate(r))` passes. Cause: `harness.abortTask` returns `"marked"` and completes the abort asynchronously (pi-durable `harness/types.d.ts:661-665`), and both the test's `liveScheduleTasks` and reconcile's own `liveScheduleTasksByJob` count a task with `abortRequested: true` as live. The dynamic import only bought enough time for the abort to finish.

**Files:**
- Modify: `src/jobs/reconcile.ts` (static imports; `liveScheduleTasksByJob` skips records with `abortRequested: true`), `src/jobs/observe.ts` (static import)
- Modify: `test/jobs-reconcile.test.ts` (`liveScheduleTasks` skips `abortRequested`; new tests)
- Modify: the W4 ledger note, if it exists in the repo (`grep -rn "dynamic import" docs/ src/jobs`), to remove the "pi-durable upstream question"

- [ ] **Step 1: Write the failing tests** in `test/jobs-reconcile.test.ts`:
  - make the static-import change first (Step 3's import half) so the existing deleteApi test fails as measured;
  - Review Focus 3: `createApi` a tick job, then `updateApi(id, {enabled: false})` and immediately `updateApi(id, {enabled: true})` with no awaits in between other than the calls themselves; afterwards exactly one schedule task for the job has `abortRequested !== true` and a non-terminal status, and its `input.hash` equals the record's hash;
  - an aborting task (abort marked, not yet terminal) is not returned by reconcile's live scan (export `liveScheduleTasksByJob` for the test, or assert through a reconcile pass that creates the replacement executor rather than leaving the job without one).
- [ ] **Step 2: Run** `npx vitest run test/jobs-reconcile.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Static imports in both files; `if (record.abortRequested === true) continue;` in `liveScheduleTasksByJob`; the same skip in the test helper.
- [ ] **Step 4: Run** `npx vitest run test/jobs` five times in a row (`for i in 1 2 3 4 5; do npx vitest run test/jobs || break; done`) to show it isn't timing-dependent, then `npm test && npm run typecheck` — PASS. `grep -rn 'import("./docs' src/jobs` returns nothing.
- [ ] **Step 5: Commit** `git commit -m "jobs: aborting tasks are not live executors; drop the timing-dependent dynamic imports"`.

### Task 3: Make the core suite self-contained

**Finding:** `test/interaction-decide.test.ts:85-101` imports `../../sigrun-ext-approvals/dist/index.js` and `../../sigrun-ext-codemode/dist/index.js` from sibling checkouts. A fresh clone, CI, or deleting `sigrun-ext-approvals` (planned) breaks `npm test`. W2's plan named an in-repo `test/fixtures/fixture-gate` that was never created.

The test checks two things: core's interaction decide flow (a core guarantee), and that a gated tool called from inside a codemode script still prompts (a codemode guarantee that depends on pi-durable routing inner calls through `beforeTool`).

**Decision:** the decide flow moves to an in-repo fixture and always runs. The codemode-nesting assertion runs only when the codemode sibling is present, with a visible skip reason, and moves to `sigrun-ext-codemode`'s own suite once sigrun is published (it can then depend on `sigrun` as a dev dependency).

**Files:**
- Create: `test/fixtures/fixture-gate/package.json`, `test/fixtures/fixture-gate/index.js` (an extension whose `beforeTool` hook gates one named tool by writing a pending interaction with an allow/deny `options` body in today's interaction format, and resolves the hook from the answer: `allow` runs the tool, `deny` returns a refusal result)
- Modify: `test/interaction-decide.test.ts` (import `fixture-gate` by file URL; the codemode case wrapped in `describe.runIf(existsSync(codemodePath))` with a `console.info` naming the missing path when skipped)
- Test: the same file

- [ ] **Step 1: Write the failing test:** with `fixture-gate` loaded and a faux model scripted to call the gated tool directly: the run pauses with one pending interaction; answering `allow` through `POST …/interactions/:callId/answer` runs the tool (its marker appears in the tool result); a second run answered `deny` returns the refusal and the tool's marker is absent.
- [ ] **Step 2: Run** `npx vitest run test/interaction-decide.test.ts` — FAIL (fixture missing).
- [ ] **Step 3: Implement** the fixture and the test restructure. The sibling check is `existsSync(codemodePath) && process.env.SIGRUN_TEST_HIDE_SIBLINGS !== "1"`, so the skip path can be exercised. The approvals import is gone; `grep -rn sigrun-ext-approvals test src` returns nothing.
- [ ] **Step 4: Run** the file with the codemode sibling present (both cases pass) and with `SIGRUN_TEST_HIDE_SIBLINGS=1` making the path check fail (decide case passes, codemode case reported skipped); then `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `git commit -m "test: in-repo gate fixture for the decide flow; codemode nesting runs only with the sibling present"`.

### Task 4: Events stream denies unknown event types

**Finding:** `visible()` in `src/server/routes/events.ts` handles `providers.changed`, `job.changed` and `taskSettled` explicitly; every other type falls into a branch that snapshots `SessionMetaDoc` for `event.conversationId`. An event with no `conversationId` yields no meta, and `accessOf(principal, {})` is `"write"` for an ownerless resource, so the event goes to every client. Nothing emits such an event today; the ui-blocks work will.

**Files:**
- Modify: `src/server/routes/events.ts` (`visible()` becomes an exhaustive `switch (event.type)`)
- Test: `test/events-stream.test.ts`

**Interfaces:** the switch has one `case` per `HostEventWire` member in `shared/src/views.ts` (`conversation.created`, `conversation.changed`, `run.admitted`, `run.settled`, `interaction.pending`, `interaction.settled`, `ambient.changed` → conversation-scoped by `SessionMetaDoc` access; `providers.changed` → everyone; `job.changed` → `accessOf` on the job, enriched with `access`; `taskSettled` → never) and a `default` that assigns `event satisfies never` and returns `undefined`.

- [ ] **Step 1: Write the failing test:** publish a hub event whose `type` is not a known member (cast through `unknown`) and assert neither alice's nor bob's stream receives it within 200 ms while a following `providers.changed` does arrive (proves the stream is alive); add a type-level test file (`test/events-exhaustive.typecheck.ts`, included in `tsc`) that would fail to compile if a member were added without a case — demonstrate by temporarily adding a member locally in Step 2, then reverting.
- [ ] **Step 2: Run** `npx vitest run test/events-stream.test.ts` — FAIL (unknown event delivered).
- [ ] **Step 3: Implement** the switch.
- [ ] **Step 4: Run** the file and `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `git commit -m "events: exhaustive per-type visibility; unknown event types are never delivered"`.

### Task 5: Storage failure pages again

**Finding:** W2 moved the scrape from `/readyz` to `/metrics` and re-keyed `SigrunNotReady` on `up == 0 or sigrun_up == 0`. `sigrun_up` reflects `harness.inspect()`; `/readyz`'s storage check (reading the root conversation) has no metric. When that read fails, `/readyz` answers 503 but `/metrics` answers 200, so nothing fires.

**Files:**
- Create: `src/server/readiness.ts` (`checkStorage(ctx: ServerContext): Promise<"ok" | "failed">`, the exact read `/readyz` does today)
- Modify: `src/server/routes/probes.ts` (`/readyz` calls `checkStorage`), `src/server/routes/metrics.ts` (new gauge `sigrun_ready`, 1 when `checkStorage` is `"ok"`, else 0, with `# HELP`/`# TYPE` lines), `charts/sigrun/templates/prometheusrule.yaml` (`SigrunNotReady` expr gains `or sigrun_ready == 0`; its description names all three conditions), `README.md` (the metrics and alerts tables)
- Test: `test/server-metrics.test.ts`, `test/server-probes.test.ts`, `test/manifests.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - with the harness's root-conversation read made to throw (stub `opened.harness.conversation` to reject), `/metrics` contains `sigrun_ready 0` and still returns 200, and `/readyz` returns 503 `{ready: false, checks: {storage: "failed"}}`; restoring the stub gives `sigrun_ready 1` and `/readyz` 200 (Review Focus 5);
  - `test/manifests.test.ts`: the rendered `SigrunNotReady` expr equals `up{job="sigrun"} == 0 or sigrun_up == 0 or sigrun_ready == 0` (update the existing assertion at line ~558).
- [ ] **Step 2: Run** `npx vitest run test/server-metrics.test.ts test/server-probes.test.ts test/manifests.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `/readyz` and the gauge share `checkStorage`, so they can't disagree.
- [ ] **Step 4: Run** the full gate: `npm test && npm run typecheck && npm --workspace @sigrun/webui run test && npm run typecheck:webui && npm run build:webui && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck && npm run test:e2e` — PASS.
- [ ] **Step 5: Commit** `git commit -m "metrics: sigrun_ready gauge from the readiness storage check; SigrunNotReady fires on storage failure"`.

---

## After the branch

- Merge `fix/hardening-review` into main with `--no-ff` after the full gate.
- The ui-blocks plans already account for Tasks 3 and 4 (U6 creates `fixture-gate` only if missing; U3/U4 add explicit `visible()` cases). After this branch lands, U6's "create if missing" step becomes a no-op and U3/U4 add cases to the exhaustive switch, which the typecheck now enforces.
