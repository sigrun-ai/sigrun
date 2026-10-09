
## T20 — first worker (glm-5.3, run 83fb7425) timed out with ZERO code
- The webui-scaffold task hit the glm-5.3 stall pattern (unfamiliar territory: no webui/ dir, no report, no commit — the run ended reading wire types).
- Escalated to kimi-k3 (bifrost/kimi-k3 — the gateway was renamed; the old gateway/ id is gone from the registry) with a HARD TIME BUDGET section added to the brief (read only the brief + 4 named files, write webui/package.json within the first few tool calls, incremental report).
- Redispatch: run ba4f0e53.

## Task 20 — DONE (webui workspace scaffold + channel-bundle serving)
- Implementer (kimi-k3 after a glm-5.3 zero-code timeout, run ba4f0e53): 6090520, 207/208 → orchestrator fixed the one regression (the T9e meta test booted with the default bundle path, now that webui/dist exists; pinned to absent-bundle). 208/208, webui 5/5.
- The worker verified the UI render headlessly (chromium dump-dom + screenshot): the React app mounts, fetches /v1/meta, renders all six badges.
- Deviations (documented): api.ts wire types mirror src/server/views.ts BY HAND (webui can't import server sources — NodeNext vs bundler); the deploy image must run npm run build:webui or set SIGRUN_WEBUI_BUNDLE.

## PAUSED 2026-10-08 — model-availability gate
T20 implemented (6090520 + orchestrator fix 6a498b3, 208/208 root + 5/5 webui, UI render verified headlessly). The T20 review is BLOCKED on a working reviewer model:
- bifrost/<model> (the reviewer/oracle override) fails in the subagent runner: the model id doubles to bifrost/bifrost/<model>:high and the model is not found (the runner's availableModels for the bifrost provider is empty — the offline models-store has bifrost.models: [], so the qualified id never resolves and the provider prefix re-applies). Root cause is in pi-subagents' model-resolution + the pi-bifrost-gateway plugin's models-store shape.
- ollama-cloud is at its weekly usage limit (429). synthetic has no API key in auth.json (only 'bifrost' has a key, stored as {type: api_key, key}).
USER is fixing the bifrost gateway. When a working reviewer model exists, re-dispatch the T20 review (review package: review-dc3ae48..6a498b3.diff, brief task-20-brief.md, report task-20-report.md), then continue T21-T26 per the plan.

## Task 20 — DONE (webui scaffold + channel-bundle serving)
- Implementer (kimi-k3 after glm-5.3 zero-code timeout, run ba4f0e53): 6090520 + orchestrator fix 6a498b3, 208/208 root + 5/5 webui. UI render verified headlessly (dump-dom + screenshot).
- Review (bifrost/kimi-k3 after the gateway fix, run c6528306): APPROVED, one P2 (report's fastify-plugin version rationale inaccurate — the resolved 9.3.0 declares fastify-plugin ^6, so the v10-avoidance note was wrong). Record corrected in the report (three notes now state the resolved reality). Inert — the resolved set passes all tests.
- Reviewer verified: workspace shape safe (root tsconfig include excludes webui), serving seam correct (resolveWebuiBundle fail-loud on explicit-missing, SPA fallback scoped to non-/v1), channels wiring exact, api.ts hand-mirror field-exact at birth (drift risk bounded + documented), tests hermetic + genuine, render evidence real.
- Bifrost gateway fixed by user mid-task; reviewer model resolution now works (bifrost/kimi-k3).
- Next: T21 (the transport hook + conversation view state).

## T21 — first worker (glm-5.3, run 5d992401) zero code
- glm-5.3 stalled again on a webui task — read src/server/index.ts (the submissions route) instead of staying in webui/. No stream.ts, no hook, no report. Second webui-task stall for glm-5.3 (T20 was the first).
- Escalated to kimi-k3 (bifrost/kimi-k3, run 38ad4358) with a webui-only brief (named read-list: brief + api.ts + the spike; do NOT read src/).
- PATTERN LEDGERED: glm-5.3 stalls on webui/frontend tasks (reads server internals instead of writing the webui). kimi-k3 is the webui model for this plan.

## Task 21 — implemented (in review)
- Implementer (kimi-k3 after glm-5.3 webui stall, run 38ad4358): ea21aee + report 5fdee99, webui 21/21 + root 208/208, webui tsc clean.
- stream.ts (openConversationStream: snapshot/view/heartbeat parse, malformed→onError+stream survives, reconnect w/ backoff) + useConversationView.ts ({view,status,frames,error}, full-replace, cleanup on unmount/id-change) + types.ts extended with ConversationViewWire.
- Tests drive a stubbed EventSource (the injectable factory seam — no real server).
- Review dispatched (run 49ed7d0e, default reviewer model — bifrost/kimi-k3 works post-gateway-fix).
- Note: the worker committed the .superpowers/ SDD reports (5fdee99) — they are the audit trail; this branch tracks them (the M0+M1 worktree's gitignore convention was that worktree's, not the repo's).

## Task 21 — DONE (transport hook + conversation view state)
- Implementer (kimi-k3, run 38ad4358): ea21aee + report 5fdee99, webui 21/21 + root 208/208.
- Review (bifrost/kimi-k3, run 49ed7d0e): APPROVED, 4 P2s. Verified: the wire mirror is field-exact against the fixture + views.ts (steer confirmed a sigrun projection); thin-client invariant holds (two setState paths, both full-replace); the reconnect backoff ladder is precisely tested.
- Fix round (orchestrator, 61fcd98): effect-dep doc comment + shared test-utils.ts StubEventSource. Deferred: react-test-renderer deprecation (dev-only), source-identity guard (browser-unreachable).
- Next: T22 (entry renderers by kind + tool/approval cards).

## Task 22 — implemented (in review)
- Implementer (kimi-k3, run 35faf1b4): 55fd077, webui 46/46 (25 new) + root 208/208, webui tsc clean.
- webui/src/entries/: EntryList (kind dispatch) + UserEntry + AssistantEntry (react-markdown + remark-gfm) + ToolResultEntry (expandable, running state from LiveDoc slots) + SystemEntry + ApprovalCard (pending gated calls; allow/deny POST; clears on next frame).
- The worker made a scope call the warden challenged: no browser screenshot because the components are NOT mounted yet (App.tsx is still the T20 badge scaffold; composition is T23, theming T25). The verification is structural via react-test-renderer. The reviewer is asked to judge whether that's the right scope call.
- Review dispatched (run f1a3afa4).

## Task 22 — DONE (entry renderers + tool/approval cards)
- Implementer (kimi-k3, run 35faf1b4): 55fd077, webui 46/46 (25 new) + root 208/208.
- Review (bifrost/kimi-k3, run f1a3afa4): APPROVED, 1 P1 + 2 P2s. Reviewer verified the two unpinned wire assumptions against pi-durable dist sources (toolCallId on pi.tool-result entries; ToolSlot lifecycle — a gated parked call presents as a PENDING slot, so the worker's pending-only filter was the correct call over the brief's literal pending+running). Endorsed the worker's no-browser-screenshot scope call (react-test-renderer is the brief's harness; composition is T23).
- THE P1 (a design correction, lands in T23): approval cards must be sourced from client.listApprovals() refreshed per view frame, NOT from view.live.tools slots — the view can't evaluate the gating policy, and a sequential round marks ungated queued tools pending (spurious cards). The server's approval vocabulary is pending||running AND isGated AND undecided. Baked into the T23 brief.
- Fix round (orchestrator, f49d6d2): model-less entry guard (ConversationEntryWire.model now optional — pi.reset carries none); report arithmetic corrected.
- Next: T23 (sessions sidebar + composer — WITH the approval-cards-from-endpoint composition).

## T23 — first worker (kimi-k3, run d2779411) produced ZERO code
- The run completed with acceptance:rejected and a blank acceptance record — the worker read the brief, did a git check, and the run ended with no files written. No error in the events; the completion fired on a mid-run status line.
- Resumed (run 275e9cbf) with a pointed nudge: stop reading, write code, ordered steps, do not end until the commit exists + suites pass.

## T23 — split into 23a/23b (output-budget root cause)
- Two kimi-k3 dispatches on the combined T23 (sidebar + composer + app shell + draft + approval sourcing + api additions) both produced ZERO code: the first ended after a git check (blank acceptance), the second hit a terminal stopReason:length (bifrost/kimi-k3 max-out is 8.2K — too small for the multi-component task).
- ROOT CAUSE: the task's output budget. T22 succeeded because it was smaller. T23's scope exceeded 8.2K output tokens.
- Split: T23a (sidebar + app shell, no composer) + T23b (composer + draft + approval sourcing). T23a dispatched (run 84d495a3). The T22-P1 approval-sourcing lands in T23b.
- LESSON: for kimi-k3 (8.2K max-out via bifrost), keep webui tasks to ~2 components + tests. The 4-component T23 was over budget.

## Task 23a — DONE (sessions sidebar + app shell)
- Implementer (worker, run 84d495a3): 8b639da `feat: webui sessions sidebar + app shell`. webui 58/58 (11 files), root 208/208, tsc clean both.
- Shipped: api.ts +ConversationMeta/getConversationMeta/patchConversationMeta/createConversation (post→send refactor); SessionList (pinned-first, archived dimmed, new/switch/archive, meta best-effort fallback); App.tsx rewritten to three-panel shell (SessionList | EntryList over useConversationView | right placeholder), composer = empty footer slot for T23b; app.css (first stylesheet); test-utils renderAsync.
- Next: T23b (composer + draft + approval sourcing per T22-P1) — needs T23a's composer-slot mount point, view.steer threading decision, and ConversationMeta.draft semantics.

## Task 23a — implemented (in review)
- Implementer (kimi-k3, run 84d495a3): 8b639da, webui 58/58 + root 208/208, webui tsc clean. The split worked — the smaller slice fit the output budget.
- SessionList.tsx + App.tsx (three-panel shell: sidebar + EntryList chat center + placeholder right panel) + api.ts additions (patchMeta, createConversation) + App.test.tsx + SessionList.test.tsx.
- The worker explicitly flagged the shell as browser-UNVERIFIED (structural via react-test-renderer; visual verification is T25's lane — the T22-endorsed scope call). The reviewer is asked to judge.
- Review dispatched (run 24038a08).
- Next: T23b (composer + draft + approval sourcing — brief staged) after the T23a review.

## Task 23a — DONE (sessions sidebar + app shell)
- Implementer (kimi-k3, run 84d495a3): 8b639da, webui 58/58 + root 208/208. The output-budget split worked.
- Review (bifrost/kimi-k3, run 24038a08): CHANGES-REQUIRED, 2 P1s (both mine — the T23a brief's inline meta sketch was wrong: tagged/draft as boolean, source as string; the worker mirrored it). Reviewer caught it against src/server/session-meta.ts.
- Fix round (orchestrator, 5679f17): ConversationMeta corrected to the real server shape; ConversationMetaPatch added (null-clear + draft sub-merge — unblocks T23b's draft work); DEFAULT_META.source fixed; test fixtures corrected. webui 58/58, root 208/208.
- LESSON LEDGERED: the §5 server type (src/server/session-meta.ts) is the authoritative wire source — never sketch a wire shape inline in a brief. The T22/T23a briefs' inline shapes must be replaced with 'read the server type' pointers.
- Next: T23b (composer + draft + approval sourcing — brief staged).

## Task 23b — DONE (composer + draft + approval sourcing). Task 23 complete.
- Implementer (kimi-k3, run 68b67d5a) timed out post-completion (all components built, tests green, report checklist unchecked); orchestrator verified + committed 5df1a9e. webui 77/77 (13 files), root 208/208, webui tsc clean.
- T22-P1 RESOLVED: approval cards source from client.listApprovals(activeId) refreshed per view frame (Composer.tsx:156-171), NOT the view's tool slots. Verified in the committed code.
- Next: T24 (uploads + workspace browser).

## Task 23b — DONE (composer + draft + approval sourcing). Task 23 COMPLETE.
- Implementer (kimi-k3, run 68b67d5a timed out post-completion; orchestrator committed 5df1a9e). webui 77/77, root 208/208.
- Review (bifrost/kimi-k3, run 7bd3ac64 → resumed 0ee08307 after an output-length stop; the review diff was 52KB, over the 8.2K budget — resumed with a bullet-points instruction): CHANGES-REQUIRED on a REAL P0.
- THE P0: useDraft's flush cleanup read saveRef.current.conversationId — reassigned in the render body to the NEW conversation before cleanup — so a fast switch PATCHed the old text to the new id. The test asserted only the PATCH body, never the URL — passed with the bug. Fixed (cleanup uses its own closure's id) + the test now pins the URL.
- P2s applied: post-submit draft resurrection (clear(true) persists the clear); draft-error surfacing (flush errors route to onError, were swallowed). Deferred: stale-approval flash (cosmetic).
- Fix round (orchestrator, 7844dbf). webui 77/77, root 208/208, tsc clean.
- LESSON: the output-length stop hit the REVIEW too (52KB diff over the 8.2K budget). The resume-with-bullet-points instruction recovered it.
- Next: T24 (uploads + workspace browser).

## Task 24 — implemented (in review)
- Implementer (kimi-k3, run 5601dda8): 558e2aa, webui 97/97 (21 new) + root 208/208, webui tsc clean.
- WorkspaceBrowser (file tree, lazy expand, select→preview) + FilePreview (text/binary note, read-only) + the composer attach path (upload → workspace-relative path → draft.attachments → submit path-parts) + api.ts (listFiles/readFile/upload).
- The worker explicitly flagged visual rendering as UNVERIFIED (no browser tool in its toolset; visual verification is T26's ship-gate E2E lane). The standing scope call the T22/T23 reviewers endorsed.
- Review dispatched (run 89b0a049).
- Next: T25 (themes + badges + layout shell — the visual polish task), then T26 (ship-gate E2E).
