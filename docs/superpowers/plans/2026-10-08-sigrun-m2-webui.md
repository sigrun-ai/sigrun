# sigrun M2 — WebUI rebuild (TypeScript + React against the §5 API)

**Spec:** `docs/superpowers/specs/2026-10-04-sigrun-core.md` §5 (wire), §6 (webui), §6.1 (ship-gate feature list), §6.2 (drops), §7 M2 (exit checklist)
**Re-baseline:** `docs/superpowers/audits/2026-10-08-m2-webui-port-audit.md` — the §6.3 port gate was NOT met (≈38% reuse < 60%), so M2 is a **rebuild**: TypeScript + React against the §5 API. The audit's per-subsystem port map and coupling finding are the design inputs.
**Transport:** validated by the spike (`docs/superpowers/audits/2026-10-08-m2-transport-spike.md`, `spikes/webui-transport/`). The `useConversationView` hook shape — one `EventSource` over `GET /v1/conversations/:id/stream`, every frame a full immutable revision (replace, don't accumulate) — is proven against the live server.
**Layout:** `spikes/webui-transport/mockup.html` is the rendering-verified three-panel reference (sessions sidebar, chat center, workspace browser, composer footer, themes, badges).

**Goal:** the §6.1 ship gate — a functional webui over the durable harness, all 11 exit-checklist items passing with no fallback.

**Architecture:** a `webui/` workspace package (Vite + TypeScript + React), built to a static bundle the core serves as the `webui` channel bundle (§4.1/§6: a deployment with no webui bundle serves the §5 API only; the bundle is deploy-time, never a runtime extension). The webui is a thin client: every conversation truth comes from the §5 API + the SSE view stream; no client-side model of agent state.

**Design invariants (binding):**
- **Full-revision state.** The conversation view is always the latest frame from the stream — never accumulated, never delta-merged. Reconnect = fresh snapshot (App C verified). The client holds ONE source of truth per conversation: the current `ConversationViewWire`.
- **Entries by kind.** Renderers dispatch on the `kind` discriminant (`pi.user` / `pi.assistant` / `pi.tool-result` / `pi.system`); tool cards from `pi.tool-result`; live run/tools from `docs["pi.live"]`; queued submissions from `docs["pi.inbox"]`; usage from `docs["pi.usage"]`.
- **Fail loud.** The webui refuses to render on `schemaVersion` mismatch (spec §5) and surfaces degraded health from `GET /v1/meta` as badges — never silent.
- **No port of hermes message rendering.** The audit's dispositive finding: hermes renderers are coupled to the per-turn delta SSE + hybrid message array and do not port. All message/entry rendering is new, driven by the §5 entry model.
- **Thin client.** The webui never owns agent state, session persistence, or business logic — those are the harness's. The client renders the view and issues §5 calls.

---

## Task 20: webui workspace scaffold + build/channel-bundle serving

**Files:**
- Create: `webui/` (Vite + TS + React app: `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/api.ts`), root workspace wiring (`package.json` workspaces), `src/server/static.ts` (serve the built bundle)
- Modify: `src/server/index.ts` (mount the webui bundle at `/`, set `capabilities.channels`), `src/config.ts` (webui bundle path config)
- Test: `test/server-static.test.ts`, `webui/src/api.test.ts`

**Interfaces:**
- Consumes: the §5 server (T9), `GET /v1/meta` `capabilities.channels`.
- Produces: `webui/dist/` static bundle; the server serves it at `/` when the bundle is present (channel bundle, §4.1/§6) and sets `capabilities.channels: ["webui"]`; absent bundle → API-only, `channels: []` (no error). `SIGRUN_WEBUI_BUNDLE` env or a default path (`webui/dist`) — the deploy entry serves the bundle when present.

**Steps:**
- [ ] **Step 1: failing tests** — server serves the bundle at `/` when present (index.html + a static asset), `capabilities.channels` includes `"webui"`; absent bundle → 404 on `/` and `channels: []`. `api.ts` client: typed `getMeta`/`getConversations`/etc. against the §5 shapes (a fetch wrapper test against a stub).
- [ ] **Step 2: scaffold the Vite app** — React + TS, the `api.ts` client, a root App that renders "sigrun" + the meta badges. Build to `webui/dist`.
- [ ] **Step 3: wire the server** — static serving + channels. Green.
- [ ] **Step 4: commit** `feat: webui workspace scaffold + channel-bundle serving`

---

## Task 21: the transport hook + conversation view state

**Files:**
- Create: `webui/src/useConversationView.ts`, `webui/src/stream.ts` (the EventSource wrapper)
- Test: `webui/src/useConversationView.test.ts`

**Interfaces:**
- Produces: `useConversationView(conversationId): { view, status, frames, error }` — one EventSource over `GET /v1/conversations/:id/stream`, `snapshot` + `view` events both replace the view (full revision), heartbeat tolerated, reconnect on drop (re-open → fresh snapshot), cleanup on unmount/id change. The spike's proven shape, ported to a typed hook.
- The `ConversationViewWire` type: import or re-derive from the §5 fixture (`test/fixtures/view-schema.json`) — decide: a shared `webui/src/types.ts` generated from the fixture, or hand-written types asserted against the fixture in a test. Prefer generated/derived so upstream drift trips a test.

**Steps:**
- [ ] **Step 1: failing tests** — a stubbed EventSource (or a real one against the spike server) drives the hook: snapshot sets the view, view frames replace it, reconnect re-snapshots, unmount closes. Malformed frame → error status, stream survives (the spike's try/catch).
- [ ] **Step 2: implement** the hook + the stream wrapper.
- [ ] **Step 3: commit** `feat: webui transport hook (useConversationView)`

---

## Task 22: entry renderers (by kind) + tool cards + approval cards

**Files:**
- Create: `webui/src/entries/` — `EntryList.tsx`, `UserEntry.tsx`, `AssistantEntry.tsx` (markdown), `ToolResultEntry.tsx` (tool card), `SystemEntry.tsx`, `ApprovalCard.tsx` (from `docs["pi.live"]` pending gated calls + the `/approvals` endpoints)
- Test: `webui/src/entries/*.test.tsx`

**Interfaces:**
- Consumes: `ConversationViewWire.entries` (the §5 entry model), `docs["pi.live"]` tool slots, `GET/POST /v1/conversations/:id/approvals`.
- Produces: the chat transcript renderer. Markdown via a React markdown renderer (the audit's reusable asset: port the `renderMd` pipeline shape or use `react-markdown` + `remark-gfm`; KaTeX for math). Tool cards expandable (the `pi.tool-result` entry + the LiveDoc slot's running output). Approval cards for pending gated calls (allow/deny → `POST .../approvals/:approvalId {decision}`).

**Steps:**
- [ ] **Step 1: failing tests** — render each entry kind from fixture-shaped entries; a tool card expands to show output; an approval card renders a pending gated call and POSTs the decision.
- [ ] **Step 2: implement** the renderers + the markdown pipeline + the cards.
- [ ] **Step 3: commit** `feat: webui entry renderers + tool/approval cards`

---

## Task 23: sessions sidebar + session-meta + composer (submit/steer/draft)

**Files:**
- Create: `webui/src/sessions/SessionList.tsx`, `webui/src/composer/Composer.tsx`, `webui/src/composer/useDraft.ts`
- Test: `webui/src/sessions/*.test.tsx`, `webui/src/composer/*.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /v1/conversations`, `GET/PATCH /v1/conversations/:id/meta`, `POST .../submissions` (with `requestId` idempotency), the view's `steer` field (`{busy, queued}`).
- Produces: the sessions sidebar (list, new, switch, archive, pin/tag via meta), the composer footer (textarea, model picker from `/v1/models`, context-usage ring from `docs["pi.usage"]`, attach button, send/steer toggle — `steer.busy` flips send→steer and submits with `whenBusy: "steer"`), per-session draft via `meta.draft` (PATCH on change, restored on switch).

**Steps:**
- [ ] **Step 1: failing tests** — sidebar lists conversations with meta (pinned/tagged/archived), new + switch + archive; composer submits text, disables/steers when busy (the `steer` field), persists and restores the draft per conversation.
- [ ] **Step 2: implement.**
- [ ] **Step 3: commit** `feat: webui sessions sidebar + composer (submit/steer/draft)`

---

## Task 24: uploads + workspace browser

**Files:**
- Create: `webui/src/workspace/WorkspaceBrowser.tsx`, `webui/src/workspace/FilePreview.tsx`, the composer's attachment path
- Test: `webui/src/workspace/*.test.tsx`

**Interfaces:**
- Consumes: `POST .../uploads`, `GET .../files?path=`, `GET .../files/content?path=`, `POST .../submissions` (path-parts).
- Produces: the right-panel workspace file browser (list a directory, read a file — read-only), and the composer attachment path (upload → workspace-relative path → submit with `{type:"image"|"file", path}` parts).

**Steps:**
- [ ] **Step 1: failing tests** — the browser lists a directory and previews a file; the composer attaches a file (upload → path → submit with the path-part).
- [ ] **Step 2: implement.**
- [ ] **Step 3: commit** `feat: webui uploads + workspace browser`

---

## Task 25: themes + badges + layout shell

**Files:**
- Create: `webui/src/layout/` — `ThreePanel.tsx`, `TopBar.tsx`, `useTheme.ts`
- Test: `webui/src/layout/*.test.tsx`

**Interfaces:**
- Consumes: `GET /v1/meta` (extensions, health, schemaVersion), the theme system (light/dark + accent, persisted).
- Produces: the three-panel layout shell (the mockup's structure), the top bar with the extension-set badge + degraded-health badges, the theme system (light/dark + accent picker, persisted to localStorage), and the schema-version gate (refuse to render on mismatch, fail loud per spec §5).

**Steps:**
- [ ] **Step 1: failing tests** — the layout renders the three panels; the badges reflect meta; the theme toggles + persists; a schemaVersion mismatch blocks render with an explicit message.
- [ ] **Step 2: implement.**
- [ ] **Step 3: commit** `feat: webui layout shell + themes + badges`

---

## Task 26: ship-gate E2E (§7 M2 exit checklist)

**Files:**
- Create: `webui/e2e/` — Playwright tests driving the real server + the built bundle
- Test: `webui/e2e/ship-gate.spec.ts`

**Interfaces:**
- Consumes: everything above. The real M1 server (faux provider for determinism where a model is needed; a real provider where the checklist demands live behavior).

**The §7 M2 exit checklist (all 11 items, no fallback):**
1. Start a second session; switch between sessions; archive one.
2. Send a text message; send an image.
3. Steer a running session.
4. Approve a write/exec tool; deny a write tool; see the denial reflected.
5. Pick a model from the catalog.
6. Read a tool card (expand, see output).
7. Ask about something compacted out of the live window; degenerate `recall` returns it.
8. Open the workspace panel; list a directory; read a file.
9. Switch theme.
10. Restart the pod mid-conversation; resume and continue. (Process restart in the test — kill the server, restart, the conversation resumes.)
11. Confirm degraded surfaces appear in `GET /v1/meta` (unconfigured backup; one injected-failure surface).

**Steps:**
- [ ] **Step 1: write the E2E spec** covering all 11 items.
- [ ] **Step 2: run, fix, green.**
- [ ] **Step 3: record** the ship-gate results in Appendix C (M2 exit).
- [ ] **Step 4: commit** `test: M2 ship-gate E2E + Appendix C record`

---

## Sequencing + review

T20 → T21 → T22 → T23 → T24 → T25 → T26. Each task: implementer worker → task-reviewer gate → fix round → ledger (the M0+M1 SDD cadence). T26 is the ship gate.

## Effort

The spec's "2–4 days" M2 assumed a port. A rebuild is materially larger: 7 tasks, a new TS+React+Vite app, and a full E2E ship gate. Re-baselined estimate: **5–8 days** of focused work (the audit's §6.3 re-baseline note).

## Evidence gaps carried from the audit

- `rcarmo/piclaw` was never consulted (§6.3 pattern reference only; cannot flip the rebuild decision). Optional: consult it for layout/session patterns during T22–T25.
