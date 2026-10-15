# Design review: 2026-10-15-sigrun-memory-seam.md

Reviewer stance: adversarial, fact-checked against pi-durable 1.2.0 dist and sigrun src. Citations are file:line in `node_modules/@earendil-works/pi-durable/dist/` (prefix `pd:`) or sigrun `src/`.

## Verdict summary

The spec is buildable and mostly sound. No BLOCKERs. The load-bearing claim — that endRun is a choke point through which every settle path commits — is **refuted as written** (MAJOR-1); the correct design exists and the spec actually gestures at it, but the spec text sends the builder to the wrong choke point. Several facts check out cleanly.

---

## BLOCKER

None.

## MAJOR

### MAJOR-1 — `endRun` is NOT the "single choke point"; it is the last non-resilient place to intercept

Spec: "endRun settlement classification (live.js:27 is the choke point all settle paths commit through)" and "The pairing itself survives restart: … `endRun` settles submissions in the same commit as the run outcome (live.js:27)".

Refutation: `pd:harness/live.js:27-34` — `endRun` is a pure **in-tx draft mutator**. It takes `(tx, live, taskId, settlement)`, mutates drafts, and returns nothing observable. It has no access to the run's input **texts** (the submissions' content lives in the submissions table / inbox items, not in `live.run.inputs`, which is ids only), and it is called from **five sites**, none of which is sigrun-callable:

- `pd:harness/generation.js:202` (aborted), `:249`/`:406` (model_error), `:261` (no_model), `:440` (done via answer), `:522` (done via terminate/handoff), `:530` (reset) — seven call sites actually, plus `pd:harness/live.js:148` (`settleSchedulerOutcome`, for faulted/orphaned scheduler writes).

A sigrun "wrap function" cannot intercept endRun without patching pi-durable module internals — exactly what the spec forbids ("no fork, no patch"). To observe settlement sigrun must either:

1. Wrap each **settling commit call path** in generation.js — impossible without forking; or
2. Use a **`GenerationHooks` hook that fires adjacent to every settle path** — but no hook fires on `aborted`/`reset`/`model_error`/`no_model` settles (`afterResponse` fires before classification at `generation.js:357`; the abort path at `generation.js:202` fires no hook; the faulted/orphaned path in `settleSchedulerOutcome` fires none). So hooks cannot cover the "unanswered" outcomes the spec explicitly requires (§1 "Which settles fire: done AND unanswered (model_error, no_model, aborted, reset)"); or
3. Use **commit observation** — `Session.subscribeCommits(listener)` (`pd:types.d.ts:827`, "Observe complete commits synchronously after adoption") with `CommitPublication.changes` (`pd:types.d.ts:702-705`). The listener can detect submission-settle changes and doc changes to `pi.live`, then re-read state on the Session line afterwards. This is the only mechanism in pi-durable 1.2.0 that sees **every** settle path including scheduler-written faulted/orphaned outcomes.

Caveat for path 3: the subscribeCommits contract says "The listener must not block or call Session APIs" (`pd:types.d.ts:826`), so the wrap must enqueue and re-read asynchronously — the spec's "bounded side lane after the settle commit" actually fits this, but the spec never names `subscribeCommits` and instead points the builder at a private function it cannot touch. The "isolated touchpoint" framing survives; the cited mechanism does not. The spec also claims the settlement and the outcome commit atomically ("in the same commit as the run outcome") — true for the generation paths (e.g. `generation.js:425-443` commits `endRun` + `startRun` + task outcome together), which subscribeCommits preserves.

### MAJOR-2 — `inputTexts` host-resolution is under-specified against pi-durable's actual submission model

Spec: `inputTexts` = "The paired user texts, host-resolved from the submissions above — one entry per input, in admission order."

Problems:
- `LiveDoc.run.inputs` carries `readonly SubmissionId[]` (`pd:events.d.ts:27-29`, `generation.js:555-558 startRun`). A `SubmissionRecord` (`pd:types.d.ts:336-340`) carries only `{id, conversationId, requestId?, type}` — **no content**. The text lives in the transcript entry the submission was placed as (`appendInput`, `pd:harness/inbox.js:74-81`, appends `UserEntry` with `model:[user message]`). To resolve text from a submission id, the host must map submission → placed entry id → entry record's model message. The placement link exists (`tx.placeSubmission(item.id, entry.id)`, `inbox.js:62`) but the reverse lookup from `SubmissionRecord` to entry id is not shown in the public record type — the builder must verify `SubmissionRecord`'s settled form carries the placed entry id or that the placed entry carries the submission id in `data`. If neither, "host-resolved inputTexts" requires watching placements at admission time (sigrun-side bookkeeping), which reintroduces a small version of the submit-binding state the spec claims to delete. **Spec should state the resolution path explicitly and cite the field it reads.**
- Queued-then-aborted submissions: `Conversation.abort()` "withdraws queued inputs" (`pd:types.d.ts:618-621`) — withdrawn queued submissions never become entries. If a run settles with inputs that were withdrawn mid-run, text resolution fails. The spec's empty-input ruling covers runs with zero inputs, not runs whose inputs lack resolvable text. Needs a sentence: unresolvable input → what (skip? empty string? omit?).
- Steer-merged runs: the spec claims "A steered/merged run gets one entry per input, in admission order" — consistent with `live.run.inputs.push(...users)` at `generation.js:536` (inputs append in placement order across boundaries). OK, but note admission order ≠ placement order; inputs are ordered by placement (inbox id order within a boundary — `inbox.js:50 users.sort((a,b)=>a-b)` is by inbox index, and submission ids ascend with admission, so it works out — fine, but worth the builder knowing it's placement-derived).

### MAJOR-3 — `conversationIdle` admission clock: no pi-durable signal named, and "any admission resets" conflicts with server reality

Spec: idle measured from "the conversation's last submission ADMISSION (any admission — queued or placed — resets the clock)". 

- pi-durable emits no admission event directly consumable per-conversation; sigrun server knows admissions (its own submit route) but **extensions also submit** (seam host writes, `tx.appendEntry` passive writes via `conversation.submit({type:"write"})`, `pd:types.d.ts:600`). The spec says "any admission" — does a passive write admission (a write-only submission, which "is appended at once, even mid-run", `pd:types.d.ts:596`) reset the idle clock? Those create submission rows too. Ambiguity an implementer will hit on day one.
- Detection mechanism unnamed: presumably `subscribeCommits` (submission table writes) or polling `harness.inspect()` (`pd:types.d.ts:569-575`, submissions listed). The spec should name one; each has different cost and different coverage of extension-driven admissions.
- `SIGRUN_IDLE_THRESHOLD` default 10 min with "re-arms per quiet period" — no jitter, no max-fire-rate; a cron-heavy deployment with thousands of conversations gets N timers. Feasible but worth a scaling sentence (timers per conversation vs. one sweep).

## MINOR

### MINOR-1 — `conversationArchived` listener site is vague; the SessionMetaDoc "commit path" is not a hookable point

Spec: "the SessionMetaDoc commit path is the listener, so an extension patching its own meta fires like the server route would". There is exactly one patch helper (`src/server/session-meta.ts:253-255 applySessionMetaPatch`) and one route (`src/server/index.ts:1543-1586`). "The doc-commit path is the listener site" implies observing doc changes — again `subscribeCommits`/`watchDoc` territory (`DocumentObserver.watchDoc`, `pd:types.d.ts:798-812`) — or wrapping `applySessionMetaPatch`. watchDoc is per-conversation and non-creating (returns undefined for absent docs) — a watch per conversation just for archive flips is heavy; subscribeCommits with doc-change filtering fits. Either way: **pick the mechanism in the spec.** Also un-archive fires with `archived=false` — confirmed patchable via `archived: null`→false (`session-meta.ts:83-90`, `:255`).

### MINOR-2 — `conversationForked` timing claim unverifiable as stated

Spec: fires "AFTER entries copy per doc semantics". Fork copies entries in pi-durable's `conversation.fork` (`pd:types.d.ts:626`). `src/server/index.ts:1356` calls `conversation.fork(...)`; firing after that await returns satisfies "after". Fine — but SessionMetaDoc has `fork: "current"` (`session-meta.ts:65`), so the child inherits archived/pinned state; if the parent was archived, the child is born archived — does that fire `conversationArchived(child, true)` at creation? Unspecified edge.

### MINOR-3 — `runSettled` event carries both top-level `answer` AND `outcome.answer` (shape contradiction)

The first code block shows `answer: AssistantMessage` as a top-level event field; the second code block moves the answer inside `outcome: {status:"answered", answer}` / `{status:"unanswered", reason}`. An implementer can't tell which is canonical. Minor editorial, but it's the core type of the spec.

### MINOR-4 — HookApi in the event signature is unowned

`runSettled(event, api: HookApi, context: Context)` — but `HookApi` (`pd:types.d.ts:677-685`) is task-scoped: `taskId`, `memo()` are "the asking task's memos, which hooks and the task share". Sigrun's seam-host event is not inside a pi-durable task invocation, so it cannot produce a genuine `HookApi`. Passing a fabricated one invites extensions to call `memo()` against a task they don't own. Spec should define a sigrun-side narrowed API (committed reads only: `DocumentReader` subset) rather than reusing `HookApi` verbatim.

### MINOR-5 — Factory-result `workers` validation/typing not sketched to loader-contract depth

Loader currently validates `health`/`submit`/`interactionKinds`/`ambientKinds` fail-loud (`src/harness/loader.ts:199-235`). Spec says workers get "same fail-loud validation" but doesn't enumerate violations (missing name? duplicate name within one extension? `run` not a function? `every.ms <= 0`?). The duplicate-name case matters because the spec promises names surface in `/v1/meta`. One sentence listing the rejection set would match the loader's existing rigor.

### MINOR-6 — Shutdown: `harnessShutdown` BEFORE storage closes vs `Harness.close` semantics

Spec: `harnessShutdown` fires "BEFORE storage closes", workers stop 30s then handlers 30s, worst ~60s "then storage closes regardless". Sigrun's shutdown path is `src/index.ts:36-60` (`app.close()` then `harness.close()`). Feasible: insert the fan-out between the two. But pi-durable `Session.close()` = "Seal admission, settle admitted commits, then close storage" (`pd:types.d.ts:818-819`) — extension handlers doing commits during the shutdown window race admission-seal; the spec should say whether shutdown handlers may still write (commit) or are read-only. A flush handler that commits after seal fails. Real edge, one sentence fixes it.

### MINOR-7 — `/v1/meta` extension entry shape: spec references "the extensions[] block already exists" — confirmed (`ExtensionOutcome` in `loader.ts:50-57`), additive `workers` field is consistent. But `lastRunAt`/`lastError` for a never-run worker = absent vs null, unspecified. Trivial.

## NOTE

- Verified-true claims worth recording: `afterResponse` fires per terminal provider message before classification (`pd:harness/generation.js:357`, types.d.ts:696 "Every terminal provider message, before classification") — spec's problem statement is accurate. Classification = stop/length/toolUse-no-calls at `generation.js:358-364` — spec's description matches. onYield handOver keeps the same submission set (`generation.js:436` + `handOver` at `:562-565` reassigns taskId only) — spec's continuation ruling is correct. `GenerationHooks` has no `runSettled` (`types.d.ts:688-705`) — correct. `beforeCompact` exists with summary-replacement (`types.d.ts:722-737`) — §4 mapping correct. `beforeRequest` exists per-request (`types.d.ts:690-695`) — correct. Two-phase host in loader (identity stub → re-key, `loader.ts:318-347`) — spec's "events fire only after boot completes" is consistent with factory-time capture of the same host instance. The seam-host fan-out being a factory-result field is consistent with the established contract (validated optional fields, `resolvedFromFactory`).
- The deferred-upstream issue text incorrectly says "generation.js:335" for afterResponse — actually 357 in the pinned 1.2.0 dist (line numbers drift; the issue cites 337-340 for classification, actually 358-364). Cosmetic but the issue quotes line numbers.
- `watchEvents` (`pd:harness/events.d.ts:184`) already emits `run_start`/`run_end` with `inputs` — an alternative observation channel the spec doesn't mention. It lacks the settlement reason and inputTexts, so the spec's mechanism is still needed, but noting its existence would preempt "why not just use the event stream?".

## Ranked answer to the four questions

1. **Factual correctness**: mostly accurate; one load-bearing mechanism citation wrong (MAJOR-1) plus two line-number drifts (NOTE).
2. **Design soundness**: rulings are coherent; the runSettled event shape self-contradicts (MINOR-3); HookApi reuse is conceptually wrong (MINOR-4).
3. **Feasibility**: buildable on 1.2.0 without forking **only via commit observation** (subscribeCommits) — which the spec never names; the named touchpoint (endRun) is private and multi-site.
4. **Missing**: inputText resolution path + unresolvable-input rule (MAJOR-2), passive-write admissions vs idle clock (MAJOR-3), archive-event mechanism + forked-archived-child edge (MINOR-1/2), shutdown-handler write permissions (MINOR-6), worker validation set (MINOR-5).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Full adversarial review returned: 0 blockers, 3 majors (endRun choke-point refutation with live.js:27-34 + generation.js settle-site citations; inputTexts resolution gap; idle-clock admission ambiguity), 7 minors, verified-true claims recorded, output written to the authoritative path"
    }
  ],
  "changedFiles": [
    "/home/example/.pi/agent/sessions/--home-example-repos-sigrun--/subagent-artifacts/outputs/d460eb7e-e1d2-4204-9ee8-39d4eabeaed9/context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "grep/sed reads over pi-durable dist (live.js, generation.js, types.d.ts, events.d.ts, inbox.js) and sigrun src (loader.ts, seam-host.ts, index.ts, session-meta.ts)",
      "result": "passed",
      "summary": "verified spec claims against source; found MAJOR-1 mechanism refutation"
    }
  ],
  "validationOutput": [
    "Review artifact written; all citations verified against pinned pi-durable 1.2.0 dist and sigrun src"
  ],
  "residualRisks": [
    "SubmissionRecord settled-form fields were inspected only via types.d.ts:336-340 — if the runtime record carries a placed-entry link not in the public type, MAJOR-2's resolution concern weakens (builder should confirm against submissions.js)",
    "subscribeCommits change granularity (DocumentCommitChange vs TableCommitChange, types.d.ts:678-700) was not fully traced — the recommended mechanism needs a spike to confirm settle changes are distinguishable per-conversation"
  ],
  "noStagedFiles": true,
  "diffSummary": "Wrote one review artifact to the mandated output path; no repo files modified (read-only task)",
  "reviewFindings": [
    "no blockers",
    "major: spec's endRun choke-point claim (live.js:27) is wrong — endRun is a private in-tx mutator called from 7+ sites; only Session.subscribeCommits (types.d.ts:827) observes all settle paths",
    "major: inputTexts host-resolution path not specified against pi-durable's content-less SubmissionRecord",
    "major: idle-clock 'any admission' rule ambiguous for passive write submissions; detection mechanism unnamed"
  ],
  "manualNotes": "Spec is close to shippable; the single most important fix is replacing the endRun-touchpoint story with a commit-observation mechanism (subscribeCommits) and spiking it before planning. Line-number citations in the deferred-upstream issue drifted from the pinned dist (afterResponse is generation.js:357, not 335)."
}
```
