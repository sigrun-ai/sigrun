# Sigrun codemode/tool-search/MCP-exposure parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade sigrun (and its three extension repos) to pi-durable 1.2.0 and add the thin sigrun-side wiring that delivers codemode, tool_search, and the MCP exposure model.

**Architecture:** Task 0 of the spec is the gate — a breaking-change compatibility pass (1.0.2→1.2.0, skipping 1.1.0) across sigrun core and the three independently-pinned extension repos. The feature slices are thin wrapper repos over pi-durable's own `codemode`/`tool-search` subpath extensions, an exposure upgrade in `sigrun-ext-mcp`, and two small core-side pieces the activation story needs (registry-driven settings panel, `modelTools` remap, collision warning).

**Tech Stack:** TypeScript, pi-durable 1.2.0 (`@earendil-works/pi-durable` + `/codemode` + `/tool-search` subpaths), `@earendil-works/pi-codemode` (QuickJS WASM sandbox), fastify, React webui, vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-sigrun-codemode-parity.md` (rev 3 — the plan argues from it; executors read both)

## Global Constraints

- pi-durable pins to **1.2.0** everywhere it appears (sigrun + all extension repos); chord/pi-ai duplicate-copy check passes (`npm ls @earendil-works/chord` — one copy).
- Extensions live in **separate repos** (user ruling 2026-10-06); sigrun core gains only what the spec names (the settings roster surface, the `modelTools` remap, the `loadExtensions` collision warning).
- **"Works like pi feels"** (user ruling): pi's semantics; sigrun's shape where the architectures differ.
- Loader contract: extension factories take **no arguments**; factories return `{ extension }`.
- The sandbox is constructed with **`timeoutMs` finite** and **`memoryLimitBytes: 256 MB`** (both sandbox-constructor options, never tool options).
- MCP default exposure flips to **`codemode`** (migration note in README; `"exposure": "direct"` restores old behavior).
- Core §6.4: the API never accepts or returns credentials (unchanged surfaces).
- Section budget: prompt sections cap at 4KB with whole-line truncation (skills-section precedent).
- `codemode` + `tool_search` ship **in** the effective default set (spec rev-3 activation ruling).

## Review Focus

1. **A settings re-apply that rewrites `modelTools` wholesale wipes `tool_search` loads** (`AgentChange.modelTools` "replaces the stored filter as a whole") — the panel's PATCH must use additive paths; a re-apply mid-conversation must not silently unload loaded deferred tools. → Task 3 test.
2. **A runaway script** (infinite loop) must end via the finite sandbox timeout, and aborting the caller settles its in-flight nested calls — a durable pod cannot host an immortal script. → Task 5 test.
3. **`callers: ["tools"]` tools are in `agent.callable`, never `agent.deferred`, never `agent.tools`** — the exposure testable asserts the right sets; `agent.deferred` assertions are vacuously wrong for codemode-exposed tools. → Task 7 test.
4. **BMP image reads regress** if the T1c wrapper is deleted naively (upstream read-without-images errors on BMP; our wrapper supports it) — the wrapper decision is proven by a test that reads a BMP through the shipped surface. → Task 1 test.
5. **The `mcp_servers` section must not instruct the model toward an unoffered tool** — when codemode/tool_search is not model-offered in the request, the section renders the enable notice instead of tool listings. → Task 7 test.

---

### Task 1: The pi-durable 1.2.0 upgrade — sigrun core

The gate. Everything later compiles against 1.2.0's types. One task because the whole tree must go green in one cycle; its parts have no independent deliverables.

**Files:**
- Modify: `package.json` (the pin), `package-lock.json`
- Modify: `src/harness/tools.ts` (6 `content:` sites → `output:`; lines ~89, 114 + the 4 others found by `grep -n "content:" src/harness/tools.ts`)
- Modify: `src/harness/tools.ts:56-89` (the T1c image wrapper — the BMP decision, below)
- Modify: `src/server/schema-fixture.ts` + `test/fixtures/view-schema.json` (the `pi.tool-result` content shape → output; recaptured)
- Modify: `webui/src/schema-version.ts` + `webui/src/entries/ToolResultEntry.tsx` + `webui/src/api.ts` (the wire field rename)
- Modify: `test/tools.test.ts` (any bash-throw assertions → error-result assertions; `bash.isError` at :254 already the right shape)
- Modify: battery drivers as the full-battery rerun demands (bash exit semantics, thresholds if timing shifted)

**Interfaces:**
- Consumes: pi-durable 1.2.0 from npm (`@earendil-works/pi-durable@1.2.0`); `CodemodeSandbox` NOT yet (Task 5).
- Produces: a green tree on 1.2.0 — every later task's `import` context; the T8 settings-liveness tests still passing unchanged (the upgrade's canary).

- [ ] **Step 1: Pre-flight — the dependency sanity check**

Run: `npm install @earendil-works/pi-durable@1.2.0 --save-exact && npm ls @earendil-works/chord @earendil-works/pi-ai`
Expected: single chord + pi-ai copies (no nested duplicates). If nested copies appear, STOP and report — the pin ranges need reconciling first (a ruling, not a fix-forward).

- [ ] **Step 2: The mechanical rename pass**

`ToolExecutionResult.content` → `output` in `src/harness/tools.ts` (all 6 sites), `webui/src/api.ts` wire types, `webui/src/entries/ToolResultEntry.tsx` (the field it reads), `test/tools.test.ts` assertions. The `pi.tool-result` wire shape in `src/server/schema-fixture.ts` + `test/fixtures/view-schema.json` gets `output` — recapture the fixture honestly: run `npx vitest run test/schema-drift.test.ts`, read its failure, update the fixture to the real 1.2.0 shape (do NOT re-hash blindly; `webui/src/schema-version.ts` follows).

- [ ] **Step 3: The BMP decision (test first)**

In `test/tools.test.ts`, the existing image-read test reads a PNG. Add one test: reading a `.bmp` workspace file returns image content (the wrapper's advertised behavior, tools.ts:66). Run it. THEN decide per spec Task-0 item 10: if adopting `createCodingTools({ images })` wholesale, the BMP test passes via upstream + the `@earendil-works/pi-durable/images` dependency and the wrapper is deleted; if keeping the wrapper, the test pins it. Do not delete the wrapper with the test red.

- [ ] **Step 4: The 1.1.0 items + storage semantics audit**

`grep -rn "\.context(" src/ test/ --include="*.ts"` for `TaskRuntime.context` positional-`at` call sites (verified: none found in the sweep — confirm, then note in the commit). Read `src/backup/run-backup.ts` + the server error paths against the Session-fails-on-storage-throw semantics; add `test/backup.test.ts` coverage only if a behavior actually changed.

- [ ] **Step 5: Full verification battery**

Run: `npm run typecheck && npm test` — Expected: green (bash-exit semantics diffs get fixed in the battery drivers only where tests assert throws). Then `npm run test -w @sigrun/webui && npm run typecheck:webui && npm run test:e2e` — Expected: all green. Then the FULL battery (not subset): `npx vitest run test/battery/` — Expected: 5/5 scenarios green; treat marker-timing failures as retune-first (per spec pre-flight 9).

- [ ] **Step 6: Commit**

`git add -A && git commit -m "feat: upgrade pi-durable 1.0.2 -> 1.2.0 (codemode parity Task 0)

ToolExecutionResult content->output across core/webui/pinned schema;
pi.tool v2 migration verified by battery; bash exit error-results; the
T8 settings-liveness tests unchanged and green (the upgrade canary)."`

### Task 2: The extension repos' 1.2.0 upgrade (three repos, one shape)

**Files (three repos, each the same shape):**
- Modify: `~/repos/sigrun-ext-mcp/{package.json,package-lock.json,src/*}`, `~/repos/sigrun-approvals-work/{...}`, `~/repos/sigrun-memory-work/{...}`
- Exact `content:` sites (verified): `sigrun-ext-mcp/src/extension.ts:106`, `sigrun-approvals-work/src/approvals.ts:284`, `sigrun-memory-work/src/degenerate.ts:216,225,231` (+ the `contentText` type at :124 — a *user-message* content reader, NOT a tool result; leave unless typecheck moves it).

**Interfaces:**
- Consumes: Task 1's green tree (for the vendored file: install shape only).
- Produces: three repos each on pi-durable 1.2.0 with their own suites green — Task 7's exposure work builds on the mcp repo's upgraded base.

- [ ] **Step 1: Per repo — bump, typecheck, fix, test**

For each repo: `npm install @earendil-works/pi-durable@1.2.0 --save-exact && npm run typecheck` → fix the `content:` → `output:` rename (tool-result returns only; do not touch user-message content readers) → `npm test` green → commit `feat: upgrade pi-durable 1.2.0 (content->output)`.
Expected per repo: typecheck clean, suite green. The memory repo's `contentText` helper reads pi-ai `UserMessage["content"]` — unchanged in 1.2.0; verify by typecheck, not by edit.

- [ ] **Step 2: The load-order integration check**

Run sigrun's own suite with the three repos' built dists (the devDependencies git-pins pick up the working trees per the existing dev setup): `cd /home/user/repos/sigrun && npm test`.
Expected: green — the extensions' tool results still publish non-empty output (the silent-empty break the spec warns about would show here as a skills/tools test failure).

### Task 3: `defaultTools` → `modelTools` remap + the re-apply hazard

The spec's two-layer-filter ruling: settings `defaultTools` maps to 1.2.0's `AgentChange.modelTools` (the model-offered filter), NOT `AgentChange.tools` (the enabled filter). Includes the settings-panel roster surface (the spec's one core-side addition).

**Files:**
- Modify: `src/server/index.ts:137-176` (`storeAgentChange`: resolve names → `ToolRegistration` objects → `{ modelTools }`; keep the dropped-names warning — it now guards `modelTools` resolution)
- Modify: `src/harness/settings.ts` (doc comments; no field change — `defaultTools` stays the store's name)
- Modify: `src/server/index.ts` GET `/v1/settings` (+ the response type in `src/server/views.ts` or wherever the settings route's types live): gains `toolRoster: readonly string[]` — the live registry snapshot's tool names, so the panel is registry-driven
- Modify: `webui/src/api.ts` + `webui/src/settings/SettingsPanel.tsx` (replace the hardcoded `CORE_TOOLS` with the fetched roster; `defaultTools` checkboxes render the roster)
- Test: `test/server-settings.test.ts` (extend), `webui/src/settings/SettingsPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1's 1.2.0 types (`AgentChange.modelTools`).
- Produces: `storeAgentChange` emits `{ modelTools }`; the settings GET carries `toolRoster`; Tasks 5-7 rely on codemode/tool_search names appearing in the roster.

- [ ] **Step 1: Failing tests (three)**

(1) `storeAgentChange` with `defaultTools: ["read"]` produces an agent change whose `modelTools` (not `tools`) carries the read registration — assert the 1.2.0 field. (2) The re-apply hazard: with `modelTools` set and a `control.addTools`-loaded deferred name in the stored `add` list, re-running the settings write does NOT drop the added name (the write uses the object form's additive path or re-reads current state first). (3) `GET /v1/settings` returns `toolRoster` containing the installed extension tools (read, write, ..., load_skill).

- [ ] **Step 2: Run — verify all three fail for the right reasons**

Run: `npx vitest run test/server-settings.test.ts`
Expected: FAIL — no `modelTools` emitted; roster absent.

- [ ] **Step 3: Implement the remap + roster + panel**

`storeAgentChange` resolves the store's names against `registry.snapshot().tools()` into `ToolRegistration` objects and emits `{ modelTools: objects }` (the same object-taking shape as the old `tools` emit — the minimal diff). The settings GET reads `registry.snapshot().tools()` names. The panel fetches `toolRoster` and renders checkboxes over it. Run the three tests → green.

- [ ] **Step 4: Full suites + commit**

`npm test && npm run typecheck && npm run test -w @sigrun/webui && npm run typecheck:webui` → green. Commit `feat(server): defaultTools maps to modelTools; registry-driven settings roster (codemode parity T3)`.

### Task 4: `sigrun-ext-mcp` exposure upgrade

**Files (all in `~/repos/sigrun-ext-mcp`):**
- Modify: `src/config.ts` (the `exposure`/`toolExposure`/`enabled`/`timeout` schema + validation, pi's precedence: exact name over patterns, first pattern wins)
- Modify: `src/extension.ts` (per-tool registration: `direct` → normal; `codemode` → `callers: ["tools"]`; `deferred` → `deferred: true`; `hidden` → not registered; the `mcp_servers` section with the 4KB budget + the enable-notice gating)
- Modify: `src/client.ts` (per-request timeout + progress-notification reset — real client work: the JSON-RPC notifications surface + the timeout machinery)
- Test: `test/mcp.test.ts` + `test/exposure.test.ts` (new)

**Interfaces:**
- Consumes: pi-durable 1.2.0's `ToolRegistration.callers`/`deferred`; Task 2's upgraded repo base.
- Produces: the exposure config shape Tasks 5-7 test against; the `mcp_servers` section key (`"mcp_servers"`) that Task 7's gating test asserts.

- [ ] **Step 1: Failing tests — the exposure matrix (spec testables, corrected-set assertions)**

Default-exposure server → its tools in `agent.callable`, absent from `agent.tools`, NEVER `agent.deferred`. `direct` → in `agent.tools`. `toolExposure` override → per-tool. `hidden` → not registered. `codemode-deferred` alias → codemode. Per-request timeout → a stub server that never answers errors at the deadline. Section: with codemode active, lists the server; with codemode not model-offered, renders the enable-notice line and no tool listings.
Run → verify each fails.

- [ ] **Step 2: Implement config schema + registration mapping + section + timeout client**

Follow the exposure mapping table in the spec verbatim (`codemode` → `callers: ["tools"]`, etc.). The section: pi's shape (name, description, how reached) with the skills-style 4KB whole-line-truncation budget; the gating reads `PromptInput.agent.tools` at render time. Run the matrix → green. Repo suites (`npm test` in the repo) + typecheck + build → green. Commit.

- [ ] **Step 3: The README migration note**

`README.md`: the default-exposure flip (`"exposure": "direct"` restores old behavior), the timeout field, the tool-name convention decision (made here per spec open-item: keep `<server>/<tool>` unless the codemode section rendering requires upstream's `mcp__<server>__<tool>` — test with the namespace grouping and pick; record the choice).

### Task 5: `sigrun-ext-codemode` (new repo)

**Files (new repo `~/repos/sigrun-ext-codemode`, mirroring sigrun-ext-mcp's shape):**
- Create: `package.json` (deps: pi-durable 1.2.0, `@earendil-works/pi-codemode`, `@earendil-works/chord`, `@earendil-works/pi-ai`; the loader-contract default export)
- Create: `src/index.ts` (the factory: builds the sandbox + namespaces, wraps `createCodemodeExtension`)
- Create: `src/extension.ts` (the section-render warn-if-not-offered; config re-read for namespaces)
- Test: `test/codemode.test.ts` (real harness + faux provider, mirroring sigrun-ext-mcp's test idiom)

**Interfaces:**
- Consumes: `createCodemodeExtension({ sandbox, namespaces?, inlineBudget?, models? })` from `@earendil-works/pi-durable/codemode`; `CodemodeSandbox({ timeoutMs, memoryLimitBytes })` from pi-codemode; the MCP config resolution convention (`SIGRUN_MCP_CONFIG` → `~/.config/sigrun/mcp.json`).
- Produces: the `codemode` tool (named exactly) with `callers: ["model"]`; the `codemode` prompt section; the namespaces snapshot. Task 7's end-to-end depends on this repo's tool being installable.

- [ ] **Step 1: The repo skeleton + the factory**

Scaffold per sigrun-ext-mcp's shape (Task 3 part 1's precedent). The factory: read the MCP config (same resolution; empty on absent), map server names to `CodemodeNamespace` entries, `new CodemodeSandbox({ timeoutMs: 300_000, memoryLimitBytes: 256 * 1024 * 1024 })`, return `{ extension: createCodemodeExtension({ sandbox, namespaces }) }`. Declare `quickjs-wasi` transitively real.

- [ ] **Step 2: Failing tests — the sandbox round-trips (spec testables)**

The model calls `codemode` with a script calling `tools.read` (real harness, real workspace temp dir, faux provider); `store`/`load` round-trip across two calls; a fork sees values as-of; a failing script yields partial-output error; `details.calls` + `pi.live.nestedTools` records; **the runaway-script test** (Review Focus 2): a `while(true){}` script ends at the deadline with an error result, and the harness stays healthy.
Run → verify fails (no extension yet).

- [ ] **Step 3: Implement + verify + commit**

Wire the factory's extension; the section's warn-if-not-offered render (the spec's corrected channel). Full repo suite + typecheck + build green. Commit per repo convention.

- [ ] **Step 4: The in-image canary (the spec's boot smoke)**

Add `test/canary.spec.ts` (or a bin script): execute a trivial `return 1+1` script in the built package; run it in the container image build (wired in Task 8). Until Task 8, it runs as a repo test with the same assertions.

### Task 6: `sigrun-ext-tool-search` (new repo)

**Files (new repo, same shape):**
- Create: `package.json`, `src/index.ts` (factory → `{ extension: createToolSearchExtension() }` — upstream's, verbatim), the section-warn wiring
- Test: `test/tool-search.test.ts`

**Interfaces:**
- Consumes: `createToolSearchExtension()` from `@earendil-works/pi-durable/tool-search`; Task 4's deferred MCP tools (for the end-to-end).
- Produces: the `tool_search` tool; nothing downstream builds on it.

- [ ] **Step 1: Failing test — the end-to-end with Task 4's deferred tools**

Real harness: an MCP server (stub) with `exposure: "deferred"` connected + this extension installed + codemode's repo installed; `tool_search("echo")` returns the stub tool; `addTools` grew the model-offered set (assert the agent's tools array non-vacuously); the next model call invokes the loaded tool; the loaded set survives a fork at a later entry; nothing-deferred → empty result, not error.
Run → verify fails.

- [ ] **Step 2: Implement + verify + commit**

The wrapper is thin (upstream's extension + the warn section). Repo suites + sigrun-tree integration (install both new repos as devDependencies per the existing git-pin convention — Task 8 wires the image). Commit.

### Task 7: End-to-end exposure + collision warning + docs

**Files:**
- Modify: `src/harness/loader.ts` (`loadExtensions` — the duplicate-tool-name scan + `console.warn` after installs)
- Modify: the two new repos' READMEs + sigrun-ext-mcp's README (replacement semantics: last-selected-wins, do-not-co-install)
- Test: `test/loader.test.ts` (extend — the collision warning), the repos' cross-cutting tests

**Interfaces:**
- Consumes: Tasks 5+6's tools installed together in the sigrun tree; Task 4's exposure.
- Produces: the slice-4 deliverable — nothing downstream.

- [ ] **Step 1: Failing tests**

(1) Loader collision: two extensions registering the same tool name → `console.warn` names the pair (last-wins is pi-durable's behavior, unchanged). (2) The security-parity test (spec slice 3): an approvals-gated tool called from a codemode script PROMPTS (nested `executeTool` runs the hooks — the whole point of the upgrade). (3) The `mcp_servers` gating test (Review Focus 5). Run → verify fails where the code doesn't exist yet.

- [ ] **Step 2: Implement + verify + commit**

The loader scan is one function over the installed registry snapshot. The approvals-parity test lives in the sigrun tree (it needs the approvals extension + the codemode extension + the harness). Full suites everywhere. Commit.

### Task 8: Image + deploy wiring

**Files:**
- Modify: `Dockerfile:22-32` + `scripts/docker-vendor-exts.sh` (vendor the two new repos alongside the existing two; rewrite their devDependency pins per the existing pattern)
- Modify: `deploy/base/deployment.yaml:96-100` (container memory request/limit bump for the sandbox — 256Mi request → 512Mi, limit 512Mi → 1Gi, or as the canary's observed footprint dictates; record the observed number in the commit)
- Test: the Task 5 canary runs in the image build; `test/deploy-entry.test.ts` extend if it pins manifests

- [ ] **Step 1: Vendor + build + canary-in-image**

Extend the vendor script's enumeration; build the image locally; the canary passes in-image (fail-loud on missing wasm/worker). Commit with the observed memory numbers.

---

## Ordering & shippability

Task 1 (gate) → Task 2 (extensions on 1.2.0) → Task 3 (modelTools + roster) → Task 4 (MCP exposure) → Task 5 (codemode) → Task 6 (tool-search) → Task 7 (e2e + collision) → Task 8 (image). Each of 1-6 is independently shippable; 7 is the integration proof; 8 is deploy.

## Self-review notes

- Spec coverage: Task 0 items 1-6a → Task 1; item 7-9 pre-flights → Task 1 steps 1/5 (+ Task 2's repos, the deepseek P1); item 10 → Task 1 step 3. Slices 1-4 → Tasks 4-7. Open items: tool-name convention → Task 4 step 3; wrapper decision → Task 1 step 3; vendor wiring → Task 8; memory bump → Task 8.
- The five Review Focus lines each carry a test in the named task.
- 30-minute worker budgets: Tasks 1, 4, 5 are the big ones — each will be split at dispatch time (Task 1 by step groups; Tasks 4/5 by test-file boundaries) with the pre-digested context convention from the parity run.