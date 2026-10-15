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

- **Registration shape:** a seam-host event, NOT a pi-durable
  HookRegistration. pi-durable 1.2.0's `GenerationHooks` has no
  `runSettled` field, so a task-hook shape would require widening the
  handlers object against a foreign type — fragile and upstream-hostile.
  Extensions declare interest in the factory result
  (`runSettled?: (event, api, context) => void | Promise<void>`, a new
  validated optional field, same fail-loud treatment as
  health/submit/kinds); the seam host fans out. The harness learns of
  run settlement through ONE internal wrap function — the isolated
  touchpoint — which keeps the upstream rebase (a real `runSettled` in
  `GenerationHooks`) a clean swap of the wrap's internals plus deletion
  of the seam-host event fan-out.
- **Which settles fire:** every run terminal outcome — `done` AND
  `unanswered` (model_error, no_model, aborted, reset). The event
  carries the outcome:
  ```ts
  readonly outcome:
    | { readonly status: "answered"; readonly answer: AssistantMessage }
    | { readonly status: "unanswered"; readonly reason: string };
  ```
  Memory extensions decide what to do with failed turns (the surveyed
  ones capture user text even when the answer failed — losing it
  silently is worse than delivering an event with no answer). The
  degenerate memory extension's afterResponse skip-list (error/tool
  rounds observe nothing) moves INTO the host's classification: only
  settled runs emit, and a settled run emits once.
- **onYield continuations:** a `continue`-driven successor run is the
  SAME submission set handed over (`live.run.taskId` reassignment —
  pi-durable generation.js handOver). No `runSettled` fires for the
  pre-continuation answer; the event fires once, at the run that
  actually settles the submissions. Extensions wanting intermediate
  answers use `afterResponse` (still available).
- **Empty-input runs:** fire with empty `inputs`/`inputTexts` (e.g.
  agent-initiated work; sigrun's cron `source` creates conversations
  whose runs still answer submissions — but a nested/tool-driven run
  may legitimately carry none). Extensions filter on what they need.
- **Error isolation & fan-out order:** handlers run in extension
  install order, sequentially; a throwing handler is caught, logged,
  and does NOT skip the remaining fan-out, does NOT fail the run
  settle, and does NOT fail the triggering operation. The settle path
  is the run's own commit path — a memory extension must never be able
  to break admission or answering (the observe-infallibility rule from
  the survey's sigrun contract row).
- **Awaited with a deadline, not fire-and-forget:** handlers run in a
  bounded side lane after the settle commit (never inside it). Deadline
  `SIGRUN_HOOK_DEADLINE` (default 30s, shared with lifecycle
  handlers); a timed-out handler is abandoned and logged. This keeps a
  slow distiller from delaying the next run while making shutdown
  flushes real (awaited, bounded).
- **Ordering vs lifecycle events:** per-conversation event
  serialization — `runSettled` for conversation N is delivered before
  any `conversationIdle`/`conversationArchived` for conversation N
  (the final flush cannot outrun the final capture). Cross-conversation
  ordering is unspecified (independent).

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
| `conversationArchived(id, archived)` | archive flag flip, BOTH directions (un-archive = resume) — any writer (the SessionMetaDoc commit path is the listener, so an extension patching its own meta fires like the server route would) | `SessionMetaDoc.archived` patch |
| `conversationIdle(id, idleMs)` | no submission ADMITTED for the idle threshold (admission-based clock; re-arms per quiet period) | timer, host-owned |
| `harnessShutdown()` | server shutdown, BEFORE storage closes | `Harness.close` |

Notes:
- **Idle is the real shutdown analog.** "Went quiet" is the honest
  end-of-conversation signal for durable conversations. The idle
  threshold is host config (`SIGRUN_IDLE_THRESHOLD`, default 10 min),
  **measured from the conversation's last submission ADMISSION** (any
  admission — queued or placed — resets the clock; a long-running task
  keeps the conversation active even without settled runs). Ruling:
  admission-based, not settle-based — the curator must not fire
  mid-run. The host owns the timer; the extension never sets one
  (the twill lesson: no timers in factory bodies).
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
  fork point; the memory system chooses inherit-vs-fresh.
- **Recovery/replay:** the once-per-run guarantee is per-process
  best-effort; durable dedup is the extension's cursor (the
  at-least-once contract above). The pairing itself survives restart:
  the input's text is durable (the `pi.user` entry commits before run
  admission) and `endRun` settles submissions in the same commit as
  the run outcome (live.js:27) — so a post-restart settle resolves
  `inputTexts` from storage.
- **Wake matching is declared:** each worker carries
  `wakeOn?: readonly ["conversationIdle" | "conversationArchived" |
  "conversationCreated" | "conversationForked"]` (default: no event
  wakes — `every`-tick only). A wake arriving while the run is in
  flight is QUEUED (coalesced to one pending wake), not dropped —
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
  internal touchpoint (run-settle classification) is isolated in
  sigrun's harness behind one function.
- Extension contract changes stay additive to the loader's factory
  result (workers join health/submit/interactionKinds/ambientKinds as
  an optional validated field — same fail-loud validation).
- The seam host gains event fan-out; the loader's two-phase host
  pattern (identity stub → re-key after resolution) already supports
  it — events fire only after boot completes, never during factory
  execution.

## Deferred upstream (pi-durable `runSettled`)

**Issue to file after sigrun release.**

Title: `GenerationHooks: add runSettled — one hook per settled run with paired input texts`

Body:

> `afterResponse` fires per terminal provider message (every round:
> tool requests, error rounds, retries — generation.js:335, before
> classification), so every consumer that wants "the turn's answer"
> re-derives the classification internally (stop/length, or toolUse
> with no tool-call block — the same logic generation.js:337-340 uses
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
> sigrun currently wraps this locally (spec:
> docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md §1); we'd
> move to the upstream hook when available.

## What's left to the builder

- The exact internal shape of the run-settle wrap (where
  classification is borrowed from) — one function, tested against
  pi-durable's generation.js behavior (endRun settlement sites:
  answer/aborted/model_error/no_model/reset — live.js:27 endRun is the
  single choke point every settle path commits through).
- Test strategy for worker deadlines (fake timers are fine; this is
  host logic, not the extension's).

Resolved during the builder check (rulings now in the design body):
runSettled registration = seam-host event (factory-result field, not a
foreign HookRegistration key); settle-outcome coverage = done AND
unanswered, with outcome in the event; onYield continuation = no event
(the handOver keeps the same submission set; fire at the settling run);
empty-input runs = fire with empty arrays; error isolation = caught,
logged, never fails the run or the fan-out; hook latency = bounded
side lane (SIGRUN_HOOK_DEADLINE 30s), never inside the settle commit;
per-conversation event ordering (settle before idle/archive); idle
basis = submission ADMISSION (ruling — the builder-note contradiction
is resolved); idle = per quiet period, re-arming; wake matching =
per-worker `wakeOn` declaration, in-flight wakes queued+coalesced;
shutdown ordering = workers stop (30s) then shutdown handlers (30s);
recovery/replay = input texts are durable (the input's pi.user entry
commits before run admission; endRun settles submissions in the same
commit as the outcome) so a post-restart settle resolves inputTexts
— the once-only guarantee is per-process best-effort, durable dedup is
the extension's cursor (at-least-once contract, stated); archive event
source = the SessionMetaDoc patch itself (any writer — the doc-commit
path is the listener site, so an extension patching its own meta fires
like the server route would); never-run conversations = idle applies
(created + never admitted = quiet from creation, fires at the
threshold; harmless, idempotent); cron runs = treated as any run
(empty inputs fire empty); ambient's `expires: "idle"` may share the
idle clock later (noted, not required).
