# Sigrun ↔ pi feature parity spec (rev 2 — post-review)

Goal: sigrun core matches base pi's surface. Extensions come after.

**Review corrections incorporated.** Two reviewers (glm-5.3 + deepseek-v4.1-flash) verified every upstream claim against pi 1.1.0 and pi-durable 1.0.2. Four P1s changed the spec's shape:

1. **Workspace confinement does not exist** — `isConfinedPath` is HTTP-layer only; tools get unconfined shell access. This matches pi's trust model (pi's tools are equally unconfined). The spec must name this as a trust-posture statement, not a gating claim.
2. **Skills are already core** — `src/skills/index.ts` is installed unconditionally in `openHarness`. The spec's premise was stale. The real work is convention alignment (pi has no `load_skill` tool; the model loads skills via `read`).
3. **Branch summarization has no trigger** — pi-durable has no `/tree` navigation; `CompactionPolicy` has no strategy field. Dropped; replaced with manual compact + per-model overrides.
4. **Auth contradicts core §6.4** — "the API never accepts or returns credentials." Moved to a provider-side extension; core gains only a secret-free readiness check.

---

## What's in base pi that sigrun needs

### Slice 1: Built-in tools (the agent's hands)
pi: `read`, `bash`, `edit`, `write`, `find`, `grep`, `ls` + file mutation queue + output accumulator + renderers.

sigrun: no coding/file tools. The harness's tool surface is extension-provided only (`load_skill` is the sole core-installed tool).

**Work:** port pi's tool implementations to sigrun as core tools. The tools operate on the conversation's workspace env (the `conversationEnv` seam), so they inherit sigrun's workspace resolution. **Trust posture:** the tools are NOT confined — `isConfinedPath` is HTTP-layer only; a tool call's `bash` runs unconfined in the pod. This matches pi's trust model (pi's tools are equally unconfined). The spec must name this explicitly: sigrun's security model is policy-gated (approvals extension, when installed), not filesystem-gated. The core tools themselves carry no gating — they're the same tools pi ships, adapted to the ExecutionEnv.

**Tool provenance:** pi-durable ships `CodingTools` (`read`, `write`, `edit`, `bash` — ExecutionEnv-native). pi's `find`/`grep`/`ls` shell out to `fd`/`ripgrep` with `.gitignore` semantics — pi-durable's `ExecutionEnv` has no glob/grep primitive. The port installs pi-durable's `CodingTools` for the four file ops, and hand-writes `find`/`grep`/`ls` against `ExecutionEnv` (a TS walk with `.gitignore` filtering, or shell out to `fd`/`rg` — an image requirement decision).

**Default selection:** pi's default is `read`, `bash`, `edit`, `write` (grep/find/ls available, not default). Sigrun's default should match.

**Testable:** a conversation can read/write a workspace file, run a bash command, edit a file, and the webui's tool cards render the results. find/grep/ls return results honoring `.gitignore`.

### Slice 2: Skills convention alignment (NOT a move to core — skills are already core)
pi: `skills.js` core — skill discovery, loading. The model loads skills via the ordinary `read` tool (no `load_skill` tool exists in pi).

sigrun: `skillsExtension` is already core (installed unconditionally in `openHarness`, never quarantined). The `load_skill` tool is a sigrun invention.

**Work:** align the convention with pi:
- pi tells the model the skill's **path** in the section (so bundled `references/`/`scripts/` resolve); sigrun lists `- name: description` only. Add the path.
- pi's collision rule is first-wins + warn; sigrun is last-wins. Align.
- pi ignores `disable-model-invocation` frontmatter; sigrun ignores all other frontmatter. Align.
- pi has `/skill:name` (the slash command surfaces skills); sigrun has no slash commands (slice 7).
- The skill path is `skills/` (sigrun already scans this — `SKILLS_DIRECTORY = "skills"`, `src/skills/index.ts:52`).

**Decision:** keep `load_skill` as the primary mechanism (it's the only core tool; the model always has it). The section path addition enables pi's convention for models that have `read` — the model can load a skill by reading its file directly when the tools slice lands. `load_skill` is not deprecated; it's the guaranteed-available path.

**Testable:** a skill in `skills/` is discoverable, loadable via `load_skill`, and the section lists the path.

### Slice 3: MCP servers (extension, not core)
pi: `@earendil-works/pi-mcp` is a separate package. The core only validates and stores registrations; the extension connects them.

sigrun: no MCP.

**Work:** `sigrun-ext-mcp` — a new extension that registers MCP tools through the existing tools surface. The extension handles child-process lifecycle, the config store (a `mcp.json` equivalent), and OAuth token storage.

**OAuth:** pi's MCP OAuth is RFC 8252 loopback (the callback must be `localhost`/`127.0.0.1`/`[::1]`). A server-hosted callback (`/mcp/oauth/callback`) makes sigrun a web client — the authorization server must accept a non-loopback redirect URI (normally pre-registration only), and sigrun must know its own external base URL (a deployment choice core §4.4 leaves open). **Adopt pi's paste-the-URL flow:** a loopback listener inside the pod + a webui "paste the redirect URL" input. No new endpoint, no redirect-URI registration.

**Testable:** an MCP server connects, its tools appear in the harness, and a tool call through the MCP server works end-to-end.

### Slice 4: Manual compaction (NOT branch summarization, NOT per-model overrides)
pi: `/compact` (manual compaction). Per-model compaction is NOT a pi core feature — it comes from the pi-vcc extension (`overrideDefaultCompaction: true` + `modelThresholds`). The pi-durable `CompactionPolicy` type has no strategy field and no per-model map; the only seam is `CompactionHooks.beforeCompact` (decline or return a summary string — it cannot rewrite the summarizer model, which is pinned to `agent.model`).

sigrun: threshold-based only; summarizer pinned to the conversation's own model.

**Work:** expose `Conversation.compact(instructions)` (the pi-durable API exists — `types.d.ts:448`) as a `POST /v1/conversations/:id/compact` endpoint + a webui affordance (a "Compact" button in the conversation header). Per-model compaction is a sigrun-side extension concern (a `beforeCompact` hook that self-summarizes with a configured summarizer — pi-vcc style), not a core slice.

**Testable:** a manual compact via the endpoint produces a summary entry; the webui shows the compaction.

### Slice 5: Session management (fork + export, NOT resume)
pi: fork (duplicate a session), export (HTML or JSONL), picker, resume by id/name.

sigrun: conversation records in SQLite; resume already works (the M1 battery verified kill-9 → resume → continue).

**Work:** fork (`Conversation.fork(at, options)` — pi-durable's API) as a `POST /v1/conversations/:id/fork` endpoint + a webui affordance. Export to JSONL (pi's portable format; HTML is a pi-CLI convenience, not parity). Import the JSONL back (export without import is one-way). The picker is the webui's session list (already built).

**Testable:** fork a conversation, export it to JSONL, import the export, continue the imported copy.

### Slice 6: Auth readiness check (secret-free, NOT a credential store)
pi: `pi auth` — per-provider auth storage, credential print, readiness checks.

sigrun: env-var provider config only (the degenerate provider reads `OPENAI_API_KEY`).

**Work:** a `/v1/auth/check` endpoint that reports `ready | not_ready | invalid` per provider (pi's `auth check` shape). No credential print, no auth store — core §6.4: "The API never accepts or returns credentials." The credential store is a provider-side extension concern (pi-ai's `CredentialStore` contract exists; an extension implements it).

**Testable:** the endpoint reports readiness for the configured providers.

### Slice 7: Slash commands (thin catalog over other slices' endpoints)
pi: `/new`, `/resume`, `/name`, `/session`, `/fork`, `/clone`, `/compact`, `/import`, `/export`, `/model`, `/thinking`, `/login`, `/logout`, `/settings`, `/skill:name`, prompt templates, extension commands.

sigrun: none.

**Work:** a command registry that maps command names to endpoint calls. The commands are a thin catalog over the other slices' endpoints (`/fork` → the fork endpoint, `/compact` → the compact endpoint, etc.). The webui's composer gets a `/` menu.

**Scope:** only the server-reachable commands. TUI-only commands (`/tree`, `/hotkeys`, `/reload`, `/trust`, `/changelog`, `/quit`, `/copy`, `/bug`, `/share`, `/llama`, `/scoped-models`) are pi-CLI artifacts with no sigrun surface. `/login` and `/logout` are NOT in the core catalog — core §6.4: "The API never accepts or returns credentials." They appear only when a provider-auth extension ships (pi's `pi auth` is the CLI surface; sigrun's equivalent is the extension's own tooling).

**Testable:** `/fork` in the composer creates a fork; `/compact` compacts; an unknown command produces a clear error.

### Slice 8: Settings endpoint + webui panel (split: server store + webui preferences)
pi: `settings-manager.js`, `keybindings.js`, `model-config.js` — interactive config TUI.

sigrun: env-var config only.

**Work:** split into two parts:
- **8a (server):** a settings store (file-backed, read at every resolution — pi-durable's `HarnessSettings` is "read at every resolution and never copied; getters are fine") + a `/v1/settings` endpoint. The settings that flow through `HarnessSettings` unmodified: `steeringMode`/`followUpMode`, `retry`, `stream`. The settings sigrun resolves itself (not `HarnessSettings` fields): `defaultTools` (a tool-selection filter applied at agent creation), per-model thinking levels (an `AgentChange` field). The boot refactor: `openHarness` currently builds a frozen settings literal; the store makes it live.
- **8b (webui):** a settings panel in the webui (the webui is the primary surface, CONTEXT §3.4). Keybindings are terminal-only (pi's `keybindings.js` maps `tui.*` actions to key sequences); browser shortcuts are webui-local, not a server endpoint.

**Testable:** change `steeringMode` via the webui, it persists and the next submission steers instead of queuing.

## Missing from pi's core surface (caught by review)

1. **Prompt templates** — a first-class pi core resource (`dist/core/prompt-templates.js` — `loadPromptTemplates`, `expandPromptTemplate`, `parseCommandArgs`; the resource-loader wires them). sigrun has none. Add to slice 7 (the command registry) or a separate slice.
2. **Session name** — pi's `/name`. sigrun's `SessionMeta` has no name field (`pinned|tagged|archived|draft|source|owner`). Add `name` to the session meta schema (slice 5).
3. **Session import** — pi's `/import <path>`. Export without import is one-way. Add an import endpoint (JSONL) to slice 5.
4. **Image reads** — pi's `read` returns image content to the model; pi-durable's `read` hard-errors. Add image content to the read tool (slice 1).
5. **Tool `details` / diff rendering** — pi's tools return details (truncation, edit diff); sigrun's card renders name + status + raw output only. Add a diff view to the tool card (slice 1).

## Ordering

1. **Tools** (nothing works without them; the trust-posture decision is here)
2. **Skills convention alignment** (cheap; the section path fix unblocks `read`-based loading)
3. **MCP** (extension; self-contained)
4. **Manual compaction** (the seam exists)
5. **Session management** (fork/export/import + session name)
6. **Auth readiness** (secret-free check only)
7. **Slash commands** (the catalog over the endpoints)
8. **Settings** (the store + the endpoint + the webui panel)

Each slice is independently shippable. The tools slice is the gate — everything else assumes the tools exist.
