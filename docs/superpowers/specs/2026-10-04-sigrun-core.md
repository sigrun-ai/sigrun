# Sigrun Core: a pi-durable assistant anyone can run

**Status:** Draft v1 (restructured from rev 3 of `2026-10-02-sigrun.md` — see that file for history)
**Date:** 2026-10-04
**Scope:** the core — harness, webui, surface contracts, degenerate defaults. **No external
service dependencies.** A stranger with Node and one OpenAI-compatible endpoint can run this
and it is worth releasing publicly.
**Sibling specs:** `2026-10-04-sigrun-hermes-replacement.md` (extensions that restore hermes
parity and scale hermes to 0), `2026-10-04-sigrun-improvements.md` (capabilities hermes never
had, incl. the-work-fabric-scrubbed).
**Context:** `CONTEXT.md` explains why sigrun exists; this spec is the *what* for the core.

---

## 1. What this is

Sigrun is a **pi-durable harness with a webui and a small set of task extensions**, not a
monolith. The core is: the harness process, the webui, the surface contracts (§3), and
degenerate defaults for every surface. The core contains no model-provider code, no memory
backend, no scheduled-job definitions, no integration tools. Every capability beyond the
degenerate defaults arrives as an extension package (specs B and C own the ones we build).

Design test: **a stranger downloads sigrun, sets three env vars (`OPENAI_BASE_URL`,
`OPENAI_API_KEY`, `SIGRUN_MODEL`), and has a working durable chat assistant with a webui.**
Its absence-of-extensions behavior is a feature, not a missing-feature state.

### 1.1 Two gates

- **Ship gate (v0, end of M2):** functional webui over the durable harness at
  *bare-harness parity* — chat, model selection, durable resumable multi-session history,
  context files, degenerate memory, context management, approvals, uploads. The gate is a
  concrete checklist (§7 M2), not a vibe.
- This core spec has **no cutover gate** — scaling hermes to 0 is spec B's business.

### 1.2 Decoupling boundary

| Layer | Owner |
|---|---|
| Conversation runtime (durable, resumable) | `@earendil-works/pi-durable` (upstream) |
| Everything in this spec — harness process, webui, surface contracts, degenerate defaults | **sigrun core** |
| Extensions (providers, memory backends, tools, jobs, channels) | specs B and C |

If every extension vanished, the core still runs. That is the test.

---

## 2. Core principles

- **Minimal core, thin contracts, degenerate defaults** — pi's philosophy, applied: the core
  owns three extension-contributed contracts (skills, memory, provider-contributor) and code
  (not contracts) for workspace resolution and context policy. Everything else is
  pi-durable surface used directly.
- **Honest verification ledger.** Every upstream-behavior claim is either in the Appendix C
  verified list or in the named-M1-verifications list with a fallback. Nothing is asserted
  in prose alone. (This rule was adopted after review; it is binding.)
- **Fail loud.** Schema-version mismatch refuses to render; unknown model ids 4xx with the
  available list; a failing extension is quarantined and surfaced, never silent.

---

## 3. Surface contracts

The core defines one named interface per capability surface. Extensions plug into these;
nothing else is coupled. "Inventor" = who defines the interface; "Degenerate default" = what
runs with zero extensions.

| Surface | Contract | Inventor | Degenerate default |
|---|---|---|---|
| **Tools** | pi-durable `defineTool` — TypeBox schema, `replay: "safe"/"unsafe"`, per-call ExecutionEnv | upstream | none needed |
| **Approvals** | pi-durable `beforeTool` hook: block/allow/await. **Verified upstream (2026-10-04, App C): a blocked call can durably await an external decision across crash+restart via `api.memo`.** Decisions are stored in the hook's durable memo *before* acting, so a crash between "user clicked allow" and "tool ran" never re-prompts or re-executes | upstream mechanism | core approvals extension: write/exec tools prompt, read-only tools pass; policy in a per-conversation document; decision enum `allow \| deny`; **aborting a submission auto-denies that submission's pending approvals** (memo reason `aborted`) — v1 exposes only per-submission abort (§5), so that is the trigger; a conversation-level abort rule lands with the jobs lane |
| **Skills** | `skills/` in the conversation workspace; SKILL.md frontmatter (agentskills.io shape); rendered as a prompt section + a `load_skill` tool. **The skill-section loader and the `load_skill` tool are core-owned code, not an extension** — extension quarantine (boot order, below) applies only to extension-contributed surfaces | **sigrun convention** | directory scan; empty = none |
| **Memory** | one interface: **`MemoryBackend { observe(record), recall(query), section() }`**. Observe rides `GenerationHooks.afterResponse` (intended: single fire per turn; replay-guard via durable memo keyed by generation id — the hook's re-fire behavior on replay is a named M1 verification that determines the guard's final design, App C). **Design assumption pending the App C verification:** `afterResponse` fires on the assistant response and its payload gives access to the user submission the turn answers (if it does not, a paired user-side capture point is the named fallback). The record's `role` field distinguishes the two; both roles are observed — a steered/queued submission that interrupts a turn is observed as its own user-role record when that turn is answered (multi-user-input turns produce multiple user records). The degenerate backend's observe records exist for **schema stability** (spec B maps the same shape onto honcho observations); degenerate `recall` does not read them — it is backed by `conversation.entries()` (paginated full-history query; whether compaction-dropped entries are reachable is a named M1 verification, App C, currently docs-sourced). `section()` injects the memory block | **sigrun contract** | `MemoryBackend` over harness entries; `section()` emits a stable placeholder ("long-term memory backend not configured") so the prompt surface is identical across configurations |
| **Context management** | pi-durable's compaction task: policy (`reserveTokens`, `backgroundTokens`) in core settings; `CompactionHooks.beforeCompact` may decline/replace the summary; summarizer model choosable per policy | upstream + sigrun policy | pi-durable defaults, tuned (§3.1) |
| **Context files** | section loaders keyed by convention: `SOUL.md` → persona section, `AGENTS.md` → per-workspace instructions, read via the conversation's ExecutionEnv. **A missing file is an empty section, not an error** — a fresh deployment boots cleanly | upstream sections | present |
| **Model providers** | **provider-contributor contract**: an extension may contribute `createProvider()` results (pi-ai) + a default model at boot; core merges contributions into one `Models` store before `Harness.open()`. Merge semantics: deterministic, last-registered wins on id collision, collisions logged (never silent); `SIGRUN_MODEL` env overrides any contributor default; a conversation pinned to an unserved model id fails explicitly at submit (4xx + available ids) | **sigrun contract** | env-driven OpenAI-compat provider |
| **Channels** | clients of the §5 API. Webui, CLI, Discord — all equal clients; no in-process privilege. **Channel bundles are deploy-time clients, not extensions** — they contribute nothing to conversations and are never quarantined; the core serves a deployed channel's static assets as a convenience, and a deployment with no webui bundle serves the §5 API only (a TUI is the reference second client) | §5 API | webui when deployed, else API-only |
| **Scheduled jobs** | pi-durable `defineTask` state machines; `runtime.sleep(until)` is a durable wait (survives restart, rechecks the harness clock); `watchDoc` for event-driven wake | upstream | none |
| **Workspace** | `HarnessOptions.env` → the `workspaceService` wrapper (§4.5) | sigrun wrapper | static local path |

Each surface's contract owner above is also that surface's
**health producer**: a contract whose implementation can fail at runtime exposes
`health(): "ok" | "degraded"` alongside its operational methods (memory backends and
provider contributors implement it in v1; degenerate implementations always report
`"ok"`). Core aggregates these into the §5 meta `health` block.

Boot order: load configured extensions → collect provider contributions (plus the env
default if none contributed) → `Harness.open(models, registry)` → `resume()`. A failing
extension at boot is **quarantined** (logged, surfaced as a degraded surface via
`GET /v1/meta`), never aborts `Harness.open()` — chat survives a bad extension release.
`GET /v1/meta` `capabilities.channels` reports which channel bundles are deployed (§5).

### 3.1 Context-management tuning (v1 defaults)

- Background compaction on, tuned values chosen in M1 against the default model's window.
- The summarizer model is a policy decision: core pins it to the cheapest long-context
  model available from the provider contributions (configurable).
- Richer strategies (vcc-style) are spec C.

### 3.2 Skills convention (v1 scope, exact)

- Discovery: local workspace root only (`skills/`); remote-workspace skill discovery is
  post-the-work-fabric-scrubbed (spec C).
- Frontmatter: `name`, `description` required; all other fields ignored in v1.
- Section: name + description only, capped at 4KB total with truncation notice.
- `load_skill(name)` returns the SKILL.md body; unknown name = explicit error.
- Collision (two skills, same name): last-wins, logged.
- Non-SKILL.md files in a skill directory are ignored in v1.

---

## 4. Architecture

### 4.1 Process layout

One Deployment, single replica, **one container**: the sigrun process runs the harness,
serves the §5 API, and serves any deployed channel's static assets (§6). Extensions are configured at boot
(deploy-time list in a ConfigMap; pi-style package.json, not runtime plugin management).

**Extension-selection semantics (v1):** the boot list is **global** — every conversation
uses the deployment's configured set. Conversations store extension names so that a
*resume after the set changed* degrades gracefully: a resumed conversation referencing a
removed or quarantined extension resumes with that surface's degenerate default; the name
is preserved so re-enabling restores it without a transcript migration. (The storage key —
believed to be the conversation's `pi.agent` state from the superseded spec — is a named
M1 verification, App C.) There is **no v1 endpoint that changes a conversation's
extension set** — per-conversation selection is spec C lane C6b (which requires a core
revision). Consequence for spec B: `sigrun-ext-honcho` replacing the degenerate memory
backend is a **global, boot-time** replacement; existing conversations pick it up on
their next turn (the degenerate backend is stateless across turns — its observe records
exist for schema stability, not as state to migrate). **Accepted:** turns observed before
the honcho extension first lands are never backfilled into honcho — honcho memory starts
from its deployment date; degenerate `recall` still covers earlier turns from
`entries()`.

### 4.2 Upstream dependency policy

`@earendil-works/pi-durable` is pinned to an exact version in `package.json` (no ranges).
All upstream contact goes through the §3 contracts; the serialized view/watch shape is
captured in-repo as a type fixture (§5), so upstream drift is a test failure, not a runtime
surprise. Upgrade procedure: read changelog → snapshot the sqlite file → upgrade on a
scratch copy → verify `resume()` + view serialization + the crash battery → deploy.

### 4.3 Storage

- **Conversation SQLite on local-block storage, not NFS.** SQLite's WAL/shared-memory
  semantics assume local disk semantics; NFS is a documented corruption hazard. Local-path
  provisioner, iSCSI-backed block PVCs, and hostPath all satisfy this — the requirement is
  *block-like semantics*, not a specific provisioner. Workspace artifacts (which reach tools
  through the ExecutionEnv, not the sqlite) are free to live on NFS.
- **Journal mode** pinned per pi-durable's storage default, confirmed in M1 and recorded in
  Appendix C.
- **Backup is an optional capability.** The contract is: *when* backup is configured,
  it is nightly `sqlite3 .backup` (consistent against a live WAL database) to a
  pluggable target — S3-compatible object store or a mounted path — with retention ≥ 30
  days, and a restore drill in M1's exit criteria. When it is **not** configured, sigrun
  runs fine and says so (an unconfigured-backup badge in `GET /v1/meta`, not an error).
  The backup CronJob carries the Deployment's node placement constraints (a node-bound
  local-path PVC hangs a naive CronJob in Pending; block-backed PVCs don't have this
  constraint) and an image containing `sqlite3` + the target's client. Target credentials
  are **core** secrets, not extension secrets. **Taking the backup against the live harness
  is a named M1 verification** (App C) — the CronJob is a second process touching the
  sqlite file, exactly the class of assumption the ledger rule covers.

### 4.4 Deployment (chart)

Chart name: **`sigrun`**. The chart is the reference deployment; the core itself (Node +
harness + webui) runs anywhere Node does. Portable requirements:

- Deployment: single replica, one container, `Recreate` strategy (the sqlite PVC is RWO —
  a RollingUpdate would deadlock two pods on one volume).
- Storage per §4.3: sqlite on block-like storage; workspace artifacts volume optional.
- Service: ClusterIP; how the webui is reached (ingress, Tailscale LB, port-forward) is a
  deployment choice, not a core contract.
- Observability: a health/metrics surface that distinguishes process-up from
  harness-ready (storage writable + resume complete + extension boot outcomes), plus
  wedged-state gauges (oldest in-flight submission age, oldest waking task age — stuck
  `runtime.sleep`/`watchDoc` becomes an actionable alert instead of a silent stall).
- Secrets: env-injected for whatever the enabled extensions need, plus core backup
  credentials when backup is configured. Extensions are trusted code with no capability
  isolation — every enabled extension can read every env secret. Accepted for v1
  (single-user, single trust domain).

**Appendix D** carries one concrete homelab instantiation of this chart as an example.
Public-release users write their own values against this section, not Appendix D.
**A deployment that skips the optional backup has zero disaster copies of transcripts** —
if the storage backend is lost, conversation history is gone. That is an accepted
deployment choice (the badge keeps it visible), not a supported-recovery posture.

### 4.5 Workspace resolution

The harness's `env()` builder — what pi-durable calls per tool call to produce an
`ExecutionEnv` — is a thin wrapper:

```typescript
const env = await workspaceService.forConversation(conversation, defaultPrefs);
```

Core ships the static version (`{ defaultWorkspace: { type: "local", path: "/home/sigrun" } }`).
Dynamic resolution through the the-work-fabric-scrubbed registry is a wrapper swap (spec C); the signature
doesn't change.

---

## 5. API surface (what clients talk to)

**Shape: serialized native views, not a bespoke endpoint list.** pi-durable's
`ConversationView`/`watch()` are designed for UI clients ("everything a UI needs is
committed state"). The sigrun server authenticates (network perimeter = trusted principal
for self-hosters, §6.4; bearer-token layer reserved as the seam for the first non-browser
client — not day 1), serializes the native view/watch frames, and adds the write
endpoints below.

v1 endpoints:

- **Views + watch frames** over SSE — the native `ConversationView` (transcript, streaming
  answer, running tools, queued submissions, pending approvals, agent, usage) serialized
  per the captured schema; includes a per-conversation `steer` field reflecting
  submit-while-busy queue semantics. **Reconnect contract:** a client that reconnects
  passes its last-seen cursor and receives a fresh snapshot plus missed frames — no lost
  state across transport drops. Whether upstream `watch()` replays exactly this shape is
  a named M1 verification (App C; fallback: sigrun serves its own per-conversation ring
  buffer).
- `POST /v1/conversations` — create a conversation (upstream `createConversation()`,
  type-verified); `GET /v1/conversations` — list with session-meta. v1 is
  multi-**session**, single-user; the root conversation is the default.
- `GET /v1/conversations/:id/meta` / `PATCH` — session metadata:
  `pinned: bool`, `tagged: string[]`, `archived: bool`, `draft: { text: string,
  attachments: string[] }`, `source: "user" | "cron"`. Field types as listed; PATCH is a
  merge, explicit `null` clears a field. `draft.attachments` are workspace-relative paths
  from the uploads endpoint (the attachment tray survives a reload). ("session" ≡
  conversation; one resource, one path.)
- `POST /v1/conversations/:id/submissions` `{ input, requestId }` — **content-part
  schema:** `input` is an array of parts, each `{ type: "text", text: string }` or
  `{ type: "image" | "file", path: string, mime?: string }` with `path` workspace-relative
  (from the uploads endpoint). **The server resolves path-parts to inline content
  (base64 for images, text for files) at submit time** — the verified upstream path — via
  the conversation's ExecutionEnv; a missing path yields an explicit error part, never a
  silent drop. `requestId` makes duplicate submission idempotent (verified: API present;
  **crash-replay semantics are a named M1 verification**). Submitting while busy queues the
  input (queue semantics also verified in M1).
- `POST /v1/conversations/:id/uploads` — materialize an uploaded file into the
  conversation's workspace; returns the workspace-relative path. v1 writes via the
  resolved workspace path (static workspace makes this exact); the ExecutionEnv write
  primitive is type-verified (`FileSystem` in `env/index.d.ts`) and used once verified.
- `GET /v1/conversations/:id/files?path=` — list a workspace directory;
  `GET /v1/conversations/:id/files/content?path=` — read a file (text; binary via base64
  with a size cap). Read-only in v1 (no edit/save). Served through the conversation's
  ExecutionEnv so remote workspaces stay correct.
- `GET /v1/models` — the merged provider-contribution catalog.
- `POST /v1/conversations/:id/abort` — `abortSubmission` (per-submission, idempotent —
  idempotence type-verified, behavior named in M1 verifications); conversation-level abort
  not exposed in v1.
- `POST /v1/conversations/:id/configure` — model/thinking changes via `configure()`
  (type-verified); v1 accepts exactly `model` and `thinking`.
- `GET /v1/conversations/:id/approvals` + `POST .../approvals/:approvalId`
  `{ decision: "allow" | "deny" }` — pending approvals surface in the view; decision via
  endpoint; terminal state delivered via the watch stream. The approval **policy**
  (per-conversation document, §3) is fixed to the conservative default in v1 with no
  read/write endpoint; policy configurability is spec C lane C9.
- `GET /v1/meta` — `{ harnessVersion, schemaVersion, extensions: [{name, status}],
  health: { backup: "configured" | "unconfigured" | "degraded", memory: "ok" | "degraded",
  providers: "ok" | "degraded" }, capabilities: { backup: bool, channels: string[] } }`.
  `capabilities.channels` lists the deployed channel bundles (§4.1, §6) — `"webui"` when the
  reference webui is deployed, absent when the core serves the API only. A TUI or Discord
  client reads §5 over the network and never appears here (it is not server-deployed).
  `schemaVersion` hashes the captured fixture (upstream drift bumps it before any sigrun
  release); the webui refuses to render on mismatch. `extensions[].status` surfaces
  quarantined (boot-failed) extensions; the `health` block surfaces runtime-degraded
  surfaces (unreachable memory backend, provider outage) and the
  unconfigured-backup badge (§4.3); `capabilities` lets clients hide affordances whose
  backing capability is absent.

**Captured schema:** the serialized view/watch shapes **and the `configure()` accepted
field set** are captured from the pinned version and committed in-repo as type fixtures.

Not exposed in v1: fork, reset, task graph, per-task control, `GET /v1/jobs` (that ships
with the scheduled-jobs lane in spec B). The webui grows UI for these only when the
endpoints ship.

**Multi-user seam:** v1 is multi-session but single-user. v2 adds a user→conversation
mapping, per-user auth, and an `owner` dimension on the meta resource. The `owner` field
exists in schema from day 1; the flow does not.

---

## 6. The webui

The flagship channel — but a **channel**, not a required core component. The webui is the
reference channel bundle; a deployment with no webui bundle serves the §5 API only, and a
TUI or any other client consumes the same endpoints. **Goal: hermes-webui's UX,
shamelessly, rebuilt as a thin client.**

### 6.1 Feature list (ship gate)

- Three-panel layout: sessions sidebar (pinned/tagged, `⋯` menu), chat center,
  on-demand **workspace file browser** right panel (list/read; hermes's preview polish can
  trail).
- Composer footer: model picker, context-usage ring. **Picker convention: a picker renders
  only when its list has more than one item** — applies to workspace (and later persona)
  pickers, so day-1 single-workspace deployments hide it and the the-work-fabric-scrubbed era shows it.
- Tool-call cards, expandable, streamed; **approval cards** for write/exec tool calls.
- Image/file uploads (composer attachment path).
- Light/dark + accent theme system.
- Per-session persistent composer draft.
- "Steer" — injecting text into a running session (submit-while-busy).
- Surface visibility: the enabled extension set, rendered from `GET /v1/meta`
  (read-only badge). v1's extension set is global (§4.1), so the badge is per-deployment;
  a per-conversation view arrives with the spec C selection lane.
- v1's only event channel is the watch stream; push notifications are a later concern. The
  audit treats hermes's service-worker/notification settings as drop-don't-port.
- No cron panel at the ship gate (no jobs surface exists until spec B's lane lands).

### 6.2 What to explicitly drop

- The backend entirely (no Python, no second agent loop).
- Provider/credential management UI (provider extensions own that; the surface is the model
  picker).
- Profile `.env` management (hermes-profile commedia-toolsity — dead).
- Runtime plugin management UI (deploy-time extension list).
- Persona/profile picker (v1: single `SOUL.md` persona; per-conversation selection is spec C).
- Notification service-worker and settings.
- Cron management panel (spec B).

### 6.3 Stack decision — port, with a concrete gate

**Decision: port hermes-webui's frontend.** It is Python + vanilla JS (~170KB of
framework-free code). The Python backend is replaced by the §5 API; the JS is kept where
its API calls allow.

Gate: the ship-gate milestone begins with a **4-hour audit** of hermes-webui's frontend
(JS/HTML/CSS only — no Python is ever ported), with `rcarmo/piclaw` (MIT) consulted as a
*pattern reference only* (same webui-over-agent shape; a piclaw finding cannot flip the
port/rebuild decision by itself).

Threshold: **more than 60%** of hermes-webui's frontend reusable as-is (API calls replaced,
layout/session/theme logic intact) → port. At or below 60% → **rebuild**: TypeScript +
React against the §5 API. If the audit lands ≤60%, M2 is re-baselined before work starts.

The audit must also measure **render-code coupling**, not just layout/theme reuse: message
renderers coupled to hermes's message shape do not port regardless of layout percentage.
Record per subsystem what survives unchanged vs what re-keys to the §5 schema.

### 6.4 Trust boundary

- The network perimeter (tailnet/ingress) is the trusted principal for the reference
  deployment; sigrun assumes a single authenticated user behind it. The API never accepts
  or returns credentials.
- **Bearer tokens: seam, not day 1.** The server reserves a bearer-token layer (tokens
  from a secret, one per client — webui, CLI, future bots) implemented when the first
  non-browser client lands.
- Multi-user: in-app OIDC SP is a later spec (spec C).

---

## 7. Milestones

### M0 — pre-flight (½ day)
- Root repo layout: `package.json`, `docs/`, `src/harness/`, `src/extensions/`, `src/webui/`
- (Provider-API and approvals-mechanism verification are done — App C, 2026-10-04.)

### M1 — Core skeleton (3–4 days)
- `Harness.open` over SQLite on block-like storage per §4.3, `resume()` on start
- Provider-contributor contract + env-driven degenerate provider
- Skills convention skeleton (§3.2 scope exactly)
- Context files (`SOUL.md`, `AGENTS.md`) as sections (missing = empty)
- `MemoryBackend` with the degenerate implementation (recall over `entries()`, observe
  hook writing per-turn records: `{conversationId, generationId, role, text, timestamp}`)
- Approvals extension: conservative default policy, durable memo decisions, abort-denies
- Context-management defaults (§3.1), summarizer pinned to cheapest available
- Static `workspaceService`
- §5 server: the full v1 endpoint list incl. files list/read, uploads, approvals, meta
- **Backup CronJob + restore procedure (§4.3) — when backup is configured.** The reference
  deployment (Appendix D) configures it; the restore drill runs there. For the
  public-release verification path (no Appendix D), M1 runs the same drill against a
  scratch mount on any block-backed volume.
- Deployment on the target platform
- **Crash-verification battery (exit criteria, not optional):**
  1. `kill -9` mid-streaming-generation → restart → answer completes **or** is marked
     aborted; no duplicate final answer.
  2. `kill -9` mid-tool-call → **safe** tools may re-execute; **unsafe** tools must NOT
     silently re-execute (parked with visible state, or failed with visible state); the
     memo records the outcome. Recorded in Appendix C.
  3. `kill -9` during background compaction (forced via a tiny `reserveTokens`) →
     `resume()` succeeds; no half-written summary entry; all previously-committed turns
     intact (losing the in-flight turn is acceptable); view serializes; subsequent submits
     succeed.
  4. Duplicate-`requestId` submit after crash → single completion.
  5. Submit-while-busy → queued/steered behavior observed and recorded.
  6. Hook re-fire behavior on replay observed and recorded (determines the observe-guard).
  7. `kill -9` a task mid-durable-`sleep(until)` → restart → the task wakes at (or after)
     the deadline **exactly once** — no double-fire, no missed wake. (CONTEXT App A makes
     scheduled-job durability a hard constraint; `defineTask`/`sleep` are type-verified
     only until this runs.)
- **Exit:** text assistant reachable via curl; pod restart resumes; **restore from the
  nightly backup resumes (in the reference deployment, which configures backup)**;
  provider arrived via extension contract; the battery passes with recorded outcomes.

### M2 — WebUI → **SHIP GATE** (2–4 days)
- Step 0: §6.3 audit (4 hours), records port/rebuild; re-baseline if <60%
- Port or rebuild against §5 per that choice
- Three-panel layout, composer footer, tool cards, context ring, themes, model picker,
  approval cards, uploads, workspace browser (read-only)
- **Exit (ship gate) — the checklist, all items pass with no fallback:**
  1. Start a second session; switch between sessions; archive one.
  2. Send a text message; send an image.
  3. Steer a running session.
  4. Approve a write/exec tool; deny a write tool; see the denial reflected.
  5. Pick a model from the catalog.
  6. Read a tool card (expand, see output).
  7. **Ask about something compacted out of the live window; degenerate `recall` returns
     it.**
  8. Open the workspace panel; list a directory; read a file.
  9. Switch theme.
  10. Restart the pod mid-conversation; resume and continue.
  11. Confirm degraded surfaces appear in `GET /v1/meta` (unconfigured backup in the
      public-release verification deployment; injected failure of one surface in the
      reference deployment).
- A daily-soak period follows **after spec B's B1+B2 restore memory and research** — the
  ship gate is a milestone, not the daily-driver gate. Gaps found in soak are filed and
  fixed before any cutover (spec B's gate).

**Estimates:** M0–M2 ≈ 6–9 days focused work.

---

## 8. What the core does not do

- No coding-agent work (pi + herdr own that).
- No multi-user auth (seam documented, §5).
- No voice/TTS.
- No external service integrations — those are extensions (specs B/C).
- No push notifications.
- No cost-accounting metrics (deliberate; revisit when pricing stabilizes).

## 9. Relationship to the sibling specs

Spec B (`2026-10-04-sigrun-hermes-replacement.md`) builds the extensions that restore
hermes's used functionality on top of these contracts and retires hermes. Spec C
(`2026-10-04-sigrun-improvements.md`) builds what hermes never had. Neither can change the
§3 contracts without a core spec revision; both consume them as-is.

---

## Appendix A — constraints from the design conversation

- Grow toward multi-household use; day 1 is single-user.
- The webui is the primary surface — including from a phone; how the phone reaches it is a
  deployment detail, not a spec concern.
- Scheduled jobs must be crash-durable.
- Keep pi's philosophy: minimal core, well-defined interfaces, extension ecosystem.
- Away-from-desk steering of *coding* sessions already works via `herdr --remote`; sigrun's
  job there is only to surface the link (spec C, the-work-fabric-scrubbed-dependent).

## Appendix B — decision record (inherited from rev 2/3 + restructure)

The full numbered decision record lives in `2026-10-02-sigrun.md` Appendix B (decisions
1–23). Restructure decisions (2026-10-04):

24. **Three-spec split** (user): core (this spec, publicly releasable, zero external
    deps) / hermes-replacement (parity extensions + cutover) / improvements (post-hermes
    capabilities incl. the-work-fabric-scrubbed). The 2026-10-02 spec is superseded by the three.
25. **Workspace browser kept at the ship gate** (user): read-only v1 (list/read via
    ExecutionEnv); hermes's edit/save path deliberately out of scope. LoE ~0.5–1 day.
26. **Picker convention** (user): hide when the list has one item, show when more —
    replaces "drop the picker" for workspace; persona picker remains spec C.
27. **Away-from-desk steering needs no new surface** (user): the webui on mobile is the
    away surface; the deepseek-review "no attention path" finding is dissolved; transport
    is deployment.

## Appendix C — verification record

**Probes performed 2026-10-04** against `@earendil-works/pi-durable@1.0.2`,
`@earendil-works/pi-ai`, Node 26. **M1 battery outcomes are recorded in this appendix
when M1 runs** (the named-verifications list below is their checklist).

**Verified live/behaviorally:**
- Custom provider via `createProvider` + `openai-completions` `stream`/`streamSimple`;
  auth via `ProviderAuth.apiKey.resolve()` returning `{ auth: { apiKey, baseUrl } }`;
  models need `baseUrl`/`input`/`cost` — **live E2E through a gateway returned a committed
  answer** on SQLite storage.
- Image content in submissions reaches the model (live test answered a color question
  about a PNG) — the base64 inline path.
- **Approvals mechanism (behavioral probe, 2026-10-04):** a `beforeTool` hook wrote a
  pending durable memo, awaited an external decision, and the process was hard-killed
  mid-pending. On restart + `resume()`, the hook re-fired, consumed the decision, and the
  conversation completed correctly — allow executed the tool; deny produced an error
  tool-result the model reported. **The async-approval design works natively; no fallback
  design needed.** Entry shapes (`pi.user`/`pi.assistant`/`pi.tool-result`/`pi.system`,
  with `kind`/`id`) captured during the probe.
- `HarnessOptions.env(target, context)` per-tool-call env builder.
- Sections mechanism (`defineExtension` + `section()`, per-request re-render).

**Verified by type inspection (dist .d.ts, pinned 1.0.2):**
- `createConversation(options, context)` and `Conversation.configure(change, context)`.
- `Conversation.entries(query, limit, cursor, context)` — paginated history query; the
  degenerate recall primitive. Whether **compaction-dropped entries remain reachable**
  through it is sourced from upstream docs only — promoted to the named list below.
- `ConversationView`, `watch()`, `abortSubmission`, `requestId` idempotent submissions,
  `resume()`, `defineTask` + `runtime.sleep(until)` + `watchDoc`, `CompactionHooks`,
  `GenerationHooks`, `ExecutionEnv` (`FileSystem` + `Shell` interfaces). Whether
  `FileSystem` exposes a **directory-list** primitive is not verified — named below.

**Named M1 verifications (claimed, not yet observed — each with a fallback):**
- requestId crash-replay semantics (fallback: treat as at-most-once per process, document).
- resume() recovery outcomes for mid-generation / mid-tool / mid-compaction (the battery;
  criteria in §7 M1).
- Hook re-fire behavior on replay (determines observe-guard final design).
- **`GenerationHooks.afterResponse` payload shape** — what the hook receives per turn
  (does it include the user submission text, or must user-side observation capture it
  separately). Determines the observe-record schema spec B's honcho mapping consumes;
  the paired user-side capture point is the named fallback, mandatory for steered/queued
  inputs (core §3). The schema — including which generation id steered records carry —
  is fixed at M1 either way.
- **Extension-name storage key** — `pi.agent` per the superseded spec, unverified here
  (fallback: any conversation-scoped durable field; the §4.1 semantics are identical).
- Steer/follow-up queue semantics on busy submit (fallback: busy submits return 4xx with
  position-in-queue; the webui renders the queue as read-only).
- Journal mode pi-durable actually sets on its SQLite storage (fallback: pin WAL +
  `synchronous=NORMAL` in sigrun's open path).
- **Watch-stream reconnect replay** — whether upstream `watch()`'s cursor replays missed
  frames plus a snapshot as §5 states (fallback: sigrun serves its own per-conversation
  ring buffer).
- `abortSubmission` idempotence under concurrent aborts.
- **`entries()` reaches compaction-dropped entries** (currently docs-sourced; fallback:
  degenerate recall reads the pinned-version SQLite schema directly, covered by the
  captured-schema fixture test).
- **Live-harness backup resumes**: `sqlite3 .backup` taken against the running harness
  restores and resumes (a second process touching the file — exactly the accepted
  no-cross-process-locking assumption; fallback: scale-to-0 backup window).
- **`FileSystem` directory-list primitive** for the workspace browser's list endpoint
  (fallback: server-side fs for the static workspace, documented).
- **Task wake after kill-during-`sleep(until)`**: exactly-once, no double-fire, no missed
  wake (battery item 7; fallback: document wake semantics honestly, design cron extension
  accordingly).
- sigrun co-tenancy of the harness sqlite file — **decision: use pi-durable documents
  first** (session-meta, approval policy, observe records are conversation-scoped docs;
  `watchDoc` gives free reactivity). **`watchDoc` is type-verified; that arbitrary
  app-defined document shapes are supported is part of this verification** (fallback: own
  prefixed tables, covered by the upgrade drill). **Own prefixed tables only if a shape
  doesn't fit**; if tables are used, the upgrade drill covers them and the co-tenancy
  question becomes a named verification.
- Whether `ConversationView` serializes directly to JSON or needs a projection — M1's
  server task captures the fixture first and defines the projection then (planned work,
  not discovered work).

**Not present upstream:** skill directory convention (sigrun defines it, §3.2);
cross-process storage locking (accepted — single harness process).

---

## Appendix C.1 — plan-time verification addendum (pinned `pi-durable@1.0.2` types read)

Resolved from the shipped `.d.ts` before planning. Each entry closes or reshapes a named
M1 verification above; the remaining runtime (crash/replay) items stay for M1.

- **`pi.agent` storage key — RESOLVED (real).** `AgentDoc` is a
  `RewindableConversationDocToken<AgentState>`; `AgentState.extensions?: string[] | { add,
  remove }`. Per-conversation extension selection is a first-class stored field, so spec C
  lane C6b wraps `Conversation.configure({ extensions })` rather than inventing storage.
  Core v1 §5 still *accepts only* `model` and `thinking` (policy choice, not an upstream
  limit — `AgentChange` also carries `extensions`, `tools`, `instructions`, `cwd`).
- **`FileSystem.listDir` — RESOLVED (present).** `env/index.d.ts` defines
  `listDir(path): Promise<Result<FileInfo[], FileError>>`; the files-list endpoint is
  verified against the type, no fallback needed.
- **`afterResponse` user-text capture — RESOLVED (design settled).**
  `GenerationHooks.afterResponse(message: AssistantMessage, api, context)` receives the
  **assistant** message only. User-side observation reads the just-committed user entry via
  the hook's `DocumentReader` (`api.read`), so the paired capture is the design, not the
  fallback. The observe-record schema is fixed in the plan (T-MEM).
- **Document model for session-meta / approval policy — RESOLVED (present).**
  `defineDoc` / `defineDocFamily` support `session` / `conversation` / `task` scopes with
  `migrate(version)` and `checkpointWhen`; `Session.snapshot`/`watchDoc` are typed.
  Session-meta and approval policy are conversation documents; observe records are a
  conversation doc family keyed by turn.
- **Watch reconnect replay — RESOLVED (shape).** `Conversation.watch()` returns a
  "serialized exact-frame watch with bounded pending frames"; `conversationViews.attach`
  registers an observer that "sees every later publication and nothing earlier." Reconnect
  = re-attach and take a fresh snapshot; the §5 reconnect contract maps onto this. Bounded
  pending frames means a slow consumer can miss intermediate frames, so the §5 server
  buffers per-conversation frames (a small ring) rather than assuming upstream retention.
- **`GenerationHooks.afterResponse` replay-guard — RESOLVED (mechanism).** The hook runs
  inside the generation task; the memo guard keys on the generation's durable id via
  `HookApi.memo(name)`, which is shared between the hook and the task. Confirmed by the
  2026-10-04 live approvals probe's durable-memo behavior.

**⚠ Spec correction (material):** §5 described `ConversationView` as carrying "streaming
answer, running tools, pending approvals." The type is **structural only**:
`ConversationView = { conversation, entries, docs }`. Streaming deltas, running-tool slots,
and live run state live in **`watchEvents(harness, id)` → `AgentEventStream`** (snapshot +
`message_*` / `tool_execution_*` events) and the built-in **`LiveDoc`** (`pi.live`:
`run`, `generation.message` partial, `tools: ToolSlot[]`, `compactions`), with queued
submissions in **`InboxDoc`** (`pi.inbox`). The §5 server view is therefore **composite**:
serialize `ConversationView` for transcript/docs, plus `LiveDoc`/`InboxDoc` for run state,
plus the `AgentEventStream` for streaming. The captured-schema fixture (§5) covers all
three sources. This corrects §5's parenthetical, not its endpoint list.

---

## Appendix D — homelab deployment instantiation (user's cluster)

The concrete values this deployment uses against §4.4. Kept here so the core sections
stay portable — nothing in §1–§7 or App A–C depends on these specifics.

- **Chart:** `sigrun` in `~/repos/helm-charts`, modeled on `hermes-pantheon` (~⅓ the size).
- **Storage class:** iSCSI-backed block PVC for the sqlite (block semantics, safe for WAL);
  workspace artifacts on `REPLACE-nfs-node` if a separate volume is wanted. (The cluster's
  local-path provisioner also exists and satisfies §4.3, but iSCSI block is preferred — and
  the DR runbook explicitly does not preserve local-path PVCs, whereas the backup below is
  target-agnostic.)
- **Node placement:** worker nodeSelector + `dedicated=workload` toleration (both pools are
  tainted). With the iSCSI PVC the backup CronJob has no node-binding constraint; the
  placement stays for consistency.
- **Service:** ClusterIP + Tailscale LB (`tailscale` class) at
  `sigrun.tailnet.example.test`.
- **Backup target:** RustFS S3 at `RUSTFS-ENDPOINT-REMOVED.example.invalid:3900` (the CNPG barman
  precedent); retention is enforced by a retention step in the backup CronJob unless
  RustFS bucket-lifecycle behavior is verified in M1 (added to App C's named
  verifications); credentials in a core SealedSecret. **This is the only disaster copy of
  transcripts** — the DR runbook does not preserve local-path PVCs, and the iSCSI volume's
  own replication is not a transcript backup. Unconfigured backup (allowed by §4.3) means
  zero disaster copies; this deployment does not make that choice.
- **Monitoring:** ServiceMonitor + PrometheusRule as §4.4 describes.
