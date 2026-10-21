# U6 — Interactions and Ambient Surfaces on Block Trees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interaction records and ambient surfaces carry block trees only; interaction answers are `{values}`; both channels render them with the U1/U2 renderers; and every core fixture and test is rewritten to the new shapes. No compatibility layer (ruling 16).

**Architecture:**
- `shared/src/interactions.ts` and `shared/src/ambient.ts` keep their envelopes and replace their bodies with `body: Tree`.
- `src/harness/interactions.ts` and `src/harness/ambient.ts` validate the body with `validateTree(…, {placement: "interaction" | "ambient"})`, so legacy-shaped records fail validation with paths.
- The answer route's body becomes `{values}`. Channels render an interaction as a `SurfaceView` whose transport turns the form's submit into the answer POST, and an ambient record as a read-mostly `SurfaceView` placed by its envelope.

**Tech Stack:** U0 (`validateTree`), U1/U2 (`SurfaceView`), the existing seam host (`src/harness/seam-host.ts`).

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §9 (all), rulings 16 and 20, §16 (Interactions and ambient).

**Depends on:** U0, U1, U2.

## Global Constraints

- Interaction envelope, unchanged: `kind`, `callId`, `status`, `createdAt`, `expiresAt?`, `settledAt?`, `answeredBy?`, `answeredByUser?`, `answer?`, `details?`; first-answer-wins.
- `InteractionAnswer` becomes `{values: Readonly<Record<string, JsonValue>>}`. The route `POST /v1/conversations/:id/interactions/:callId/answer` keeps its path; body `{values}`.
- Interaction placement allows: `stack`, `section`, `markdown`, `fields`, `callout`, `diff`, `details`, `collection(list)`, and a root `form` with fields `text`, `longtext`, `number`, `toggle`, `choice`, `secret` only.
- Ambient envelope, unchanged: `key`, `owner`, `place: "status" | "footer" | "panel"`, `maxRows?`, `overflow?: "drop" | "wrap" | "summarize"`, `refreshMs?`, `expires: "never" | "idle"`, `updatedAt`, `details?`. `status` and `footer` allow one line (one `markdown`, or one `columns` of one-line blocks; footer zones are three columns).
- Tone renames for anything ported: `danger` → `bad`, `ok` → `good`.
- Row severity mapping (for docs and ports): 0 → `bad`, 1 → `warn`, 2 → `neutral`.
- `sigrun-ext-approvals` is not migrated (it is deleted). Its replacement ports (`rpiv-ask-user-question`, `pi-warden`) are separate work in their own repos.

## Review Focus

1. **An interaction answered from two channels at once** — first-answer-wins still holds with `{values}`; the loser gets `409` and its card shows the winning answer. Owner: Task 2.
2. **An interaction that expires while a user is mid-way through a multi-question stepper** — submitting returns `410` and the card shows "expired" without losing what they typed (it stays visible, read-only). Owner: Task 3.
3. **An ambient `panel` with more rows than `maxRows`** — `overflow` applies (`drop` hides the rest with "N more", `summarize` shows a count line), in both channels. Owner: Task 3.
4. **A `secret` field in an interaction** — its value is in the answer posted to the extension but never in the stored record that channels read, nor in logs. Owner: Task 2.
5. **An extension writing a legacy-shaped record after upgrade** — the write fails loudly with the validation path in the server log and nothing is rendered; the conversation is unaffected. Owner: Task 1.

---

### Task 1: Shared types and server-side validation

**Files:**
- Modify: `shared/src/interactions.ts` (body → `body: Tree`; `InteractionAnswer` → `{values}`; drop `InteractionOption`, `InteractionField`, `InteractionDiff` body types), `shared/src/ambient.ts` (body → `body?: Tree`; drop `AmbientBody`, `AmbientRow`, `AmbientGauge`, `AmbientLedgerEntry`, segment types)
- Modify: `src/harness/interactions.ts` (`validateInteraction` checks the envelope then `validateTree(body, {placement: "interaction"})`; `validateAnswer` accepts `{values: JsonObject}` only), `src/harness/ambient.ts` (same with `placement: "ambient"` and the one-line rule for `status`/`footer`), `src/extension.ts` (re-exported record types follow)
- Test: `test/seam.test.ts`, `test/seam-guarantees.test.ts`, `test/interaction-decide.test.ts` (rewrite to trees)

- [ ] **Step 1: Rewrite the tests to the new shapes and add:** a record with the old `options[]` body fails with a path naming `body`; a tree using `chart` in an interaction fails with its path; a `file` field in an interaction form fails; an ambient `status` record with two stacked `markdown` blocks fails; a `footer` record with a three-column `columns` passes; an answer `{ids: ["a"]}` → `400`; `{values: {q1: ["a", "b"], q2: {other: "x"}}}` passes; Review Focus 5 (the write throws a validation error naming the path; a later valid write succeeds).
- [ ] **Step 2: Run** `npx vitest run test/seam.test.ts test/seam-guarantees.test.ts test/interaction-decide.test.ts` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** + `npm run build:shared && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `git commit -m "seams: interaction and ambient bodies are block trees; answers are {values}; legacy shapes rejected"`.

### Task 2: Answer route, secrets, fixtures

**Files:**
- Modify: `src/server/routes/interactions.ts` (body schema `{values}`; secret fields' values are passed to the extension's answer handler and stripped from the stored `answer`, replaced by `"[secret]"`)
- Modify: `test/fixtures/fixture-seam/`, `test/fixtures/fixture-seam-visual/`, `test/fixtures/fixture-seam-bad-kinds/` — rewrite every record they write as trees built with `@sigrun/sigrun/blocks` builders
- Modify: `test/fixtures/fixture-gate/` (added by `2026-10-21-core-hardening-review-fixes.md` Task 3) — its allow/deny interaction becomes a tree: a root `form` with a `choice` named `decision` (options `allow`/`deny`, tones `good`/`bad`) and a `longtext` named `reason`; it reads `answer.values.decision`
- Test: `test/interaction-decide.test.ts`, `test/server-configure.test.ts` (any interaction assertions)

- [ ] **Step 1: Write failing tests:** the decide flow answers with `{values: {decision: "allow", reason: "ok"}}` and the extension sees exactly that; Review Focus 1 (two concurrent POSTs: one 200, one 409 carrying the stored answer); Review Focus 4 (a form with `secret` named `token`: the extension's handler receives the value, `GET` of the record shows `"[secret]"`, and the server log never contains the value — assert on a captured log stream); a four-question ask-user-question-shaped fixture (sections with one `choice` each, `preview`, `allowOther`) answers in one POST as `{values: {q1, q2, q3, q4}}`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "seams: {values} answer route, secret values never stored, fixtures rewritten as block trees"`.

### Task 3: Channels render interactions and ambient surfaces from trees

**Files:**
- Create: `webui/src/entries/interactionTransport.ts` (a `SurfaceTransport` whose `load` returns the record's tree and `act` on submit POSTs the answer), `tui/src/blocks/interaction-transport.ts`
- Modify: `webui/src/entries/InteractionCards.tsx`, `webui/src/entries/AmbientPanels.tsx`, `webui/src/entries/SeamComponents.test.tsx`; `tui/src/ui/interactions.ts`, `tui/src/ui/ambient.ts`, `tui/src/ui/status-bar.ts` (footer zones); delete the old body renderers
- Modify: `webui/e2e/seam-assert.spec.ts`, `webui/e2e/seam-visual.spec.ts` (update snapshots once, reviewed)
- Test: `webui/src/entries/SeamComponents.test.tsx`, `tui/test/interactions.test.ts`, `tui/test/ambient.test.ts`, `tui/test/status-bar.test.ts`

- [ ] **Step 1: Write failing tests:** an interaction card renders its tree and submits `{values}`; a multi-question card offers the stepper with review and submits once; Review Focus 2 (expiry mid-stepper → `410`, the card shows "expired", typed values remain visible and read-only); a settled interaction renders read-only with the answer; ambient `status` renders one line in the status bar, `footer` renders left/middle/right zones, `panel` renders above the composer; Review Focus 3 (`maxRows: 3` with 5 rows: `drop` shows "2 more", `summarize` shows a count line); a `quiet` row is folded; all of the above in both channels.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate: `npm test && npm run typecheck && npm --workspace @sigrun/webui run test && npm run typecheck:webui && npm run build:webui && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck && npm run test:e2e` — PASS.
- [ ] **Step 5: Commit** `git commit -m "channels: interactions and ambient surfaces rendered from block trees in webui and TUI"`.

### Task 4: Docs

**Files:**
- Modify: `docs/approval-ux-seams.md` (replace the primitive sections with a pointer to the block set and the §9 mappings; keep the evidence tables as history), `docs/extending.md` (interaction and ambient examples rewritten with `@sigrun/sigrun/blocks` builders; the `{values}` answer shape)
- Test: `test/docs-examples.test.ts` (new: extracts the TypeScript code blocks tagged `ts check` from `docs/extending.md` and type-checks them against `@sigrun/sigrun/blocks`)

- [ ] **Step 1: Write the failing docs-example test.** **Step 2: Run** — FAIL. **Step 3: Rewrite the docs.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "docs: seams documented on the block set; checked examples"`.
