# Adversarial spec review — sigrun rev 3, angle: requirements coverage + user-intent fidelity

**Files read in full:** `CONTEXT.md`; `docs/superpowers/specs/2026-10-02-sigrun.md` (rev 3); the sibling fabric repo's spec (dependency claims); prior reviews `2026-10-04-sigrun-ds41f.md`, `2026-10-04-sigrun-glm53.md`. Repo is spec-only (no code) — no diff to review; grounding for hermes claims came from `~/repos/hermes-webui/static/*` and `api/`.

**Angle:** does rev 3 still deliver what CONTEXT.md promises, and did the review-driven edits weaken anything? Rev 3 is a large net improvement on rev 2 (12 of the 13 prior P0/P1 items are genuinely encoded — see "Rulings fidelity"). The residual defects are all of one kind: **capabilities the user named, or rev 3 itself lists as M2 features, that have no owner and no endpoint** — the same failure mode rev 2 was flagged for, in the three places rev 3's fixes did not reach.

---

## Correct

- **Two-gate structure now closes the rev-2 cutover contradiction.** §1.2 "Cutover gate (hermes → 0): memory + scheduled jobs + maintenance-task parity" is restated in §7 as "**Cutover gate (hermes → 0) = L1 + L3 both exited** (and L2 if daily research matters before decommissioning — expected, per CONTEXT §2)", plus "Lane independence is an implementation-order property; the *gate* is a property of the whole lane set." Exactly the requested fix.
- **Every rev-2 P0 has a real endpoint or a real decision behind it:** `POST/GET /v1/conversations` + `GET/PATCH /v1/sessions/:id/meta` (§5, App B.12); approvals row in §2 + `GET/POST .../approvals` (§5, App B.14); exact pin + captured schema fixture + `GET /v1/meta` fail-loud (§5, App B.16); cron panel → L3 (§4.1, §4.2, App B.17).
- **The M1 crash battery is now exit criteria, not prose** (§7 M1): "`kill -9` mid-streaming-generation … mid-tool-call … during background compaction … duplicate-`requestId` submit after crash … hook replay behavior observed and recorded in Appendix C". This is the strongest single addition in rev 3.
- **Appendix C's honesty discipline is preserved:** it explicitly separates verified ("live E2E through bifrost returned a committed answer") from "**Named M1 verifications (claimed in spec, not yet observed)**".

---

## Use-case coverage (CONTEXT §2) — owner audit

| CONTEXT §2 use case | Owner in rev 3 | Verdict |
|---|---|---|
| Research ("The most common use") | Lane L2 `sigrun-ext-web-research`, exit "go find out about X works from the composer" | **Owned**, but *after* the ship gate (§7: "A soak day in the webui follows the checklist pass… the daily soak follows L1+L2") |
| Research → work (Forgejo ticket → pi) | L4 "Cards + forgejo (gated on the fabric's T1)" | **Partially orphaned** — P1-3 |
| Steering coding from away | App A "sigrun only needs to surface the link (via Card's `claimed_by`)" → L4; no attention path | **Orphaned** — P1-2 |
| Routine maintenance ("wants *more* of this… calendar access, household context") | L3 "port the crontasks actually used" | **Narrowed to parity** — P1-4 |
| Ambient awareness (Discord) | L5, "channels as synthetic honcho peers, ingestion only", exit "discord digest works" | **Owned and bounded** |
| Memory (honcho parity "a v1 requirement, not an enhancement") | L1, "**first lane, user requirement**" | **Owned**; "v1" redefined to post-ship-gate by the authorized two-gate ruling (App B.1) |
| Household multi-user eventually | §5 "**Multi-user seam:** v1 is multi-session but single-user"; §8 "Multi-user UI in v1 (schema carries `owner`, §5 documents the seam)"; §4.4 "Later: in-app OIDC SP" | **Documented deferral, faithful** |

---

## P0 — blocks implementation planning

### P0-1. §4.1 ships a workspace file browser at the ship gate, and §5 has no contract for it

Evidence — §4.1 parity list: "Three-panel layout: sessions sidebar …, chat center, **on-demand workspace file browser right panel**." §5's v1 surface is an enumerated list (views/watch, conversations, session-meta, submissions, uploads, models, abort, configure, approvals, meta) — there is **no file list, read, or delete endpoint**; the only workspace-touching endpoint is one-way: "`POST /v1/conversations/:id/uploads` — materialize an uploaded file into the conversation's workspace … returns the workspace-relative path". §5 also states the shape rule that forecloses an unlisted route: "The sigrun server is a thin layer that authenticates (§4.4), serializes the native view/watch frames, and adds the few write endpoints clients need." The M2 exit checklist omits the panel entirely — "start/switch/archive a session; send text and an image; steer a running session; approve/deny a tool call; pick a model; read a tool card; theme switch; resume after a pod restart" — so it can silently vanish.

Why it blocks: M2's implementer cannot build the right panel, and the §4.3 audit cannot judge how much of `workspace.js` (a ~1500-line module: `/api/list`, `/api/file/read`, `/api/file/save`, `/api/git-info`, preview, escape grants) ports — the same "no contract to build against" failure rev 2 raised for cron and conversation creation. This is also the surface that makes "steering coding work" and "research → work" inspectable from a phone.

Smallest fix: add the read path to §5 (`GET /v1/conversations/:id/files?path=` and `GET …/files/content?path=`, executed through the conversation's ExecutionEnv so §3.4 remote workspaces stay correct) and add one checklist item ("open the workspace panel, read a file"); **or** cut the panel from M2 exactly as the cron panel was cut, and say so in §4.2.

---

## P1 — fix before/early implementation

### P1-1. §9's fabric claim is false, and L4's gate contradicts the sibling spec

Evidence — sigrun §9: "its honcho memory, webui, and cron extensions **exercise every object kind in the fabric except AgentProfiles**." The fabric spec says otherwise: §0.0 "Card and the other reserved kinds parked"; §2 "One is v1 (`Workspace`); four are **schema-reserved** (the fields exist, no behavior yet)"; §4 "Implementation is **deferred until after** the fabric + `fabric-workspace` deployment. **Do not implement Card from this document.**"; §9 "**T5 (deferred):** Card/skuld per the holding note". And sigrun's gate is wrong in the same direction: §3.3 "`sigrun-ext-kanban` … | Gated on the fabric's T1 |" and §7 "Lane L4 — Cards + forgejo (gated on the fabric's T1)". The fabric's T1 is "registry process + resolve endpoint + YAML watch + **Workspace kind only**".

Honcho memory, the webui, and cron touch *no* fabric kind (they are a memory backend, a UI, and `defineTask`s). L4 cannot exit at T1 because Card does not exist at T1.

Fix: rewrite §9 to "sigrun is the first consumer of the fabric's **Workspace** kind (via the §3.4 swap); Card consumption is blocked on the fabric's Card revival" and change L4's gate from "the fabric's T1" to "the fabric's Card kind (currently deferred to the fabric's T5)".

### P1-2. Away-from-desk steering — a stated must-have — has no attention path in any lane

Evidence — App A: "**Away-from-desk steering of pi coding sessions is a must-have**… *and* it already works via `herdr --remote` today; sigrun only needs to surface the link (via Card's `claimed_by`)." §4.1: "**Notification/push:** v1's only event channel is the §5 watch stream; push notifications are a later client concern. The audit treats hermes's service-worker/notification settings as out of scope (drop, don't port)." Combined with P1-1 (Card deferred), the use case has no owner: no lane produces the link, and nothing tells a user on a phone that pi is waiting.

Fix: either (a) add the link surface without the Card dependency — a v1 `GET /v1/conversations/:id/links` / card-URL field rendered in the webui — and name an owner for the notification (browser notification on completion via the existing watch stream, or an explicit §8 deferral "away-from-desk attention is unowned in v1; `herdr --remote` remains the path"), or (b) move away-from-desk steering out of Appendix A's must-have list and into §8 with the reason. Do not leave it owned by a lane that cannot exit.

### P1-3. "Research that turns into work" is bundled behind a deferred fabric kind it does not need

Evidence — CONTEXT §2: "If finding out about X reveals a tool to build or software to update, the assistant should open a ticket in Forgejo and hand the actual work to pi." §3.3 lists `sigrun-ext-forgejo` ("create repo, file issue, read PR") and `sigrun-ext-kanban` ("thin client over the fabric's skuld API | Gated on the fabric's T1") as **separate extensions**, but §7 merges them: "Lane L4 — Cards + forgejo (gated on the fabric's T1)". The Forgejo half has no fabric dependency whatsoever, yet it inherits the gate and therefore waits on the fabric's T5-deferred Card (P1-1).

Fix: split the lane — "L4a `sigrun-ext-forgejo` (no fabric dependency; exit: 'turn this into a ticket' from the composer)" and "L4b `sigrun-ext-kanban` (gated on the fabric's Card kind)".

### P1-4. Routine maintenance was narrowed from "wants *more*" to "port what's used", and the two named chores lost their owner

Evidence — CONTEXT §2: "**Routine maintenance.** Existing cron jobs performing household and self-hosted-service maintenance. **The user wants *more* of this and keeps not getting to it — calendar access, household context, and similar assistant-ish chores.**" Rev 3: §7 L3 "`sigrun-ext-cron`: **port the crontasks actually used**", exit "scheduled jobs and maintenance-task parity". Calendar and household context appear nowhere in §3.3, §7, or §8's "What sigrun does not do".

Fix: one line in §3.3 or L3 ("calendar access and household context are L3 follow-ons; no owner yet") or one line in §8 ("calendar/household-context tools are deferred; the seam is a new tool extension"). CONTEXT names them explicitly; the spec currently drops them silently.

### P1-5. The workspace picker is the exact defect the user ruled against for the persona picker

Evidence — §4.1 composer footer: "model picker (fed by provider contributions, §3.2), **workspace picker**, context-usage ring." §3.4 day 1: "`workspaceService` is static config (`{ defaultWorkspace: { type: \"local\", path: \"/home/sigrun\" } }`)." §5 exposes no workspace-list endpoint. The user's ruling dropped the persona picker for precisely this reason (§4.2: "Persona/profile picker: v1 is a single persona (`SOUL.md`). Per-conversation persona selection (directory convention + picker) is a later lane") — yet the same-shaped workspace picker survived into M2, where it will render a list of one.

Fix: apply the user's own ruling symmetrically — "workspace picker: v1 is the static `defaultWorkspace`; a picker is a later lane (with the workspace swap, §3.4)". One line in §4.2.

### P1-6. The ship-gate checklist omits a capability §1.2 promises at the ship gate

Evidence — §1.2: "Ship gate (v0): functional webui over the durable harness, at *hermes-with-nothing-enabled* parity: chat, model selection, durable resumable sessions, context files, **degenerate memory** and context management." §7 M2 exit checklist has nine items and **no memory item** — "start/switch/archive a session; send text and an image; steer a running session; approve/deny a tool call; pick a model; read a tool card; theme switch; resume after a pod restart." Degenerate memory is the one capability in §1.2's ship-gate sentence with no corresponding observation, so the thing that must work for a stranger's sigrun (recall over full entry history, including compaction-dropped entries, per §2/§3.3) is untested at the gate that ships it.

Fix: add one checklist item — "ask a question whose answer was compacted out of the live window; `recall` returns it" — and one for the workspace panel if P0-1 is resolved by adding the contract.

---

## P2 — report-only

- **Review-added M2 scope: the surface-visibility view.** §4.1: "**Surface visibility:** what's enabled per conversation (pi-durable stores extension selection in `pi.agent`). v1: static deploy-time view; a picker is later." No user request, no §5 endpoint, and it is the third "view over a singleton" in §4.1. Fix: cut to a `GET /v1/meta`-derived read-only badge or defer it with the picker.
- **Review-added M2 scope: the piclaw half of the audit.** §4.3 gate now audits two codebases plus "render-code coupling". App B.9 records it, but the user authorized a port of hermes-webui; piclaw is a review addition inside the same 4-hour box. Fix: keep, but state it is pattern-reference only (as §4.3 already half-says) and that a piclaw finding cannot flip the port/rebuild decision by itself.
- **§1.2's daily-surface claim vs the M2 parenthetical.** §1.2: "the webui can be the daily surface well before hermes scales down"; §7 M2: "the daily soak follows L1+L2, which restore the two functions the user actually lives in: memory and research." Both can be true only if L1+L2 land promptly; the checklist framing invites M2 to be read as the daily-driver gate. Fix: one clause — "the ship gate is a milestone, not the daily-driver gate; daily driving begins after L1+L2."
- **Duplicate section number.** §6.2 is used twice: "### 6.2 Storage safety and backup" and "### 6.2 Dependencies (already deployed, consumed by extensions)". Fix: renumber the second to §6.3.
- **`source: user|cron` is a dead field until L3.** §5 session-meta carries "`source`: `user|cron`", but App B.17 moved cron to L3. Harmless; note it as intentional schema-ahead-of-behavior (same class as `owner`).
- **Imprecise citation for the gateway-only policy.** §3.2: "an accepted consequence of the gateway-only policy (CONTEXT §4)". CONTEXT §4's actual text is "**Provider management.** Bifrost already routes models with virtual keys, budgets, and failover chains. Sigrun points at one VK." The gateway-only policy comes from the hermes config history, not CONTEXT §4. Fix: cite §4 without the quotation-style attribution, or restate the policy inline.
- **Ambiguous sentence in §5.** "Deliberately not exposed in v1: fork, reset, task graph, per-task control. They exist upstream; the webui grows UI for them before they ship." Reads as "UI before endpoints", contradicting "not exposed in v1". Fix: "the webui grows UI for them only when the endpoints ship."

---

## Rulings fidelity (post-review user decisions)

| Ruling | Encoded? | Evidence |
|---|---|---|
| Trust boundary documented, tokens not day 1 | **Faithful, not over-applied** | §4.4 "the API never accepts or returns credentials"; "**Bearer tokens (seam, not day 1)**… Implemented when the first non-browser client lands; not in the MVP" |
| Uploads/images important | **Faithful** | §5 uploads endpoint + content parts; §4.1 "Image/file uploads"; App B.5 (live image probe) + B.23 |
| Persona picker dropped | **Faithful; persona NOT dropped** | §4.2 drops the picker; §2 keeps "`SOUL.md` → persona section" as a live core surface. No orphaned picker reference remains in §4.1. (But see P1-5 — the workspace picker survived the same test.) |
| Ops hygiene wanted | **Faithful** | §6.1 quarantined extensions surfaced via `GET /v1/meta`, "wedged-state gauges: oldest in-flight submission age, and oldest waking task age"; §2 "never aborts `Harness.open()`" |
| No cost accounting | **Faithful** | App B.20 "cost-accounting metrics excluded (inference pricing is unstable; revisit when it matters)"; §5 view keeps `usage` without adding a metrics surface |
| Fabric work out of MVP | **Encoded, but leaves dangling claims** | §3.4 "Ship gate ships with the static version"; App B.20 "fabric-adjacent work (workspace swap, kanban, remote skill discovery) stays out of the MVP". **But** §9 overclaims and L4's gate is wrong — P1-1 |
| Fallback provider = separate future extension | **Faithful** | §3.2 "deliberately **not** in the MVP; if bifrost is down, sigrun is down… It can be built any time as just another contributor" |

---

## Ship gate / cutover gate judgement

- **Ship gate checklist (M2 exit):** covers sessions, image send, steer, approvals, model pick, tool cards, themes, restart-resume. It is honest about memory and research being absent — the parenthetical "the daily soak follows L1+L2, which restore the two functions the user actually lives in" names the gap and its rationale explicitly. Missing items: degenerate memory (P1-6), the workspace panel (P0-1). Everything else the user does daily (research, honcho memory, cron, agentic maintenance) is a lane with a stated exit — acceptable for a *ship* gate.
- **Cutover gate:** "L1 + L3 both exited (and L2 if daily research matters before decommissioning — expected, per CONTEXT §2)" is a defensible reading of "hermes scales to 0" as the user would judge it, and it now names memory explicitly. Two caveats: L1's exit is "what did we discuss about X last week works; search works from the composer" (behavioral, good) while L3's is "scheduled jobs and maintenance-task parity" (a bare parity claim with no observation — add one concrete job and one concrete maintenance action); and P1-1/P1-2 mean the away-from-desk and research→work must-haves are not covered by either gate.

---

## Scope drift

No user-unauthorized *architecture* was added. Every rev-3 addition traces to App B.12–B.23 and 11 of 13 are load-bearing (session-meta, approvals, uploads, storage safety, crash battery, version pinning, trust boundary, meta/quarantine, cron-panel move). The two that add M2 *work* without user authorization are the surface-visibility view (§4.1) and the piclaw/render-coupling audit expansion (§4.3) — both P2 above, both cheap to keep or cut. The one *removal* that should be checked with the user rather than assumed: notifications (P1-2), because it silently de-owns a must-have use case.

---

Verdict: CHANGES-REQUIRED (minimum: P0-1 workspace file-browser contract in §5 + checklist item, or drop the panel; P1-1 correct §9's fabric claim and L4's gate (Card is fabric-T5-deferred, not T1); P1-2 give away-from-desk steering an attention/link owner or an explicit §8 deferral; P1-3 split L4 so `sigrun-ext-forgejo` is not gated on the fabric; P1-4 owner or deferral for calendar/household context; P1-5 apply the persona-picker ruling to the workspace picker; P1-6 add the degenerate-memory item to the M2 checklist)