All four files read in full. Writing the revision audit now.

---

# Revision audit: sigrun spec rev 3 — fix verification + internal consistency

**Angle:** revision audit (did rev 3 fix round 1?) + new-defect/consistency hunt.
**Files read:** `docs/superpowers/specs/2026-10-02-sigrun.md` (rev 3), `CONTEXT.md`, `docs/superpowers/specs/reviews/2026-10-04-sigrun-glm53.md`, `docs/superpowers/specs/reviews/2026-10-04-sigrun-ds41f.md`. Repo is spec-only (no code); no upstream re-verification performed or claimed — every verdict below is from the rev-3 text itself.

---

## Part 1 — Round-1 finding disposition

### glm53 review

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | P0 storage/backup (sqlite on NFS, no backup, no restore drill) | **FIXED** | New §6.2: "**Not on NFS.** … The sqlite lives on a local-path (or local-RWO) PV", "**Scheduled backup:** nightly `sqlite3 .backup` to the NFS/RustFS path (CronJob in the chart), retention ≥ 30 days", "**Restore drill in M1's exit criteria**". §6.1 chart bullet updated to "two PVCs". M1 exit: "restore from the nightly backup resumes". Journal mode is a named M1 verification ("confirmed against the shipped package in M1 … recorded here once known"; App C named list) — acceptable, since the decision frame (WAL+NORMAL on local disk, else pi-durable default) is stated. |
| 2 | P1 exactly-once overclaim | **FIXED** | §5: "`requestId` makes duplicate submission idempotent (API verified upstream; **crash-replay semantics are a named M1 verification**, §7 — the claim is 'idempotent', not yet 'exactly-once across crash')". M1 battery: "duplicate-`requestId` submit after crash → single completion". |
| 3 | P1 hook-replay / memo-guard / resume trust | **FIXED** | §2 memory: "replay-guard via a durable memo keyed by generation id — **exact semantics verified in M1**". M1 battery: `kill -9` mid-stream / mid-tool-call / mid-compaction + "hook replay behavior observed and recorded in Appendix C (this determines the memory observe-guard design)". L1 defers the guard design to the M1 finding; L3 adds "unsafe-replay semantics verified against a side-effect-free dummy before any mutating maintenance tool ships". App C names all of these as M1 verifications. |
| 4 | P1 upgrade churn (no pinning/adapters) | **FIXED** (pinning/drift; adapter-seam suggestion not adopted — see note) | §5: "`@earendil-works/pi-durable` is pinned to an exact version in `package.json` (no ranges); the upgrade procedure is: read changelog → snapshot the sqlite file → upgrade on a scratch copy → verify `resume()` + view serialization → deploy"; "Captured schema … committed in-repo as a type fixture"; `GET /v1/meta` with fail-loud webui. **Note:** the review's "confine upstream touchpoints to named adapter modules" suggestion was not taken up anywhere in rev 3; the captured-schema fixture partially substitutes for it. Report-only residual. |
| 5 | P1 tailnet auth / undefined "authenticates" | **FIXED as a documented decision** | §4.4 rewritten: "the tailnet is the trusted principal", "The Tailscale LB path reaches the Service directly and does NOT traverse Authelia — that is the documented trust boundary, not an accident", bearer-token layer reserved as a seam "Implemented when the first non-browser client lands; not in the MVP". The review asked for tokens *now*; rev 3 consciously defers with the boundary documented. Residual risk is real but bounded and explicit (App B.19). |
| 6 | P1 observability (wedged-harness blindness, extension boot abort) | **FIXED** | §6.1: "`GET /v1/meta` liveness (storage writable + resume complete + extension boot outcomes — not the same as process-up), plus two wedged-state gauges: oldest in-flight submission age, and oldest waking task age". §2 boot order: "A failing extension at boot is quarantined (logged, surfaced as a degraded surface via `GET /v1/meta`), never aborts `Harness.open()`". |
| 7 | P2 steer endpoint | **FIXED** | §5: "plus a per-conversation `steer` field reflecting submit-while-busy queue semantics"; "Submitting while the conversation is busy queues the input (steering/follow-up queue semantics verified in M1)". |
| 8 | P2 cron list vs task-graph exclusion | **FIXED** | §4.1: "Cron job list: NOT in the ship gate — it moves to lane L3 … where it reads `GET /v1/jobs`". §5: "(The L3 cron panel reads a read-only `GET /v1/jobs` enumeration added with that lane, not the full task graph.)" |
| 9 | P2 removed-extension resume behavior | **FIXED** | §3.1: "A resumed conversation referencing a removed extension resumes with that surface's degenerate default; the name is preserved in the conversation record so re-enabling the extension restores it without a transcript migration." |
| 10 | P2 §3.2 code example contradicts verification note | **FIXED** | Example now reads `createProvider({ id: "bifrost", auth: { apiKey: { resolve: async () => ({ auth: { apiKey: VK, baseUrl: GATEWAY } }) } } })` — matches the verified shape. |
| 11 | P2 "upstream sections" unverified | **FIXED** | App C: "Sections mechanism (`defineExtension` + `section()`, per-request re-render from latest state) — present in the shipped package (verified in dist 2026-10-04; the context-files surface uses it)". |
| 12 | P2 cost/token accounting | **FIXED as a deferral decision** | App B.20: "cost-accounting metrics excluded (inference pricing is unstable; revisit when it matters)". |
| 13 | P2 bifrost single point of failure | **FIXED as a decision** | §3.2: "A fallback-provider extension … is deliberately **not** in the MVP; if bifrost is down, sigrun is down — an accepted consequence of the gateway-only policy … It can be built any time as just another contributor." |

### ds41f review

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| P0-1 | No conversation create/list; session-meta unowned | **FIXED** | §5: "`POST /v1/conversations` … `GET /v1/conversations` … `GET /v1/sessions/:id/meta` / `PATCH …` — … Backed by a sigrun session-meta document/table in the same `/data/sigrun.sqlite`"; "v1 is multi-**session**, single-user". App B.12. |
| P0-2 | No jobs surface for the cron panel | **FIXED** (chose the drop-from-M2 alternative) | §4.1/§5/§7 as above; `GET /v1/jobs` ships with L3. |
| P0-3 | Approvals missing from §2/§5 | **FIXED** | §2 "Approvals (part of Tools)" paragraph (beforeTool seam, durable memo, per-conversation policy document); §5 approvals endpoints; M1 "Approvals extension: conservative default policy + durable memo decisions"; M2 approval cards. |
| P0-4 | Unversioned upstream dependency | **FIXED** | Same evidence as glm #4. |
| P1-1 | Memory contract is three seams; degenerate prompt surface differs | **FIXED** | §2: "one interface: **`MemoryBackend { observe(record), recall(query), section() }`**", afterResponse pinned, "`section()` emits a stable placeholder ('long-term memory backend not configured') so the prompt surface is identical across configurations". |
| P1-2 | Image chat has no §5 contract | **FIXED** | §5: "`input` carries content parts — text and image/file references"; "`POST /v1/conversations/:id/uploads` — materialize an uploaded file into the conversation's workspace via its ExecutionEnv; returns the workspace-relative path". App B.23. |
| P1-3 | Provider merge semantics unspecified | **FIXED** | §3.2 "Merge semantics (core, fixed)": "last-registered wins on provider-id/model-id collision, collisions are logged (never silent). `SIGRUN_MODEL` env overrides any contributor's default model. A conversation pinned to a model id that no contributor serves fails explicitly at submit (4xx listing available ids) — never a silent fallback." |
| P1-4 | Skills convention scope | **FIXED** (chose the shrink option) | M1: "Skills convention skeleton (v1 scope: local workspace root only; section carries name + description; `load_skill(name)` returns the body; no management UI; remote-workspace skill discovery is deferred)". |
| P1-5 | Persona picker over single-persona contract | **FIXED** (chose drop) | §4.2: "Persona/profile picker: v1 is a single persona (`SOUL.md`). Per-conversation persona selection … is a later lane." §4.1 composer footer no longer lists it. |
| P1-6 | Cutover-gate ordering contradiction | **FIXED** | §7: "**Cutover gate (hermes → 0) = L1 + L3 both exited** (and L2 if daily research matters…). Lane independence is an implementation-order property; the *gate* is a property of the whole lane set." L3 exit no longer says "hermes scales to 0". |
| P1-7 | Ship-gate criterion untestable / excludes research | **FIXED** — but the edit introduced a new internal contradiction (New finding N6). | M2 exit is now a concrete checklist + soak; parity redefined as "harness+webui parity for these interactions". |
| P1-8 | Auth/trust boundary unstated | **FIXED** | §4.4 rewrite (glm #5). |
| P1-9 | Notification/push seam | **FIXED** | §4.1: "v1's only event channel is the §5 watch stream; push notifications are a later client concern. The audit treats hermes's service-worker/notification settings as out of scope (drop, don't port)." §4.2 mirrors it. |
| P2s | configure enumeration | **PARTIAL** | §5: "accepted fields enumerated in the captured schema" — but the captured schema is defined as "the serialized `ConversationView`/watch-frame shape", i.e. *output* frames; `configure()`'s accepted *input* fields are not part of a view serialization. See N11. |
| P2s | abort semantics | **FIXED** | §5: "`abortSubmission` (per-submission, idempotent; conversation-level abort is not exposed in v1)". |
| P2s | observe memo key | **FIXED** | "memo keyed by generation id" (§2, L1). |
| P2s | env-secret isolation | **FIXED** | §6.1: "extensions are trusted code with no capability isolation — every enabled extension can read every env secret. Accepted for v1". |
| P2s | M2 estimate rebaseline | **FIXED** | M2 step 0: "**if the audit lands <60%, M2 is re-baselined before work starts**". |
| P2s | Discord: root conversation vs honcho-only | **NOT FIXED** (carried P2) | §3.3/L5 say "channels as synthetic honcho peers, ingestion only" but never state whether ingestion writes into the shared root conversation or only into honcho. One-line fix in §3.3 or L5. |
| P2s | cron-origin sessions | **FIXED** | §5 session-meta includes "`source`: `user\|cron`". |

**Scorecard:** 6/6 glm majors FIXED; 13/13 ds41f P0/P1 FIXED; ds41f P2s: 6 FIXED, 1 PARTIAL (configure), 1 NOT FIXED (Discord ingestion target — report-only). No round-1 fix was faked; every claimed mechanism exists in the body text quoted above.

---

## Part 2 — New defects introduced by the rev-3 edits

### N1 — P1: `createConversation()` is asserted in §5 but violates the spec's own verified-vs-named-M1 split

**Evidence:** §5: "`POST /v1/conversations` — create a conversation (upstream `createConversation()`); returns its id." Appendix C's verified list covers provider auth, image input, env builder, "`requestId` idempotent submissions, `resume()`, `Conversation.watch()`, `abortSubmission`", defineTask/sleep/watchDoc, hooks, and sections — **`createConversation` appears nowhere**, and it is also absent from the "Named M1 verifications (claimed in spec, not yet observed)" list. Rev 3 established the rule that asserted-but-unobserved upstream behavior gets named in App C (App B.15) — and then broke that rule for the single most load-bearing new primitive of the revision (the whole multi-session lifecycle, App B.12, rests on it).

**Same class, smaller:** §5 asserts "`abortSubmission` (per-submission, **idempotent**…)" — App C records `abortSubmission` as *present* only; idempotence is unverified and unnamed.

**Fix:** add both to App C's named M1 verifications ("`createConversation()` exists and survives `resume()`; `abortSubmission` idempotence"), and add one line to the M1 crash battery or deliverables so they are actually exercised. Two lines.

### N2 — P1: §4.1 ships a workspace file browser; §5 exposes no file read/list endpoint

**Evidence:** §4.1: "Three-panel layout: sessions sidebar …, chat center, **on-demand workspace file browser right panel**." §5's entire endpoint list is: views/watch, conversations create/list, session-meta, submissions, **uploads** (write-only, "returns the workspace-relative path"), models, abort, configure, approvals, meta. There is no `GET` for workspace file listing or file content. Round 1 (ds41f P1-2) forced the *upload* path into §5; the symmetric *browse/read* path the same parity bullet needs was never added. M2 cannot build the right panel against §5 as written.

**Fix:** add to §5: `GET /v1/conversations/:id/files?path=` (list) and `GET /v1/conversations/:id/files/:path` (read), served through the conversation's ExecutionEnv exactly like uploads; one sentence noting size caps/binary handling. If the file browser is deliberately later-lane, move it out of §4.1's ship-gate parity list instead.

### N3 — P2: two sections numbered §6.2

**Evidence:** "### 6.2 Storage safety and backup" (new) immediately followed by "### 6.2 Dependencies (already deployed, consumed by extensions)" (the pre-existing section, not renumbered). App B.13's "§6.2" reference is now formally ambiguous (context saves it, but the doc should not rely on that).

**Fix:** renumber Dependencies to §6.3.

### N4 — P2: Appendix B.10 still says `afterResponse`/`onYield`; §2 pinned `afterResponse` only

**Evidence:** §2 memory row: "Observe rides the `GenerationHooks.afterResponse` hook (**pinned choice: single fire per turn**…)" — the ds41f P1-1 fix. App B.10 (revision-2 decision text, unedited): "observe rides `GenerationHooks.afterResponse`/`onYield`, memo-guarded…". The appendix now contradicts the body it is supposed to record.

**Fix:** edit B.10 to "`afterResponse` (pinned, single fire per turn; rev 3)" or add a one-line amendment marker.

### N5 — P2: §1.2 says "No memory backend"; the ship gate includes one

**Evidence:** §1.2 ship gate: "degenerate memory and context management. **No memory backend**, no cron, no maintenance tools." But §2 defines the degenerate default as an implementation of "one interface: **`MemoryBackend`**", §3.3 calls it "Degenerate memory (core, no extensions): the `MemoryBackend` over harness entries", and M1 (pre-ship-gate) ships "`MemoryBackend` (§2) with the degenerate implementation". "No memory backend" is only true if it means "no *external* memory backend (honcho)".

**Fix:** §1.2: "No *external* memory backend (degenerate transcript-recall only), no cron, no maintenance tools."

### N6 — P2: M2 exit contradicts itself on when the soak happens

**Evidence:** M2 exit, parenthetical: "the daily soak **follows L1+L2**, which restore the two functions the user actually lives in: memory and research." Two sentences later: "A soak day in the webui **follows the checklist pass**; any feature gap that forces a fallback is filed as a Card and fixed before the cutover gate." The parenthetical implemented ds41f P1-7's chosen option (harness+webui parity at ship, soak after L2); the trailing sentence is the pre-decision wording and schedules the soak immediately after M2, before L1/L2 exist.

**Fix:** delete or reword the trailing sentence: "The soak day happens after L1+L2 (memory + research restored); any feature gap…". Decide whether a gap found in the soak gates the *cutover* gate (current text) or the ship gate (impossible if the soak is post-L2 — ship is already passed); current text says cutover, which is consistent once the sentence is fixed.

### N7 — P2: steer-queue verification promised as an M1 exit test (App B.15, §5) but absent from M1's exit list

**Evidence:** App B.15: "requestId crash-replay, hook-replay/observe-guard semantics, unsafe-tool replay, **steer queue semantics** — all asserted behavior becomes M1 exit tests". §5: "steering/follow-up queue semantics verified in M1". App C named M1 verifications: "steer/follow-up queue semantics on busy submit" ✓. But M1's own crash-battery/exit block lists kill-9 ×3, duplicate-requestId, and hook replay — **steer is not there**. Three places say M1 verifies it; the milestone that must do the work doesn't list it.

**Fix:** add "submit-while-busy → queued/steered behavior observed and recorded" to the M1 battery.

### N8 — P2: §1.2 cutover-gate definition not synced with §7's

**Evidence:** §1.2: "Cutover gate (hermes → 0): **memory + scheduled jobs + maintenance-task parity** reached." §7: "Cutover gate (hermes → 0) = L1 + L3 both exited (**and L2 if daily research matters before decommissioning — expected, per CONTEXT §2**)". §7's "(+L2, expected)" qualifier never made it back to §1.2, so the summary definition and the operative definition differ by exactly the lane CONTEXT calls "the most common use".

**Fix:** §1.2: "memory + scheduled jobs + maintenance-task parity reached (research expected in practice — §7)".

### N9 — P2: §4.1 composer lists a "workspace picker"; day-1 workspace is a single static path with no §5 resource

**Evidence:** §4.1: "Composer footer: model picker …, **workspace picker**, context-usage ring." §3.4: "Day 1: `workspaceService` is static config (`{ defaultWorkspace: { type: "local", path: "/home/sigrun" } }`)" — exactly one workspace, and §5 exposes no workspace list/switch endpoint. This is the same defect class round 1 killed for the persona picker (decorative UI over a single-value contract), re-introduced in a different bullet.

**Fix:** either mark the picker "deferred, hidden when one workspace" in §4.1, or drop it from the ship-gate feature list.

### N10 — P2: session-meta "table in the same `/data/sigrun.sqlite`" is an unverified assumption about sharing pi-durable's storage file

**Evidence:** §5: "Backed by a sigrun session-meta document/table **in the same `/data/sigrun.sqlite`**". App C records "cross-process storage locking" as *not present* upstream, and nothing about whether pi-durable tolerates a second writer (or even a second connection) to its SQLite file — WAL/busy behavior, migration interplay, and `.backup` interaction with the new nightly CronJob are all unexamined. This follows ds41f's own suggested fix, so it is sanctioned direction, but it is exactly the class of upstream-behavior claim rev 3 elsewhere insists on naming for M1 (App B.15) and didn't.

**Fix:** add to App C named M1 verifications: "sigrun-owned tables coexisting in the harness SQLite (concurrent access, backup interaction) — or fall back to pi-durable documents for session-meta". Zero replanning cost now; real cost if discovered in M1 without a fallback named.

### N11 — P2: "accepted fields enumerated in the captured schema" misuses the captured schema

**Evidence:** §5 captured-schema paragraph: "the serialized `ConversationView`/**watch-frame shape** is captured from the pinned pi-durable version and committed in-repo as a type fixture" — an *output* contract. The `configure` bullet: "accepted fields enumerated in the captured schema" — an *input* contract. Configure's accepted fields do not appear in a view serialization; the fixture as defined cannot enumerate them.

**Fix:** widen the fixture definition to "view/watch frames **and the `configure()` accepted-field set**", or drop the claim and enumerate configure's v1 fields inline (model, thinking).

### Carried / minor (no new action beyond noting)

- ds41f P2 "Discord: root conversation vs honcho-only" — NOT FIXED; one line in §3.3/L5.
- glm P1-4 adapter-seam suggestion — not adopted; pinning + captured schema is an acceptable substitute, noted for the record.
- Terminology split: `/v1/sessions/:id/meta` amid `/v1/conversations/*` resources. Harmless but will confuse the first client implementer; consider `/v1/conversations/:id/meta`.
- App B.14 calls approvals "a first-class surface" while §2 keeps "nine surfaces" with approvals folded into Tools — cosmetic, self-consistent enough.

---

## Summary

Rev 3 is a genuinely responsive revision: **all six glm majors and all thirteen ds41f P0/P1s are fixed with real mechanisms, not wording** — storage got a design (§6.2), over-trust got converted into a named M1 verification battery with Appendix C as the record, approvals/multi-session/uploads/merge-semantics got actual contracts, and the deferrals (tokens, cost metrics, fallback provider) are stated as decisions with rationale rather than silence. The honest-verification culture (App C's "named M1 verifications") is the spec's best feature — which is exactly why N1 and N10 matter: they are the two places rev 3 *itself* asserts upstream behavior without entering it in its own ledger.

No P0s. The two P1s are both contract-completeness issues that implementation planning trips over immediately: the multi-session lifecycle rests on an unverified `createConversation()` (N1), and the §4.1 file browser has no §5 API (N2). Everything else is cheap consistency repair (N3–N9, N11).

Verdict: CHANGES-REQUIRED (minimum: N1 — add `createConversation()` + `abortSubmission` idempotence to App C named M1 verifications and the M1 battery; N2 — add workspace file list/read endpoints to §5 or move the file browser out of the ship-gate parity list; N3 — renumber duplicate §6.2; N4 — sync App B.10 with the pinned afterResponse choice; N6 — resolve the M2 soak-timing self-contradiction)