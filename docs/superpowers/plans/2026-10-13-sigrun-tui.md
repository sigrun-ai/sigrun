# Sigrun TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sigrun a terminal client — pi-idiom conversation pane, sidebar with conversation switching and fork, the interaction + ambient seams rendered — plus the launcher story (`sigrun` / `sigrun serve` / `sigrun attach`) and the two server seams (auth hook, durable enumeration) the spec names.

**Architecture:** A thin client of the existing harness HTTP + SSE API, living in a new `tui/` npm workspace alongside `webui/`. The TUI holds only the currently-open conversation id and the latest view; everything else is re-fetched (the "no second agent loop" rule made structural). Server work is limited to the two seams the spec sanctions: the auth request-hook and the `scanConversations`-backed enumeration.

**Tech Stack:** TypeScript, Node ≥22, Fastify (server), `@earendil-works/pi-tui` (terminal UI, new direct dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-sigrun-tui.md`

## Global Constraints

- pi-durable is pinned at `1.2.0` (`package.json`). pi-tui is a NEW direct dependency, pinned to the 1.x line compatible with pi 1.1.0.
- The config directory is `SIGRUN_CONFIG_DIR` → `~/.config/sigrun` (`src/harness/settings.ts:248`). The TUI's client config file joins that directory.
- Sigrun is configured entirely through environment variables (`src/config.ts`); this plan adds NO file-based harness config.
- Bare `sigrun` is always in-process. `sigrun serve` is headless. `sigrun attach --server <url>` targets a remote harness (default `http://localhost:<port>`).
- The TUI exits → the server exits with it (workstation mode). `serve` is the only way to leave the harness up.
- The TUI sends identity on every request via `X-Sigrun-User`; the webui does the same (one configured value). No auth flow in v1.
- TUI ≈ webui feature parity; differences minimal and deliberate (attachments are the named difference — text-only composer in v1).
- No second agent loop: the TUI submits and watches; it never manages conversation state the server owns.
- Tests live in `test/*.test.ts` at repo root (vitest, `environment: "node"`); the `webui/**` exclusion already exists. The `tui/` workspace's own tests follow the same convention as webui (its own vitest under the workspace, excluded from the root suite).
- Tests own their literals: synthetic hosts (`example.invalid`, `acme/`), no real tokens, private URLs, personal identity, or homelab hostnames in fixtures.

## Review Focus

The five input classes / failure modes the spec implies but no task's tests exercise, most likely first — each with its owning test added to the task that owns the code:

1. **SSE reconnect with a missed frame.** The server's reconnect contract: a fresh snapshot subsumes any missed frame. If the TUI's SSE watcher drops a frame on reconnect and renders stale state, the user sees a conversation that never updates. Owning test in Task 4 (the SSE client): simulate a reconnect after a revision gap, assert the fresh snapshot replaces state wholesale.
2. **A submission POST that returns an immediate 4xx.** Fire-and-forget means the error arrives on the POST response, not the stream. If the TUI doesn't surface `unserved_model`/`invalid_input` visibly, the user thinks the message sent and waits forever. Owning test in Task 7 (composer): stub a 400 response, assert the error renders in the conversation pane.
3. **Steer-while-running and Esc-abort racing a settling run.** The composer sends `whenBusy` steer while the run is live; Esc aborts. If the run settles between the TUI's render and the POST, the server 404s/409s — the TUI must show the outcome, not crash. Owning test in Task 7: abort arrives after settlement, assert a clean "already settled" surface, not an exception.
4. **An identity header the server doesn't recognize (naive mode).** In the no-auth deployment the hook passes requests through unidentified; conversations created ownerless must still list and open. Owning test in Task 2 (auth hook): no header → request proceeds, `owner` unset.
5. **Enumeration across a restart.** The whole point of the enumeration seam: conversations this process didn't create (or created before a restart) must list. Owning test in Task 3: create a conversation, rebuild the server against the same storage file, assert the conversation still lists.

---

### Task 1: `tui/` workspace scaffold + pi-tui dependency

**Files:**
- Create: `tui/package.json`
- Create: `tui/tsconfig.json`
- Modify: `package.json` (workspaces array, add `"tui"`; dependencies add `@earendil-works/pi-tui`)
- Modify: `vitest.config.ts` (exclude `tui/**` from the root suite, same as `webui/**`)

**Interfaces:**
- Produces: the `@sigrun/tui` workspace, `npm --workspace @sigrun/tui run test` / `typecheck` scripts, and `@earendil-works/pi-tui` resolvable from `tui/` code.

- [ ] **Step 1: Write the failing test** — `tui/test/scaffold.test.ts`: importing `@earendil-works/pi-tui` from within the `tui/` workspace resolves and exposes the component names the plan uses (`SelectList`, `Editor`, `Markdown`, `ScrollView`, `Loader`).

```ts
import { test, expect } from "vitest";
import * as piTui from "@earendil-works/pi-tui";
test("pi-tui resolves with the components the TUI uses", () => {
  for (const name of ["SelectList", "Editor", "Markdown", "ScrollView", "Loader"]) {
    expect(piTui, name).toHaveProperty(name);
  }
});
```

- [ ] **Step 2: Run it to make sure it fails** — `npm --workspace @sigrun/tui run test` → module not found (workspace + dependency don't exist yet).
- [ ] **Step 3: Create the workspace** — `tui/package.json` (`"name": "@sigrun/tui"`, `"private": true`, `"type": "module"`, scripts `test`/`typecheck` mirroring webui's), `tui/tsconfig.json` extending the root config; add `"tui"` to root `workspaces`; `npm install @earendil-works/pi-tui@^1.1.0` at the root; add `tui/**` to the root `vitest.config.ts` exclude list.
- [ ] **Step 4: Run test to verify it passes** — the scaffold test passes; root `npm test` still green.
- [ ] **Step 5: Commit** — `feat(tui): workspace scaffold + pi-tui dependency`

### Task 2: Server auth hook (the identity seam)

**Files:**
- Modify: `src/server/index.ts` (add a request-hook + conversation-create stamping)
- Test: `test/auth-hook.test.ts`

**Interfaces:**
- Consumes: nothing new — the hook runs inside `createServer`.
- Produces: every request's resolved identity available as `request.sigrunUser: string | undefined`; conversation-create/fork/import stamps `SessionMeta.owner` from it. The header name is exactly `X-Sigrun-User`.

- [ ] **Step 1: Write the failing tests** — `test/auth-hook.test.ts`:
  - `POST /v1/conversations` with header `X-Sigrun-User: alice` → `GET /v1/conversations/:id/meta` returns `owner: "alice"`.
  - Same POST without the header → request succeeds, `owner` absent (naive mode, Review Focus 4).
  - Fork and import inherit the identity of the caller (header present on the fork/import request → the new conversation carries that owner, not the source's).
- [ ] **Step 2: Run to verify they fail** — `owner` is never stamped today.
- [ ] **Step 3: Implement the hook** — in `createServer`, a Fastify `onRequest` (or `preHandler`) hook reads `request.headers["x-sigrun-user"]`, trims it, and sets `request.sigrunUser` (empty/absent → `undefined`). In the create/fork/import routes, pass the resolved identity into the conversation's initial session-meta commit (the create route already commits an initial meta; extend it with `owner` when present). The hook verifies nothing — documented trusted-network behavior.
- [ ] **Step 4: Run tests to verify they pass.**
- [ ] **Step 5: Commit** — `feat(server): auth hook — X-Sigrun-User → SessionMeta.owner at conversation create`

### Task 3: Durable conversation enumeration

**Files:**
- Modify: `src/server/index.ts:625-646` (the `GET /v1/conversations` route)
- Modify: `src/harness/boot.ts` (expose the storage handle on `OpenedHarness`)
- Test: `test/conversation-enumeration.test.ts`

**Interfaces:**
- Consumes: `OpenedHarness` (boot.ts).
- Produces: `OpenedHarness.storage` (the pi-durable `Storage` handle from `boot.ts:268`), and `GET /v1/conversations` returns ALL durable conversations (not just the in-memory tracked set), each with `id`, `root`, `entryCount`, and `owner` when set.

- [ ] **Step 1: Write the failing test** — create a conversation via the API, then build a SECOND server against the same storage file (the restart case, Review Focus 5): `GET /v1/conversations` on the new server must list the conversation. Also assert a cron-created conversation (created through the harness directly, not the route) appears.
- [ ] **Step 2: Run to verify it fails** — the tracked-set listing forgets the conversation on the second server.
- [ ] **Step 3: Implement** — add `storage` to the object `openHarness` returns (it's already in scope at `boot.ts:268`); in the route, replace the `trackedConversations` loop with `storage.scanConversations(query, limit, cursor, BACKGROUND_CONTEXT)` and resolve each record's view for `entryCount` (the route already does this per-id via `readView`). Keep the `trackedConversations` set ONLY as a fallback fast-path removal is fine — delete it; the storage scan is authoritative. Update the module docstring's "Conversation listing gap (v1)" note (index.ts:27-33) to reflect the fix.
- [ ] **Step 4: Run tests to verify they pass** — the restart test and the cron test green; `test/server.test.ts` still green.
- [ ] **Step 5: Commit** — `feat(server): durable conversation enumeration via scanConversations`

### Task 4: TUI client — API + SSE layers

**Files:**
- Create: `tui/src/api.ts` (typed client over the wire types)
- Create: `tui/src/sse.ts` (the SSE watcher)
- Test: `tui/test/api.test.ts`, `tui/test/sse.test.ts`

**Interfaces:**
- Consumes: wire types from the spec's §4.2 list (`ConversationList`, `ConversationViewWire`, `SubmissionResponse`, `InteractionList`/`InteractionWire`, `AmbientList`/`AmbientWire` — import the shapes the webui's `webui/src/api.ts` already declares, or re-declare them; the plan leaves the sharing decision to the builder per spec §9).
- Produces:
  - `class SigrunClient` with methods: `listConversations()`, `getConversation(id)`, `createConversation()`, `forkConversation(id)`, `submit(id, text, whenBusy)`, `abort(id)`, `compact(id)`, `getMeta(id)`, `patchMeta(id, patch)`, `listInteractions(id)`, `answerInteraction(id, callId, answer)`, `getAmbient(id)`, `getCommands()`, `getSettings()`. Every method sends the configured `X-Sigrun-User` header.
  - `watchConversation(id, onSnapshot, onFrame, onError)` → returns an `unwatch()` function. Reconnects on stream drop; a reconnect's fresh snapshot REPLACES state wholesale (Review Focus 1).

- [ ] **Step 1: Write the failing tests** —
  - `api.test.ts`: against a stub Fastify server (or `fetch` mock), every method issues the right request AND carries the `X-Sigrun-User` header.
  - `sse.test.ts`: a fake SSE endpoint (node `http` server writing frames) — `watchConversation` delivers the snapshot then frames; kill the connection, emit a revision on the "reconnect", assert `onSnapshot` fires again and replaces state (no stale merge).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — `api.ts` is thin `fetch` wrappers (Node 22 global `fetch`), JSON parse, non-2xx → typed error carrying the server's error body. `sse.ts` reads the response body as a stream, parses `event:`/`data:` frames, and on close retries with backoff, always treating a fresh snapshot as authoritative (the server sends one on every connect).
- [ ] **Step 4: Run tests to verify they pass.**
- [ ] **Step 5: Commit** — `feat(tui): api client + sse watcher`

### Task 5: CLI entrypoints — `sigrun` / `sigrun serve` / `sigrun attach`

**Files:**
- Create: `src/cli.ts` (the subcommand switch)
- Modify: `package.json` (`"bin": { "sigrun": "src/cli.ts" }`; adjust `start` to route through it)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (src/config.ts), `openHarness`, `createServer`, and the TUI entry from Task 8.
- Produces: `parseArgs(argv)` → `{ command: "run" | "serve" | "attach", server?: string, user?: string }`; and the three behaviors wired: `run` boots harness+server+TUI in-process, `serve` boots harness+server only, `attach` boots the TUI against `--server` (default `http://localhost:${SIGRUN_PORT ?? 3000}`).

- [ ] **Step 1: Write the failing tests** — `parseArgs`: bare → `{command:"run"}`; `serve` → `{command:"serve"}`; `attach --server https://x` → `{command:"attach", server:"https://x"}`; `attach` → localhost default; unknown subcommand → usage error, non-zero exit intent. (Keep process-launch behavior out of unit tests — test the parse and the wiring seams with injected factories.)
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement the switch** — `src/cli.ts`: parse argv, then dispatch. `run`: `loadConfig(process.env)` → `openHarness` → `createServer` → listen → launch the TUI against `http://localhost:<port>`; when the TUI exits, shut the server+harness down (the spec's lifecycle rule: the agent dies with the TUI). `serve`: the same minus the TUI, with the existing SIGTERM/SIGINT graceful shutdown. `attach`: no harness boot; launch the TUI against the resolved server URL, carrying `--user`/`SIGRUN_USER` into the client config. Keep `src/index.ts` as the deploy entry (the cluster keeps running the monolith); the CLI imports it or reuses its composition.
- [ ] **Step 4: Run tests to verify they pass.**
- [ ] **Step 5: Commit** — `feat(cli): sigrun / serve / attach entrypoints`

### Task 6: TUI shell — layout, sidebar, conversation pane

**Files:**
- Create: `tui/src/ui/app.tsx` (or `.ts` — pi-tui's rendering idiom), `tui/src/ui/sidebar.ts`, `tui/src/ui/conversation-pane.ts`
- Test: `tui/test/app.test.ts`

**Interfaces:**
- Consumes: `SigrunClient` + `watchConversation` (Task 4); pi-tui components (`SelectList` for the sidebar, `ScrollView`/`Markdown` for the conversation).
- Produces: the runnable TUI shell: sidebar left (conversation list, `+ new`, active marked), conversation pane right (entries rendered top-to-bottom: user prompts, assistant text streaming, thinking blocks, tool calls as compact rows), composer footer (a pi-tui `Editor`).

- [ ] **Step 1: Write the failing tests** — the app renders against a stub client: the sidebar lists conversations from `listConversations()`; selecting one swaps the pane's conversation; the pane renders a `ConversationViewWire`'s entries in order (user/assistant/tool/thinking). Render-to-string or component-state assertions, whatever pi-tui's test idiom supports — the tests pin structure, not pixels.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement the shell** — wire the sidebar to `listConversations()` (refresh on focus/interval), the pane to `watchConversation(id)` (snapshot replaces, frames append per the SSE contract), the composer to `submit(id, text)`. Fork action: a keybinding/command on the current conversation → `forkConversation(id)` → refresh sidebar → switch to the fork.
- [ ] **Step 4: Run tests to verify they pass.**
- [ ] **Step 5: Commit** — `feat(tui): shell — sidebar, conversation pane, composer`

### Task 7: Composer behaviors — steer, abort, slash-commands, error surfacing

**Files:**
- Modify: `tui/src/ui/conversation-pane.ts`, `tui/src/ui/composer.ts` (new if the composer is its own component)
- Test: `tui/test/composer.test.ts`

**Interfaces:**
- Consumes: `SigrunClient.submit(id, text, whenBusy)`, `abort(id)`, `getCommands()` (Task 4).
- Produces: the pi-idiom composer: submit is fire-and-forget (the SSE stream is the source of truth); type-while-running queues a steer (`whenBusy`); Esc aborts; `/`-prefixed input routes to the slash-command catalog; immediate 4xx responses render visibly in the pane.

- [ ] **Step 1: Write the failing tests** —
  - Submit while idle → POST without `whenBusy`; while a run is live → POST with the steer field set.
  - Esc during a live run → `abort(id)` called.
  - A 400 response (Review Focus 2) renders the server's error in the pane; an abort racing settlement (Review Focus 3) surfaces cleanly.
  - `/fork` in the composer hits the fork path (the catalog's command → endpoint mapping), `/compact` hits compact.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — the composer never awaits the POST for the reply (it awaits only for the immediate error path); the pane keeps rendering off the SSE stream. Esc binding on the editor. Slash-command catalog fetched once and cached; unknown commands show a clear error.
- [ ] **Step 4: Run tests to verify they pass.**
- [ ] **Step 5: Commit** — `feat(tui): composer — steer, abort, slash commands, error surfacing`

### Task 8: Interaction + ambient rendering (the parity rule)

**Files:**
- Create: `tui/src/ui/interactions.ts`, `tui/src/ui/ambient.ts`
- Modify: `tui/src/ui/app.ts` (mount them)
- Test: `tui/test/interactions.test.ts`, `tui/test/ambient.test.ts`

**Interfaces:**
- Consumes: `listInteractions(id)`, `answerInteraction(id, callId, answer)`, `getAmbient(id)` (Task 4); the wire types `InteractionWire`/`AmbientWire`.
- Produces: the pending-interaction stack rendered in the conversation pane (the channel-agnostic seam's TUI renderer — the webui renders cards, the TUI renders an answerable prompt/list), and ambient surfaces placed in the TUI's chrome per the seam's `place` field (status/footer/panel → statusline/footer/panel — spec §8 leaves the exact mapping to the builder).

- [ ] **Step 1: Write the failing tests** —
  - Interactions: a pending interaction renders its prompt and options; answering POSTs the decision and the item clears on the next list. Multiple pending items stack.
  - Ambient: an ambient record with `place: "status"` renders in the statusline; `place: "footer"` in the footer; `refreshMs` triggers re-fetch; `expires: "idle"` entries disappear when idle.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — poll `listInteractions` on SSE frames (each revision may change the pending set) and on a short interval; render the top pending item as the pane's prompt. Ambient: fetch on connect + on `refreshMs`, render per `place`. Keep both renderers generic over the record kinds — the seam's whole point is that the TUI doesn't know what an "approval" is.
- [ ] **Step 4: Run tests to verify they pass.**
- [ ] **Step 5: Commit** — `feat(tui): interaction + ambient seam rendering`

### Task 9: End-to-end smoke + docs

**Files:**
- Create: `tui/test/e2e.test.ts` (boot a real harness+server on an ephemeral port, drive the client layers headlessly)
- Modify: `README.md` (the `sigrun`/`serve`/`attach` story), `AGENTS.md` (the tui workspace note)
- Modify: `docs/superpowers/specs/2026-10-13-sigrun-tui.md` (mark the design implemented, link the plan)

**Interfaces:**
- Consumes: everything above.
- Produces: a green e2e proving the full path: `attach`-mode client against a real server — list → create → submit (with a faux provider) → SSE stream renders → fork → interaction round-trip (a fixture extension producing a pending interaction) → identity header stamps `owner`.

- [ ] **Step 1: Write the failing e2e test** — the full path above against a real `createServer` instance (the repo's existing test-server pattern) with the `SigrunClient` + SSE watcher from Task 4 driving it headlessly (no terminal — the UI layer is tested in 6–8; this proves the wire path end-to-end).
- [ ] **Step 2: Run to verify it fails** (no client exists to drive it until wired).
- [ ] **Step 3: Wire the e2e + write the docs.**
- [ ] **Step 4: Run to verify it passes** — plus the full suite: `npm test`, `npm --workspace @sigrun/tui run test`, `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(tui): e2e smoke + docs`

---

## Self-review notes (run per the skill)

- **Spec coverage:** every spec section maps to a task — §3.1 CLI (T5), §3.2 layout (T6), §4.1 stack (T1), §4.2 client shape (T4), §5 auth seam (T2 + client header in T4), §6 interaction/ambient (T8), §7 constraints (global), §10 enumeration (T3) + composer (T7), parity rule (T6–T8), fork (T6), deletion-absent/archive (T6 sidebar filtering), settings-consumes-defaults (T4 `getSettings`, no TUI panel per spec).
- **Type consistency:** `SigrunClient` method names are defined once (T4) and consumed by name in T5–T9; `watchConversation` signature likewise. Wire types come from the spec's list (InteractionWire/AmbientWire, not the retired ApprovalSummary).
- **Proportion:** tasks are interface-and-test shaped; no step contains a body the signature and test already determine.
- **Open items deliberately left to the builder (per spec §8/§9):** pi-tui widget internals, sidebar keybindings, `/` menu rendering, fork-point selection (default fork-at-latest), subcommand arg-parsing mechanism, config filename, ambient `place`→chrome mapping, webui/TUI slash-menu code sharing.
