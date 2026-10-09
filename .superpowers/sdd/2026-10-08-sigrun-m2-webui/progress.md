
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

## Task 24 — DONE (uploads + workspace browser)
- Implementer (kimi-k3, run 5601dda8): 558e2aa, webui 97/97 + root 208/208.
- Review (bifrost/kimi-k3, run 89b0a049 → resumed bd76af4e after the verdict didn't surface): APPROVED, no P0/P1, 3 P2s. ALL FOUR wire-shape risk checks passed against the server (upload {name,contentBase64}→{path}; files/files-content shapes; session-meta draft sub-merge preserves the other sub-key; submission parts {type,path,mime}).
- Fix round (orchestrator, 0f5b71b): suppress the perpetual loading label after a failed root list. Deferred (latent under v1's shared static workspaces): cross-conversation attachment pollution on mid-upload switch; stale children-cache repopulation.
- Next: T25 (themes + badges + layout shell — the visual polish task), then T26 (ship-gate E2E).

## Task 25 — implemented (in review)
- Implementer (kimi-k3, run 3448adc6): e0f965f, webui 114/114 (17 new) + root 209/209, both tsc clean.
- Theme system (light/dark + accent, CSS custom properties, useTheme persisted to localStorage) + TopBar (extension badge, health badges, theme controls) + layout shell styled to the mockup + the schema-version gate + the picker convention (model picker hides on a single-model catalog).
- THE VISUAL CHECK LANDED: built the bundle, booted the server, headless screenshot at /tmp/sigrun-t25/sigrun-webui-t25.png — verified non-blank programmatically (256 distinct byte values; orchestrator re-verified the PNG is 1280x800/33KB/non-blank). Neither worker nor orchestrator can view images — the visual content is verified structurally (dump-dom) + non-blank, not by eye. The theme toggle/accent live click-through is deferred to T26's E2E.
- Review dispatched (run 0bd6faa1).
- Next: T26 (the ship-gate E2E — the final M2 task).

## Task 25 — DONE (themes + badges + layout shell). ALL M2 FEATURE TASKS DONE.
- Implementer (kimi-k3, run 3448adc6): e0f965f, webui 114/114 + root 209/209. The visual check landed (screenshot verified non-blank programmatically + structurally via dump-dom; the picker convention live-verified — the single-model smoke boot has no .composer-model node).
- Review (bifrost/kimi-k3, run 0bd6faa1): APPROVED, no P0/P1, 2 P2s. Verified: the CSS port is clean (only 3 text-on-accent literals outside the custom properties), the schema gate + its drift guard are sound, the picker convention is live-verified, the report's verified-vs-not split is honest.
- Fix round (orchestrator, 34dc9be): the pre-paint theme boot (inline script applies the persisted theme before first paint). The localStorage-throw guard deferred.
- Next: T26 (the ship-gate E2E — the final M2 task, all 11 §7 checklist items).

## T26 — split into 26a/26b (env setup ate the budget)
- The combined T26 (server fixes + the 11-item E2E) timed out: the worker spent the whole budget on playwright/chromium environment setup (resolved chromium 1228 = playwright 1.61.0) and never wrote the server fixes or the E2E spec. Zero code committed (only package.json/lock changes — playwright added).
- The ship-gate pre-flight had already found TWO genuine M1 server gaps (supervisor-approved fixes): (A) the submissions route drops whenBusy (steer falls to queued); (B) the loader discards the memory wiring's submit, so degenerate recall never binds in the real server.
- Split: T26a (the two server fixes — server-only, root vitest) + T26b (the E2E spec + Appendix C, env now set up). T26a dispatched (run f76e189d).

## Task 26a — implemented (in review)
- Implementer (kimi-k3, run f76e189d timed out post-completion; orchestrator verified + committed bc5c282): root 212/212 (4 new: 2 steer-path + 2 recall-binding), tsc clean.
- Fix A: submissions accept whenBusy (validated against pi-durable's SubmissionDraft union steer|followUp|reject; unknown 400 invalid_field; passed to conversation.submit). The steer-path test proves steering (the run's inputs, not the inbox).
- Fix B: loader.ts ResolvedExtension gains submit; boot.ts exposes memorySubmit identity-matched to the memory-surface owner (mirroring memoryHealth); the submissions route uses it when present. The recall-binding test drives the real sigrun-ext-memory via the extensionSpecifiers seam.
- Review dispatched (run aecfe5b7).
- Next: T26b (the E2E spec + Appendix C — the final slice).

## Task 26a — DONE (the two ship-gate server fixes)
- Implementer (kimi-k3, run f76e189d timed out post-completion; orchestrator committed bc5c282): root 212/212 (4 new), tsc clean.
- Review (bifrost/kimi-k3, run aecfe5b7): APPROVED, 3 P2s (all minor/notes — no fix): the hand-duplicated WHEN_BUSY_MODES union (re-check on pi-durable upgrades), the steer test's ~45s timing margin (watch for flakes), the string-only pendingInputs disclosure (pre-existing wiring behavior).
- Reviewer verified against upstream sources: the whenBusy union matches pi-durable verbatim; the steer observable is real (InboxDoc mode='steer'); the identity-matching mirrors memoryHealth; the wiring's submit is a strict superset of conversation.submit; the recall test is genuine against the real package.
- Next: T26b (the E2E spec + Appendix C — the final slice, env already set up).

## T26b — first worker (run bd885345) failed on a phantom env issue
- The worker's smoke test imported @playwright/test from /tmp/pw-smoke.mjs — resolving against /tmp's node_modules, not the project's — and got ERR_MODULE_NOT_FOUND. It burned its budget fighting the phantom env issue, wrote no code.
- Orchestrator verified the env is FINE: @playwright/test is installed (webui/node_modules), loads, and chromium launches (a real page title read works). The worker's smoke test was just pointed at the wrong directory.
- Redispatching with the env confirmed working + a note to import from the project dir.

## Task 26b-i — DONE (E2E harness + smoke). In review.
- Implementer (kimi-k3, run 27a0a28b): 70c4110, webui 114/114 + root 212/212 + the smoke test passes in real chromium (1/1). The harness works end-to-end.
- webui/playwright.config.ts + e2e/harness.ts (bootE2EServer: real server + multi-model faux provider + tmpdir + the built bundle) + e2e/smoke.spec.ts (boots, renders the shell, screenshots) + tsconfig.e2e.json split + the test:e2e script (builds the bundle fresh first).
- Screenshot: .superpowers/sdd/2026-10-08-sigrun-m2-webui/artifacts/task-26b-i-smoke.png (1280x720, non-blank, orchestrator-verified).
- Review dispatched (run b1d0f0b6).
- Next: the 11 checklist items against the proven harness (the next slice).

## Task 26b-i — DONE (E2E harness + smoke)
- Implementer (kimi-k3, run 27a0a28b): 70c4110, webui 114/114 + root 212/212 + the smoke test passes in real chromium. Screenshot verified non-blank (1280x720).
- Review (bifrost/kimi-k3, run b1d0f0b6): APPROVED. The review's full text exceeded the output capture boundary (the verdict + opening analysis are persisted; the diff-reading + focus-area detail was cut off — the verdict line is the authoritative outcome).
- Next: the 11 checklist items against the proven harness (T26b-ii).

## Task 26b-ii — DONE (checklist items 1-2, 5-6, 8-9, 11). Orchestrator-written.
- The dispatched worker (run bd1d5c8c) burned its whole budget reading the components for selectors — 24 reads, 0 writes. Orchestrator wrote the seven specs directly against the proven harness (grep'd the selectors from the components).
- All 8 E2E pass (7 items + the smoke) in real chromium.
- TWO fixes the E2E surfaced (the gate working as intended): (1) App.tsx boot-time default selection of the root conversation (the composer was disabled until a click); (2) the files list endpoint returned ABSOLUTE paths (pi-durable listDir) but files/content requires RELATIVE (isConfinedPath) — a genuine server contract inconsistency; the list endpoint now relativizes.
- App unit tests updated for the default selection. webui 114/114, root 212/212, e2e 8/8, tsc clean both.
- Next: T26b-iii (items 3 steer, 4 approvals, 7 compaction recall, 10 restart resume) — the harder four.

## T26b-iii — groundwork committed (95140d6); the four specs still to write
- Worker (run 1a2d58a8) timed out post-groundwork: the harness extensions (tokensPerSecond, settings, extensionSpecifiers, restart()) landed + a genuine ship-gate bug found+fixed (the Composer's send button was disabled while busy — Steer unclickable). NO checklist specs written.
- Orchestrator committed the groundwork + fixed the item-6 timing race (the draft-restore/settle race, same as item 2). e2e 8/8 still green.
- Next: write the four specs (steer, approvals, compaction recall, restart-resume) against the extended harness — dispatch a fresh worker or orchestrator-write.

## Task 26b-iii — DONE. ALL 11 §7 M2 SHIP-GATE ITEMS PASS. M2 COMPLETE.
- The T26b-iii worker (run 1a2d58a8) stalled post-groundwork; orchestrator wrote the four specs directly. The harness groundwork (restart, tokensPerSecond, settings, extensionSpecifiers) + the Composer steer-button fix landed in 95140d6.
- The four hard items (orchestrator-written): steer (busy→Steer toggle, whenBusy:steer — the steered input lands in the inbox, the honest observable), approvals (the endpoint-sourced card, the T22 P1 composition), compaction recall (a forced compaction + the T26a-fixed binding), restart resume (the harness restart() re-boots on the same storage; the transcript survives; the page closes before the restart — the open SSE watch stream would otherwise hold the old server's close() open forever).
- Appendix C gains the M2 ship-gate record (C.2): all 11 items pass + the five ship-gate-surfaced fixes (whenBusy dropped, memory binding, the steer-button gate, the files path relativization, the auto-select gap).
- ALL 12 E2E green (11 items + smoke), webui 114/114, root 212/212, tsc clean both. THE §7 M2 SHIP GATE IS MET.
- Next: the final T26b-iii review + the M2 whole-branch review, then merge.

## Task 26b-iii + the ship-gate review — DONE. M2 COMPLETE.
- The T26b-iii worker stalled post-groundwork; orchestrator wrote the four hard specs. The ship-gate review (run fdfad24d → resumed 0722e8d5) was CHANGES-REQUIRED and RIGHT: items 4 + 7 were recorded PASS without exercising their criteria (the gate's value is an honest record).
- Fix round (orchestrator, 670c5e8): item 4 gained the deny leg (approve one + deny one, both asserted); item 7 now genuinely exercises recall (the memory extension loaded, a real memory_recall tool call, the tool card shows the recalled marker — the T26a binding proven end-to-end). The compaction policy needed keepRecentTokens 2000 (the too-tight policy was eating the tool round — the E2E caught it).
- P2 fixes: item 11 matches 'unconfigured'; the item-2 dead writeFile removed; the App auto-select clobber race fixed. The steer unit pin already existed (Composer.test.tsx asserts whenBusy:steer).
- ALL 12 E2E green, GENUINELY. webui 114/114, root 215/215, tsc clean both. THE §7 M2 SHIP GATE IS MET with the record matching the evidence.
- Next: the M2 whole-branch review, then merge feat/m2-webui to main.
