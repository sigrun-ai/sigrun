# W4 — Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable core scheduler. Jobs (cron / every / at schedules; prompt or task actions) come from the API, `settings.json`, or extensions. Each job runs as one background pi-durable task, survives restarts, fires exactly once per slot, and is visible and runnable through `/v1/jobs`.

**Architecture:**
- **One task per job.** Each enabled job is one background `sigrun.schedule` task on the root conversation. It loops `waiting` (durable `runtime.sleep`) → `firing` → `waiting`.
- **Desired state is reconciled.** The desired set is:
  - `file` jobs (settings);
  - `extension` jobs (factory result);
  - `api` jobs (stored in a session doc, `ApiJobsDoc`).

  It is reconciled against the live tasks by `(jobId, specHash)` at boot and after every API write.
- **Status** lives in a keyed session doc family, `JobStatusDoc`.
- **Prompt runs** are observed settling by an event-bus `runSettled` handler.

**Tech Stack:** TypeScript (NodeNext), `@earendil-works/pi-durable` 1.2.0 tasks (`defineTask`, `runtime.sleep`, `runtime.commit`, `tx.createTask`, `harness.abortTask`, `storage.scanTasks`), `croner` 10.x (new dependency), vitest + the `test/battery` kill -9 driver harness.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` §8 (all), plus the §10 W4 tests. Also §5.9 for job access and §5.8 for transfer.

**Depends on:**
- W1: principal, `accessOf`, `registerOwnershipParticipant`.
- W3: the `EventHub` for `job.changed`.
- W2 Task 8: `/metrics`, for the job metrics.

## Deviations from the spec (plan-level, flag in review)

- **`ApiJobsDoc` is a small job store for `api` jobs.** Spec §8.1 says "no separate job store". A disabled `api` job has no live task, yet must persist its definition, so `api` definitions live in one session doc. Tasks remain the only executors, and the spec's semantics are unchanged. File and extension jobs still have no store; their source is their declaration.
- **The fire record is atomic through `ConversationInit`, not through the task-state commit.** Spec §8.1 describes the atomic step 1 as one `runtime.commit` that creates the conversation AND records its id. pi-durable's raw `tx.createConversation` cannot apply an `AgentChange` (the run conversation needs the job's model), so step 1 uses `harness.createConversation({ownership, agent, init})`. The `init` callback, which runs inside the creating commit, writes the `JobFireDoc` record keyed `<jobId>:<fireAt>`. Re-entry reads that record first. The guarantee is the same: the conversation and the record of it are atomic.
- **Run-now fires through the same `fireJob` function directly from the route,** with fire key `<jobId>:manual:<epochMs>`. It does not wake the task. The scheduled cadence is unaffected.

## Global Constraints

- **Task kind:** `sigrun.schedule`, version 1, created with `{ownership: {kind: "conversation"}, conversationId: rootId, background: true}`.
- **Job ids:** `api:<uuid>`, `file:<name>`, `ext:<slug>:<name>`. Names match `^[a-z0-9][a-z0-9._-]*$`.
- **Schedules:**
  - `{cron: string, timezone?: string}` — 5-field; `timezone` is an IANA name, defaulting to `server.timezone` (default: the process TZ, `Intl.DateTimeFormat().resolvedOptions().timeZone`);
  - `{every: string}` — `^\d+(s|m|h|d)$`, minimum 60s;
  - `{at: string}` — ISO 8601.
- **Defaults:** `overlap: "skip"` (`"skip"` | `"queue"`); `catchUp: "once"` (`"once"` | `"none"`; under `"none"` a fire missed by more than 60 s is recorded `skipped`); `enabled: true`.
- **Actions:**
  - `{kind: "prompt", prompt: string, model?: "provider/id", thinking?: ThinkingLevel, conversation: "new" | number, runSharing?: Sharing}`. `model`/`thinking`/`runSharing` apply only to `"new"`.
  - `{kind: "task", task: string, input?: JsonValue}`. An unregistered task name → job `state: "blocked"` with `reason: "task <name> is not registered"`.
- **Run conversation:**
  - pi-durable `ownerless` (not task-owned);
  - `SessionMeta` `{owner: job.owner, sharing: action.runSharing, source: "cron", jobId, name: "<job name> · <YYYY-MM-DD HH:mm in the job TZ>"}`;
  - the auto-namer skips `source === "cron"`.
- **requestId** = `job:<jobId>:<fireAt>`; a manual fire uses `job:<jobId>:manual:<ms>`.
- **Status** (`JobStatusDoc`, key jobId): `{lastRun?: {at: string, outcome: "running"|"succeeded"|"failed"|"skipped", conversationId?: number, error?: string}, nextRun?: string}`.
- **Access:** jobs carry `owner?` + `sharing?` and use `accessOf`.
  - Read lists/gets.
  - Write is needed for PATCH, DELETE, and run-now.
  - Ownerless jobs are household-write.
- **Verification:** per task `npm test` + `npm run typecheck`; the battery tests run within `npm test` (they live under `test/battery`).

## Review Focus

1. **Calling `harness.createConversation` from inside a task phase.** It must not deadlock the Session line. It is called from the phase body, never inside a `runtime.commit` callback. Task 2's battery test exercises it end to end; if it deadlocks, the test times out loudly.
2. **A DST spring-forward slot** (`30 2 * * *` America/New_York on 2026-03-08). croner skips the non-existent time; the job's `nextRun` jumps to the next day. Task 1 pins croner's behavior so an upgrade cannot silently change it.
3. **A `file` job renamed in `settings.json`.** The old id's task is aborted and the new one created. `JobStatusDoc` history for the old id stays (an orphan doc row, accepted). Task 3 pins abort + create.
4. **An extension job whose extension is quarantined on a later boot.** It becomes undeclared, so its task is aborted. On re-enable it returns with a fresh task; its status doc persists. Task 3 pins this.
5. **Boot with many overdue `every` jobs after long downtime.** `catchUp: "once"` fires each once, then schedules from now; it never fires once per missed interval. Task 2 pins it: nextAt is computed from `now`, not from the missed slot.

---

### Task 1: Job spec and schedule math

**Files:**
- Modify: `package.json`, adding `"croner": "^10.0.1"` to dependencies (`npm install croner@^10.0.1`).
- Create:
  - `src/jobs/spec.ts`;
  - `src/jobs/schedule.ts`;
  - `shared/src/jobs.ts` (the wire types) + `shared/package.json` `exports["./jobs"]`.
- Test: `test/jobs-schedule.test.ts` (new).

**Interfaces:**
- Produces:
  ```ts
  // shared/src/jobs.ts
  export type JobSchedule = { cron: string; timezone?: string } | { every: string } | { at: string };
  export type JobAction =
    | { kind: "prompt"; prompt: string; model?: string; thinking?: string; conversation: "new" | number; runSharing?: Sharing }
    | { kind: "task"; task: string; input?: JsonValue };
  export interface JobSpec { name: string; schedule: JobSchedule; action: JobAction;
    overlap?: "skip" | "queue"; catchUp?: "once" | "none"; enabled?: boolean; owner?: string; sharing?: Sharing }
  export interface JobWire { id: string; name: string; source: "api" | "file" | "extension"; owner?: string;
    sharing?: Sharing; schedule: JobSchedule; action: JobAction; enabled: boolean;
    state: "waiting" | "firing" | "disabled" | "blocked"; reason?: string;
    nextRun?: string; lastRun?: JobLastRun; lastError?: string; access: "read" | "write" }
  export interface JobLastRun { at: string; outcome: "running" | "succeeded" | "failed" | "skipped"; conversationId?: number; error?: string }
  // src/jobs/spec.ts
  export function validateJobSpec(value: unknown): { ok: true; spec: JobSpec } | { ok: false; field: string; message: string };
  export function specHash(id: string, spec: JobSpec): string; // sha256 of canonical JSON (sorted keys)
  // src/jobs/schedule.ts
  export function nextFireAt(schedule: JobSchedule, after: number, defaultTz: string): number | undefined; // undefined = no more (past `at`)
  export function parseEvery(text: string): number; // ms; throws below 60_000
  ```

- [ ] **Step 1: Write failing tests:**
  - `nextFireAt({cron:"0 7 * * *", timezone:"America/Toronto"}, Date.parse("2026-10-19T12:00:00Z"), "UTC")` → `Date.parse("2026-10-20T11:00:00Z")`;
  - DST: `{cron:"30 2 * * *", timezone:"America/New_York"}` after `2026-03-07T12:00Z` → the 2026-03-09 slot (03-08 02:30 does not exist);
  - `{every:"15m"}` after t → t + 900 000;
  - `parseEvery("30s")` throws;
  - `{at: "2026-10-19T00:00:00Z"}` after a later instant → `undefined`;
  - `validateJobSpec`:
    - rejects a bad name (field `name`);
    - rejects a bad cron (field `schedule.cron`, via croner's constructor throwing);
    - rejects an unknown action kind;
    - accepts the spec §8.2 example;
  - `specHash` is stable across key order and changes when `owner` changes.
- [ ] **Step 2: Run** `npx vitest run test/jobs-schedule.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `nextFireAt` uses `new Cron(expr, { timezone }).nextRun(new Date(after))`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "jobs: spec validation + schedule math (croner, TZ/DST-correct)"`.

### Task 2: Docs, the schedule task, and `fireJob`

**Files:**
- Create:
  - `src/jobs/docs.ts`;
  - `src/jobs/fire.ts`;
  - `src/jobs/task.ts`;
  - `test/battery/drivers/job-fire.ts`;
  - `test/battery/job-fire.test.ts`.
- Modify: `src/harness/naming.ts`. `createAutoNamer` skips when `meta?.source === "cron"` (next to the existing `isTaskOwned` check).
- Test: `test/jobs-task.test.ts` (new, in-process); the battery test (kill -9); `test/naming.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // docs.ts
  export const ApiJobsDoc: SessionDocToken<{ jobs: Record<string, { spec: JobSpec; owner?: string; createdAt: string }> }>;
  export const JobStatusDoc: SessionDocFamilyToken<{ lastRun?: JobLastRun; nextRun?: string }, string>; // key = jobId
  export const JobFireDoc: SessionDocFamilyToken<{ conversationId: number }, string>;                  // key = fire key
  // fire.ts
  export interface JobRuntimeDeps { harness: Harness; models: Models; defaultModel: ModelRef; now(): number; defaultTz: string }
  export function fireJob(deps: JobRuntimeDeps, job: { id: string; spec: JobSpec; owner?: string },
    fireKey: string, fireAt: number, context: Context): Promise<{ outcome: "running" | "skipped" | "blocked"; conversationId?: number }>;
  // task.ts
  export interface ScheduleInput { id: string; spec: JobSpec; owner?: string; hash: string }
  export type ScheduleState = { phase: "waiting"; nextAt: number } | { phase: "firing"; fireAt: number };
  export function createScheduleTask(deps: JobRuntimeDeps): Task<ScheduleInput, ScheduleState, void>;
  ```
- **`fireJob` for a prompt with `conversation: "new"`:**
  1. snapshot `JobFireDoc(fireKey)`; absent → `harness.createConversation({ownership:{kind:"ownerless"}, agent: {model, thinking}, init: (tx, id) => { tx.doc(JobFireDoc, fireKey, …).conversationId = id; tx.doc(SessionMetaDoc, id) ← cron meta }})`;
  2. `harness.conversation(id).submit({type:"input", content:[{type:"text", text: prompt}], requestId: "job:" + fireKey})`;
  3. set `JobStatusDoc(jobId).lastRun = {at, outcome:"running", conversationId}`.
- **Fixed conversation:** submit directly with the requestId.
- **Overlap `skip`:** when `JobStatusDoc.lastRun.outcome === "running"`, record `skipped` and return.
- **The task action:** inside `runtime.commit`, `tx.createTask(registry task by name, input, {ownership: {kind:"task", taskId}})`. That runs in the schedule task — `fireJob` receives an optional `runtime` for this branch.
- **Phases:**
  - `waiting`:
    - `await runtime.sleep(nextAt, ctx)`;
    - under `catchUp:"none"`, `now - nextAt > 60_000` → record `skipped` and commit `{phase:"waiting", nextAt: nextFireAt(…, now)}`;
    - else commit `{phase:"firing", fireAt: nextAt}`.
  - `firing`:
    - `fireJob(…, fireKey = id + ":" + fireAt)`;
    - then `next = nextFireAt(schedule, max(now, fireAt), tz)` — **from now, not from the missed slot**;
    - `next === undefined` → commit terminal (completed); else commit `{phase:"waiting", nextAt: next}` and write `JobStatusDoc.nextRun`.
- **`initial(input)`:** `{phase: "waiting", nextAt: nextFireAt(spec.schedule, now, tz)}`.
- **`abort`:** commits terminal.

- [ ] **Step 1: Write failing tests.**
  - In-process (`test/jobs-task.test.ts`, faux provider):
    - an `every:"60s"` prompt job with an injectable clock (`deps.now`) and pi-durable's harness clock option — use the clock seam the battery's task-wake driver uses — fires once → a run conversation with `SessionMeta.source:"cron"`, `jobId`, and owner; `JobStatusDoc.lastRun.outcome === "running"` then (after the run settles and Task 3's observer lands) `succeeded`. In this task, assert `running` + `conversationId`;
    - overlap skip: a second fire while running → `skipped`;
    - a downtime-overdue fire (nextAt 3 slots in the past) fires once, and the next `nextAt > now`;
    - the auto-namer does not name the cron conversation.
  - Battery (`test/battery/job-fire.test.ts`, the `task-wake.test.ts` pattern):
    - (a) kill -9 while `waiting`, then verify: exactly one run conversation for the slot;
    - (b) kill -9 right after the driver prints `CONVERSATION_CREATED` (emitted from the `init` callback's commit observer), then verify: one conversation (`JobFireDoc` reused) and one submission (requestId dedup);
    - (c) kill -9 before creation → after restart, one conversation and zero orphans.

    The driver records markers like the task-wake driver.
- [ ] **Step 2: Run** `npx vitest run test/jobs-task.test.ts test/battery/job-fire.test.ts test/naming.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "jobs: sigrun.schedule background task, atomic fire records, overlap/catch-up, cron runs skip auto-naming"`.

### Task 3: Sources, reconciliation, run-status observer, ownership transfer

**Files:**
- Create: `src/jobs/reconcile.ts`, `src/jobs/index.ts`, with `JobsService` constructed in boot.
- Modify:
  - `shared/src/settings.ts` (`SettingsFile.jobs?: JobSpec[]`; `server.timezone?: string`);
  - `src/harness/settings.ts` (validate each entry with `validateJobSpec`; `jobs` is restart-required like `extensions`; duplicate names → validation error);
  - `src/config.ts` (`timezone`, env `SIGRUN_TIMEZONE`).
- Modify: `src/harness/loader.ts`. The factory-result field `jobs?: JobSpec[]` is validated (each `validateJobSpec`; invalid → quarantine) and collected as `LoadedExtensions.jobBindings: {extension: slug, jobs}[]`.
- Modify: `src/harness/boot.ts`:
  - register the schedule task on the registry **before** `Harness.open`, via a core extension `sigrun.jobs` with `tasks: [scheduleTask]`, installed like the other core extensions;
  - after `resume()`, `jobs.reconcile()`;
  - register a `runSettled` handler on the event bus as `sigrun:jobs` that sets `JobStatusDoc.lastRun.outcome` to `succeeded` (answered) or `failed` (unanswered, `error: reason`) for conversations whose `SessionMeta.jobId` is set;
  - expose `OpenedHarness.jobs: JobsService`.
- Modify: `src/server/ownership.ts` caller (in `createServer`). Register a jobs participant: rewrite `owner` in `ApiJobsDoc` entries owned by `from`, then `jobs.reconcile()`. File jobs whose declared owner is the deleted user get a boot-time warning: their owner no longer exists, so they run ownerless until the file is edited.

**Interfaces:**
- Produces:
  ```ts
  export interface JobsService {
    list(): Promise<JobWire[]>;                      // access computed by the route
    get(id: string): Promise<JobWire | undefined>;
    createApi(spec: JobSpec, owner: string | undefined): Promise<JobWire>;
    updateApi(id: string, patch: Partial<JobSpec>): Promise<JobWire>; // throws JobDeclaredError for file/ext ids
    deleteApi(id: string): Promise<void>;
    runNow(id: string): Promise<{ outcome: "running" | "skipped" | "blocked"; conversationId?: number }>;
    reconcile(): Promise<void>;
  }
  export class JobDeclaredError extends Error {}
  ```
- **`reconcile`:**
  - desired = file jobs ∪ extension jobs ∪ `ApiJobsDoc` jobs, filtered to `enabled !== false`;
  - live = `storage.scanTasks({kind: "sigrun.schedule"}, 500, cursor, ctx)` paged, filtered in memory to non-terminal;
  - for each desired job without a live task of the same `hash` → abort any live task with that `id`, then create;
  - for each live task whose `id` is not desired → `harness.abortTask`.

  Creation runs in one `harness.commit` (`tx.createTask(scheduleTask, input, {ownership:{kind:"conversation"}, conversationId: rootId, background: true})`).

- [ ] **Step 1: Write failing tests** in `test/jobs-reconcile.test.ts`:
  - **file jobs:**
    - boot with a `settings.json` file job → one live task;
    - reboot unchanged → still one, with the same task id;
    - change its prompt → old aborted, new created;
    - remove it → aborted;
  - **extension jobs:** a `fixture-jobs` extension declaring a job → `ext:<slug>:<name>` is live; quarantine the fixture (rename its entry) on reboot → aborted;
  - **api jobs:**
    - `createApi` → live;
    - `updateApi({enabled:false})` → aborted, and `list()` shows `state:"disabled"`;
    - `updateApi` on a `file:` id → `JobDeclaredError`;
  - `runSettled` observer: a cron run answering → `lastRun.outcome === "succeeded"`; a faux error turn → `failed` with `error`;
  - transfer: bob's api job → `transferOwnership(bob → alice)` → its owner is alice and its task was recreated (new hash);
  - terminal tasks never appear in `list()`.
- [ ] **Step 2: Run** `npx vitest run test/jobs-reconcile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The `fixture-jobs` fixture lives at `test/fixtures/fixture-jobs/index.js`: a factory returning `{extension: defineExtension({name: "fixture-jobs"}), jobs: [{name: "tick", schedule: {every: "60s"}, action: {kind: "prompt", prompt: "tick", conversation: "new"}}]}`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "jobs: file/extension/api sources reconciled to schedule tasks; run-status observer; ownership transfer"`.

### Task 4: `/v1/jobs` API, events, metrics

**Files:**
- Create: `src/server/routes/jobs.ts`.
- Modify:
  - `src/server/routes/metrics.ts`;
  - `src/server/events/hub.ts` usage (publish `job.changed`);
  - `shared/src/views.ts` (`JobsResponse`, `JobRunResponse`);
  - the `HostEventWire` `job.changed` variant narrows to `job: JobWire` (without `access`; the stream adds it per principal).
- **Routes:**
  - `GET /v1/jobs` → `{jobs: JobWire[]}`, filtered to `accessOf !== "none"`, with `access` set per principal;
  - `GET /v1/jobs/:id` → 404 `job_not_found` when hidden or missing;
  - `POST /v1/jobs` (body `JobSpec`, owner = `principal.user`) → 201 `{job}`; validation errors → 400 `{error:"invalid_field", field}`;
  - `PATCH /v1/jobs/:id` (write) → `{job}`; `file:`/`ext:` ids → 409 `job_declared`;
  - `DELETE /v1/jobs/:id` (write) → 204; declared → 409;
  - `POST /v1/jobs/:id/run` (write) → `200 {outcome, conversationId?}`.
- **`job.changed` is published** after every create/update/delete/run and after every `JobStatusDoc` change. The jobs service takes the hub as an injected `onChange(jobId)`. The status-doc changes come from the run-status observer and `fireJob`; both call `onChange`.
- **Metrics:**
  - `sigrun_job_last_run_timestamp_seconds{job,outcome}`;
  - `sigrun_job_next_run_timestamp_seconds{job}`;
  - `sigrun_job_runs_total{outcome}` (an in-process counter, reset on restart).
- Test: `test/jobs-api.test.ts` (new); `test/server-metrics.test.ts`; `test/events-stream.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - CRUD round trip as alice;
  - bob (no share) → `GET /v1/jobs/:id` 404 and absent from his list;
  - bob run-now → 404 (hidden); after alice shares household-read → bob GET 200, run-now 403;
  - a `file:` job `PATCH` → 409;
  - run-now → `outcome:"running"` and a run conversation id;
  - `/metrics` contains `sigrun_job_next_run_timestamp_seconds{job="api:`;
  - the events stream receives `job.changed` after run-now.
- [ ] **Step 2: Run** `npx vitest run test/jobs-api.test.ts test/server-metrics.test.ts test/events-stream.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "jobs: /v1/jobs API (access-scoped, declared jobs immutable), job.changed events, job metrics"`.

### Task 5: Clients and docs

**Files:**
- Create: `webui/src/jobs/JobsPanel.tsx`, a right-panel tab beside the workspace/outline tabs in `webui/src/layout/RightPanel.tsx`. It lists jobs with name, schedule, next run, last run outcome, and a link to the last run conversation, plus a "Run now" button when `access === "write"`. It refetches on `job.changed`.
- Modify:
  - `webui/src/api.ts` (`listJobs`, `runJob`);
  - `tui/src/api.ts` + `tui/src/actions.ts`: the `/jobs` slash command prints a table into the transcript pane notice area (name, next run, last outcome);
  - `src/server/commands.ts`: `/jobs` joins `SLASH_COMMANDS` with endpoint `GET /v1/jobs`.
- Modify: `README.md`, a "Jobs" section covering the three sources, the schedule/action shapes (the spec §8.2 example), overlap/catchUp, run-now, and that cron runs are ordinary continuable conversations.
- Test: `webui/src/jobs/JobsPanel.test.tsx` (renders rows; run-now only on write); a TUI `/jobs` command test; `test/server-commands.test.ts` (`/jobs` listed).

- [ ] **Step 1: Write the failing tests** above.
- [ ] **Step 2: Run** `npm --workspace @sigrun/webui test && npm --workspace @sigrun/tui test && npx vitest run test/server-commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement + docs.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui test && npm run typecheck:webui && npm --workspace @sigrun/tui test && npm run build:webui`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "jobs: webui panel with run-now, TUI /jobs, README jobs section"`.
