# Sigrun system prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sigrun a core-authored system prompt: static identity facts, a SOUL.md-or-default persona, and per-model-family tool/execution guidance that swaps safely mid-conversation.

**Architecture:** Three new/changed core-owned pi-durable prompt sections, all in the registry before/after `loadExtensions` per the pinned order; guidance keyed by substring-matching the request's `provider/model-id` (no catalog access in renderers); a boot-time reserved-key assertion so no extension can silently replace a core section.

**Tech Stack:** TypeScript, pi-durable 1.2.0 (`defineExtension`, `section`, `PromptInput.agent.model`), vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-10-18-sigrun-system-prompt.md`

## Global Constraints

- Section keys match `^[a-z][a-z0-9_-]*$` (pi-durable registry validation): use exactly `identity`, `persona`, `tool-guidance`, `execution-guidance`.
- The pinned core-section order is `identity` → `persona` → `workspace-instructions` → `skills` → (extension sections) → `long-term-memory` → `tool-guidance` → `execution-guidance` → (`instructions`, pi-durable reserved). Guidance installs LAST in boot — after `loadExtensions` and after the memory-owner/no-op install.
- Section renderers never touch the `Models` catalog; `PromptInput.agent.model?: ModelRef` is the only model input.
- Identity text is verbatim (spec §Design 1): "You are sigrun, an AI assistant running as a persistent server built on the pi-durable harness. Conversations are durable: they survive restarts and can span channels (web UI, terminal UI, HTTP API). Multiple conversations may be active at once; each is independent."
- Default persona text is verbatim (spec §Design 2): "You are Sigrun. You choose, and you say why — a valkyrie doesn't dither over the field. You have opinions and you give them straight: if a plan is bad, say it's bad and say what would make it good. Hedging is a way of lying politely.\n\nMatch your reply to the weight of the ask. No filler openers, no restating the request, no narrating what the user can already see. When you don't know, say so and name what would settle it.\n\nDry wit when it lands. Never forced, never at the user's expense — punch at the problem, not the person. Warmth is welcome; flattery is not."
- Persona resolution rule: SOUL.md read succeeds → file body; `not_found` → default persona; `input.env === undefined` → default persona; any other error → render throws (upstream keeps previously shown text).
- Guidance matching: substring on `"${provider}/${modelId}"`, case-insensitive, first match wins; no match → section absent.
- `npm test` + `npm run typecheck` green before each commit (repo convention).

## Review Focus

1. A model whose id CONTAINS a matcher substring but isn't that family (e.g. a fine-tune named `my-kimi-k3-lora`) gets the family guidance — acceptable, first-match-wins is documented; test the ordering rule, not exhaustive family coverage.
2. `SOUL.md` present but EMPTY (0 bytes) — read succeeds, persona is the empty body (today's behavior), NOT the default. Pin in T2.
3. Model swap matched→unmatched mid-conversation — the patch must remove only the two trailing guidance sections, never a remove-all/re-add-all of the whole prompt (the placement invariant). Pin in T4.
4. An extension (even a friendly one) shipping a `persona` section — boot must fail loud, not silently replace. Pin in T5.
5. `agent.model` unset — guidance renders absent; unit-level only (upstream `no_model` fails before render end-to-end). Pin in T3.

---

### Task 1: `identity` section + persona fallback

**Files:**
- Modify: `src/harness/sections/context-files.ts` (add `identity` section; persona fallback)
- Test: `test/context-files.test.ts`

**Interfaces:**
- Produces: `contextFilesExtension` gains sections in order `identity`, `persona`, `workspace-instructions`. `DEFAULT_PERSONA` (exported const, the verbatim persona text). Persona renderer rule per Global Constraints.

- [ ] **Step 1: Write the failing tests**

Append to `test/context-files.test.ts` (follow the existing fixture style):

```ts
test("identity renders the static sigrun facts", async () => {
	// render the identity section; expect the verbatim identity text from the plan header
});

test("missing SOUL.md renders the default persona", async () => {
	// no SOUL.md in the workspace fixture; persona === DEFAULT_PERSONA
});

test("a present SOUL.md replaces the default persona wholesale", async () => {
	// existing pattern: write SOUL.md "persona only\n"; persona === that body
});

test("an empty SOUL.md renders an empty persona, not the default", async () => {
	// writeFile SOUL.md ""; persona === "" (read succeeded; default applies only to not_found/no-env)
});

test("no env renders the default persona", async () => {
	// PromptInput.env === undefined; persona === DEFAULT_PERSONA
});

test("a non-not_found SOUL.md read error still throws", async () => {
	// existing rejects.toThrow(/read SOUL\.md/) pattern keeps passing
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/context-files.test.ts`
Expected: FAIL — identity section absent; default-persona tests fail (persona `undefined`).

- [ ] **Step 3: Implement**

In `src/harness/sections/context-files.ts`:
- Export `const DEFAULT_PERSONA = ` (verbatim text from Global Constraints) and `const IDENTITY_TEXT = ` (verbatim).
- Add `section("identity", () => IDENTITY_TEXT)` as the FIRST section.
- Change the persona renderer: `readContextFile(...)` result `undefined` (either `not_found` or no env) → `DEFAULT_PERSONA`; a successful read (including empty string) → the body. Do not catch the throw path.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run test/context-files.test.ts`
Expected: PASS (new + existing — the existing "missing SOUL.md renders an absent persona section" test will now FAIL; update it to expect `DEFAULT_PERSONA`, that's the intended behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/harness/sections/context-files.ts test/context-files.test.ts
git commit -m "prompt: identity section + default persona fallback for absent SOUL.md"
```

---

### Task 2: model-guidance module (table + matchers + extension)

**Files:**
- Create: `src/harness/sections/model-guidance.ts`
- Test: `test/model-guidance.test.ts`

**Interfaces:**
- Produces:
  - `export interface ModelGuidance { readonly tool?: string; readonly execution?: string }`
  - `export declare const MODEL_GUIDANCE: readonly { readonly match: string; readonly guidance: ModelGuidance }[]` (ordered, first-match-wins)
  - `export function matchGuidance(modelRef: ModelRef | undefined): ModelGuidance | undefined`
  - `export const modelGuidanceExtension = defineExtension({ name: "sigrun.model-guidance", sections: [section("tool-guidance", ...), section("execution-guidance", ...)] })` — each section renders the matched entry's field or `undefined`.
- Consumes: `ModelRef` from `@earendil-works/pi-durable`.

Seed table (my call — mechanism is the deliverable, entries are conservative):
- `{ match: "kimi", guidance: { execution: "Think through the full plan before acting; verify the result before finalizing." } }` (reasoning family)
- `{ match: "deepseek", guidance: { execution: "Think through the full plan before acting; verify the result before finalizing." } }` (reasoning family)
- `{ match: "qwen", guidance: { tool: "Prefer your tools over recollection when the answer is checkable on disk or in the environment." } }` (known under-caller family)

- [ ] **Step 1: Write the failing tests**

```ts
test("first match wins", () => {
	// MODEL_GUIDANCE order: a ref matching two entries resolves the earlier one
});

test("matching is case-insensitive substring on provider/modelId", () => {
	expect(matchGuidance({ provider: "Bifrost", modelId: "Kimi-K3" })).toBeDefined();
});

test("no match returns undefined (absent sections)", () => {
	expect(matchGuidance({ provider: "acme", modelId: "unmatched-1" })).toBeUndefined();
});

test("undefined model yields undefined (defensive; upstream no_model gates first)", () => {
	expect(matchGuidance(undefined)).toBeUndefined();
});

test("sections render undefined when unmatched, the guidance text when matched", async () => {
	// drive modelGuidanceExtension's two sections with a PromptInput whose agent.model
	// matches kimi and one that doesn't; matched → tool-guidance undefined (kimi has no
	// tool entry) and execution-guidance present; unmatched → both undefined
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/model-guidance.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implement `model-guidance.ts`**

`matchGuidance`: normalize `${provider}/${modelId}` to lowercase, `String.includes(match)` over `MODEL_GUIDANCE` in order, first hit wins, `undefined` on no hit or undefined ref. The extension's two sections read `input.agent.model`, call `matchGuidance`, return the field or `undefined`.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run test/model-guidance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/sections/model-guidance.ts test/model-guidance.test.ts
git commit -m "prompt: per-model-family tool/execution guidance sections + matcher"
```

---

### Task 3: boot wiring — guidance LAST + reserved-key assertion

**Files:**
- Modify: `src/harness/boot.ts` (install `modelGuidanceExtension` after the memory-owner/no-op install; add the reserved-key assertion after `loadExtensions`)
- Test: `test/boot-prompt-order.test.ts` (new)

**Interfaces:**
- Consumes: `modelGuidanceExtension` (Task 2); `contextFilesExtension` (Task 1); pi-durable `Registry.snapshot().sections()` → `{extension, section}[]` in install order.
- Produces: `const RESERVED_CORE_SECTION_KEYS = ["identity", "persona", "workspace-instructions", "skills", "tool-guidance", "execution-guidance"]` (exported from boot or a constants module); boot throws `Error` naming the colliding key + extension when a non-core extension owns one.

- [ ] **Step 1: Write the failing tests**

```ts
test("core section order: identity first, guidance after long-term-memory", async () => {
	// openHarness with a fixture workspace; read registry.snapshot().sections() keys in order;
	// expect [identity, persona, workspace-instructions, skills, ..., long-term-memory, tool-guidance, execution-guidance]
	// (memory no-op is installed when no memory extension is loaded)
});

test("an extension declaring persona fails boot loud", async () => {
	// loadExtensions with a fixture extension shipping section("persona", ...);
	// expect openHarness rejects with /persona/ + the extension name
});

test("guidance sections install after loadExtensions (memory section precedes them)", async () => {
	// with a fixture extension contributing a section, order is: ...core..., <ext section>, long-term-memory, tool-guidance, execution-guidance
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/boot-prompt-order.test.ts`
Expected: FAIL — guidance extension not installed; no assertion exists.

- [ ] **Step 3: Implement in `boot.ts`**

- Move nothing existing. After the memory-owner/no-op install block (`registry.install(noopMemoryExtension)` conditional), `registry.install(modelGuidanceExtension)`.
- After `loadExtensions` and after the guidance install, walk `registry.snapshot().sections()`; for each entry whose key is in `RESERVED_CORE_SECTION_KEYS`, assert the owning extension is the expected core extension (`sigrun.context-files`, `sigrun.skills`, `sigrun.model-guidance`); mismatch → throw `Error(\`extension "<name>" declares reserved core section "<key>"\`)`. (Note: `sections.set` last-writer-wins means a replacing extension IS the owner in the snapshot — that's exactly what this catches.)
- Keep the existing `memoryOwner` derivation working (it reads the same snapshot).

- [ ] **Step 4: Run the suites**

Run: `npx vitest run test/boot-prompt-order.test.ts test/context-files.test.ts test/model-guidance.test.ts`
Expected: PASS. Then `npm test` full + `npm run typecheck` — both green (this touches boot; the full suite must pass before commit).

- [ ] **Step 5: Commit**

```bash
git add src/harness/boot.ts test/boot-prompt-order.test.ts
git commit -m "prompt: wire guidance last in boot; reserve core section keys"
```

---

### Task 4: end-to-end patch-shape verification

**Files:**
- Test: `test/system-prompt-patching.test.ts` (new)

**Interfaces:**
- Consumes: the fully wired boot (Task 3); pi-durable's `planSystemEntries` (importable from `@earendil-works/pi-durable` harness internals — if not exported, drive the behavior through two consecutive conversation runs with different models and inspect committed `pi.system` entries in the conversation's message log).

- [ ] **Step 1: Write the failing tests**

```ts
test("matched→matched model swap patches only the guidance values", async () => {
	// conversation on a kimi model, then switch to deepseek; the new pi.system
	// entry patches tool-guidance/execution-guidance VALUES only; identity/persona/
	// workspace-instructions/skills/long-term-memory keys are ABSENT from the patch
});

test("matched→unmatched removes only the two trailing guidance sections", async () => {
	// conversation on kimi, then switch to an unmatched model; the pi.system entry
	// contains { "tool-guidance": null, "execution-guidance": null } and NO nulls
	// or re-adds for any other section (this is the placement invariant —
	// a remove-all/re-add-all pair here means the guidance did not install last)
});

test("unmatched→matched appends only the two trailing guidance sections", async () => {
	// reverse direction; patch ADDS tool-guidance/execution-guidance, nothing else
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/system-prompt-patching.test.ts`
Expected: FAIL before Tasks 1–3 are wired (and these are the regression net for the whole spec).

- [ ] **Step 3: Implement the harness-level test driver** (fixture model providers serving `kimi`/`deepseek`/unmatched ids; two submits; read the conversation's committed system entries from the store).

- [ ] **Step 4: Run**

Run: `npx vitest run test/system-prompt-patching.test.ts` then `npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add test/system-prompt-patching.test.ts
git commit -m "prompt: pin minimal-patch behavior across model swaps (placement invariant)"
```

---

### Task 5: docs + full gate

**Files:**
- Modify: `docs/extending.md` (reserved section keys list + guidance convention) and `docs/superpowers/specs/2026-10-18-sigrun-system-prompt.md` status line → "implemented"

- [ ] **Step 1: Update `docs/extending.md`** — document the reserved core section keys and the rule that provider/persona overrides are rejected at boot.

- [ ] **Step 2: Full verification**

Run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: reserved prompt sections + per-model guidance convention"
```
