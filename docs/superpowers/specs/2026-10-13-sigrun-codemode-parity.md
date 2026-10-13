# Sigrun codemode/tool-search/MCP-exposure parity spec (rev 2)

Goal: sigrun matches pi 1.1.0's deferred-tool architecture — the `codemode` script tool, the `tool_search` model tool, and the MCP exposure model — by upgrading pi-durable to 1.2.0 (which shipped all three seams upstream) and adding the thin sigrun-side wiring the upgrade does not provide. `llama.cpp` remains ruled OUT (user decision 2026-10-13).

**Parity philosophy (user ruling 2026-10-13):** "works like `pi` feels" — sigrun is in the spirit of pi, not a replica. Where sigrun's architecture (extension separation, webui surface, durable pod) gives a different-but-equivalent shape, that shape wins over pixel parity.

**Provenance:** every pi-durable 1.2.0 claim below was verified against the published tarball (npm-packed, read directly), and every pi 1.1.0 claim against the installed dist. Rev 1 was reviewed by two cross-family reviewers (kimi-k3, deepseek-v4.1-flash); rev 2 incorporates every one of their findings — the three P1s all dissolved or transformed in the 1.2.0 upgrade, as detailed inline.

## Why

Rev 1's blocker was that pi-durable 1.0.2 had no concept of tool exposure: registration *is* declaration, one filtered list serves the model and everything else. Both reviewers found the same three walls (per-server exposure had no seam; `store()/load()` had no read path; the registry shadows duplicate tool names silently). Upstream fixed all three: GitHub issues #10455/#10728 (opened for exactly this codemode use case, closed "fixed on main" 2026-10-12) shipped in **pi-durable 1.2.0**:

- `ToolRegistration.callers: ("model"|"tools")[]` — who may call a tool; "tools behind code mode, such as MCP tools, can be `["tools"]`, so the model is never offered them."
- `ToolRegistration.deferred: true` + `AgentState.modelTools: {remove?, add?}` + `control.addTools` writing to `add` — deferred tools invisible to the model until loaded, loads append in order, durable and fork-aware; `Agent.callable` and `Agent.deferred` are the separate sets.
- `api.executeTool(name, args, context, options)` — nested calls through the real pipeline (validation, ToolTask hooks with `parent`, output limits, replay policy, own task/call IDs owned by the caller, `NestedCallDoc`, `pi.live.nestedTools`, abort propagation).
- **pi-durable 1.2.0 ships codemode and tool-search itself**: `@earendil-works/pi-durable/codemode` (`createCodemodeExtension({sandbox, namespaces?, inlineBudget?, models?})` — journal-based deterministic replay across restarts, `searchTools()`, `describeTool()`/`describeNamespace()`, per-conversation `store()/load()` "forked as of the fork's entry", `structuredOutput` resolution, grammar-constrained sampling declaration) and `@earendil-works/pi-durable/tool-search` (`createToolSearchExtension()` — the coding agent's BM25 tool_search over `agent.deferred`).

So the build shrinks from "port three extensions" to "upgrade + thin wiring." The sigrun-side work that remains is real and itemized below.

## Task 0: the pi-durable 1.0.2 → 1.2.0 upgrade (the gate)

A breaking-change compatibility pass over the merged pi-parity code, NOT a version bump. Itemized from 1.2.0's changelog, cross-referenced with both reviewers' upgrade-risk findings:

**Must fix at upgrade (breaking):**
1. `ToolExecutionResult.content` → `output`, next to new `structuredOutput` — our T1 read-wrapper, tool-result view serialization, and the pinned view schema (`test/schema-drift.test.ts` recapture + `webui/src/schema-version.ts`) all touch it. **AND the three extension repos, independently pinned at 1.0.2** (`sigrun-ext-mcp`, `sigrun-approvals`, `sigrun-memory-markdown` — each pins `@earendil-works/pi-durable: 1.0.2` in package.json + lockfile, and each returns the removed `content:` field: extension.ts:106 / approvals.ts:284 / degenerate.ts:216,225,231). Compile-only checks MISS this — `content`→`output` is the model-visible channel; a missed site silently publishes empty `pi.tool-result` content. Bump + fix source, tests, lockfiles in all three repos; note the load-order consequence (extensions load before `Harness.open`, loader.ts:201).
2. `pi.tool` task v1→v2 tagged-union migration (`{kind:"model"|"nested"}`) — live in-flight tool tasks migrate on open, but drain/abort before any prod rollout; the battery's kill-9 scenarios get a fresh pass.
3. `bash` nonzero exit → error result with `exit_code` diagnostic instead of throwing — battery drivers and any tool test asserting throw behavior.
4. Storage-error semantics (Session fails and closes on any Storage throw; `StorageRejected` removed) — `src/backup` and server error paths read with fresh eyes.
5. Display-only write submissions settle immediately — verify no sigrun route depended on the old queue behavior.
6. `ToolTaskInput`/`ToolExecutionApi` surface changes — the fabricated-api test stubs (`test/skills.test.ts:81-88`, `test/tools.test.ts:363`) get re-checked against the real api (reviewer finding: stubs go stale silently).
6a. 1.1.0's `TaskRuntime.context()` options-object change (`runtime.context(conversationId, context, { at })` replaces positional) — sigrun jumps 1.0.2→1.2.0 and skips the 1.1.0 section entirely; audit call sites. (The remaining 1.1.0 items — `Storage.order`, custom-env conformance, `durationMs`, `startedAt` — need no action: upstream `openNodeSqliteStorage` covers storage; no custom envs exist; recorded here so the next reader doesn't redo the sweep.)

**Pre-flight checks (reviewer findings, in order):**
7. `npm ls @earendil-works/chord` duplicate-copy check — 1.2.0's chord/pi-ai ranges vs our `^1.0.4` pins; a nested second copy means symbol-identity split.
8. SQLite backup (`src/backup/run-backup.ts` path) before first boot on the new version; confirm the migration set is additive.
9. Full battery rerun (not subset) — the thresholds are timing-relative; treat marker failures as "retune first, regression second."

**Upstream wins to absorb (not new work, replacement):**
10. Upstream `read` now returns images natively — but WITHOUT the `images` option it supports PNG/JPEG/GIF/WebP only and ERRORS on BMP (read.js:46-47,147); BMP support (plus orientation/resize) comes only via `createCodingTools({images})`. Our T1c wrapper advertises and supports BMP (tools.ts:63-89), so the adopt-upstream decision must weigh: the BMP regression, the lost orientation/resize, AND the webui diff-view's dependency on the diagnostic shape. Options: adopt `createCodingTools({images})` wholesale (full parity, adds the `@earendil-works/pi-durable/images` Photon dependency), or keep our wrapper. Decision in planning with the webui-diff check; the spec records the full tradeoff, not just the diff-view question.
11. Upstream `ExecutionEnv.listFiles(path, options)` — gitignore-aware bounded tree listings; a follow-up (post-spec) may replace our hand-written find/grep/ls walk internals.

**Testable:** the full sigrun suite (root + webui + battery + e2e) green on 1.2.0 with the recaptured schema pin; the T8 settings liveness tests (the discriminating pair) still pass unchanged — they are the upgrade's canary.

## Slice 1: `sigrun-ext-codemode` (thin wiring)

A separate repo (extension-separation ruling, 2026-10-06) exporting the sigrun loader-contract factory (default export → `{extension}`) whose extension wraps **pi-durable's own** `createCodemodeExtension` from `@earendil-works/pi-durable/codemode`:

- **Sandbox:** `new CodemodeSandbox({ timeoutMs, memoryLimitBytes })` from `@earendil-works/pi-codemode` — the finite default timeout and the memory cap are SANDBOX-CONSTRUCTOR options (verified: `CodemodeToolOptions` has neither; `timeoutMs` is read only from the script's `// @options:` line otherwise, host.js:302-303; pi CLI passes `Number.POSITIVE_INFINITY` — we pass a finite default as sigrun's durability posture, scripts override via `@options`; memory: pi CLI caps 256 MB, the sandbox default is unlimited wasm32 — we pass 256 MB). Declare `@earendil-works/pi-codemode` AND its transitive `quickjs-wasi` as real dependencies (reviewer finding: a missing dep means `loadQuickJSWasm` throws at first script, in prod).
- **Namespaces:** constructor-time only; there is no cross-extension channel (loader factories take no args — verified). Ruling: the codemode extension re-reads the MCP config itself (`SIGRUN_MCP_CONFIG` env → `~/.config/sigrun/mcp.json`, the same resolution sigrun-ext-mcp uses, duplicated parse accepted) to build `namespaces` at factory time — snapshot semantics, documented: a server that connects late or flaps renders un-namespaced in the section until next boot; the section body itself re-renders from `agent.callable` each turn, so tool listings stay live.
- **Activation (user-facing default — RULING, replaces rev 2's contradiction):** rev 2 said "ships NOT in the default set" while the shipped code offers every installed tool when `defaultTools` is unset, and the T8 panel's `CORE_TOOLS` is a hardcoded 7-name list that cannot add codemode. Resolved: the settings panel's tool list becomes registry-driven (the `GET /v1/settings` surface gains the live tool roster — a small core-side addition this spec DOES own, the one place "core gains something"), and sigrun ships with `codemode` and `tool_search` IN the effective default set (pi's own default: both builtins enabled). "Not in the default set" remains the user's choice via the panel; the warn path below covers that case.
- **Boot smoke:** a trivial canary script executes in-image at boot (fail loud on missing wasm/worker — the "passes typecheck, dies at first script" class).
- **Warn-if-inactive channel (corrected — the only seam that exists):** extensions have no boot lifecycle hook and no registry visibility (verified: the `Extension` interface has tools/sections/hooks/wraps/tasks only; factories take no args). The honest channel is the extension's PROMPT SECTION render: when `codemode` is installed but not model-offered in this request (`PromptInput.agent.tools` — available at render time), the codemode section renders a short deprecation-style notice instead of tool listings ("codemode scripts are available but the tool is not offered; enable it via Settings → default tools"). Per-request, de-duplicated by construction. Same shape for tool-search's section and slice 3's `mcp_servers` section (gated on the discovery tool actually being offered, else it would instruct the model toward an unoffered tool).

**Non-goals (unchanged from rev 1):** the `models.*` namespace internals (upstream provides them; sigrun's degenerate provider means `models.classify`/`generateImages` resolve nothing until a provider extension ships them — acceptable, they degrade honestly); `codemode.mode`/`inlineBudget` beyond the constructor defaults.

**Testable:** the model calls `codemode` with a script that calls `tools.read` on a workspace file and returns its content (via `api.executeTool` — full pipeline); `store`/`load` round-trip across two script calls on one conversation; a fork sees the parent's stored values as of the fork entry; a failing script yields a partial-output error result; nested call records appear in `details.calls` and `pi.live.nestedTools`; the canary passes in a container image build.

## Slice 2: `sigrun-ext-tool-search` (thin wiring)

A separate repo, factory → `{extension}`, wrapping `createToolSearchExtension()` from `@earendil-works/pi-durable/tool-search`. The substance (BM25 over `agent.deferred`, `control.addTools` loads) is upstream; sigrun-side:

- Activation: in the effective default set at ship (slice 1's ruling); self-report via the same section-render warn when not model-offered.
- No ranker package: rev 1's `sigrun-tool-ranker` micro-package is DROPPED — upstream ships the ranker inside its tool-search; a future hybrid/embedding ranker would be an upstream contribution (pi's own comment invites it), not a sigrun package.
- Replacement semantics documented honestly (slice 4): last-selected-wins shadowing.
- **Two-layer filter note (reviewer findings):** `defaultTools` settings writes map to 1.2.0's `modelTools` (the model-offered filter), NOT `AgentState.tools` (the enabled filter) — the activation story rides on the distinction. A settings re-apply that rewrites `modelTools` wholesale ("replaces the stored filter as a whole") nukes tool_search's `add`-list loads: the panel's PATCH must use additive object-form paths or re-read current state first. Recorded so the slice-2 tests cover the re-apply hazard, not just fork survival.
- **Assertion-shape note:** a `callers: ["tools"]` MCP tool is in `agent.callable` but NEVER in `agent.deferred` (agent.js requires model-calleability for deferred); slice-3 testables assert presence/absence against `agent.callable` and `agent.tools`, never `agent.deferred`.

**Testable:** with MCP tools deferred (slice 3), `tool_search("echo")` returns the server's tool and `addTools` made the declared set grow (assert `state.modelTools`/agent tools non-vacuously — reviewer finding: the "not re-listed" testable must not pass vacuously); a subsequent model call invokes the loaded tool directly; the loaded set survives a fork at a later entry; with nothing deferred the tool returns empty, not error.

## Slice 3: MCP exposure (upgrade `sigrun-ext-mcp` to 1.2.0 semantics)

The config schema gains per-server `exposure?: "codemode" | "deferred" | "direct" | "hidden"` (default `codemode`), per-tool `toolExposure` overrides (exact name over patterns, first pattern wins — pi's precedence), `enabled?: boolean` (default true), per-request `timeout?: number` (seconds; default 60). `codemode-deferred` alias kept (pi compat).

**Mapping onto 1.2.0 (the whole point of the upgrade):**
- `direct` → register normally (model-offered when in the effective tool set).
- `codemode` → register with `callers: ["tools"]` — scripts reach it, the model is never offered it. Tool names keep our existing `<server>/<tool>` shape (upstream namespaces handle prefix grouping for the codemode section; verify the prefix convention during planning — pi uses `mcp__<server>__<tool>`, ours is `<server>/<tool>`; the codemode `namespaces` option takes the groups, so the naming is ours to keep or align — planning decides, lean align-upstream for section-rendering compat).
- `deferred` → register with `deferred: true` — invisible to the model until `tool_search` loads it.
- `hidden` → do not register the tool (keep the config entry).

**Client work the config implies (rev 1 P2, unchanged):** per-request timeout with progress-notification reset — real client work in `src/client.ts` (the JSON-RPC notifications surface + the timeout machinery), not a config passthrough.

**Default flip: KEPT, now honest.** Rev 1's flip (implicit-direct → default `codemode`) was judged "inert or a lie" by both reviewers on 1.0.2 semantics. On 1.2.0 semantics it does exactly what it says: a server with default exposure has its tools callable by scripts but never offered to the model. Migration note in the repo README (`"exposure": "direct"` restores old behavior); the spec keeps the flip per pi's actual default (user's "spirit of pi" ruling).

**The `mcp_servers` prompt section:** a section listing every enabled server with codemode/deferred tools (name, description, how its tools are reached — `tool_search` for deferred, codemode scripts for codemode). Sigrun's 4KB-section budget + whole-line truncation pattern (skills-section precedent).

**Activation warnings (corrected channel — rev 2's console.warn/boot-outcomes claim had no seam):** extensions have no boot lifecycle hook, no registry visibility, and no args (verified by both re-reviewers). The `mcp_servers` section itself is the warning channel: it renders per request from live agent state, so it lists codemode/deferred servers ONLY when their discovery tool is model-offered in that request, and appends one notice line when servers exist whose tools are unreachable ("N server(s) have script-only or deferred tools; enable codemode/tool_search in Settings → default tools to reach them"). Per-request, de-duplicated by construction, visible to the model where it matters. `console.warn` at factory time remains as a best-effort boot log line (the factory CAN read the settings file itself), but it is not the contract.

**Non-goals (unchanged):** MCP resources, OAuth upgrades (PKCE flow stands), HTTP transport, background connection ordering, the `/mcp` manager command.

**Testable:** a default-exposure server connects; its tools appear in `agent.callable` but NOT in the model-offered set (`agent.tools`) — never `agent.deferred` (callers-gated tools are not model-calleable, so not deferred either); `exposure: "direct"` offers them; `toolExposure` overrides per-tool; `hidden` registers nothing; a tool call through a codemode script (nested `executeTool`) works end-to-end with approvals hooks firing (the security-parity test — an approvals-gated nested call PROMPTS); `codemode-deferred` alias resolves; per-request timeout fires.

## Slice 4: replacement semantics, honestly recorded

Rev 1 promised a "loud conflict" test that pi-durable's registry cannot pass (verified by both reviewers: cross-extension duplicate tool names resolve last-selected-wins, silently; install-replace is by EXTENSION name only). Slice 4 shrinks to documentation + a test of the verified semantics:

- Each extension repo's README records: replacement works by not installing ours and installing yours (the name-addressed tool surface makes per-name replacement trivial); co-installation shadows silently last-wins — do not co-install.
- A test pins the shadowing semantics as a warning condition. The reachable detection point is sigrun's `loadExtensions` (it owns the registry and install order — one function, converts the vacuous testable into a real one): after installs, scan the registry snapshot for duplicate tool names across extensions and `console.warn` the shadowed pairs (last-selected-wins is pi-durable's verified behavior, unchanged). Extension-side factory-time detection is NOT reachable (no args, no registry) — dropped from rev 2.

**Testable:** documented; collision-warning behavior pinned whatever shape it takes; no false "loud conflict" promise.

## Ordering

1. **Task 0** — the upgrade (the gate; everything else compiles against 1.2.0).
2. **Slice 1** codemode wiring (depends on Task 0; namespaces empty until slice 3).
3. **Slice 2** tool-search wiring (depends on Task 0; testable fully once slice 3 defers tools).
4. **Slice 3** MCP exposure (depends on 1+2 for the end-to-end tests).
5. **Slice 4** docs + collision warning (any time after 1+2).

## What rev 2 dropped from rev 1, and why (the reviewers' ledger)

- `sigrun-tool-ranker` micro-package — upstream ships the ranker in tool-search.
- The sandbox/store/replay design work — upstream's `pi.codemode.run/journal` documents and ships it; our `store()/load()` read-path P1 (kimi) and no-timeout P2 (deepseek) are absorbed as upstream behavior + our sandbox-constructor `memoryLimitBytes`/`timeoutMs` (rev 3 correction: neither is a tool/extension option — sandbox constructor and script `@options` line respectively; rev 2's "tool option the caller overrides" wording was wrong).
- The three rev-1 options for the nested-call seam — upstream `executeTool` supersedes; kimi's independent recommendation ("(ii) as upstream contribution") proved prescient — upstream had already taken it.
- The "registered but not declared" mechanism design — upstream `callers`/`deferred` IS the mechanism (both reviewers' P0 resolved by upgrade, not by core changes).
- The breaking-flip debate — kept, now honest under 1.2.0 semantics; both reviewers' objections were 1.0.2-conditioned.

## What rev 3 changed (the re-review ledger)

Both re-reviewers (kimi-k3, deepseek-v4.1-flash) verified rev 2 against the 1.2.0 tarball and the sigrun/extension sources; verdict was BLOCK with three specified edits, all applied:
- **Task 0 gains the three extension repos** (deepseek P1): sigrun-ext-mcp / sigrun-approvals / sigrun-memory-markdown each pin 1.0.2 and each return the removed `content:` field — a silent model-visible break. Plus kimi's 1.1.0 `TaskRuntime.context({at})` item and the no-action-needed sweep note.
- **Activation story rebuilt** (deepseek P1 + kimi P1): rev 2's "ships NOT in default" contradicted the shipped code (unset `defaultTools` = everything offered) and the T8 panel's hardcoded `CORE_TOOLS` couldn't add codemode. Ruling: panel goes registry-driven (the spec's one core-side addition), codemode + tool_search ship IN the effective default set (pi's own default). Warn channel corrected to the section render (the only seam extensions actually have) — rev 2's console.warn/boot-outcomes claim had no seam.
- **Namespaces seam ruled** (deepseek P1): no cross-extension channel exists; codemode re-reads the MCP config itself, snapshot semantics documented (late/flapping servers render un-namespaced until next boot; the section body still re-renders live from `agent.callable`).
- **Task 0 item 10 corrected** (deepseek P2): upstream read-without-images ERRORS on BMP; our wrapper supports it — the decision now records the BMP regression + orientation/resize loss, not just the webui-diff question.
- **Slice-3 testables corrected** (deepseek P2): assert against `agent.callable`/`agent.tools`, never `agent.deferred`; `defaultTools`↔`modelTools` two-layer mapping + the re-apply-wipes-loads hazard recorded for the tests.
- **Slice 4 detection point fixed** (kimi P3 + deepseek P2): extension-side collision detection is unreachable; sigrun's `loadExtensions` owns it (one function, real testable).

## Open items for planning (not spec-level)

- The MCP tool-name convention (`<server>/<tool>` vs upstream's `mcp__<server>__<tool>`) — decided in planning against the codemode-section rendering.
- Whether the T1c image wrapper goes or stays (Task 0 item 10 — now includes the BMP + orientation tradeoff).
- The vendor-ext image wiring for the two new extension repos (deepseek's finding: `Dockerfile:22-32` + `scripts/docker-vendor-exts.sh` enumerate exactly two today).
- Deploy manifests: container memory bump for the sandbox.