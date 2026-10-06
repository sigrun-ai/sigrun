# Sigrun Core Skeleton (M0 + M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the durable sigrun core — pi-durable harness over SQLite, the §3 surface contracts with degenerate defaults, the §5 HTTP/SSE server, the approvals extension, degenerate memory, skills, static workspace, backup, and deployment — and prove durability with the §7 M1 crash battery.

**Architecture:** One Node process runs `Harness.open()` over file-backed SQLite, exposes the §5 JSON+SSE API, and serves degenerate defaults for every surface. Extensions arrive as pi-durable `defineExtension` bundles selected globally at boot. All upstream contact goes through the §3 contracts; the serialized view/event shapes are captured as in-repo type fixtures so upstream drift fails a test, not a deploy.

**Tech Stack:** TypeScript, Node ≥ 22 (built-in `node:sqlite` via `openNodeSqliteStorage`), `@earendil-works/pi-durable@1.0.2` (exact pin), `@earendil-works/pi-ai`, TypeBox (`@sinclair/typebox`) for tool schemas, Fastify (or `node:http`) for the server, vitest for tests.

**Specs (read all three; the plan argues from them):**
- `docs/superpowers/specs/2026-10-04-sigrun-core.md` — the contract being built (primary)
- `docs/superpowers/specs/2026-10-04-sigrun-hermes-replacement.md` — consumes the contracts; do not break its assumptions
- `docs/superpowers/specs/2026-10-04-sigrun-improvements.md` — deferred lanes; build only what unblocks them
- `docs/superpowers/specs/2026-10-04-sigrun-core.md` Appendix C + C.1 — the verification record; several "named M1 verifications" are already resolved there by type inspection

## Global Constraints

- `@earendil-works/pi-durable` pinned to **exactly `1.0.2`** (no ranges) in `package.json`. Copy from spec §4.2.
- Every upstream-behavior claim is either verified in Appendix C/C.1 or exercised by an M1 crash-battery test with a recorded outcome. No prose-only assertions. (Spec §2, binding.)
- **Fail loud:** schema-version mismatch refuses to render; unknown model id 4xx with the available list; a failing extension is quarantined + surfaced in `GET /v1/meta`, never silent. (Spec §2.)
- SQLite lives on **block-like storage** (spec §4.3), never NFS. In this greenfield M1 the harness path is a local directory; the chart constraint is a deployment concern, not code.
- **One process owns the sqlite file** (spec App C "no cross-process locking, accepted"). Do not add a second writer; the backup CronJob is a separate pod that reads the file, and its live-harness safety is battery item 8.
- Extensions are **trusted code with no capability isolation** (spec §4.4). Do not add sandboxing.
- Node's built-in `node:sqlite` is the storage driver (`openNodeSqliteStorage` from `pi-durable/storage/sqlite/node`). Do not add `better-sqlite3` unless a task proves the built-in insufficient.
- Single-user, multi-session. `owner` field exists in session-meta schema from day 1; no auth flow. (Spec §5 multi-user seam.)
- TypeScript strict; ESM; no runtime plugin management — extensions are a deploy-time list.

## Review Focus

The spec is a vision document; these input classes / failure modes are implied but not owned by any single task's tests. Each line names the input and the behavior a reasonable person expects; each gets its test added to the owning task.

1. **A `submissions` POST with an image `path` that does not exist in the workspace** → an explicit error part in the submitted content, never a silent drop and never a 500. *(Test in T-SERVER, submissions step.)*
2. **A `configure` call pinning a conversation to a model id no contributor serves, then a submit** → 4xx at submit listing available ids; the bad configure either 4xx'd at configure time or the submit fails loud. Never a silent fallback to a default model. *(Test in T-PROVIDER + T-SERVER.)*
3. **Two extensions both contributing a provider/model with the same id** → deterministic last-registered-wins, the collision logged, and `GET /v1/meta` lists it. Never a silent merge. *(Test in T-PROVIDER.)*
4. **A skill directory with two `SKILL.md` sharing one `name`, and a `skills/` dir with non-SKILL.md files** → last-wins + logged for the collision; non-SKILL.md files ignored; section stays ≤4KB with a truncation notice. *(Test in T-SKILLS.)*
5. **A crash (`kill -9`) during background compaction, then resume, then a new submit** → resume succeeds, no half-written summary entry, previously-committed turns intact, view serializes, subsequent submits succeed. *(Battery item 3 in T-BATTERY.)*

---

## File Structure

Greenfield `package.json` in the worktree root; sources under `src/`.

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | tooling; exact pi-durable pin |
| `src/harness/boot.ts` | boot order: load extensions → collect provider contributions → `Harness.open` → `resume()`; quarantine on boot failure |
| `src/harness/registry.ts` | the pi-durable `Registry` (`createRegistry()`), degenerate extensions installed |
| `src/harness/workspace.ts` | `workspaceService.forConversation()` → static `ExecutionEnv` (local path); the the-work-fabric-scrubbed-swap seam |
| `src/harness/providers/index.ts` | provider-contributor contract: collect `createProvider()` results + defaults, merge into one `Models`, env-driven OpenAI-compat degenerate provider |
| `src/harness/sections/context-files.ts` | `SOUL.md`/`AGENTS.md` → prompt sections via conversation ExecutionEnv; missing file = empty section |
| `src/extensions/memory/degenerate.ts` | degenerate `MemoryBackend` extension: observe hook (afterResponse + paired user capture), recall tool over `entries()`, placeholder `section()` |
| `src/extensions/memory/backend.ts` | the `MemoryBackend` interface + observe-record schema (conversationId, generationId, role, text, timestamp) |
| `src/extensions/approvals/index.ts` | approvals extension: `beforeTool` block/await, durable-memo decisions, per-conversation policy doc, submission-abort auto-deny |
| `src/extensions/skills/index.ts` | skills convention: workspace `skills/` scan, 4KB-capped section, `load_skill` tool |
| `src/extensions/health.ts` | `health()` aggregation into the §5 meta `health` block |
| `src/server/index.ts` | HTTP server: §5 endpoints, SSE view/event streams, auth seam (trusted-principal passthrough) |
| `src/server/views.ts` | serialize `ConversationView` + `LiveDoc` + `InboxDoc` + `watchEvents` into the wire shape; capture the fixture |
| `src/server/schema-fixture.ts` + `test/fixtures/` | captured-schema type fixture + drift test |
| `src/config.ts` | env parsing: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `SIGRUN_MODEL`, storage path, extension list, backup config |
| `chart/` (or `deploy/`) | reference chart values per spec §4.4 + Appendix D (homelab instantiation) — manifests only, no cluster apply in M1 |
| `test/` | vitest unit/integration + `test/battery/` crash-restart integration scripts |

---

## Task 0: Project scaffolding + pinned deps

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (node_modules, dist, data), `src/config.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): SigrunConfig` where `SigrunConfig = { storagePath: string; models: { provider, modelId } ; extensionsDir: string; port: number; backup?: { target: "s3"|"path", ... } }`. Later tasks import `loadConfig`.

- [ ] **Step 1: Write the failing smoke test**
```ts
// test/smoke.test.ts
import { expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
test("loadConfig requires SIGRUN_MODEL", () => {
  expect(() => loadConfig({ OPENAI_BASE_URL: "x", OPENAI_API_KEY: "y" })).toThrow(/SIGRUN_MODEL/);
});
```
- [ ] **Step 2: Run, expect FAIL** (`loadConfig` not defined). `npx vitest run test/smoke.test.ts`
- [ ] **Step 3: Scaffold.** `package.json` deps: exact `"@earendil-works/pi-durable": "1.0.2"`, `@earendil-works/pi-ai`, `@sinclair/typebox`, `fastify`; dev: `typescript`, `vitest`, `tsx`. `tsconfig`: strict, `module: NodeNext`, `target: ES2023`. Implement `src/config.ts` `loadConfig`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `chore: scaffold sigrun core (pin pi-durable 1.0.2)`

## Task 1: Harness open + resume over SQLite (storage + root conversation)

**Files:**
- Create: `src/harness/boot.ts`, `src/harness/registry.ts`
- Test: `test/harness-open.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (T0).
- Produces: `openHarness(config): Promise<{ harness: Harness; registry: Registry }>`; `Harness` and `Registry` are pi-durable's types. Every later task takes `{ harness, registry }`.

- [ ] **Step 1: Failing test** — opening a harness on a fresh SQLite file, creating a root conversation via `harness.root(context)`, closing, reopening the same file, and re-reading the conversation returns the same id (durability).
```ts
test("harness reopens persisted root conversation", async () => {
  // openNodeSqliteStorage(tmp.db) → Harness.open(storage, {models, registry}) → root()
  // close, reopen, root() → same id
});
```
- [ ] **Step 2: Run, expect FAIL** (no `openHarness`).
- [ ] **Step 3: Implement** `boot.ts`: build storage via `openNodeSqliteStorage(config.storagePath)`, an empty `createRegistry()`, a degenerate `Models` (a stub is fine until T-PROVIDER), `Harness.open(storage, { models, registry })`, then `harness.resume()`. Use `Harness.root(context)` to create/get the root conversation.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: harness open/resume over sqlite`

## Task 2: Provider-contributor contract + env degenerate provider

**Files:**
- Create: `src/harness/providers/index.ts`
- Modify: `src/harness/boot.ts`
- Test: `test/providers.test.ts`

**Interfaces:**
- Consumes: `openHarness` (T1).
- Produces: `collectProviders(extensions, env): { models: Models; defaultModel: ModelRef }`; merge semantics = deterministic last-registered-wins, collisions logged to a sink the meta endpoint reads. Degenerate provider = `createProvider({ id: "openai", auth: { apiKey: { resolve: async () => ({ auth: { apiKey, baseUrl } }) } } })` (verified shape, App C).

- [ ] **Step 1: Failing tests** (Review Focus #2, #3):
```ts
test("unknown model id at submit fails loud with available ids", ...);
test("two contributors with same model id: last wins, collision logged", ...);
test("SIGRUN_MODEL overrides any contributor default", ...);
```
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the merge (`collectProviders`) and wire the degenerate env provider when no extension contributes one. Models entries carry `baseUrl`/`input`/`cost` (verified App C).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: provider-contributor contract + env degenerate provider`

## Task 3: Static workspaceService (ExecutionEnv wrapper)

**Files:**
- Create: `src/harness/workspace.ts`
- Modify: `src/harness/boot.ts` (pass `env` into `HarnessOptions`)
- Test: `test/workspace.test.ts`

**Interfaces:**
- Consumes: `openHarness` (T1).
- Produces: `workspaceService.forConversation(conversation, prefs): Promise<ExecutionEnv>`; the wrapper signature is the the-work-fabric-scrubbed-swap seam (spec §4.5). v1 returns a local-path env rooted at the configured workspace dir.

- [ ] **Step 1: Failing test** — `HarnessOptions.env(target, ctx)` is called per tool call (verified App C); assert the builder returns an env whose `FileSystem.id` is stable and `cwd` is the configured workspace root.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** using pi-durable's local Node env (the per-tool-call env builder shape from `EnvTarget`); confirm `FileSystem.listDir` exists on it (App C.1 resolved).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: static workspace service`

## Task 4: Context files (SOUL.md / AGENTS.md) as prompt sections

**Files:**
- Create: `src/harness/sections/context-files.ts`
- Test: `test/context-files.test.ts`

**Interfaces:**
- Consumes: `workspaceService` (T3) for the conversation's ExecutionEnv file reads.
- Produces: a `defineExtension` contributing two `section()`s keyed `persona` and `workspace-instructions`; missing file → empty section (no error).

- [ ] **Step 1: Failing tests** — missing `SOUL.md` yields an empty/absent persona section; a present `SOUL.md` in the workspace yields its body in the `persona` section; a present `AGENTS.md` yields the workspace-instructions section.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with `section(key, render)` from `pi-durable`, reading via `input.env` (the `PromptInput.env`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: context-file sections (SOUL.md/AGENTS.md)`

## Task 5: MemoryBackend interface + degenerate implementation

**Files:**
- Create: `src/extensions/memory/backend.ts`, `src/extensions/memory/degenerate.ts`
- Test: `test/memory-degenerate.test.ts`

**Interfaces:**
- Consumes: `harness`, sections (T4).
- Produces: `interface MemoryBackend { observe(record: ObserveRecord): void; recall(query: string): Promise<RecallResult[]>; section(): string }`; `ObserveRecord = { conversationId, generationId, role: "user"|"assistant", text, timestamp }`. The observe hook is a `hook(GenerationTask, { afterResponse })` + a paired user-side capture (read the just-committed user entry via `HookApi.read`, per App C.1); replay-guard via `api.memo` keyed by generation id.

- [ ] **Step 1: Failing tests**:
  - after one user+assistant turn, the degenerate backend observed **two** records (user + assistant) with correct roles.
  - `recall(q)` over `conversation.entries()` returns a match from an entry compacted out of the live window (force compaction via tiny `reserveTokens`); **this is the App C `entries()`-reachability verification** — if entries can't reach dropped entries, record the fallback (direct SQLite read) and use it.
  - `section()` returns the stable placeholder string.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the interface, the observe hook (assistant from `afterResponse` arg; user from the paired read), the recall tool as a `defineTool` querying `entries()`, and the placeholder section.
- [ ] **Step 4: Run, expect PASS** (or record the entries() fallback outcome in App C).
- [ ] **Step 5: Commit** `feat: degenerate MemoryBackend (observe/recall/section)`

## Task 6: Approvals extension (beforeTool + durable memo + auto-deny)

**Files:**
- Create: `src/extensions/approvals/index.ts`
- Test: `test/approvals.test.ts`

**Interfaces:**
- Consumes: `harness`, a `write`/`exec` dummy tool to gate.
- Produces: approvals extension contributing a `hook(ToolTask, { beforeTool })`; policy doc (per-conversation, default conservative: write/exec prompt, read-only pass); decision enum `allow|deny`; **submission abort auto-denies that submission's pending approvals** (memo reason `aborted`). Pending approvals are readable via the conversation's docs for the server.

- [ ] **Step 1: Failing tests**:
  - a write tool triggers a pending approval (hook awaits); an `allow` decision lets it run; a `deny` produces an error tool-result.
  - **crash durability (behavioral, App C verified)**: block mid-pending, `kill -9` the process, restart, `resume()`, supply the decision → the tool consumes the memoized decision exactly once (no re-prompt, no re-execute). Drive this with two process spawns.
  - aborting the submission auto-denies its pending approvals (memo reason `aborted`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `beforeTool` block/await via `api.memo`, the policy document (`defineDoc` conversation scope), and the auto-deny on abort (listen for the submission's abort settlement).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: approvals extension (durable memo, auto-deny)`

## Task 7: Skills convention

**Files:**
- Create: `src/extensions/skills/index.ts`
- Test: `test/skills.test.ts`

**Interfaces:**
- Consumes: `workspaceService` (T3).
- Produces: a core-owned extension (skills loader + `load_skill` tool are **core-owned, not quarantinable**, spec §3) scanning `{workspace}/skills/*/SKILL.md`; section carries name+description, ≤4KB with truncation notice; `load_skill(name)` returns the body, unknown name → explicit error. **Core-owned** (not an extension) per spec §3.

- [ ] **Step 1: Failing tests** (Review Focus #4): name collision last-wins + logged; non-SKILL.md files ignored; 4KB cap with truncation notice; unknown `load_skill` name → explicit error.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the directory scan (via ExecutionEnv `listDir`/`readTextFile`), frontmatter parse (`name`,`description` required), the section, and the `load_skill` `defineTool`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: skills convention (scan, section, load_skill)`

## Task 8: Context-management defaults (compaction tuning)

**Files:**
- Modify: `src/harness/boot.ts` (settings), `src/config.ts`
- Test: `test/compaction.test.ts`

**Interfaces:**
- Consumes: `openHarness` (T1), provider default (T2).
- Produces: `HarnessSettings.compaction` = `{ enabled, reserveTokens, keepRecentTokens, backgroundTokens }` tuned against the default model's window; summarizer pinned to the cheapest long-context contributed model (spec §3.1).

- [ ] **Step 1: Failing test** — with a small `reserveTokens`/`backgroundTokens`, a conversation that overflows triggers background compaction and a summary entry appears; `resume()` after kill mid-compaction leaves transcript consistent (forward-ref to T-BATTERY for the kill).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** settings wiring + `beforeCompact` default (accept upstream summary in v1).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: compaction policy defaults`

## Task 9: §5 HTTP/SSE server + captured-schema fixture

**Files:**
- Create: `src/server/index.ts`, `src/server/views.ts`, `src/server/schema-fixture.ts`, `test/fixtures/view-schema.json`
- Test: `test/server.test.ts`, `test/schema-drift.test.ts`

**Interfaces:**
- Consumes: `openHarness`, providers, workspace, memory, approvals, skills (T1–T7).
- Produces: the §5 endpoints; `GET /v1/meta` shape `{ harnessVersion, schemaVersion, extensions[{name,status}], health{backup,memory,providers}, capabilities{backup, channels: string[]} }`; the composite view serializer (ConversationView + LiveDoc + InboxDoc + watchEvents per App C.1); the in-repo type fixture. `capabilities.channels` lists deployed channel bundles — `["webui"]` when its static bundle is present, `[]` when the core serves the API only.

- [ ] **Step 1: Capture the fixture first** (planned work, App C): serialize a real `ConversationView` + `LiveDoc` + `InboxDoc` + an `AgentEventStream` snapshot, commit as `test/fixtures/view-schema.json`. Write `test/schema-drift.test.ts` that fails if the serialized shape diverges from the fixture (this is the upstream-drift tripwire).
- [ ] **Step 2: Failing server tests** — the full §5 v1 endpoint list:
  - `POST /v1/conversations`, `GET /v1/conversations` (list w/ session-meta)
  - `GET/PATCH /v1/conversations/:id/meta` (pinned/tagged/archived/draft/source; merge + null-clear)
  - `POST /v1/conversations/:id/submissions` (content parts; **missing image path → explicit error part**, Review Focus #1; `requestId` idempotent)
  - `POST /v1/conversations/:id/uploads`, `GET .../files?path=`, `GET .../files/content?path=`
  - `GET /v1/models`, `POST .../abort`, `POST .../configure` (accepts exactly `model`,`thinking`)
  - `GET .../approvals`, `POST .../approvals/:approvalId` `{decision}`
  - `GET /v1/meta`
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement** the server (Fastify), SSE streams for view + events (reconnect = re-attach → fresh snapshot, per App C.1), and the meta health aggregation from `health()`.
- [ ] **Step 5: Run, expect PASS** incl. the schema-drift test green.
- [ ] **Step 6: Commit** `feat: §5 HTTP/SSE server + captured-schema fixture`

## Task 10: Session-meta document + sidebar resource

**Files:**
- Create: `src/server/session-meta.ts` (document definition) — or fold into `src/extensions/` if it reads better as an extension
- Modify: `src/server/index.ts`
- Test: `test/session-meta.test.ts`

**Interfaces:**
- Produces: the conversation-scoped session-meta document (`defineDoc` conversation scope): `{ pinned: bool, tagged: string[], archived: bool, draft: { text, attachments: string[] }, source: "user"|"cron", owner?: string }`. `owner` present, unused. Backing = pi-durable document (App C co-tenancy decision: documents first).

- [ ] **Step 1: Failing tests** — default meta on create; PATCH merges; explicit `null` clears a field; `draft.attachments` round-trips; `source` accepts only `user|cron`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the document + the GET/PATCH handlers (already wired in T9 routes).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: session-meta document + resource`

## Task 11: Backup capability (optional) + restore drill

**Files:**
- Create: `src/backup/` (a small script invoked by the CronJob), `deploy/cronjob-backup.yaml`
- Modify: `src/config.ts` (backup config), `src/server/index.ts` (capabilities.backup)
- Test: `test/backup.test.ts`

**Interfaces:**
- Produces: when backup configured, `capabilities.backup: true` and a nightly `sqlite3 .backup` to the configured target (S3 or mounted path). When absent, `capabilities.backup: false` + `health.backup: "unconfigured"` (badge, not error).

- [ ] **Step 1: Failing test** — with backup unconfigured, `GET /v1/meta` reports `capabilities.backup: false`; the backup script produces a restorable `.backup` file from the **live** harness database (App C named verification).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the backup script (uses `sqlite3 <db> ".backup <out>"`), the config, the meta fields, and the CronJob manifest (block-storage node placement rule from §4.3).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Restore drill (manual step, recorded):** restore the `.backup` to a scratch path, `Harness.open` it, `resume()`, read the root conversation. Record the outcome in Appendix C.
- [ ] **Step 6: Commit** `feat: optional backup capability + restore drill`

## Task 12: Crash-verification battery (M1 exit)

**Files:**
- Create: `test/battery/` — one runnable script per battery item (spawn a real harness process, `kill -9`, restart, assert)
- Test: `test/battery/*.test.ts`

**Interfaces:**
- Consumes: everything above.

The §7 M1 exit criteria, each an automated spawn-and-kill integration test, outcomes recorded into Appendix C:

- [ ] **Step 1: mid-generation** — `kill -9` mid-streaming-generation → restart → answer completes **or** is marked aborted; no duplicate final answer.
- [ ] **Step 2: mid-tool-call** — `kill -9` mid-tool → safe tools may re-execute; unsafe tools must NOT silently re-execute (parked/failed with visible state); memo records the outcome.
- [ ] **Step 3: mid-compaction** — `kill -9` during background compaction (tiny `reserveTokens`) → resume succeeds, no half-written summary, committed turns intact, view serializes, subsequent submits succeed. *(Review Focus #5.)*
- [ ] **Step 4: duplicate requestId** — duplicate-`requestId` submit after crash → single completion.
- [ ] **Step 5: submit-while-busy** — queued/steered behavior observed + recorded.
- [ ] **Step 6: hook re-fire on replay** — observed + recorded (finalizes the observe-guard design).
- [ ] **Step 7: task wake after kill-during-sleep** — exactly-once wake, no double-fire, no missed wake.
- [ ] **Step 8: live-harness backup resumes** — `sqlite3 .backup` against the running harness restores + resumes (from T11).
- [ ] **Step 9: Record every outcome in Appendix C** (the M1-results slot) and update the named-verifications list (each becomes verified or its fallback is taken).
- [ ] **Step 10: Commit** `test: M1 crash-verification battery + recorded outcomes`

## Task 13: Reference deployment manifests (chart values)

**Files:**
- Create: `deploy/` (or `chart/`) — Deployment (single replica, Recreate, RWO), Service (ClusterIP), backup CronJob, ServiceMonitor/PrometheusRule per spec §4.4; `deploy/values.homelab.yaml` carrying Appendix D (iSCSI class, Tailscale LB `sigrun.tailnet.example.test`, RustFS target, worker nodeSelector + toleration)
- Test: `test/manifests.test.ts` (optional: `helm template`/`kustomize build` renders without error)

**Interfaces:**
- Produces: portable chart/values (§4.4) + the homelab overlay (Appendix D). No cluster apply in M1 — render-only.

- [ ] **Step 1: Write manifests** per §4.4 portable requirements (Recreate/RWO, block storage, health-vs-ready probes, wedged-state gauges) and the Appendix D homelab values.
- [ ] **Step 2: Render check** — `helm template` (or `kustomize build`) succeeds; the CronJob carries the node-placement constraint for node-bound storage.
- [ ] **Step 3: Commit** `feat: reference deployment manifests + homelab overlay`

---

## Self-Review notes (already applied)

- **Spec coverage:** M0 (Task 0), M1 deliverables (Tasks 1–13) map 1:1 to core §7 M1's list incl. the crash battery (Task 12) and backup/restore (Task 11). M2 (webui) is **deliberately a separate plan** — its §6.3 audit (port vs rebuild) forks the task list and must be written after the audit runs.
- **App C.1 resolutions folded in:** `pi.agent`/C6b seam (real), `listDir` (verified), `afterResponse` user-capture (paired-read design), composite view (ConversationView + LiveDoc + InboxDoc + watchEvents).
- **Review Focus:** all five lines have a test in the owning task (noted inline).
- **Proportion:** plan carries signatures + test names, not bodies.

## What this plan deliberately does NOT include

- The M2 webui (separate plan, gated on the §6.3 audit outcome).
- Spec B lanes B1–B4 (they consume these contracts; building them is the hermes-replacement plan).
- Spec C lanes (all deferred).
- Cluster apply / Flux wiring (M1 is render-only; deploy is a separate ops step).
