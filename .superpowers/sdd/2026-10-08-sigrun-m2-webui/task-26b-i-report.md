# Task 26b-i report: E2E harness + smoke test

Slice 1 of Task 26b: the harness + ONE smoke test. Checklist items (spec §7)
are the NEXT slice.

## Harness shape (`webui/e2e/harness.ts`)

`bootE2EServer(options?: { responses?: readonly FauxResponseStep[] })` →
`{ url, conversationId, opened, app, cleanup }`.

- Adapts `server.test.ts`'s `bootServer` + `sse-view.test.ts`'s
  `app.listen({port: 0, host: "127.0.0.1"})` ephemeral-loopback pattern.
- Multi-model faux provider: `faux/m` (128k ctx, the SIGRUN_MODEL default) +
  `faux/m2` (64k) so the composer model picker has options. Responses
  configurable per boot via `options.responses` (default: one canned
  `fauxAssistantMessage("e2e answer")`).
- Storage + workspace in a per-boot `mkdtemp` tmpdir; cleanup closes app →
  harness → rm tmpdir (idempotent).
- `webuiBundle` = the built `webui/dist` (harness.ts is at webui/e2e, so
  `../dist`), `webuiBundleExplicit: true` → missing bundle fails boot loud.
- `conversationId` = the root conversation (`opened.harness.root(...)`).

## Playwright config (`webui/playwright.config.ts`)

testDir `e2e`, single chromium project (Desktop Chrome; cached chromium-1228),
120s per-test timeout (server boots in beforeAll), 10s expect timeout,
workers 1 / serial, `trace: retain-on-failure`, reporter `list`.

## Smoke test assertions (`webui/e2e/smoke.spec.ts`)

One test: boots the server, `page.goto(url)`, asserts
1. `.app-refused` count 0 (the schema gate PASSED — served schemaVersion ==
   bundle pin),
2. `header.top-bar` visible + `.brand` reads "sigrun",
3. `nav.session-list` visible + first `.session-select` visible (root
   conversation listed),
4. zero uncaught pageerrors,
5. full-page screenshot to
   `.superpowers/sdd/2026-10-08-sigrun-m2-webui/artifacts/task-26b-i-smoke.png`.

## package.json scripts

- root: `test:e2e` = `npm run build:webui && npm --workspace @sigrun/webui run test:e2e`
- webui: `test:e2e` = `playwright test`; `typecheck:e2e` =
  `tsc --noEmit -p tsconfig.e2e.json` (NodeNext mirror of root tsconfig —
  the main webui tsconfig is bundler-resolution and cannot check the
  harness's `../../src/*.js` imports).

## Run tail

```
> @sigrun/webui@0.1.0 test:e2e
> playwright test

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e/smoke.spec.ts:39:1 › the bundle serves and the app shell renders (233ms)

  1 passed (1.1s)
```

(vite build before it: 288 modules, dist written, 147ms. First green run was
347ms/1.7s; the tail above is the FINAL run after the vite.config vitest-
exclude edit, proving the whole `npm run test:e2e` chain post-edit.)

Screenshot: `.superpowers/sdd/2026-10-08-sigrun-m2-webui/artifacts/task-26b-i-smoke.png`
(33,869 bytes, 256 distinct byte values — non-blank, same check T25 used).
Committed as evidence.

## Verification

- `cd webui && npx tsc --noEmit` — CLEAN (main tsconfig; e2e/ not in its
  include set, so `npx tsc --noEmit -p tsconfig.e2e.json` also run — CLEAN).
- `npm run test:e2e` — GREEN (build + 1/1 chromium pass).
- webui unit suite: 17 files / 114 tests PASS.
- root unit suite: 29 files / 212 tests PASS; root `npm run typecheck` CLEAN.

### The one integration fix

webui's vitest (no `test` key in vite.config.ts) swept `e2e/smoke.spec.ts`
into the unit run (default include matches `*.spec.ts`) — 114 unit tests
passed but the file failed the suite. Fix: `vite.config.ts` now imports
`defineConfig` from `vitest/config` and adds
`test: { exclude: [...defaultExclude, "e2e/**"] }`.

## Commit

`test: M2 ship-gate E2E harness + smoke` on feat/m2-webui — this report
ships inside the commit it reports on (hash: `git log -1`), together with
the screenshot artifact, the harness, the smoke spec, the playwright config,
the tsconfig.e2e.json, the vite.config vitest-exclude, the package.json
scripts + lockfile playwright entries, and the .gitignore test-results line.
`progress.md` (the orchestrator's ledger) was deliberately NOT staged.

## What the next slice (checklist items) needs

- **The harness is ready as-is.** `bootE2EServer({ responses })` scripts the
  faux provider per boot: multi-turn (`fauxAssistantMessage` sequences),
  tool calls (`fauxToolCall`), errors (`stopReason`/errorMessage options),
  deferred handles (`fauxProvider({ deferred })` — NOT yet exposed as a
  bootE2EServer option; add when a checklist item needs it).
- **One server per spec FILE** (module-level `let server` + beforeAll/
  afterAll, as smoke.spec.ts does). workers: 1 keeps files serial; do not
  raise without rethinking tmpdir/port isolation (both are per-boot so it
  would work, but there's no need).
- **`conversationId`** = the root conversation — checklist tests can drive
  the §5 API directly against it (`fetch(`${url}/v1/conversations/${id}/...`)`)
  to set up state, then assert the UI reflects it.
- **`opened`** is exposed for harness-level seams (e.g. `opened.harness.root`
  conversation `.submit`) when a checklist item needs to move the run state
  without clicking.
- **Selectors proven live**: `header.top-bar`, `.brand`, `nav.session-list`,
  `.session-select`, `.app-refused` (gate failure — assert count 0 to prove
  the bundle/server contract held). Chat empty state reads "Select or create
  a conversation" until a session is selected.
- **Artifacts**: screenshots to the SDD `artifacts/` dir (see smoke for the
  path pattern); playwright traces land in `webui/test-results/`
  (gitignored) on failure.
- **The faux response queue is shared across models** (m + m2 draw from one
  scripted list) — a checklist item asserting model-specific replies must
  account for queue order, not model routing.
