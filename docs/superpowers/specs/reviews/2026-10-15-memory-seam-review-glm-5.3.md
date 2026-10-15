# Design review — 2026-10-15-sigrun-memory-seam.md

Reviewer: senior-engineer scout pass, read-only. All file:line citations verified against the working tree at sigrun main and the pinned `@earendil-works/pi-durable` in `node_modules`.

## 1. FACTUAL CORRECTNESS

### Verified correct

- **"pi-durable 1.2.0's `GenerationHooks` has no `runSettled` field"** — TRUE. `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:688-701` defines exactly `beforeRequest`, `afterResponse`, `onYield`, `afterTools`. Nothing else.
- **"`afterResponse` fires per terminal provider message, before classification"** — TRUE. `types.d.ts:694-695`; dispatched from `generation.js:357` inside `classify()`, which runs on every classify call including retries, tool rounds, overflow-compaction detours.
- **Classification logic as described** — TRUE in substance. `generation.js:358-363`: `stopReason === "toolUse" && calls.length > 0` → tool round; `stop|length|toolUse` → `answer()`. (Line numbers cited in the spec are off — see F1.)
- **"`endRun` (live.js:27) is the single choke point every settle path commits through"** — TRUE and stronger than the spec states: in addition to the generation-task sites (`answer()` done; `finishToolRound` done/reset; `failModelError`/`failNoModel`/`classify` terminal `model_error`; abort handler `aborted`), the **scheduler fault/orphan path** also routes through it: `live.js:145-156` `settleSchedulerOutcome` calls `endRun(... {status:"unanswered", reason:"faulted"|"orphaned"})`. A commit-observation implementation gets all six settle reasons from one signal class.
- **"`endRun` settles submissions in the same commit as the run outcome"** — TRUE. Every `endRun` call sits inside a `runtime.commit` returning `{status:"terminal", outcome...}` whose write batch includes both the `settleSubmission` writes (`live.js:29-31`) and the task's terminal state.
- **onYield / handOver semantics** — TRUE. `generation.js` `handOver(live, from, to)`: `if (live.run?.taskId === from) live.run.taskId = to;` — the run's `inputs` move with the id; `endRun` is NOT called on the yielding task. Consistent with "no runSettled for the pre-continuation answer; fire at the settling run". Also consistent for `finishToolRound`'s postTools hand-over, where `live.run.inputs.push(...users)` accumulates steered inputs onto the same run — supporting "one entry per input, admission order".
- **Admission-order inputs** — TRUE. `inbox.js` `applyBoundary` places users in ID order (`users.sort((a,b) => a-b)`); ID order is admission order per the `mintId` contract in `types.d.ts`.
- **Input text durability before run start** — TRUE. `inbox.js` `appendInput` commits the `pi.user` entry and `placeSubmission` in the same commit; `startRun` runs only after `applyBoundary` in that commit. Post-restart `inputTexts` resolve from the settled submission's `entry` → `UserEntry.model[0]`.
- **Loader contract is additive-friendly** — TRUE. `src/harness/loader.ts` `resolvedFromFactory` validates `extension`/`health`/`submit`/`kinds` only; new optional validated fields (`runSettled`, `workers`) follow the same pattern. The two-phase host (identity stub → re-key) supports post-boot event wiring.
- **Archive listener site** — TRUE. The meta patch route is a `conversation.commit` on `SessionMetaDoc` (`src/server/index.ts:1548-1579`; `src/server/session-meta.ts:54` archived default false, `:255` patch application); any writer committing the same doc shape is indistinguishable to a commit observer.
- **Shutdown ordering premise** — TRUE. `src/index.ts` `shutdown()`: `app.close()` then `harness.close()`; sigrun owns the call site, so worker-stop → lifecycle-flush → `harness.close()` insertion is possible without upstream change.
- **`beforeCompact` / `beforeRequest` already exist** — TRUE (`types.d.ts:722-738`, `:689-692`).

### Factual problems

- **F1 (MINOR) — wrong line citations.** The deferred-upstream issue body cites `generation.js:335` (afterResponse dispatch) and `generation.js:337-340` (classification). Actual: `generation.js:357` and `:358-363`. `live.js:27` is correct. Fix before filing upstream.
- **F2 (MINOR) — empty-input runs may not exist.** Every `live.run` comes from `startRun(tx, conversationId, live, inputs)` and every call site passes a non-empty `users` array (guarded by `if (users.length > 0)` at both `answer()` and `finishToolRound`). The "nested/tool-driven run may carry none" case is not reachable in 1.2.0. Harmless defensive spec — mark it as such.
- **F3 (MINOR) — `inputTexts: readonly string[]` is underspecified for multimodal input.** `appendInput` writes submission `content` verbatim; entries carry `readonly Message[]`. The spec never defines "host-resolved text" when a submission carries images/attachments (concatenate text blocks? empty string? skip?). Define it now.

## 2. DESIGN SOUNDNESS

- **D1 (MAJOR) — idle admission-clock contradicts the "no mid-run curator" ruling.** §2: idle measured "from the conversation's last submission ADMISSION" AND "a long-running task keeps the conversation active even without settled runs" AND "the curator must not fire mid-run". With a purely admission-based clock, a run admitted at t0 that legitimately runs 25 minutes sees zero new admissions, so the 10-minute idle fires mid-run. The parenthetical holds only if live-run activity also re-arms the clock — which the ruling excludes. Fix: idle arms only when the conversation is idle in the pi-durable sense — no admission AND no live run (`Conversation.waitForIdle`/`Harness.waitForIdle`, `types.d.ts` Session/Conversation interface, is the existing primitive). Otherwise §1's "settle before idle" ordering guarantee also breaks: a mid-run idle fires before the settling `runSettled`.
- **D2 (MAJOR) — the run-settlement detection mechanism is misdescribed; "one internal wrap function" is not implementable without monkey-patching upstream.** `endRun` is called *inside* pi-durable's task code; `HookRegistration` (`types.d.ts:292-295`) can only carry handlers of the task's declared hook type `H` (fixed `GenerationHooks` for `pi.generation`), so a `runSettled` handler cannot be injected through the registry. Wrapping the exported `endRun` symbol doesn't intercept its internal call sites. The realistic upstream-clean mechanism that already exists is **`Session.subscribeCommits`**: every settle commit publishes submission settlement writes (`SubmissionSettlement` = `{done, answer: EntryId}` or `{unanswered, reason, detail}`) plus the task's terminal write — detection = observe submission settlements grouped by conversation. Consequences the spec must own: (a) the touchpoint is a commit listener, not a function wrap (the "clean upstream swap" claim still holds); (b) the listener contract "must not block or call Session APIs" *forces* the bounded side lane — the spec's "never inside the settle commit" is an upstream constraint, not merely a ruling (strengthens the spec); (c) `answer: AssistantMessage` must be reconstructed post-commit from the settled submission's `answer: EntryId` → AssistantEntry, since the commit carries an entry id, not a message. Rewrite §1's wrap paragraph before the builder plans.
- **D3 (MAJOR) — event scoping is unaddressed.** pi-durable hooks fire only for extensions the conversation selects (`types.d.ts` TaskRuntime `hooks`: "Handlers of this task's name from the extensions its conversation selects"). The spec's seam-host fan-out is described as global ("the seam host fans out", install order). Does a memory extension receive `runSettled` for every conversation, or only conversations that select it? Changes correctness (transcript leakage to unselected extensions) and load. Needs an explicit ruling.
- **D4 (MINOR) — two inconsistent `runSettled` type sketches.** §1's main signature has top-level `answer: AssistantMessage`; the semantics block replaces it with an `outcome` union. Pick one (the outcome union).
- **D5 (MINOR) — worker `run` signature inconsistency.** §2: `run(context, wake?: {event, conversationId})`; §3's code block: `run(context): Promise<void>` with no wake parameter.
- **D6 (MINOR) — abandoned ≠ stopped for workers.** "A timed-out run is abandoned (its promise rejected)" — the host cannot reject a foreign promise. The zombie `run()` keeps executing; its writes land after the host considers the worker free, so the next run overlaps it, violating "one run at a time". Require an abortable context, or explicitly accept zombie overlap.
- **D7 (NOTE) — `harnessShutdown` write capability.** Flush handlers that need to commit must run before `harness.close()` seals the mutation line. Feasible at `src/index.ts` shutdown; name the insertion point in the plan.

## 3. FEASIBILITY

- Extension-contract side is sound: additive factory-result fields follow the loader's validated-field pattern; `/v1/meta` reporting exists; no upstream fork for workers/lifecycle/shutdown.
- Archive/fork/created events via commit observation are feasible (`subscribeCommits` publishes document changes incl. `SessionMetaDoc` and conversation-create writes) — but the spec should state ALL lifecycle events share the commit-listener + side-lane substrate rather than implying per-route hooks.
- **MAJOR gap — boot re-arming of idle.** Idle state is in-process; after a restart, which conversations get timers? `ConversationRecord` has no `createdAt` (`types.d.ts` — id/parent/owner only); a boot scan must approximate last activity from entries/submissions. Without a ruling, idle is silently per-uptime and archive/shutdown are the only reliable post-restart triggers. Say so explicitly.
- NOTE — timer scale: one timer per conversation is unbounded for a durable server; a single sweep over a last-activity map (updated by the commit listener) is the right shape.
- NOTE — the "settle before idle/archive" ordering requires one per-conversation FIFO shared between the settle fan-out and the lifecycle fan-out, drained by the side lane and bounded-drained again at `harnessShutdown`. Two independent delivery paths make this easy to lose; call it out.

## 4. MISSING CONSIDERATIONS

- **M1 (MINOR) — config plumbing.** `SIGRUN_HOOK_DEADLINE`, `SIGRUN_IDLE_THRESHOLD`, `SIGRUN_WORKER_DEADLINE` are named but not assigned to the config surface (`src/config.ts` / settings.json env-over-file precedence, `src/index.ts:60-63`). loadConfig is fail-loud — state validation rules.
- **M2 (MINOR) — archive event de-dup.** `tx.doc(SessionMetaDoc, ...)` materializes the doc with `archived: false` on first touch; the observer must not fire `conversationArchived(id, false)` on doc creation or on no-op patches (`session-meta.ts:139-144` maps null→delete). Fire only on an actual boolean flip — "on change, not on write."
- **M3 (MINOR) — write submissions re-arm idle.** A passive write (cron/tool display entries every few minutes) is an admission under "queued or placed — resets the clock" and would keep a conversation permanently non-idle. Decide whether write-type submissions count.
- **M4 (NOTE) — survey claims** (`pendingInputs`/`lastUserText`/`turn_id`/`operationId` in named extensions) are not verifiable from this repo; treat the comparison doc as authority and spot-check one during planning.
- **M5 (NOTE) — `runSettled` and forks.** A fork copies history, not live runs; no interaction is possible today (`src/server/index.ts:1281-1366`). One sentence so a builder doesn't invent one.

## Verdict

Sound core design; three MAJORs must be resolved before writing the implementation plan:

1. **D1** — idle clock basis contradicts the no-mid-run ruling (use "no admission AND no live run").
2. **D2** — replace the "wrap endRun" touchpoint with `Session.subscribeCommits` observation of submission settlements + post-commit entry reads; the side lane then becomes an upstream-forced constraint (strengthens the spec).
3. **D3** — rule on event scoping (all conversations vs conversation-selected extensions).

MINORs (F1-F3, D4-D6, M1-M3) are cheap text fixes. No BLOCKER: nothing makes the design unbuildable within pinned pi-durable 1.2.0 + the loader contract + Fastify; the additive factory-result contract, host-owned workers, and shutdown ordering are all consistent with verified source.
