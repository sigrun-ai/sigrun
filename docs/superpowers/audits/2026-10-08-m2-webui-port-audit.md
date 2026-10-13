# M2 Step 0 — hermes-webui frontend → sigrun §5 webui: port/rebuild audit

**Date:** 2026-10-08
**Spec:** `docs/superpowers/specs/2026-10-04-sigrun-core.md` §6.3 (gate), §5 (wire contract), §6.1/§6.2 (feature list / drops)
**Sources audited (read-only):**
- `~/repos/hermes-webui/static/` (vanilla JS + HTML + CSS; no Python counted)
- `~/repos/sigrun/test/fixtures/view-schema.json` (captured §5 ConversationView wire shape)
- `docs/superpowers/specs/2026-10-04-sigrun-core.md` §5/§6/App C.1

---

## Decision

**REBUILD.** The M2 webui is re-baselined to **TypeScript + React against the §5 API** (spec §6.3). The port gate is **not** met.

**Measured reuse:** **≈ 38%** of ship-gate-relevant frontend is reusable as-is / with API-call replacement (point estimate; defensible band **35–50%** — the 50% upper bound already counts every "re-key" subsystem as reusable, which is the most generous reading of §6.3). The 60% threshold is not reached under any interpretation.

The decision is driven by two independent findings:
1. The **message renderer + SSE transport is total coupling** to hermes's per-turn event protocol and OpenAI/Anthropic-hybrid message array (`messages.js` `attachLiveStream`, the named §6.3 risk). Per §6.3 these "do not port regardless of layout percentage."
2. Once the dropped §6.2 surfaces are excluded, the remaining mass is dominated by the coupled streaming/render stack, not by reusable layout/theme/session chrome.

---

## Method (and its limits)

This run had no shell/grep/ripgrep tooling (read-only file access only), so the percentage is a **structural LOC attribution from direct reading**, not a grep-counted line classification. Every file's total line count was measured exactly; per-subsystem LOC splits within a file are estimates derived from reading the file's structure (function boundaries, section comments) and are labelled as estimates. The direction of uncertainty is stated for each; none of the bands crosses 60%.

- Denominator = **ship-gate-relevant** frontend (§6.1 features), **excluding** §6.2 dropped surfaces.
- "Reusable" = survives with API-call replacement (§6.3's own definition) — layout, session-list rendering, theme/CSS, markdown rendering, file-preview rendering, generic DOM helpers.
- "Re-key" = logic survives, but field/endpoint mapping changes (counted as reusable in the generous band, not in the point estimate).
- "Rebuild" = coupled to hermes's message shape or SSE/session transport (per §6.3, not reusable).

### Measured frontend inventory (exact LOC, excluding `vendor/`)

| File | LOC | §6.1 ship-gate role |
|---|---:|---|
| `ui.js` | 23,137 | chat render, tool cards, context ring, file tree, todos, dialogs |
| `i18n.js` | 27,401 | localization catalog (locale bundles) |
| `panels.js` | 13,765 | cron, skills, memory, profiles, todos, settings/Control Center |
| `sessions.js` | 10,418 | sessions sidebar + session CRUD + unread machinery |
| `messages.js` | 9,859 | `send()`, SSE handlers, live streaming, approval/clarify, steer |
| `style.css` | 7,364 | themes + skins + layout |
| `boot.js` | 4,142 | mobile nav, voice input, theme/skin boot, bfcache |
| `commands.js` | 2,471 | slash-command registry/autocomplete |
| `index.html` | 1,917 | layout skeleton + 11 nav panels |
| `workspace.js` | 1,550 | file preview, file ops, git badge, central `api()` wrapper |
| `onboarding.js` | 839 | first-run provider/profile wizard |
| `sw.js` | 263 | service worker (offline shell) |
| `login.js` | 206 | login page |
| `icons.js` | 97 | Lucide icon path registry |
| `pwa-startup.js` | 83 | PWA startup helpers |
| **Total** | **≈ 103,512** | |

### §6.2 dropped surfaces (excluded from the denominator)

`panels.js` (cron / skills / memory / profiles / persona picker / settings incl. provider + credential + `.env` + plugin management) ≈ 13,765 · `onboarding.js` 839 (provider/credential/profile setup) · `commands.js` ≈ 2,000 (hermes agent commands, `/moa`, bundles, `/theme`, `/usage`, `/workspace`) · `sw.js` 263 (notification service worker) · `login.js` 206 (auth; perimeter in §6.4) · `pwa-startup.js` 83. Also dropped slices inside otherwise-kept files: `index.html` rail panels, `ui.js` todos/settings helpers, `boot.js` voice-input + PWA/bcache, `sessions.js` profile/cron unread machinery.

---

## The 60% threshold computation

**Ship-gate-relevant denominator** (after excluding dropped files and dropped slices) ≈ **49,000 LOC**:
`ui.js` ≈ 20,600 · `sessions.js` ≈ 7,900 · `messages.js` ≈ 8,650 · `style.css` ≈ 7,350 · `boot.js` ≈ 1,800 · `index.html` ≈ 1,050 · `workspace.js` ≈ 1,550 · `icons.js` 97.

**Reusable (port)** ≈ **18,400 LOC**: `style.css` ≈ 5,500 · `ui.js` (renderMd/fenced/KaTeX/tables ≈ 2,500; DOM helpers/dialogs/toasts ≈ 3,000; file tree ≈ 1,200; context ring ≈ 400) ≈ 7,100 · `sessions.js` (list render/search/grouping/actions) ≈ 2,200 · `workspace.js` (preview routing, breadcrumb, language map, `api()` wrapper) ≈ 900 · `messages.js` (markdown helpers, selection-context UI, saved prompts) ≈ 700 · `boot.js` (theme/skin boot, sidebar/mobile nav) ≈ 1,200 · `index.html` (chat/sessions/composer/workspace skeleton) ≈ 700 · `icons.js` 97.

**Reuse = ≈ 18,400 / 49,000 ≈ 38%.**

Sensitivities (none cross 60%):
- Counting every **re-key** subsystem as reusable (generous reading of "API calls replaced"): ≈ 24,400 / 49,000 ≈ **50%**.
- Including the `i18n.js` locale catalog in the denominator and counting only its mechanism as reusable: ≈ **27%**.
- Excluding `i18n.js` entirely (it is not a §6.1 ship-gate feature): the ≈ 38% figure above.

**Verdict: ≤ 60% ⇒ rebuild.**

---

## Per-subsystem port map

| # | Subsystem | Source | Verdict | Survives unchanged | Re-keys to §5 | Rebuilt |
|---|---|---|---|---|---|---|
| 1 | **Sessions sidebar** | `sessions.js`, `index.html` sidebar | **Re-key** (with rebuild core) | List rendering, Today/Yesterday/Earlier grouping, title/message search, pin/archive/`⋯` menu, tag chips, swipe actions, skeletons | session→conversation model; `GET /api/sessions` → `GET /v1/conversations`; session meta (pinned/tagged/archived/draft/source) → `/v1/conversations/:id/meta` | profile scoping, cron-session unread tombstones, CLI-session bridge, `transcript_generation` viewed-count CRDT (~2,500 LOC) |
| 2 | **Chat rendering (message renderers)** | `messages.js`, `ui.js` | **REBUILD** | message CSS/skeleton chrome only | — | render pipeline, message-array model, `renderMd` wiring to `S.messages` |
| 3 | **Chat streaming / live turn** | `messages.js` `attachLiveStream` | **REBUILD** | — | — | full SSE state machine (see coupling finding) |
| 4 | **Composer footer** (model picker + context ring) | `ui.js`, `index.html` | **Re-key** | footer layout, ring SVG, picker-hides-when-single convention, per-session draft UI | model list → `GET /v1/models`; usage → `docs["pi.usage"]`; draft → `meta.draft`; send → `POST /v1/conversations/:id/submissions` | — |
| 5 | **Tool-call cards** | `ui.js`, `messages.js` | **REBUILD** | card chrome/CSS, expand-collapse affordance | — | data model: hermes `tool_calls`/`tool_complete` SSE → `pi.tool-result` entries in the view |
| 6 | **Approval cards** | `messages.js`, `ui.js` | **REBUILD** | card chrome, allow/deny buttons | — | transport: `/api/approval/pending` polling + `/api/approval/respond` → view pending-approvals + `POST /v1/conversations/:id/approvals/:approvalId`; decision enum `allow-once/session/always/deny` → `allow/deny` |
| 7 | **Steer (submit-while-busy)** | `messages.js`, `ui.js` | **REBUILD** | interaction UX | — | hermes `/api/chat/steer` + local queue + drain → busy `POST /submissions` with the view `steer` field |
| 8 | **Workspace browser** | `workspace.js` | **Re-key** (mostly) | file tree, breadcrumb, preview routing (image/md/code/csv/pdf/audio/video), Prism language map, markdown preview, `api()` wrapper | `/api/list` → `GET /v1/conversations/:id/files?path=`; `/api/file` → `.../files/content?path=` | edit/save/rename/delete + git badge (v1 is read-only) |
| 9 | **Themes (light/dark + accent)** | `style.css`, `boot.js`, `index.html` pre-paint scripts | **Port (re-key)** | CSS-variable theme/skin tokens, pre-paint flash prevention, `data-skin`/`.dark` mechanism | hermes theme+skin taxonomy → sigrun light/dark + accent (collapse the 20+ skins) | large CSS volume that styles dropped panels |
| 10 | **Extension-set badge** | (none in hermes) | **New** (small) | — | — | new widget from `GET /v1/meta` `extensions[]` |
| 11 | **i18n** | `i18n.js` | **Mechanism port, copy rewrite** | `t()` helper, `applyLocaleToDOM`, locale structure | hermes keys → sigrun copy | ≈ 27k lines of locale strings |

---

## Render-code coupling finding (the gate's named risk)

This is the dispositive finding. The message renderer is **not** coupled at the "layout percentage" level — it is coupled at the **data-model and transport** level, which §6.3 explicitly rules out of the port.

**hermes transport (what the frontend consumes today).** `messages.js::attachLiveStream` opens `new EventSource('api/chat/stream?stream_id=…')` and runs a bespoke per-turn state machine over hermes's SSE frames:
- Frames carry per-turn deltas: `token` / `reasoning` / `tool_complete` / `done` / `stream_end` / `apperror` / `cancel`, plus run-journal replay cursors (`after_seq`, `after_event_id`, `Last-Event-ID`), documented in `docs/sse-streams.md` and `docs/rfcs/session-sse-contract-v1.md`.
- The client maintains `INFLIGHT[session_id]` (assistant/reasoning accumulators, `activityBurstAnchors`, `currentLiveSegmentSeq`, `lastRunJournalSeq`), throttled persistence, live-turn DOM snapshot/restore across session switches, stream-fade animation, offline/`visibilitychange` deferred recovery, and reconnect-or-restore logic. This is thousands of lines of state that exists **only** to reconcile deltas against a mutable transcript.

**sigrun transport (what §5 serves).** `GET /v1/conversations/:id/stream` delivers **full immutable `ConversationView` revisions** — snapshot + view events, no deltas (App C.1: "every `watch()` frame is a FULL immutable `ConversationView`"). Streaming answer / running tools / live run state arrive as `docs["pi.live"]` and queued submissions as `docs["pi.inbox"]`. There is no `token`/`done` event stream to accumulate.

**hermes message shape (what the renderers read).** `S.messages` is a flat array of hybrid OpenAI/Anthropic dicts: `{role:"user"|"assistant"|"tool", content: string | [{type:"text"|"tool_use"|…}], tool_calls:[{function:{name,arguments}}], _partial_tool_calls, reasoning, attachments, _statusCard, _turnUsage, _ts, …}` (confirmed in `ui.js` `_messageIsRenderable`/`_messageVirtualRoleForEntry`, `messages.js` `_anchorScene*`).

**§5 entry shape (what sigrun serves).** `view-schema.json` entries are **typed, discriminated variants**: `kind:"pi.user"|"pi.assistant"|"pi.tool-result"`, each with `model:[{role, content, …}]`, `id`, `conversationId`, `byTaskId`; assistant variants carry `usage:{input,output,cacheRead,cacheWrite,totalTokens,cost{…}}`, `stopReason`, `timestamp`; docs are `pi.agent`/`pi.live`/`pi.inbox`/`pi.provider`/`pi.usage`. Nothing about this matches hermes's `role`/`content`/`tool_calls` array.

**Consequence.** Every hermes message renderer (`renderMessages`, the tool-card builders, the live assistant-segment/worklog/anchor scene, the virtualization role mapper, the approval/clarify cards) reads fields that do not exist in the §5 entry model and reacts to events that do not exist in the §5 stream. Re-keying them is a rewrite, not a mapping. This finding alone forces rebuild per §6.3, independent of the layout/theme percentage.

**Corollary — the largest single file is also coupled.** `ui.js`'s message-virtualization engine (windowed rendering, height caches, measurement-burst rAF scheduling, `_messageVirtualRoleForEntry`, `_messageIsRenderable`) is ~2,000+ lines that operate on the `S.messages` array and would be rebuilt against the `entries` array. The genuinely reusable slice of `ui.js` is `renderMd` + the fenced-block/KaTeX/table pipeline + generic DOM/dialog helpers.

---

## Re-baselined M2 shape (per §6.3, since the audit landed ≤60%)

M2 becomes: **build the webui as a TypeScript + React client against the §5 API**, replacing the port task. Concrete shape:

- **Stack:** Vite + TypeScript + React (no server-side render needed; static bundle served as the `webui` channel bundle of §4.1/§6). Keep the zero-build backend; the frontend gains a build step.
- **Transport:** one `useConversationView(conversationId)` hook over `EventSource('GET /v1/conversations/:id/stream')`, treating every frame as a full view revision (replace, don't accumulate). No per-turn delta state machine.
- **Rendering:** entries rendered by `kind` discriminant (`pi.user` / `pi.assistant` / `pi.tool-result`); tool cards from `pi.tool-result`; live run/tools from `docs["pi.live"]`; queued submissions from `docs["pi.inbox"]`; usage ring from `docs["pi.usage"]`.
- **Reused assets (port into the new app):** `style.css` theme/skin CSS variables + pre-paint theme boot; the markdown pipeline (port `renderMd`/fenced/KaTeX/table enhancement as a framework-agnostic module or replace with a React markdown renderer); Prism language map; file-preview routing; icon registry; the `api()` fetch-wrapper pattern (re-pointed at `/v1/*`).
- **Ship-gate features (§6.1) implemented natively:** three-panel layout; sessions sidebar (conversations + `/v1/conversations/:id/meta`); composer footer with `/v1/models` picker + `pi.usage` ring; tool cards + approval cards (`/approvals` endpoints, `allow`/`deny`); uploads (`POST .../uploads` + path-parts in `POST .../submissions`); light/dark + accent themes; per-session draft via `meta.draft`; steer via busy `POST /submissions`; extension-set badge from `GET /v1/meta`.
- **Not built (drop list already fixed by §6.2):** provider/credential/`.env`/plugin management, persona/profile picker, notification service worker, cron panel.

**Effort note.** The audit does not re-estimate M2; the spec's "2–4 days" M2 assumed a port. A rebuild is materially larger than the port path and the M2 estimate should be revised before work starts (spec §6.3: "M2 is re-baselined before work starts").

---

## Evidence gaps / limitations

- **`rcarmo/piclaw` was not consulted** — this run had no network/web-fetch tool (only read/write file access). §6.3 makes piclaw a *pattern reference only* that "cannot flip the port/rebuild decision by itself," so this gap does not affect the outcome, but the required consultation is unfulfilled and should be done in a network-capable session if the pattern reference is still wanted.
- **LOC sub-splits within files are structural estimates**, not grep counts (no shell tooling in this run). File totals are exact. The reuse band (35–50%) reflects this; it does not approach 60%.
- **The §5 wire shape is taken from the committed fixture** (`test/fixtures/view-schema.json`) and App C.1, i.e. the spec's own captured contract; the live server was not run in this audit.
