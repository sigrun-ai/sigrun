# U4 — Settings on Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every setting says how it applies (`live` or `restart`); saving publishes `settings.changed` and calls extensions' `onSettingsChanged`; restart-only changes show as pending with an admin Restart button where something will restart sigrun; and core plus extension settings sections render from one block renderer in both channels.

**Architecture:**
- **Metadata:** `src/settings/registry.ts` declares every core key with `apply` and its section. Extension sections bring their own fields.
- **Pending restarts:** a boot snapshot of every `restart` key is diffed against stored values to produce `pendingRestart`.
- **Sections are surfaces:** `settings` placement trees served through U3's surface routes, under the reserved slug `core` for core sections. The webui and TUI settings panels become a list of sections, each a `SurfaceView` (U1/U2).
- **Restart:** `POST /v1/admin/restart` runs the normal graceful shutdown and exits 0. It's offered only when `server.supervised` is true.

**Tech Stack:** Fastify, `src/harness/settings.ts` `SettingsStore`, W3's extension settings/secrets routes (core-hardening §7.7), U0–U3.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §13 (all), ruling 18, §16 (Settings).

**Depends on:** U0, U1, U2, U3.

## Global Constraints

- Ruling 18: this replaces core-hardening §5.7's "every `server.*` key is restart-required". Do not edit the core-hardening docs.
- Core keys:
  - `live`: `namingModel`, `server.providers.refreshIntervalMinutes` (the scheduler re-arms), `jobHistory.runs`, `jobHistory.revisions`;
  - `restart`: listen host and port, data and config dirs, `server.auth.*`, `server.trustedProxies`, `server.webui.*` (bundle selection), the extension list;
  - every other existing key: audit in Task 1, and record its classification in the registry with a one-line reason.
- Extension fields default to `live`.
- `settings.changed {scope: "server" | {extension: slug}, keys: string[]}` on the event bus and on `/v1/events`.
- `onSettingsChanged(keys)` errors are caught and logged; the write still succeeds.
- `server.supervised` (env `SIGRUN_SUPERVISED=1`): set by the Helm chart and docker compose only, **not** the Dockerfile.
- Sections default `admin: true`.

## Review Focus

1. **Saving a mix of live and restart keys in one save** — live keys apply now, restart keys go pending, and the response says which is which. Owner: Task 1.
2. **Reverting a restart key to its boot value** — it leaves `pendingRestart`, and the callout disappears without a restart. Owner: Task 1.
3. **Two admins saving the same section at once** — the second save, based on a stale read, gets `409` with the current values rather than silently overwriting. Owner: Task 3.
4. **Restart clicked while a run is streaming** — graceful shutdown lets the run reach a durable boundary (pi-durable resumes it after restart), and the channels show "Restarting…" then reconnect. Owner: Task 2.
5. **An extension section whose stored settings no longer match its fields** (after an upgrade) — unknown keys are kept and shown under Advanced (raw JSON), never dropped. Owner: Task 3.

---

### Task 1: Apply metadata, change events, pending restarts

**Files:**
- Create: `src/settings/registry.ts` (`CORE_SETTING_KEYS: {key, apply, section, reason}[]`), `src/settings/pending.ts`
- Modify: `src/harness/settings.ts` (writes return `{applied: string[], pending: string[]}`; publish `settings.changed`), `src/harness/providers/scheduler.ts` (re-arm on `server.providers.refreshIntervalMinutes` change), `src/server/routes/settings.ts` (`GET`/`PATCH /v1/settings` include `pendingRestart`), `src/server/routes/extensions.ts` (W3: extension settings GET includes `pendingRestart`; PUT fires `onSettingsChanged`), `shared/src/views.ts` (`settings.changed` in `HostEventWire`) and `src/server/routes/events.ts` (an explicit `settings.changed` branch in `visible()`: server-scope events to admins, extension-scope events to admins), `src/extension.ts` + `src/harness/loader.ts` (`onSettingsChanged?(keys: string[]): void | Promise<void>` on the factory result), `shared/src/settings.ts` (`SettingsResponse.pendingRestart: string[]`)
- Test: `test/settings-apply.test.ts`

- [ ] **Step 1: Write failing tests:** every key in `ServerSettings` (walk the shared type's runtime defaults) has a registry entry (a missing one fails the test with its name); a `PATCH` of `namingModel` + `server.port` returns `applied: ["namingModel"]`, `pending: ["server.port"]` and `GET` shows `pendingRestart: ["server.port"]`; patching the port back removes it (Review Focus 2); changing `refreshIntervalMinutes` re-arms the scheduler (next fire at the new interval, fake timers) with no restart; `settings.changed` is published with `{scope: "server", keys}`; an extension's `onSettingsChanged` receives its changed keys, and one that throws is logged while the PUT still returns 200.
- [ ] **Step 2: Run** `npx vitest run test/settings-apply.test.ts` — FAIL.
- [ ] **Step 3: Implement.** The boot snapshot is taken once, after settings load and before listen.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "settings: live/restart metadata for every core key, settings.changed, onSettingsChanged, pendingRestart (supersedes core-hardening §5.7 rule)"`.

### Task 2: Restart route and supervision

**Files:**
- Create: `src/server/routes/admin.ts` (`POST /v1/admin/restart`)
- Modify: `src/config.ts` (`server.supervised`, env `SIGRUN_SUPERVISED`, strict `true`/`false`; `server.dev` already exists from U0), `src/serve.ts` (restart = the existing graceful shutdown path, then `process.exit(0)`), `src/server/routes/meta.ts` (`/v1/meta` gains `supervised`), `charts/sigrun/values.yaml` + `charts/sigrun/templates/common.yaml` (`SIGRUN_SUPERVISED: "1"`), `docker/docker-compose.yaml` (`SIGRUN_SUPERVISED: "1"`, `restart: unless-stopped`), `README.md` (restart section)
- Modify: `webui/src/App.tsx` + `tui/src/ui/app.ts` (a "Restarting…" state after a restart call, reconnecting when `/readyz` answers)
- Test: `test/admin-restart.test.ts`, `test/manifests.test.ts` (extend), `webui/src/App.test.tsx`, `tui/test/app.test.ts`

- [ ] **Step 1: Write failing tests:** non-admin → `403`; unsupervised → `409 not_supervised`; supervised admin → `202`, then the shutdown hook runs and `process.exit(0)` is called (stubbed); the Dockerfile does not set `SIGRUN_SUPERVISED` (grep in test), compose and the rendered chart do; `/v1/meta` reports `supervised`; Review Focus 4 with a faux streaming run: the run's submission is durable before exit (a fresh harness on the same db resumes it); the webui shows "Restarting…" and recovers when a mocked `/readyz` flips to 200.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "settings: admin restart route, supervised only in chart and compose, channels reconnect after restart"`.

### Task 3: Section definitions and extension sections

**Files:**
- Modify: `src/extension.ts` (`SettingsSectionDef {id, title, icon?, form: Tree, secrets?, admin?}`; `surfaces.settings?: SettingsSectionDef[]`), `src/harness/loader.ts` (validate each `form` with placement `settings`; field names must be top-level keys; an extension whose slug is `core` is quarantined, since core sections use that slug)
- Create: `src/server/surfaces/settings-surfaces.ts` (adapts a `SettingsSectionDef` to a `SurfaceDef<"settings">`: `render` returns the form plus current values from `settings/<slug>.json` and secret statuses; the `save` action validates fields, writes, fires Task 1's change path; `access` = `write` for admins, `none` for others when `admin`)
- Test: `test/settings-sections.test.ts`, `test/fixtures/fixture-settings-section/`

- [ ] **Step 1: Write failing tests:** the fixture's section renders with stored values; saving a value violating `min` returns `{ok: false, error: {field}}` and writes nothing; a valid save writes `settings/<slug>.json`, returns `{ok: true, rev}` and fires `onSettingsChanged`; a `secret` field shows `set (stored)` after `PUT …/secrets/<key>` and its value never appears in any response; a non-admin gets `404` on an `admin` section; an extension with slug `core` is quarantined; Review Focus 3 (the action payload carries the `rev` it was based on; a stale `rev` → `{ok: false, error: {message: "changed by someone else"}}` and the response's next fetch shows current values); Review Focus 5 (an unknown stored key survives a save and appears in the Advanced raw JSON).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "settings: extension-declared settings sections as settings-placement surfaces"`.

### Task 4: Core sections on blocks, both settings panels, search

**Files:**
- Create: `src/settings/core-sections.ts` (General, Interface, Providers, Users and invites, Jobs, Backup, Extensions as `SettingsSectionDef`s under slug `core`; Interface binds client prefs and saves them client-side)
- Modify: `webui/src/settings/SettingsPanel.tsx` (replace the hardcoded `SECTIONS` with the list from `GET /v1/settings/sections`; each section is a `SurfaceView`; the `pendingRestart` callout with the Restart button when `supervised` and the user is an admin, otherwise "Restart sigrun to apply"), `tui/src/ui/app.ts` (a Settings view doing the same)
- Create: `src/server/routes/settings-sections.ts` (`GET /v1/settings/sections` → `{sections: {slug, id, title, icon}[], index: {sectionId, label, help}[]}`)
- Test: `test/settings-sections-core.test.ts`, `webui/src/settings/SettingsPanel.test.tsx`, `webui/e2e/settings-panel.spec.ts` (update), `tui/test/settings.test.ts`

- [ ] **Step 1: Write failing tests:** every core section validates as a `settings` tree; the section list orders core first then extensions alphabetically; the search index includes every field label and help string, and searching "naming" in the webui and TUI jumps to General → naming model; an extension without a section still shows its raw JSON editor under Extensions → <name> → Advanced; the restart callout lists pending keys and shows the button only for a supervised admin; Playwright: change `namingModel` (no callout) and `server.port` (callout appears).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate: `npm test && npm run typecheck && npm --workspace @sigrun/webui run test && npm run typecheck:webui && npm run build:webui && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck && npm run test:e2e` — PASS.
- [ ] **Step 5: Commit** `git commit -m "settings: core sections rebuilt on blocks; one settings renderer in webui and TUI; label search"`.
