# Memory-seam spec review (verified against pi-durable 1.2.0 + sigrun source)

## FACTUAL CORRECTNESS
- `live.js:27` is a true single choke point: `endRun` settles `live.run.inputs` and clears `run` in the caller's commit. Call sites verified: generation.js:202 (abort), 249 (model_error), 261 (no_model), 406 (classify), 440 (answer), 522 (finishToolRound), 530 (reset); live.js:153 (scheduler faulted/orphaned). Claim sound.
- handOver (generation.js:562-565) reassigns `taskId` only; `inputs` stay. "Fire at the settling run, not the continuation" is correct.
- `beforeCompact` (CompactionHooks) and `beforeRequest` (GenerationHooks) exist as §4 claims. Sound.
- Deferred-issue citations are off: `afterResponse` is generation.js:357, not 335; classification is generation.js:359-362, not 337-340. `live.js:27` is right.

## BLOCKER
**B1 — Settlement detection mechanism is unspecified and unsupported as described.** Spec §1 says the host learns of settlement "through ONE internal wrap function." There is no seam to wrap generation.js's settle commits: `endRun` is NOT exported (`index.d.ts:11` exports `LiveDoc` only), and deep-importing `dist/harness/live.js` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` (verified). Two supported mechanisms exist and are never mentioned:
- `Session.subscribeCommits` (`types.d.ts:827`) — sees submission table changes; exactly how `Submissions.#observe` (submissions.js:78) detects settlement.
- `watchEvents` (`index.d.ts:7`; `events.js:261,279`) — emits `run_start`/`run_end`, and its `runChanged = run?.inputs[0] !== runBefore?.inputs[0]` logic already suppresses `run_end` on handOver, i.e. it *already implements the spec's "settle only, not continuation" semantics*. The spec must name its mechanism and justify not using these.

## MAJOR
**M1 — Idle basis contradicts its rationale.** §2: "measured from the conversation's last submission ADMISSION … admission-based, not settle-based — the curator must not fire mid-run." A single long run with no further admissions is anchored at admission T and fires at T+threshold while the run is still live → fires mid-run. Admission-based does NOT prevent mid-run firing; the claim is inverted. Must gate on live-run/busy (via subscribeCommits) or use settle-based.

**M2 — Inbound fan-out vs. the loader's discarded host.** The two-phase re-key (loader.ts:~380-400) calls `hostContextFactory` twice and discards the second return; `seamHosts[realName]` is set to host2 (boot.ts) while the extension's factory captured host1 (created with `""` and the empty kinds cell, seam-host.ts copies kinds eagerly at creation). The spec asserts the pattern "already supports" event fan-out. It does not: an inbound handler registry must be reachable from the instance the host will actually call. Builder must resolve this identity/kinds plumbing before runSettled/lifecycle registration can work.

**M3 — `inputTexts: readonly string[]` is lossy.** `UserInput = UserMessage["content"]` (types.d.ts) can carry image content parts; a string[] cannot represent them. A capture seam for memory should carry content/`UserInput`, or explicitly document the text-only loss.

## MINOR
- **m1** "never-run idle" has no durable anchor: `ConversationRecord` (types.d.ts:264-278) has no `createdAt`; "quiet from creation" cannot survive restart.
- **m2** `SessionMetaDoc` is `fork:"current"` (session-meta.ts:62) → a forked child inherits `archived:true` with no archive commit, so `conversationArchived` never fires for it; extensions miss inherited archive.
- **m3** `harnessShutdown` wiring point unspecified: sigrun's shutdown is src/index.ts:42-57 (`app.close` → `harness.close` → `process.exit`), and `Session.subscribeClose` is synchronous/never-calls-Session-APIs (types.d.ts:828) so it cannot host a 30s async flush. A pre-close seam must be added to index.ts/openHarness.
- **m4** New knobs `SIGRUN_HOOK_DEADLINE`/`SIGRUN_IDLE_THRESHOLD`/`SIGRUN_WORKER_DEADLINE` aren't placed in sigrun's env > settings-file > default model.
- **m5** "bounded side lane" has no stated queue bound/drop policy if runs settle faster than handlers drain.

## NOTE
- Existing `HarnessOptions.conversationCreated` (runs in every create/fork commit; throw fails the commit) is prior art for `conversationCreated`/`Forked` detection the spec omits.
- `watchEvents` `run_end`/`run_start` already match the spec's settle semantics — reinforces B1's resolution path.
- Verified sound: `live.js:27` settles inputs in the same commit as the outcome, so a post-restart settle resolves `inputTexts` from `submission.entry`; per-conversation settle-before-idle ordering is implementable with an explicit FIFO; the deferred-upstream "clean swap" framing is the honest posture once B1 is fixed.
