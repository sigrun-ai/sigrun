# Sigrun codemode/tool-search/MCP-exposure parity spec (rev 1)

Goal: sigrun matches pi 1.1.0's deferred-tool architecture: the `codemode` script tool, the `tool_search` model tool, and the MCP exposure model that routes MCP tools through them. `llama.cpp` is ruled OUT of parity scope (user decision 2026-10-13).

**Provenance:** every pi claim below was verified against the installed pi 1.1.0 dist (`/home/linuxbrew/.linuxbrew/Cellar/pi-coding-agent/1.1.0/...`) during this session, not from memory. Verification notes inline.

## Why

The pi-parity branch (merged at 5407523) covered pi's eight original slices but missed pi's **built-in extension set** — the parity spec enumerated surfaces (tools, skills, MCP, compaction, sessions, auth, commands, settings), never `dist/extensions/`. pi 1.1.0 ships exactly four built-ins (`llama.cpp`, `codemode`, `tool-search`, `mcp`); three are in this spec's scope. They are one coupled feature family: MCP tools stay out of the model's tool declarations by default (`exposure: "codemode"`), reachable only through codemode scripts (`searchTools()`) or `tool_search` (`exposure: "deferred"`), which keeps tool-bloat out of every request — the exact problem sigrun's seven core tools plus MCP direct-declaration will hit as servers grow.

**pi's architecture (verified):**
- `dist/extensions/index.js` exports `builtInExtensions = [llama.cpp, codemode, tool-search, mcp]`, all `replaceable: true`, enabled by default, excludable via the `extensions` setting.
- Replacement is per-registered-name: "Leave this extension out when another extension registers a tool, command, or flag with a name it registers during loading" — an extension registering a tool named `codemode` replaces that builtin *independently* of `tool_search` and vice versa. The MCP extension activates `codemode` when servers use codemode exposure, activates `tool_search` instead for `deferred`, and `autoEnableCodemode: false` severs the MCP→codemode coupling.
- The sandbox engine is the separate package `@earendil-works/pi-codemode` ("Sandboxed JavaScript execution where the only capability is calling injected tools") — QuickJS WASM (`loadQuickJSWasm`), `parseCodemodeSource` (`// @options:` prefix), `renderDeclarations` (tool signatures as TS), and the store/prelude limits.
- The BM25 ranker (`Bm25Ranker`, `tokenize`, `createToolSearchDocument`) is shared by codemode's `searchTools()` and the `tool_search` tool; pi's own comment: "BM25 today; a hybrid ranker with embeddings can replace it."

## Packaging decision (user ruling, from the replacement-seam question)

**Two extension repos + one shared micro-package**, mirroring pi's split:

- `~/repos/sigrun-ext-codemode` — the `codemode` tool.
- `~/repos/sigrun-ext-tool-search` — the `tool_search` tool.
- `~/repos/sigrun-tool-ranker` — the shared ranker (tokenize + document builder + BM25). Controller call: a third micro-package rather than duplicating ~100 lines, because it is ALSO the seam an embedder replaces (pi's own interface comment invites a hybrid/embedding ranker); both extension repos depend on it.

Rationale (user question → answer): per-surface replacement is real — replace tool-search with an embedding ranker while keeping codemode; replace codemode with a Python sandbox while keeping tool-search; run tool-search-only with `autoEnableCodemode: false`. One glued repo would delete a replacement seam pi deliberately keeps separate. The 2026-10-06 extension-separation ruling (extensions in separate repos, no first-party favoritism) applies: sigrun core gains NOTHING in this spec.

## The sigrun seams (verified against pi-durable 1.0.2 + the merged branch)

1. **Deferred-tool loading = `ToolControl.addTools`** (verified: `harness/types.d.ts:83` — a tool result may carry `control: { addTools: names }`; generation applies it post-round, "array gets each name it lacks appended, `{remove}` loses the names" per agent.js:49-58). Durable, fork-aware, transcript-recorded. `tool_search`'s "loading" = returning `addTools` from its result. (The `AgentChange.tools` array form is a full replacement and the object form remove-only — NOT the seam; settled from code.)
2. **Codemode nested tool calls: THE OPEN ARCHITECTURE QUESTION — see "The nested-call seam" below.** pi runs nested calls through the agent loop's tool pipeline (`ctx.executeTool`); pi-durable 1.0.2 has NO equivalent (verified: `ToolExecutionApi` exposes no `executeTool`, and the built-in `ToolTask` resolves calls only from a committed assistant entry). The user rules the choice before planning.
3. **The `codemode-store` entry maps to a typed entry** (`pi.*`-style): `CODEMODE_STORE_ENTRY_TYPE = "codemode-store"` with `{set, delete}` data — pi-durable's `defineEntry` + `appendEntry` (the fork-aware session entries T5's import already manipulates). Fork semantics: "each branch sees the values written on its own path" — free with fork-aware history.
4. **Activation = documented no-op + warning.** pi registers codemode/tool_search "inactive" and activates via `defaultTools`; pi's own MCP extension, finding neither active, only WARNS ("MCP tools are only reachable… neither is active"). Verified: extension factories take no arguments (loader contract), and no settings-store handle crosses into extension-land — an extension cannot PATCH `defaultTools`. Sigrun matches pi's actual behavior: the MCP extension warns when codemode/tool_search is not in `defaultTools`; the user adds it via the T8 settings panel. (Sigrun's eager factory-time MCP connect makes pi's `ensureDiscoveryActive`-at-session-start moot in the good direction.)

## The nested-call seam (OPEN — user rules before planning)

pi's codemode runs nested tool calls through the agent loop's pipeline, so validation, `tool_call`/`tool_result` hooks, and permission checks apply to them exactly as to direct calls. pi-durable 1.0.2 has no equivalent (verified by the builder check): `ToolExecutionApi` exposes no `executeTool`, and the built-in `ToolTask` resolves calls only from a committed assistant entry — an ad-hoc nested call cannot ride it. The options:

- **(i) Direct invocation (extension-side):** the codemode tool looks the callee up in `api.registry` and calls `tool.execute(args)` itself, fabricating the nested api. Keeps "core gains nothing." Loses validation/hooks/permission parity for nested calls (the spec's advertised property), and some tools may misbehave under a fabricated api (taskId/callId/commit semantics per callee are unverifiable).
- **(ii) Upstream seam (pi-durable change):** add `executeTool` to `ToolExecutionApi` (or a `ToolTask` input variant accepting inline calls). Full pi parity, hooks/permissions exact. Cost: a pi-durable fork PR or dependency patch — violates "sigrun core gains nothing" at the DEPENDENCY level; pi-durable is pinned at 1.0.2 and has never been forked here.
- **(iii) Conversation round-trip:** the nested call becomes a real submitted turn. Wrong on its face: destroys "only the script's output reaches the model" and the latency profile.

Controller recommendation if forced: **(i) for v1**, honestly documented (nested calls bypass hooks/permissions — stated in the README and the trust-posture line), with **(ii) as the follow-up upstream PR** when the gap bites. NOT settled — this changes slice 1's architecture.

## Slice 1: `sigrun-ext-codemode`

**What ships:** a separate repo exporting the loader-contract factory (default export → `{extension}`) whose extension registers ONE tool named `codemode`. Tool input schema: `{ code: string }`. The tool:
- parses the script via `@earendil-works/pi-codemode`'s `parseCodemodeSource` (the `// @options:` line, `max_output_tokens`/`timeout_ms` today — the package's `CodemodeSourceOptions`);
- runs it in `CodemodeSandbox` (QuickJS WASM, `loadQuickJSWasm`);
- injects a `tools` surface: `searchTools(query)` (ranked via sigrun-tool-ranker), `ALL_TOOLS`, `describeNamespace()`/`describeTool()`, and nested calls per "The nested-call seam" ruling below, with id shape `<codemode call id>/<n>` and the call record in the tool result's `details.calls` (pi's own `CodemodeToolDetails` location);
- provides `text()`, `image()`, `exit()`, `store(key, value)`/`load(key)` (JSON values; writes append `codemode-store` entries), `console.*`, `return <value>`;
- results: "Script completed"/"Script failed" header + partial output on failure; `isError` mapping per pi;
- resolves nested results per pi's rules: `outputSchema` tools → `structuredContent`; others → text content as one string; failed/blocked calls → Error carrying the tool's error text.

**Store persistence:** `store()` writes become `codemode-store` typed entries on the conversation (appendEntry inside the tool's own commit boundary); `load()` reads the branch's entries newest-first. Without a session context, `store()` starts empty and writes are dropped (pi's exact degraded mode).

**Limits (inherited from the package):** `MAX_OUTPUT_CHARS`, `MAX_OUTPUT_ITEMS`, `MAX_STORE_TOTAL_CHARS`, `MAX_STORE_VALUE_CHARS`, `DEFAULT_INPUT_SCHEMA_MAX_CHARS` — do not re-tune; the package's limits ARE the parity surface.

**Non-goals:** the `models.*` namespace (pi's model catalog/classifiers/image-gen for scripts — sigrun's degenerate provider surface has no classifier/image API to expose; defer until a provider extension ships one); `codemode.mode`/`inlineBudget` settings (pi CLI presentation concerns — sigrun has no tool-declaration rendering budget yet; defer).

**Testable:** the model calls `codemode` with a script that calls `read` on a workspace file and returns its content; `store`/`load` round-trip across two script calls; a failing script yields a partial-output error result; nested call records appear in the result's `details.calls`.

## Slice 2: `sigrun-ext-tool-search`

**What ships:** a separate repo, factory → `{extension}`, ONE tool named `tool_search`. Input schema: `{ query: string, limit?: number }` (default 8). It:
- builds the searchable document set from the conversation's agent tool roster EXCLUDING tools already declared (the deferred set — in sigrun terms: tools registered by extensions but filtered out by the conversation's current `AgentState.tools`/defaultTools);
- ranks via sigrun-tool-ranker (the exact `createToolSearchDocument` text shape: name, name with `_` as spaces, description, schema property names/descriptions, namespace + description);
- "loads" matches by returning `control: { addTools: matched }` from the tool result (the `ToolControl.addTools` seam — pi-durable applies it durably post-round);
- result: matched tools' name+description list + `details.loaded` (the names now declared for the next model call);
- the description does NOT enumerate tools (constant while tools register — pi's exact constraint, "so it stays the same while tools are registered, for example when MCP servers connect").

**Testable:** with an MCP server connected in `codemode` exposure, `tool_search("echo")` returns the server's tool and a subsequent model call can invoke it directly; already-declared tools (the 7 core) are not re-listed as matches; the loaded set survives a fork.

## Slice 3: MCP exposure model (upgrade `sigrun-ext-mcp`)

**What changes in `~/repos/sigrun-ext-mcp`:** the config schema gains per-server `exposure?: "codemode" | "deferred" | "direct" | "hidden"` (default `codemode`), per-tool `toolExposure?: Record<string, McpExposure>` (exact name wins over patterns; first pattern wins among patterns; `hidden` removes), `enabled?: boolean` (default true), per-request `timeout?: number` (seconds; progress notifications reset; default 60). `codemode-deferred` accepted as alias (pi compat).

**Registration behavior:**
- `direct`: tools declared to the model as today (the current behavior — backward compatible for existing configs ONLY if users opt in; **default flips to `codemode`** per pi parity — a breaking config change, ruled below);
- `codemode`: tools registered but NOT declared; callable from codemode scripts; the extension WARNS when the `codemode` tool is not active (not in `defaultTools`) — pi's own no-op-with-warning behavior (verified: mcp/index.js:423-424), since extension factories cannot reach the settings store;
- `deferred`: tools registered but not declared; reachable via `tool_search` (the tool-search extension warns the same way when `tool_search` is not active);
- `hidden`: unreachable;
- an `mcp_servers` prompt section lists every enabled server with codemode/deferred tools (name + description + how its tools are reached) — mirrors sigrun's skills-section budget pattern (4KB cap, whole-line truncation).

**Breaking-change ruling (controller):** the default exposure flips from our current implicit-direct to pi's `codemode`. Existing mcp.json files without explicit `exposure` change behavior after upgrade. Cost: one-time config edit (`"exposure": "direct"`) for users who want the old behavior; justified by parity being the point of this spec. Recorded here for the user to overrule.

**Non-goals (deferred, tracked):** MCP resources (`list_mcp_resources` etc.), OAuth upgrades (dynamic client registration/CIMD — our PKCE flow stands), the `/mcp` manager command surface (sigrun's command registry is endpoint-backed; an mcp command arrives with the extension-command-surface slice), HTTP transport (stdio stands), background connection ordering ("the first prompt waits only for direct servers" — sigrun connects eagerly at factory time; revisit with the loader ready-seam follow-up).

**Testable:** a server with default exposure connects, its tools appear to `tool_search` but NOT in the conversation's declared tool list; `exposure: "direct"` declares them; `toolExposure` overrides per-tool; `hidden` removes; a tool call through codemode nested-execution works end-to-end; `codemode-deferred` alias resolves.

## Slice 4: replacement/activation wiring (small, core-adjacent but NO core code)

The loader-contract already gives every extension a clean replacement story: a user who wants a different `tool_search` simply doesn't install `sigrun-ext-tool-search` and installs their own registering the same tool name (the registry's tool surface is name-addressed). **No sigrun-core change is needed for replacement.** This slice exists to make that TRUE and tested:
- document the per-name replacement convention in each repo's README;
- test: installing a stub extension registering a tool named `tool_search` alongside (not instead of) sigrun-ext-tool-search produces a loud conflict (sigrun's registry install-replaces per EXTENSION name — verify which semantics apply and make the conflict visible, not silent; if the core registry's replace-on-extension-name makes per-tool replacement impossible without core changes, PARK the slice with that finding — do not quietly change core).

**Testable:** documented + a conflict test that fails loud.

## Ordering

1. **sigrun-tool-ranker** (leaf, no deps) — 1 dispatch.
2. **sigrun-ext-codemode** (depends on ranker + pi-codemode pkg) — 2-3 dispatches (skeleton/store/entry; sandbox+nested calls; polish+tests).
3. **sigrun-ext-tool-search** (depends on ranker; the configure seam) — 1-2 dispatches.
4. **sigrun-ext-mcp exposure upgrade** (depends on both existing for activation) — 2 dispatches.
5. Slice 4 wiring + tests — 1 dispatch.

Each independently shippable; codemode and tool-search are separable but the MCP exposure flip (slice 3) should not default to `codemode`/`deferred` until slices 1-2 exist — the ordering above guarantees that.

## Open items for planning (not spec-level)

- The nested-call seam ruling (above) — resolved by the user first.
- The ranker package's publish shape (local path deps during dev, like the-work-fabric-scrubbed's file: shape).
