# Memory seam — sigrun harness events for memory extensions

**Date:** 2026-10-15
**Status:** draft for approval
**Evidence base:** `docs/interaction-seam-survey/memory-comparison.md` (21
extensions inspected, 2026-10-15) + this session's rulings.

## Intent and why

Memory extensions for sigrun currently have no host-side lifecycle to
plug into. The surveyed pi extensions each rebuilt the same plumbing
privately because pi's process-lifecycle events (session_start /
session_shutdown) don't exist in sigrun — sigrun is a long-running
server with durable conversations that never "end". This spec defines
the small host surface memory extensions need, all inside sigrun's
harness, deferring any upstream contribution (see the deferred
upstream note at the end).

**Design ruling (user, 2026-10-15):** the seam does NOT own memory
records, storage, tools, commands, or skills. Those belong entirely to
the memory extension (markdown files, SQLite, external service — its
choice). The seam owns only the *events and lifecycle* the extension
plugs into: "the right set of hooks/events for when to trigger
functionality" plus the factory contract to receive them.

## Goals

- A memory extension can capture turns without reimplementing
  answer-classification or input↔answer pairing.
- A memory extension can flush/distill when a conversation goes quiet,
  is archived, forks, or the server shuts down — without process-
  lifecycle hacks.
- An extension can run long-lived background work (a "curator" that
  distills memories, improves skills) with host-owned lifecycle and
  host-enforced concurrency.
- Non-memory extensions can use the same surface (these are general
  harness events; memory is the motivating consumer, not the only one).

## Non-goals

- No record schemas, no storage contracts, no recall/injection
  primitives owned by the host (the user ruling above).
- No upstream pi-durable changes in this work (deferred; note below).
- No worker scheduling guarantees beyond "runs eventually, one at a
  time, with a deadline" — crash-safety stays the extension's business
  (durable cursors; the memory-evolution / pi-honcho outbox patterns
  are the surveyed precedents).

## Design

### 1. `runSettled` — one hook per run, with the paired input

**Problem (survey finding 2c, "capture-boundary pairing"):**
`afterResponse` fires per terminal provider message — tool rounds,
error rounds, retries. Every surveyed memory extension re-derives "is
this the answer?" with identical classification logic (stop/length, or
toolUse with no tool-call block — sigrun's own degenerate memory
extension copies it from pi-durable's generation internals), and every
one rebuilds the input↔answer binding privately (a submit-boundary
text map keyed by submission id, matched by identity at answer time —
`pendingInputs` in sigrun-ext-memory-markdown; `lastUserText` in mem0;
`turn_id` in pi-session-memory; `operationId` in pi-honcho).

**Design:** a new hook on the generation task, fired by the harness
(NOT upstream pi-durable — sigrun wraps its own registration):

```ts
runSettled(event: {
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  /** The submission ids the settled run answers. */
  readonly inputs: readonly SubmissionId[];
  /**
   * The paired user texts, host-resolved from the submissions above —
   * the capture-boundary pairing, provided. A steered/merged run gets
   * one entry per input, in admission order.
   */
  readonly inputTexts: readonly string[];
  /** The final assistant answer, already classified. */
  readonly answer: AssistantMessage;
}, api: HookApi, context: Context): void | Promise<void>;
```

Semantics (rulings on delivery, settle paths, ordering, and failure —
the builder-check questions):

- **Detection mechanism (three-review convergence, replaces the
  original "wrap function" story):** the host observes settlement via
  **`Session.subscribeCommits`** (`types.d.ts:827`), filtering
  submission-table writes — the same signal `Submissions.#observe`
  uses internally (submissions.js:78). This is the only 1.2.0
  mechanism that sees EVERY settle path: `endRun` (live.js:27) is a
  private in-tx mutator called from 7 generation sites PLUS the
  scheduler fault/orphan path (live.js:145-156), is NOT exported
  (`index.d.ts:11` exports LiveDoc only — a deep import throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, verified), and no
  `GenerationHooks` hook fires on abort/reset/model_error/no_model
  settles. The original "one internal wrap function" was
  unimplementable without forking. `watchEvents` (`index.d.ts:7`,
  events.js:261,279) is the fallback channel: its `run_end` already
  suppresses handOver continuations (`runChanged =
  run?.inputs[0] !== runBefore?.inputs[0]`) — the spec's
  settle-not-continuation semantics, pre-implemented — but carries no
  settlement reason; subscribeCommits is primary, watchEvents
  documents that the semantics are upstream-proven.
- **Side lane is an upstream constraint, not a ruling:**
  subscribeCommits' listener contract is "must not block or call
  Session APIs" — the listener enqueues; the bounded side lane drains.
  Delivery: handlers run in extension install order, sequentially; a
  throwing handler is caught, logged, and does NOT skip the remaining
  fan-out, does NOT fail the run settle. Queue bound: if runs settle
  faster than handlers drain, the queue is bounded (SIGRUN_QUEUE_MAX,
  default 1000); overflow drops the OLDEST pending event and logs (a
  memory extension that needs stronger guarantees keeps durable
  cursors — the at-least-once contract below).
- **Event scoping (ruling):** `runSettled` and lifecycle events are
  delivered to EVERY loaded extension (global fan-out, install
  order) — NOT gated on conversation selection. Rationale: the surveyed
  memory extensions are global-curators by nature (cross-conversation
  distillation is the point), and conversation-selection gates
  transcript access, not event visibility; a handler reading another
  conversation's transcript goes through the same DocumentReader
  surface core already exposes. Load shaping is the extension's
  business (it can filter by conversationId).
- **Which settles fire:** every run terminal outcome — `done` AND
  `unanswered` (model_error, no_model, aborted, reset, faulted,
  orphaned). The event carries the outcome:
  ```ts
  readonly outcome:
    | { readonly status: "answered"; readonly answerEntryId: EntryId;
        readonly answer: AssistantMessage }
    | { readonly status: "unanswered"; readonly reason: string };
  ```
  The answer is reconstructed post-commit (entry id → AssistantEntry
  read) because the commit carries ids, not messages. Memory
  extensions decide what to do with failed turns (the surveyed ones
  capture user text even when the answer failed — losing it silently
  is worse than delivering an event with no answer).
- **onYield continuations:** a `continue`-driven successor run is the
  SAME submission set handed over (`live.run.taskId` reassignment —
  pi-durable generation.js handOver, which ALSO matches watchEvents'
  built-in run_end suppression). No `runSettled` fires for the
  pre-continuation answer; the event fires once, at the run that
  actually settles the submissions.
- **Empty-input runs:** fire with empty `inputs`/`inputTexts`.
  Verified defensive in 1.2.0 (every `startRun` call site passes a
  non-empty users array — glm review F2) but kept as a contract line;
  extensions must not assume non-empty.
- **inputTexts is text-only, documented loss (ruling):**
  `readonly inputTexts: readonly string[]` carries the TEXT blocks of
  each input's `pi.user` entry, concatenated; image/file parts are
  dropped (position-preserving empty strings). Memory capture is a
  text store concern in every surveyed implementation; an extension
  needing full parts reads the entry via the event's `inputs` →
  submission → `entry` link (durable, same-commit). Resolution path
  (stated explicitly): submission id → settled `SubmissionRecord`
  (`status: "done"` carries `entry: EntryId`) → `pi.user` entry →
  text blocks. Withdrawn queued inputs never placed: unresolvable →
  empty string at that position, never a reordering.
- **HookApi is NOT reused (ruling):** the event signature takes a
  sigrun-narrowed `MemoryEventApi` — `DocumentReader` subset +
  `conversationId` — no `taskId`, no `memo()` (HookApi is task-scoped;
  a fabricated one would let extensions memo against a task they
  don't own).

### 2. Conversation lifecycle events

**Problem:** pi's `session_start`/`session_shutdown` are process
lifecycle (ephemeral sessions). Sigrun conversations are durable rows
with no open/close. The surveyed extensions' flush/warmup/index work
has no sigrun counterpart.

**Design:** host events on the factory's host context (the seam-host
pattern — the extension declares interest via the factory result, the
host calls it):

| Event | Fires when | Durable trigger |
|---|---|---|
| `conversationCreated(id)` | conversation create | `createConversation` |
| `conversationForked(childId, parentId, at)` | durable fork, AFTER entries copy per doc semantics | `forkConversation` |
| `conversationArchived(id, archived)` | archive flag flip, BOTH directions (un-archive = resume) — **on an actual boolean flip only, not on doc creation or no-op patches** (SessionMetaDoc materializes with `archived: false`; a forked child INHERITS the parent's flag with `fork: "current"` and fires no event — the inherited-archive edge is delivered via `conversationForked`, and extensions check the child's meta there) — any writer (the SessionMetaDoc commit path is the listener, so an extension patching its own meta fires like the server route would) | `SessionMetaDoc.archived` patch |
| `conversationIdle(id, idleMs)` | no submission ADMITTED for the idle threshold (admission-based clock; re-arms per quiet period) | timer, host-owned |
| `harnessShutdown()` | server shutdown, BEFORE storage closes — inserted at sigrun's own shutdown call site (src/index.ts shutdown(): between app.close() and harness.close()); NOT via Session.subscribeClose (synchronous, cannot host a 30s async flush). Flush handlers may COMMIT (admission is still open in this window; the seal happens at harness.close) | `Harness.close` |

Notes:
- **Idle is the real shutdown analog.** "Went quiet" is the honest
  end-of-conversation signal for durable conversations. The idle
  threshold is host config (`SIGRUN_IDLE_THRESHOLD`, default 10 min).
  **Idle basis (ruling, corrected by review):** a conversation is idle
  when it has **no admission AND no live run** — the admission clock
  alone fires mid-run (a 25-minute run with no further admissions
  would trip a 10-minute threshold), so the clock gates on
  pi-durable's own idleness (`waitForIdle` semantics) AND the quiet
  period. Write-type submissions (passive writes) do NOT reset the
  clock — a cron heartbeat appending tool displays would keep a
  conversation permanently non-idle; only INPUT submissions (user
  turns) and live runs count. The host implements idle detection as a
  **single sweep over a last-activity map** (updated by the
  subscribeCommits listener), NOT one timer per conversation
  (unbounded on a durable server). Boot re-arm: idle state is
  in-process; after a restart, the sweep re-derives last-activity
  from a storage scan (latest submission per conversation) —
  approximate on first boot, exact thereafter. Never-run conversations
  (created, no submission) have no durable anchor and stay
  non-idle until their first input — documented, accepted. The host
  owns the timer; the extension never sets one (the twill lesson: no
  timers in factory bodies).
- **Idle fires per quiet period:** re-arms after each event; a
  conversation that goes quiet again later fires again. Extensions
  must tolerate repeats (idempotent flushes).
- **Archive is stronger idle, not a different thing** — but it gets
  its own event because it is durable and reversible (un-archive =
  resume; the extension may want a final flush AND a wake-up).
- **Fork continuity is the extension's decision, informed by the
  event.** The survey precedent is pi-honcho's `session.clone` (child
  inherits history to the fork point) vs pi-observational-memory's
  "no rollback continuity" (child starts fresh). The host passes the
  fork point; the memory system chooses inherit-vs-fresh. Forked runs:
  a fork copies history, not live runs — no `runSettled` interaction
  exists. Inherited archive state (child born `archived: true` from an
  archived parent) fires NO archive event (no flip occurred) —
  extensions see it via `conversationForked` + a meta read.
- **Recovery/replay:** the once-per-run guarantee is per-process
  best-effort; durable dedup is the extension's cursor (the
  at-least-once contract above). The pairing itself survives restart:
  the input's text is durable (the `pi.user` entry commits before run
  admission — inbox.js appendInput + placeSubmission in one commit)
  and `endRun` settles submissions in the same commit as the run
  outcome (live.js:27, verified across all 7 call sites + the
  scheduler path live.js:153) — so a post-restart settle resolves
  `inputTexts` from storage via submission → `entry` → text blocks.
- **Boot re-arm of lifecycle watchers:** the subscribeCommits
  listener re-attaches at harness boot; idle state re-derives from a
  last-activity scan (see the idle basis ruling). Created/forked/
  archive events are commit-driven — nothing to re-arm.
- **Wake matching is declared:** each worker carries
  `wakeOn?: readonly ["conversationIdle" | "conversationArchived" |
  "conversationCreated" | "conversationForked"]` (default: no event
  wakes — `every`-tick only). A wake arriving while the run is in
  flight is QUEUED (coalesced to one pending wake), not dropped —
- **Abandoned ≠ stopped (ruling):** a timed-out run is abandoned by
  the HOST (it stops waiting) — the zombie `run()` promise keeps
  executing and its late writes land unguarded. One-run-at-a-time is
  enforced on the HOST side (the next run won't start until the
  deadline fires), so zombie overlap is bounded to one late run per
  timeout; extensions needing hard cancellation take an AbortSignal
  (future: a `signal` parameter on run()).
  dropped wakes lose archive-triggered final flushes. The run's
  `run(context, wake?: { event, conversationId })` receives the
  coalesced wake.
- **Delivery is best-effort in-process, awaited at `harnessShutdown`
  (flushes must complete before storage closes). Missed idle events
  (server restart) are acceptable — the next idle/archive/shutdown
  flushes; extensions that need stronger guarantees keep durable
  cursors.

### 3. Idle workers — the curator story

**Problem (user ruling 3):** long-running agents want a curator
process — distilling memories, improving skills — over conversations.
The host currently has no story for delayed/idle background work
(memory-evolution's 15s recovery poll and omms's retry-drain are the
surveyed private implementations).

**Design:** the extension factory result may declare workers:

```ts
workers?: readonly {
  /** Unique within the extension; surfaces in /v1/meta. */
  readonly name: string;
  /** Called when the worker may run: on `every` ticks, or woken by
   * lifecycle events (2), or both. */
  readonly every?: { readonly ms: number };
  /** The work. Resolves when done; throw to fail this run. */
  run(context: Context): Promise<void>;
}[];
```

Host-owned lifecycle, mirroring the embedded-provider pattern:
- **No timers in factory bodies** (the twill lesson). The host starts
  workers after harness boot, stops them at `harnessShutdown` (await
  in-flight `run()`, deadline 30s, then abandon).
- **Host-enforced concurrency: one run at a time per worker.** A run
  still in flight skips its next tick (no queueing, no overlap).
- **Wake-on-event:** lifecycle events (2) also wake matching workers —
  `conversationIdle` and `conversationArchived` are the interesting
  ones for a curator. The event carries the conversation id; the
  worker decides what to do with it. Matching is per-worker declared
  (`wakeOn`); see §2 for the in-flight wake rule (queued, coalesced).
- **Run deadline:** host-configured (`SIGRUN_WORKER_DEADLINE`, default
  10 min). A timed-out run is abandoned (its promise rejected); the
  worker's next run proceeds. The host logs it.
- **Shutdown ordering:** workers stop FIRST (30s deadline), THEN
  lifecycle `harnessShutdown` handlers run (30s deadline, shared with
  the hook deadline) — a curator is not competing with the flush
  handlers for the same window. Both are bounded; `Harness.close`
  never hangs (worst case ~60s extension teardown, then storage
  closes regardless).
- **Observability:** worker names + last-run/last-error appear in
  `GET /v1/meta` under the extension's entry (the extensions[] block
  already exists — add `workers: [{name, lastRunAt, lastError}]`).
- **Crash-safety is the extension's business:** durable cursors /
  receipts (the surveyed outbox patterns). The host makes no
  exactly-once promise; at-least-once with extension-side dedup is the
  contract.
- **Worker runSettled dependency:** a curator that wants to react to
  settled turns does NOT register `runSettled` (that fan-out is
  immediate-handlers-only); it reads durable state in its worker runs
  (transcript scan / submission scan). Keeping hook delivery
  synchronous-bounded and worker work pull-based is what makes the
  settle path unbreakable.

### 4. What extensions do with this (the porting story)

The survey's four privately-rebuilt plumbing pieces map:

| Survey plumbing | This spec |
|---|---|
| capture-boundary pairing | `runSettled` carries `inputTexts` (host-resolved) |
| compaction-boundary hook | already exists: `beforeCompact` (can replace the summary — observational-memory's projection, pi-memory's handoff) |
| durable delivery outbox | stays extension-private (durable cursors); workers + `harnessShutdown` give it run-times |
| compaction-surviving injection | already exists: `beforeRequest` (per-request context injection) |

A ported memory extension needs NO custom submit pass-through, NO
timers, NO answer classification: it registers `runSettled` (capture),
`beforeRequest` (inject), `beforeCompact` (salvage), workers
(distill), and lifecycle events (flush/warmup). The submit-binding
hack in sigrun-ext-memory-markdown (`pendingInputs` +
`memorySubmit` + `bindRecallSource`) becomes deletable — its recall
tool reads the durable transcript as before, and capture arrives via
`runSettled` instead of a private submit wrapper.

## Constraints

- pi-durable 1.2.0 stays the exact pin; no fork, no patch. The one
  internal touchpoint (run-settle observation) is
  `Session.subscribeCommits` — a PUBLIC API, no internal touching (the
  original "wrap endRun" idea was refuted by review: endRun is not
  exported, a deep import throws ERR_PACKAGE_PATH_NOT_EXPORTED).
- Extension contract changes stay additive to the loader's factory
  result (workers + runSettled join health/submit/interactionKinds/
  ambientKinds as optional validated fields — same fail-loud
  validation; violations: run not a function, worker name missing/
  duplicate-within-extension, every.ms <= 0, wakeOn values outside
  the enum).
- **Loader host-instance fix required (review M2, deepseek):** the
  two-phase re-key (hostContextFactory called twice, second return
  discarded) means the extension's factory captured host1 while boot
  keyed host2 — inbound event handlers registered on host1 would be
  unreachable. The implementer must make the re-key MUTATE host1 in
  place (identity + kinds cell) instead of creating a second host —
  or route registration through a shared registry both instances
  reference. This is a loader bug-adjacent fix in its own right (the
  interaction/ambient seams only survived it because their handlers
  are outbound); flag it in the plan.
- Events fire only after boot completes, never during factory
  execution (two-phase ordering retained).

## Deferred upstream (pi-durable `runSettled`)

**Issue to file after sigrun release.**

Title: `GenerationHooks: add runSettled — one hook per settled run with paired input texts`

Body:

> `afterResponse` fires per terminal provider message (every round:
> tool requests, error rounds, retries — generation.js:357, before
> classification), so every consumer that wants "the turn's answer"
> re-derives the classification internally (stop/length, or toolUse
> with no tool-call block — the same logic generation.js:359-362 uses
> to classify answers). Consumers also need the user inputs the run
> answers, but `LiveDoc.run.inputs` carries submission *ids*, not
> texts — so consumers rebuild a submit-boundary text map keyed by
> submission id and match by identity at answer time (observed
> independently in four memory extensions and in sigrun's own memory
> extension, which carries a custom submit pass-through just for
> this).
>
> Proposal: a `runSettled` hook on `GenerationHooks` that fires
> exactly once per run, after settle, carrying `{ inputs:
> readonly SubmissionId[], inputTexts: readonly string[],
> answer: AssistantMessage }` — the classification and the pairing
> both resolved host-side. Steer-merged runs carry every input in
> admission order. Retry/recovery replays fire once, on the final
> attempt.
>
> Note: today the only all-path settle observation (including
> aborted/reset/model_error/no_model AND the scheduler fault/orphan
> path, live.js:153) is `Session.subscribeCommits` on submission
> writes — hooks cover none of the unanswered paths. The proposal
> closes that gap at the hook layer.
>
> sigrun currently wraps this locally (spec:
> docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md §1); we'd
> move to the upstream hook when available.

## What's left to the builder

- The subscribeCommits settle-observer spike: confirm
  submission-settlement writes are distinguishable per-conversation
  in `CommitPublication.changes` (TableCommitChange vs
  DocumentCommitChange granularity — types.d.ts:697-705) and whether
  the settled record's `entry` link is present in the table write or
  needs a post-commit read. This is the pre-planning spike both
  completing reviews flagged as residual risk.
- Test strategy for worker deadlines (fake timers are fine; this is
  host logic, not the extension's).

Resolved during the builder check (rulings now in the design body):
runSettled registration = seam-host event (factory-result field, not a
foreign HookRegistration key); settle-outcome coverage = done AND
unanswered, with outcome in the event; onYield continuation = no event
(the handOver keeps the same submission set; fire at the settling run);
empty-input runs = fire with empty arrays (defensive in 1.2.0 — every
startRun call site passes non-empty users); error isolation = caught,
logged, never fails the run or the fan-out; hook latency = bounded
side lane (SIGRUN_HOOK_DEADLINE 30s), never inside the settle commit —
UPSTREAM-FORCED by subscribeCommits' non-blocking listener contract;
per-conversation event ordering (settle before idle/archive) via ONE
per-conversation FIFO shared by settle + lifecycle fan-out; idle basis
= no admission AND no live run (corrected by review — admission-only
fires mid-run); write-submissions don't reset the clock; idle = per
quiet period, re-arming; single last-activity sweep, not per-
conversation timers; boot re-arm = storage scan (approximate first
boot, never-run conversations stay non-idle — documented); wake
matching = per-worker `wakeOn` declaration, in-flight wakes
queued+coalesced; abandoned workers = host stops waiting, zombie
overlap bounded to one late run; shutdown ordering = workers stop
(30s) then shutdown handlers (30s), inserted at sigrun's own shutdown
call site (NOT Session.subscribeClose — synchronous, can't host async
flushes); shutdown handlers may commit (seal happens at harness.close);
recovery/replay = input texts are durable (the input's pi.user entry
commits before run admission; endRun settles submissions in the same
commit as the outcome) so a post-restart settle resolves inputTexts
— the once-only guarantee is per-process best-effort, durable dedup is
the extension's cursor (at-least-once contract, stated); archive event
source = the SessionMetaDoc patch itself (any writer), fire on actual
boolean flip only (not doc creation / no-op patch), forked children
inherit archive state with NO event (seen via conversationForked +
meta read); never-run conversations = stay non-idle (no durable
anchor); cron runs = treated as any run; ambient's `expires: "idle"`
may share the idle clock later (noted, not required); event scoping =
global fan-out (every loaded extension, not conversation-selected);
inputTexts = text-only (image parts dropped, position-preserving —
full parts via inputs → submission → entry link); HookApi NOT reused
(sigrun-narrowed DocumentReader-subset API, no memo); config knobs
(SIGRUN_HOOK_DEADLINE/IDLE_THRESHOLD/WORKER_DEADLINE/QUEUE_MAX) join
the env > settings-file > default chain with loadConfig validation;
/v1/meta worker fields absent-until-first-run.

## Review pass (2026-10-15)

Three independent model reviews (kimi-k3, glm-5.3, deepseek-v4.1-flash
— artifacts in reviews/2026-10-15-memory-seam-review-*.md) verified the
spec against pi-durable 1.2.0 dist and sigrun src. Convergent findings,
all incorporated above: (1) BLOCKER — the "wrap endRun" mechanism was
unimplementable (not exported; ERR_PACKAGE_PATH_NOT_EXPORTED verified)
→ replaced with Session.subscribeCommits + bounded side lane (now an
upstream-forced constraint); (2) idle admission-clock fired mid-run →
no-admission-AND-no-live-run; (3) loader two-phase host re-key
discards the second host instance → inbound handlers unreachable →
mutate-in-place fix flagged for the plan; (4) event shape
self-contradiction (top-level answer vs outcome union) → outcome
union; (5) event scoping ruling added (global); (6) inputTexts
multimodal loss documented; (7) archive no-op/fork-inheritance edges;
(8) shutdown-handler commit permission + insertion point; (9) worker
validation set + abandoned-vs-stopped; (10) line-number drift in the
upstream issue (generation.js:357/:359-362) fixed. Note: kimi-k3 and
deepseek disagreed on whether endRun is "a true choke point" (glm:
yes functionally; kimi: yes but unwrappable; deepseek: unwrappable AND
unexported) — all three converge on subscribeCommits regardless.
(created + never admitted = quiet from creation, fires at the
threshold; harmless, idempotent); cron runs = treated as any run
(empty inputs fire empty); ambient's `expires: "idle"` may share the
idle clock later (noted, not required).
