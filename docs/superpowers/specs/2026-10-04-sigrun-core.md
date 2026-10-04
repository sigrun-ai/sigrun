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
| **Approvals** | pi-durable `beforeTool` hook: block/allow/await. **Verified upstream (2026-10-04, App C): a blocked call can durably await an external decision across crash+restart via `api.memo`.** Decisions are stored in the hook's durable memo *before* acting, so a crash between "user clicked allow" and "tool ran" never re-prompts or re-executes | upstream mechanism | core approvals extension: write/exec tools prompt, read-only tools pass; policy in a per-conversation document; decision enum `allow \| deny`; aborting a conversation auto-**denies** pending approvals (memo reason `aborted`) |
| **Skills** | `skills/` in the conversation workspace; SKILL.md frontmatter (agentskills.io shape); rendered as a prompt section + a `load_skill` tool | **sigrun convention** | directory scan; empty = none |
| **Memory** | one interface: **`MemoryBackend { observe(record), recall(query), section() }`**. Observe rides `GenerationHooks.afterResponse` (pinned: single fire per turn; replay-guard via durable memo keyed by generation id). `recall` is a tool backed by `conversation.entries()` (verified: paginated full-history query; compaction-dropped entries remain in storage). `section()` injects the memory block | **sigrun contract** | `MemoryBackend` over harness entries; `section()` emits a stable placeholder ("long-term memory backend not configured") so the prompt surface is identical across configurations |
| **Context management** | pi-durable's compaction task: policy (`reserveTokens`, `backgroundTokens`) in core settings; `CompactionHooks.beforeCompact` may decline/replace the summary; summarizer model choosable per policy | upstream + sigrun policy | pi-durable defaults, tuned (§3.1) |
| **Context files** | section loaders keyed by convention: `SOUL.md` → persona section, `AGENTS.md` → per-workspace instructions, read via the conversation's ExecutionEnv. **A missing file is an empty section, not an error** — a fresh deployment boots cleanly | upstream sections | present |
| **Model providers** | **provider-contributor contract**: an extension may contribute `createProvider()` results (pi-ai) + a default model at boot; core merges contributions into one `Models` store before `Harness.open()`. Merge semantics: deterministic, last-registered wins on id collision, collisions logged (never silent); `SIGRUN_MODEL` env overrides any contributor default; a conversation pinned to an unserved model id fails explicitly at submit (4xx + available ids) | **sigrun contract** | env-driven OpenAI-compat provider |
| **Channels** | clients of the §5 API. Webui, CLI, Discord — all equal clients; no in-process privilege | §5 API | webui |
| **Scheduled jobs** | pi-durable `defineTask` state machines; `runtime.sleep(until)` is a durable wait (survives restart, rechecks the harness clock); `watchDoc` for event-driven wake | upstream | none |
| **Workspace** | `HarnessOptions.env` → the `workspaceService` wrapper (§4.4) | sigrun wrapper | static local path |

Boot order: load configured extensions → collect provider contributions (plus the env
default if none contributed) → `Harness.open(models, registry)` → `resume()`. A failing
extension at boot is **quarantined** (logged, surfaced as a degraded surface via
`GET /v1/meta`), never aborts `Harness.open()` — chat survives a bad extension release.

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
serves the §5 API, and serves the webui as static assets. Extensions are configured at boot
(deploy-time list in a ConfigMap; pi-style package.json, not runtime plugin management).
Conversations store extension names, so a deployed extension-set change is picked up on
restart without touching transcripts. A resumed conversation referencing a removed
extension resumes with that surface's degenerate default; the name is preserved so
re-enabling restores it without a transcript migration.

### 4.2 Upstream dependency policy

`@earendil-works/pi-durable` is pinned to an exact version in `package.json` (no ranges).
All upstream contact goes through the §3 contracts; the serialized view/watch shape is
captured in-repo as a type fixture (§5), so upstream drift is a test failure, not a runtime
surprise. Upgrade procedure: read changelog → snapshot the sqlite file → upgrade on a
scratch copy → verify `resume()` + view serialization + the crash battery → deploy.

### 4.3 Storage

- **Conversation SQLite on a local-path PV, not NFS.** SQLite's WAL/shared-memory semantics
  assume local disk; NFS is a documented corruption hazard. (Cluster note: this cluster's
  DR runbook explicitly does **not** preserve local-path PVCs — which makes the backup
  below the only disaster copy of transcripts. For a public release the same rule holds:
  local disk + real backups.)
- **Journal mode** pinned per pi-durable's storage default, confirmed in M1 and recorded in
  Appendix C.
- **Nightly backup:** `sqlite3 .backup` (CronJob in the chart) to an object-store or NFS
  target, retention ≥ 30 days, restore drill in M1's exit criteria. The backup CronJob: same
  node selector + tolerations as the Deployment (local-path is node-bound — a naive CronJob
  hangs Pending), image must contain `sqlite3`, target credentials are **core** secrets (not
  extension secrets), restore procedure documented in the chart's runbook.

### 4.4 Workspace resolution

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
committed state"). The sigrun server authenticates (§4.4 of the deployment story:
tailnet/ingress = trusted principal for self-hosters; bearer-token layer reserved as the
seam for the first non-browser client — not day 1), serializes the native view/watch
frames, and adds the write endpoints below.

v1 endpoints:

- **Views + watch frames** over SSE — the native `ConversationView` (transcript, streaming
  answer, running tools, queued submissions, pending approvals, agent, usage) serialized
  per the captured schema; includes a per-conversation `steer` field reflecting
  submit-while-busy queue semantics.
- `POST /v1/conversations` — create a conversation (upstream `createConversation()`,
  type-verified); `GET /v1/conversations` — list with session-meta. v1 is
  multi-**session**, single-user; the root conversation is the default.
- `GET /v1/conversations/:id/meta` / `PATCH` — session metadata:
  `pinned: bool`, `tagged: string[]`, `archived: bool`, `draft: { text: string,
  attachments: string[] }`, `source: "user" | "cron"`. PATCH is a merge; explicit `null`
  clears a field. ("session" ≡ conversation; one resource, one path.)
- `POST /v1/conversations/:id/submissions` `{ input, requestId }` — `input` carries
  content parts: `{ type: "text", text }` or `{ type: "image" | "file", path, mime? }`
  (workspace-relative). **The server resolves path-parts to inline content (base64/text)
  at submit time** — the verified upstream path — via the conversation's ExecutionEnv; a
  missing path yields an explicit error part, never a silent drop. `requestId` makes
  duplicate submission idempotent (verified: API present; **crash-replay semantics are a
  named M1 verification**). Submitting while busy queues the input (queue semantics also
  verified in M1).
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
  endpoint; terminal state delivered via the watch stream.
- `GET /v1/meta` — `{ harnessVersion, schemaVersion, extensions: [{name, status}] }`.
  `schemaVersion` hashes the captured fixture (upstream drift bumps it before any sigrun
  release); the webui refuses to render on mismatch. Also surfaces quarantined extensions.

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

The flagship artifact. **Goal: hermes-webui's UX, shamelessly, rebuilt as a thin client.**

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
- Surface visibility: what's enabled per conversation, rendered from `GET /v1/meta`
  (read-only badge).
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

Threshold: ≥60% of hermes-webui's frontend reusable as-is (API calls replaced,
layout/session/theme logic intact) → port. Below that → **rebuild**: TypeScript + React
against the §5 API. If the audit lands <60%, M2 is re-baselined before work starts.

The audit must also measure **render-code coupling**, not just layout/theme reuse: message
renderers coupled to hermes's message shape do not port regardless of layout percentage.
Record per subsystem what survives unchanged vs what re-keys to the §5 schema.

### 6.4 Trust boundary

- The network perimeter (tailnet/ingress) is the trusted principal; sigrun assumes a
  single authenticated user behind it. The API never accepts or returns credentials.
- **Bearer tokens: seam, not day 1.** The server reserves a bearer-token layer (tokens
  from a secret, one per client — webui, CLI, future bots) implemented when the first
  non-browser client lands.
- Multi-user: in-app OIDC SP is a later spec (spec C).

---

## 7. Milestones

### M0 — pre-flight (½ day)
- Root repo layout: `package.json`, `docs/`, `src/harness/`, `src/extensions/`, `src/webui/`
- (Provider-API and approvals-mechanism verification are done — App C, 2026-10-04.)

### M1 — Core skeleton (1–2 days)
- `Harness.open` over SQLite on a local-path PV, `resume()` on start
- Provider-contributor contract + env-driven degenerate provider
- Skills convention skeleton (§3.2 scope exactly)
- Context files (`SOUL.md`, `AGENTS.md`) as sections (missing = empty)
- `MemoryBackend` with the degenerate implementation (recall over `entries()`, observe
  hook writing per-turn records: `{conversationId, generationId, role, text, timestamp}`)
- Approvals extension: conservative default policy, durable memo decisions, abort-denies
- Context-management defaults (§3.1), summarizer pinned to cheapest available
- Static `workspaceService`
- §5 server: the full v1 endpoint list incl. files list/read, uploads, approvals, meta
- Backup CronJob + restore procedure (§4.3)
- Deployment on worker nodes
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
- **Exit:** text assistant reachable via curl; pod restart resumes; **restore from the
  nightly backup resumes**; provider arrived via extension contract; the battery passes
  with recorded outcomes.

### M2 — WebUI → **SHIP GATE** (2–4 days)
- Step 0: §6.3 audit (4 hours), records port/rebuild; re-baseline if <60%
- Port or rebuild against §5 per that choice
- Three-panel layout, composer footer, tool cards, context ring, themes, model picker,
  approval cards, uploads, workspace browser (read-only)
- **Exit (ship gate) — the checklist, all items pass with no fallback:**
  1. Start a second session; switch between sessions; archive one.
  2. Send a text message; send an image.
  3. Steer a running session.
  4. Approve a read-only tool; deny a write tool; see the denial reflected.
  5. Pick a model from the catalog.
  6. Read a tool card (expand, see output).
  7. **Ask about something compacted out of the live window; degenerate `recall` returns
     it.**
  8. Open the workspace panel; list a directory; read a file.
  9. Switch theme.
  10. Restart the pod mid-conversation; resume and continue.
- A daily-soak period follows **after spec B's L1+L2 restore memory and research** — the
  ship gate is a milestone, not the daily-driver gate. Gaps found in soak are filed and
  fixed before any cutover (spec B's gate).

**Estimates:** M0–M2 ≈ 4–6 days focused work.

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

## Appendix C — verification record (2026-10-04)

Performed against `@earendil-works/pi-durable@1.0.2`, `@earendil-works/pi-ai`, Node 26.

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
  degenerate recall primitive (upstream docs: compaction-dropped entries remain in
  storage).
- `ConversationView`, `watch()`, `abortSubmission`, `requestId` idempotent submissions,
  `resume()`, `defineTask` + `runtime.sleep(until)` + `watchDoc`, `CompactionHooks`,
  `GenerationHooks`, `ExecutionEnv` (`FileSystem` + `Shell` interfaces).

**Named M1 verifications (claimed, not yet observed — each with a fallback):**
- requestId crash-replay semantics (fallback: treat as at-most-once per process, document).
- resume() recovery outcomes for mid-generation / mid-tool / mid-compaction (the battery;
  criteria in §7 M1).
- Hook re-fire behavior on replay (determines observe-guard final design).
- Steer/follow-up queue semantics on busy submit.
- Journal mode pi-durable actually sets on its SQLite storage.
- `abortSubmission` idempotence under concurrent aborts.
- sigrun co-tenancy of the harness sqlite file — **decision: use pi-durable documents
  first** (session-meta, approval policy, observe records are conversation-scoped docs;
  `watchDoc` gives free reactivity), **own prefixed tables only if a shape doesn't fit**;
  if tables are used, the upgrade drill covers them and the co-tenancy question becomes a
  named verification.
- Whether `ConversationView` serializes directly to JSON or needs a projection — M1's
  server task captures the fixture first and defines the projection then (planned work,
  not discovered work).

**Not present upstream:** skill directory convention (sigrun defines it, §3.2);
cross-process storage locking (accepted — single harness process).
