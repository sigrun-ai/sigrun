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
1. `ToolExecutionResult.content` → `output`, next to new `structuredOutput` — our T1 read-wrapper, tool-result view serialization, and the pinned view schema (`test/schema-drift.test.ts` recapture + `webui/src/schema-version.ts`) all touch it.
2. `pi.tool` task v1→v2 tagged-union migration (`{kind:"model"|"nested"}`) — live in-flight tool tasks migrate on open, but drain/abort before any prod rollout; the battery's kill-9 scenarios get a fresh pass.
3. `bash` nonzero exit → error result with `exit_code` diagnostic instead of throwing — battery drivers and any tool test asserting throw behavior.
4. Storage-error semantics (Session fails and closes on any Storage throw; `StorageRejected` removed) — `src/backup` and server error paths read with fresh eyes.
5. Display-only write submissions settle immediately — verify no sigrun route depended on the old queue behavior.
6. `ToolTaskInput`/`ToolExecutionApi` surface changes — the fabricated-api test stubs (`test/skills.test.ts:81-88`, `test/tools.test.ts:363`) get re-checked against the real api (reviewer finding: stubs go stale silently).

**Pre-flight checks (reviewer findings, in order):**
7. `npm ls @earendil-works/chord` duplicate-copy check — 1.2.0's chord/pi-ai ranges vs our `^1.0.4` pins; a nested second copy means symbol-identity split.
8. SQLite backup (`src/backup/run-backup.ts` path) before first boot on the new version; confirm the migration set is additive.
9. Full battery rerun (not subset) — the thresholds are timing-relative; treat marker failures as "retune first, regression second."

**Upstream wins to absorb (not new work, replacement):**
10. Upstream `read` now returns images natively (PNG/JPEG/GIF/WebP, orientation/resize via `createCodingTools({images})`) — our T1c rescue-wrapper becomes redundant; adopt upstream behavior, keep our wrapper only if the webui diff-view depends on the diagnostic shape (check during the pass).
11. Upstream `ExecutionEnv.listFiles(path, options)` — gitignore-aware bounded tree listings; a follow-up (post-spec) may replace our hand-written find/grep/ls walk internals.

**Testable:** the full sigrun suite (root + webui + battery + e2e) green on 1.2.0 with the recaptured schema pin; the T8 settings liveness tests (the discriminating pair) still pass unchanged — they are the upgrade's canary.

## Slice 1: `sigrun-ext-codemode` (thin wiring)

A separate repo (extension-separation ruling, 2026-10-06) exporting the sigrun loader-contract factory (default export → `{extension}`) whose extension wraps **pi-durable's own** `createCodemodeExtension` from `@earendil-works/pi-durable/codemode`:

- **Sandbox:** `new CodemodeSandbox()` from `@earendil-works/pi-codemode` (Node flavor; sigrun runs unbundled tsx so the default worker URL resolves). Declare `@earendil-works/pi-codemode` AND its transitive `quickjs-wasi` as real dependencies (reviewer finding: a missing dep means `loadQuickJSWasm` throws at first script, in prod).
- **Namespaces:** the `mcp__<server>` prefix groups for the codemode section — fed from the MCP extension's registered servers (slice 3 wiring); empty until slice 3 lands.
- **Activation:** the extension registers the `codemode` tool with `callers: ["model"]` (upstream's own convention: scripts cannot start scripts). Whether the model is OFFERED codemode is the `defaultTools` question — sigrun ships codemode NOT in the default set; the user adds `codemode` via the T8 settings panel. The extension warns (console.warn, visible in boot logs) when it detects it is not in the effective default set — pi's own warn-if-inactive behavior.
- **Memory:** set the sandbox memory limit explicitly (pi caps 256 MB; QuickJS wasm32 default is 4 GiB) — the pod's 512Mi limit means an uncapped sandbox OOMKills. Container memory request/limit bump is a deploy/ change in the same PR.
- **Timeout:** a finite default `timeoutMs` for scripts (pi uses `Number.POSITIVE_INFINITY` in the CLI; a durable pod cannot host infinite scripts) — surfaced as a tool option the caller can override per call; document the divergence from pi as sigrun's durability posture.
- **Boot smoke:** a trivial canary script executes in-image at boot (fail loud on missing wasm/worker — the "passes typecheck, dies at first script" class).

**Non-goals (unchanged from rev 1):** the `models.*` namespace internals (upstream provides them; sigrun's degenerate provider means `models.classify`/`generateImages` resolve nothing until a provider extension ships them — acceptable, they degrade honestly); `codemode.mode`/`inlineBudget` beyond the constructor defaults.

**Testable:** the model calls `codemode` with a script that calls `tools.read` on a workspace file and returns its content (via `api.executeTool` — full pipeline); `store`/`load` round-trip across two script calls on one conversation; a fork sees the parent's stored values as of the fork entry; a failing script yields a partial-output error result; nested call records appear in `details.calls` and `pi.live.nestedTools`; the canary passes in a container image build.

## Slice 2: `sigrun-ext-tool-search` (thin wiring)

A separate repo, factory → `{extension}`, wrapping `createToolSearchExtension()` from `@earendil-works/pi-durable/tool-search`. The substance (BM25 over `agent.deferred`, `control.addTools` loads) is upstream; sigrun-side:

- Activation same as slice 1: not in default set; user adds `tool_search` via the settings panel; warn if inactive while deferred tools exist (the warning is the MCP extension's to emit — slice 3 — but tool-search may also self-report).
- No ranker package: rev 1's `sigrun-tool-ranker` micro-package is DROPPED — upstream ships the ranker inside its tool-search; a future hybrid/embedding ranker would be an upstream contribution (pi's own comment invites it), not a sigrun package.
- Replacement semantics documented honestly (slice 4): last-selected-wins shadowing.

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

**Activation warnings:** the extension warns when codemode-exposed servers exist but the `codemode` tool is inactive (not in the effective default set), and separately when deferred-exposed servers exist but `tool_search` is inactive — pi's exact warn shape, channeled to console.warn + boot outcomes (visible via `GET /v1/meta`), the only channel extensions have.

**Non-goals (unchanged):** MCP resources, OAuth upgrades (PKCE flow stands), HTTP transport, background connection ordering, the `/mcp` manager command.

**Testable:** a default-exposure server connects; its tools appear in `agent.callable` and `agent.deferred`-adjacent surfaces but NOT in the model-offered set; `exposure: "direct"` offers them; `toolExposure` overrides per-tool; `hidden` registers nothing; a tool call through a codemode script (nested `executeTool`) works end-to-end with approvals hooks firing (the security-parity test — an approvals-gated nested call PROMPTS); `codemode-deferred` alias resolves; per-request timeout fires.

## Slice 4: replacement semantics, honestly recorded

Rev 1 promised a "loud conflict" test that pi-durable's registry cannot pass (verified by both reviewers: cross-extension duplicate tool names resolve last-selected-wins, silently; install-replace is by EXTENSION name only). Slice 4 shrinks to documentation + a test of the verified semantics:

- Each extension repo's README records: replacement works by not installing ours and installing yours (the name-addressed tool surface makes per-name replacement trivial); co-installation shadows silently last-wins — do not co-install.
- A test pins the shadowing semantics as a warning condition: the extensions detect name collisions at factory time (scan the registry snapshot they receive... verify the loader passes a snapshot — the sigrun loader's factory gets no args, but the extension's `tools()` can compare against the registry at install; if unreachable, the honest fallback is a boot-log warning naming the shadowed names, best-effort).

**Testable:** documented; collision-warning behavior pinned whatever shape it takes; no false "loud conflict" promise.

## Ordering

1. **Task 0** — the upgrade (the gate; everything else compiles against 1.2.0).
2. **Slice 1** codemode wiring (depends on Task 0; namespaces empty until slice 3).
3. **Slice 2** tool-search wiring (depends on Task 0; testable fully once slice 3 defers tools).
4. **Slice 3** MCP exposure (depends on 1+2 for the end-to-end tests).
5. **Slice 4** docs + collision warning (any time after 1+2).

## What rev 2 dropped from rev 1, and why (the reviewers' ledger)

- `sigrun-tool-ranker` micro-package — upstream ships the ranker in tool-search.
- The sandbox/store/replay design work — upstream's `pi.codemode.run/journal` documents and ships it; our `store()/load()` read-path P1 (kimi) and no-timeout P2 (deepseek) are absorbed as upstream behavior + our explicit `memoryLimitBytes`/`timeoutMs` options.
- The three rev-1 options for the nested-call seam — upstream `executeTool` supersedes; kimi's independent recommendation ("(ii) as upstream contribution") proved prescient — upstream had already taken it.
- The "registered but not declared" mechanism design — upstream `callers`/`deferred` IS the mechanism (both reviewers' P0 resolved by upgrade, not by core changes).
- The breaking-flip debate — kept, now honest under 1.2.0 semantics; both reviewers' objections were 1.0.2-conditioned.

## Open items for planning (not spec-level)

- The MCP tool-name convention (`<server>/<tool>` vs upstream's `mcp__<server>__<tool>`) — decided in planning against the codemode-section rendering.
- Whether the T1c image wrapper's diagnostic shape is webui-load-bearing before deleting it (Task 0 item 10).
- The vendor-ext image wiring for the two new extension repos (deepseek's finding: `Dockerfile:22-32` + `scripts/docker-vendor-exts.sh` enumerate exactly two today).
- Deploy manifests: container memory bump for the sandbox.