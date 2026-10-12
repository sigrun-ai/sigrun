# Sigrun ↔ pi feature parity — implementation plan

Spec: `docs/superpowers/specs/2026-10-12-sigrun-pi-parity.md` (rev 2)

## Task 1: Built-in tools (the gate)

**Scope:** port pi's tool surface to sigrun core. pi-durable ships `CodingTools` (`read`, `write`, `edit`, `bash`) — install those four. Hand-write `find`, `grep`, `ls` against `ExecutionEnv` (no glob/grep primitive exists upstream).

**Sub-tasks:**

- **T1a: Install pi-durable CodingTools.** `openHarness` installs `CodingTools` alongside the existing extensions. The tools operate on the conversation's `conversationEnv` (the existing seam). Test: read/write/edit/bash work end-to-end via the server.

- **T1b: Hand-write `find`/`grep`/`ls`.** TS implementations against `ExecutionEnv` (`listDir`, `readTextFile`, `fileInfo`, `exists`). `.gitignore` filtering: read `.gitignore` from the workspace root, apply it to `find`/`grep`/`ls` results. Test: find/grep/ls return results honoring `.gitignore`; the tools render in the webui's tool cards.

- **T1c: Image reads.** pi-durable's `read` hard-errors on images. Wrap it: if the file is an image (by extension), return the image content to the model (base64, same as the upload path). Test: reading an image file returns image content, not an error.

- **T1d: Tool card diff rendering.** The webui's `ToolResultEntry` renders name + status + raw output. Add a diff view for `edit` results (the `details` field carries the diff). Test: an `edit` tool call renders the diff in the tool card.

**Files:** `src/harness/tools.ts` (new — the CodingTools install + the hand-written find/grep/ls), `src/harness/boot.ts` (install the tools), `src/server/index.ts` (no changes — the tools flow through the existing conversation env), `webui/src/entries/ToolResultEntry.tsx` (the diff view), `test/tools.test.ts` (new).

## Task 2: Skills convention alignment

**Scope:** align the skills convention with pi. Skills are already core; this is alignment, not a move.

**Sub-tasks:**

- **T2a: Section path.** The skills section lists `- name: description`. Add the skill's path: `- name: description (path)`. The path is relative to the workspace root. Test: the section includes the path.

- **T2b: Collision rule.** pi: first-wins + warn. sigrun: last-wins. Align to first-wins. Test: duplicate skill names → the first wins, a warning is logged.

- **T2c: Frontmatter handling.** pi ignores `disable-model-invocation`; sigrun ignores all other frontmatter. Align: parse `disable-model-invocation` and skip the skill when set. Test: a skill with `disable-model-invocation: true` is not listed.

**Files:** `src/skills/index.ts`, `test/skills.test.ts`.

## Task 3: MCP servers (extension)

**Scope:** `sigrun-ext-mcp` — a new extension that registers MCP tools through the existing tools surface. Not a core slice.

**Sub-tasks:**

- **T3a: Extension skeleton.** The extension package structure (package.json, src/index.ts, the extension factory). The extension reads a `mcp.json` config (the MCP server registry) from the workspace or the config dir.

- **T3b: Server lifecycle.** Spawn MCP server processes (stdio transport), discover their tools, register them with the harness. Test: a stub MCP server connects, its tools appear, a tool call works.

- **T3c: OAuth (paste-the-URL).** The loopback listener + the webui "paste the redirect URL" input. The listener runs inside the pod on a random port; the user pastes the redirected URL into the webui; the extension extracts the code and completes the token exchange. Test: a stub OAuth flow completes with a pasted URL.

**Files:** `~/repos/sigrun-ext-mcp/` (new repo).

## Task 4: Manual compaction

**Scope:** expose `Conversation.compact(instructions)` as an endpoint + a webui affordance.

**Sub-tasks:**

- **T4a: The endpoint.** `POST /v1/conversations/:id/compact` — accepts `{instructions?: string}`, calls `conversation.compact(instructions, BACKGROUND_CONTEXT)`, returns the task id. Test: a compact produces a summary entry.

- **T4b: The webui affordance.** A "Compact" button in the conversation header (next to the context ring). Clicking it POSTs to the endpoint. Test: the button compacts; the context ring updates.

**Files:** `src/server/index.ts`, `webui/src/App.tsx` (or the conversation header component).

## Task 5: Session management

**Scope:** fork, export, import, session name.

**Sub-tasks:**

- **T5a: Fork.** `POST /v1/conversations/:id/fork` — accepts `{at?: number}` (the entry id to fork at; defaults to the latest), calls `conversation.fork(at, options, BACKGROUND_CONTEXT)`, returns the new conversation id. Test: fork a conversation, the forked copy has the parent's entries up to `at`.

- **T5b: Export.** `GET /v1/conversations/:id/export` — returns the conversation's entries as JSONL (pi's portable format). Test: export produces valid JSONL.

- **T5c: Import.** `POST /v1/conversations/import` — accepts JSONL, creates a new conversation from it. Test: import an exported conversation, the imported copy has the same entries.

- **T5d: Session name.** Add `name?: string` to the `SessionMeta` schema. The webui's session list shows the name when set. Test: set a name, it appears in the list.

**Files:** `src/server/index.ts`, `src/server/session-meta.ts`, `webui/src/sessions/SessionList.tsx`.

## Task 6: Auth readiness check

**Scope:** `/v1/auth/check` — secret-free readiness report.

**Sub-tasks:**

- **T6a: The endpoint.** `GET /v1/auth/check` — for each configured provider, report `ready | not_ready | invalid`. Readiness = the provider's auth resolves (the degenerate provider's `OPENAI_API_KEY` is set, the extension provider's auth resolves). No credential values in the response. Test: the endpoint reports readiness for the configured providers.

**Files:** `src/server/index.ts`.

## Task 7: Slash commands

**Scope:** a command registry + the composer's `/` menu.

**Sub-tasks:**

- **T7a: The registry.** A `Map<string, SlashCommand>` where `SlashCommand = { name, description, execute(args, context) }`. The commands map to endpoint calls: `/fork` → `POST /v1/conversations/:id/fork`, `/compact` → `POST /v1/conversations/:id/compact`, etc. The registry is extensible — extensions can register commands.

- **T7b: The composer menu.** Typing `/` in the composer opens a command menu. Selecting a command executes it. Unknown commands produce a clear error. Test: `/fork` in the composer creates a fork; an unknown command errors.

**Files:** `src/server/commands.ts` (new), `webui/src/composer/Composer.tsx`.

## Task 8: Settings endpoint + webui panel

**Scope:** a settings store + `/v1/settings` + a webui settings panel.

**Sub-tasks:**

- **T8a: The settings store.** A file-backed store (JSON, in the config dir) that `openHarness` reads at boot and re-reads on change. The store carries the `HarnessSettings` fields that flow through unmodified (`steeringMode`, `followUpMode`, `retry`, `stream`) plus the sigrun-resolved fields (`defaultTools` — a tool-selection filter applied at agent creation; `perModelThinking` — an `AgentChange` field).

- **T8b: The endpoint.** `GET /v1/settings` returns the current settings; `PATCH /v1/settings` updates them. The store persists the change; the harness picks it up on the next resolution.

- **T8c: The webui panel.** A settings panel in the webui (a gear icon in the top bar). The panel edits the settings and PATCHes them. Test: change `steeringMode` via the panel, it persists and the next submission steers instead of queuing.

**Files:** `src/harness/settings.ts` (new), `src/server/index.ts`, `webui/src/settings/` (new).

## Missing items (from the spec's review-caught list)

- **Prompt templates** — add to slice 7 (the command registry) as a template expansion mechanism, or a separate slice. The templates appear as commands (`/template-name args`).
- **Session name** — slice 5d.
- **Session import** — slice 5c.
- **Image reads** — slice 1c.
- **Tool diff rendering** — slice 1d.

## Ordering

1. **Task 1** (tools — the gate)
2. **Task 2** (skills alignment — cheap, unblocks read-based loading)
3. **Task 3** (MCP — extension, self-contained)
4. **Task 4** (manual compaction — the seam exists)
5. **Task 5** (session management — fork/export/import/name)
6. **Task 6** (auth readiness — secret-free)
7. **Task 7** (slash commands — the catalog)
8. **Task 8** (settings — the store + endpoint + panel)

Each task is independently shippable. Task 1 is the gate.
