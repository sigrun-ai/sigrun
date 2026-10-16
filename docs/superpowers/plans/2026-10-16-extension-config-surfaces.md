# Extension Config Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sigrun extensions a uniform config surface — XDG-resolved store roots, five store kinds (secrets/settings/data/state/cache), server-mediated secrets+settings with scoped factory handles, raw extension-owned data/state/cache directories, slug-based extension identity, and per-section optional backup.

**Architecture:** New leaf module `src/harness/stores.ts` owns directory resolution (the one resolution chain), the slug function, and the settings/secrets store classes. The loader computes each extension's slug once and threads a scoped `ExtensionStores` handle through the existing factory host-context seam (seam-host rekey, arity-1 factories). `config.ts` gains the three new dir envs and the backup section refactor. Backup (`src/backup/run-backup.ts`) grows from DB-only to per-section, default-off. No HTTP surface changes; nothing in `webui/` or `tui/` changes except the settings-panel §9 note (deferred — not in this plan's scope except where the wire type says otherwise).

**Tech Stack:** TypeScript/NodeNext (root tsconfig), node:fs/promises, vitest (`test/*.test.ts` root suite), chart edits in `charts/sigrun/` (values + cronjob template), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-extension-config-surfaces-design.md` (the plan argues from it; rulings ledger §Decisions 1–12)

## Global Constraints

- Resolution chain per root, verbatim: explicit env (`SIGRUN_CONFIG_DIR`, `SIGRUN_DATA_DIR`, `SIGRUN_CACHE_DIR`, `SIGRUN_STATE_DIR`) → `$XDG_CONFIG_HOME`/`$XDG_DATA_HOME`/`$XDG_CACHE_HOME`/`$XDG_STATE_HOME` + `/sigrun` (when set AND non-empty) → `$HOME`-based defaults (`~/.config/sigrun`, `~/.local/share/sigrun`, `~/.cache/sigrun`, `~/.local/state/sigrun`).
- Slug rule, verbatim: declared name → take everything after the LAST `/` → strip trailing `@version` suffix → lowercase → fold `[^a-z0-9_-]+` runs to `-` → trim edge `-`/`_`. Empty result fails loud at load. Slug collision between two loaded extensions fails loud at load.
- The slug IS the extension name everywhere in sigrun (store keys, interaction records, ambient keys, worker names). One sanitization point, computed once at load in the loader.
- No automatic deletion, ever: removing an `extensions[]` entry or `enabled: false` never deletes settings/secrets/data/state/cache. No deletion API ships in this plan.
- Secrets/ettings writes are server-mediated and atomic (temp file + rename, `0600` for secrets.json, `0700` for extension data dirs); data/state/cache are raw paths the extension owns.
- Stored-wins-with-env-bootstrap: env seeds only while nothing is stored; a stored value always wins; precedence identical for provider auth.json, extension secrets, and extension settings.
- Backup: default OFF; per-section opt-in (config, secrets, data, state — never cache); DB backup folds into the same structure preserving existing `SIGRUN_BACKUP_PATH`/`SIGRUN_BACKUP_S3_*` semantics unchanged when enabled.
- Tests own their literals: synthetic extension names (`acme-tool`, `@acme/tool`), `example.invalid` hosts, no real tokens.
- Repo conventions: NodeNext `.js` import specifiers; vitest at repo root; never `git add -A`; commit per task with the task's verbatim message.

## Review Focus

1. **Resolution-chain precedence inversion.** An env var set to EMPTY string must fall through to the next tier (the `SIGRUN_CONFIG_DIR` precedent at settings.ts:249 treats empty as unset), and `$XDG_*_HOME=""` must fall through to `$HOME` defaults. A wrong guess silently sends workstation users' stores to `/sigrun` at the filesystem root. Owning test: Task 1 (every tier, every var, empty-string cases).
2. **Slug collisions and empty slugs must fail the LOAD, not the store write.** If collision detection rides the store call, an extension that never touches its stores bootstraps with a duplicated identity and the failure lands mid-run as a 500. Owning test: Task 3 (two extensions same slug → loader rejects the second at load; name that slugs empty → load fails with the declared name in the error).
3. **Atomicity of secrets/settings writes under partial failure.** A crash between write and rename must never leave a truncated secrets.json (credential loss on next read). Owning test: Task 5 (inject write failure mid-sequence — temp file exists, target unchanged, old contents readable).
4. **Env bootstrap must not clobber stored values.** `SIGRUN_EXT_<SLUG>_<KEY>` set in the environment while `secrets.json` already holds the key must resolve to the STORED value (stored-wins), and must never write the env value back down. Owning test: Task 6 (env set + stored set → stored wins; env set + store empty → env value served; env value NEVER materializes in the file).
5. **Cache dir on emptyDir must not break boot.** In containers `SIGRUN_CACHE_DIR=/cache` may be wiped between runs; the store layer and extension load path must tolerate a missing cache root (mkdir -p semantics) and must NEVER mkdir/cache anything under the data root by fallback. Owning test: Task 2 (cache root deleted mid-session → next cache-path resolution recreates it; no fallback path ever chosen).

---

### Task 1: Store-root resolution (`src/harness/stores.ts` — resolve functions)

**Files:**
- Create: `src/harness/stores.ts`
- Test: `test/stores-resolution.test.ts`

**Interfaces:**
- Produces: `resolveStoreRoots(env: Env): StoreRoots` where `StoreRoots = { configDir: string; dataDir: string; cacheDir: string; stateDir: string }` (absolute paths, `~` expanded). Also exports `DEFAULT_STORE_ROOTS` shape for tests: `{ config: ["~/.config", "sigrun"], data: ["~/.local/share", "sigrun"], cache: ["~/.cache", "sigrun"], state: ["~/.local/state", "sigrun"] }` semantics — implementer picks the internal constant shape to match `homedir()` usage in settings.ts:249.
- Consumes: `Env` type from `src/config.ts` (the `Record<string, string | undefined>` env alias — check its export name in config.ts and reuse it verbatim).

- [ ] **Step 1: Write the failing tests** — `test/stores-resolution.test.ts`:
  - Each of the four dirs: env override wins over `$XDG_*_HOME`; `$XDG_*_HOME` set wins over `$HOME` default; all unset → `$HOME` default.
  - Empty-string env (`SIGRUN_CONFIG_DIR: ""`) falls through to the XDG tier; empty `$XDG_DATA_HOME` falls through to the `$HOME` default.
  - All returned paths are absolute and end in `/sigrun` (or the env-given path verbatim, un-suffixed, for explicit overrides).
- [ ] **Step 2: Run** `npx vitest run test/stores-resolution.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `resolveStoreRoots` in `src/harness/stores.ts` — one small function per tier, shared logic, no caching of the env (resolution is call-time so tests can vary env via the `env` param, never `process.env` directly).
- [ ] **Step 4: Run** — expect PASS. Run `npm run typecheck` — clean.
- [ ] **Step 5: Commit** — `feat(harness): XDG store-root resolution (config/data/cache/state)`

### Task 2: Store-root lifecycle (ensure/repair) + cache-repair semantics

**Files:**
- Modify: `src/harness/stores.ts`
- Test: `test/stores-lifecycle.test.ts`

**Interfaces:**
- Consumes: `resolveStoreRoots` (Task 1).
- Produces: `ensureStoreRoots(roots: StoreRoots): Promise<void>` — mkdir recursive on config/data/state roots and their `settings/` subdirectory (config only); AND `ensureCacheDir(roots: StoreRoots, slug: string): Promise<string>` — mkdir -p `<cacheDir>/<slug>` at CALL time (never boot) and return the path. Missing cache roots are recreated on every call (Review Focus 5); no other root is ever recreated mid-session by the cache path.
- Boot integration point (wire it, test asserts it): `openHarness` in `src/harness/boot.ts` calls `ensureStoreRoots` after `loadConfig` resolution, before extension loading, using the final resolved config. Fails loud on EACCES/EROFS naming the root and the operation.

- [ ] **Step 1: Write the failing tests** — boot-level `ensureStoreRoots` call creates all roots from a fake env; `ensureCacheDir` recreates a deleted cache dir; a read-only config root makes boot fail loud with the root path in the error.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** in stores.ts + the one `openHarness` call site (boot.ts, after config resolution ~line 300, before registry.install — match the file's existing comment style for placement).
- [ ] **Step 4: Run** — PASS; `npm test` root suite still green (boot changes are additive; `test/boot*.test.ts` files must not regress).
- [ ] **Step 5: Commit** — `feat(harness): store-root lifecycle — boot ensure + per-call cache repair`

### Task 3: Extension slug (`slugify`) + loader integration

**Files:**
- Modify: `src/harness/stores.ts` (slug function), `src/harness/loader.ts` (identity threading)
- Test: `test/extension-slug.test.ts`

**Interfaces:**
- Consumes: loader's `extensionName` (loader.ts:65 — "the extension name on success; the specifier on quarantine") and `createSeamHost({ name: extensionName }, ...)` call site at boot.ts:340.
- Produces: `slugifyName(declared: string): string` (pure, Task 1's module); loader change: the resolved extension's name BECOMES `slugifyName(declared)` at load — one point, then everything downstream (SeamHost identity, interaction records, worker names, health) sees the slug. Loader rejects: empty slug → load error naming the declared name; duplicate slug among this boot's loaded extensions → load error naming both extensions.
- The `rekey` path (seam-host) is untouched — the slug replaces `extensionName` BEFORE `createSeamHost` is called, so the host's two-phase rekey keeps working verbatim.

- [ ] **Step 1: Write the failing tests** — slug table: `@juicesharp/rpiv-ask-user-question` → `rpiv-ask-user-question`; `git:host/org/tool` → `tool`; `My_Tool@2.1.0` → `my_tool`; `Pí /// weird///name` → `p-name` (fold runs, trim); `@scope/` (empty last segment) → load-fail; two extensions whose slugs collide → second load fails naming both. Loader test: a fixture extension declaring a scoped name loads with slug identity visible in its factory-received host `name`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `slugifyName` (pure function in stores.ts) + the loader one-point rename + the collision/empty rejection at the collection point where loaded extensions are gathered (loader.ts — where `extensionName` is finalized).
- [ ] **Step 4: Run** — PASS; `npm test` full root suite green (loader changes are identity-only; `test/loader*.test.ts`, `test/auth-hook.test.ts` fixtures must not regress — they use un-scoped synthetic names that slug to themselves).
- [ ] **Step 5: Commit** — `feat(harness): extension slug identity — one sanitization point at load`

### Task 4: Secrets + settings store classes (atomic, keyed, API-mediated)

**Files:**
- Modify: `src/harness/stores.ts`
- Test: `test/stores-secrets-settings.test.ts`

**Interfaces:**
- Consumes: `resolveStoreRoots` (Task 1), slug (Task 3).
- Produces:
  - `class SecretsStore` — constructor `(secretsPath: string)`; methods: `readSection(slug: string): Promise<Record<string, unknown>>`, `writeSection(slug: string, section: Record<string, unknown>): Promise<void>` (read-modify-write of the whole file, atomic temp+rename, `0600`); file is `{}` when absent; a malformed secrets.json fails loud (parse error naming the path) — never silently reset.
  - `class ExtensionSettingsStore` — constructor `(settingsDir: string)`; methods: `read(slug: string): Promise<Record<string, unknown>>` (absent file → `{}`), `write(slug: string, value: Record<string, unknown>): Promise<void>` (atomic temp+rename of `settings/<slug>.json`, `0644` acceptable, contents arbitrary per extension).
  - `resolveSecretFor(slug, key, env): { value: string; source: "stored" | "env" } | undefined` — stored value wins when the section has `key`; else env var `SIGRUN_EXT_<SLUG-UPPER-SNAKE>_<KEY-UPPER-SNAKE>`; else undefined. NEVER writes env values down (Review Focus 4). Slug→env-name conversion: uppercase, `-`→`_`.
- [ ] **Step 1: Write the failing tests** — secrets: absent file → `{}`; write/read roundtrip; two extensions isolated sections; atomicity — stub `rename` to throw after the temp write, assert target unchanged with old contents intact (Review Focus 3); malformed file → loud error naming path; `0600` mode asserted. Settings: per-file isolation; atomic write; malformed file → loud. Precedence: env+stored → stored, env-only → env, neither → undefined, and the file's bytes are byte-identical before/after any env-only resolution.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Atomic write helper shared by both classes: `writeFileAtomic(path, data, mode)` — temp file in the SAME directory (rename is same-fs atomic), then `rename`. One implementation, two call sites.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** — `feat(harness): secrets + settings stores — atomic, keyed, stored-wins precedence`

### Task 5: Factory-context threading (`ExtensionStores` handle via SeamHost)

**Files:**
- Modify: `src/harness/stores.ts` (handle type), `src/harness/seam-host.ts`, `src/harness/boot.ts` (one call site), `src/harness/loader.ts` (docstring note)
- Test: `test/extension-stores-handle.test.ts`

**Interfaces:**
- Consumes: `SecretsStore`, `ExtensionSettingsStore`, `ensureCacheDir`, slug (Tasks 2–4); `createSeamHost({ name: extensionName }, kinds, ...)` at boot.ts:340 and `rekey` (two-phase identity).
- Produces: `interface ExtensionStores` on the SeamHost (a NEW field `stores`, populated by the SAME rekey two-phase pattern — identity changes, handles don't): `{ secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }` (scoped to THIS slug's section — the extension cannot name another slug), `settings: { get(): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> }` (THIS slug's file), `paths: { data: string; cache: string; state: string }` (resolved absolute paths; data/state dirs ensured at boot, cache ensured at first access via `ensureCacheDir`). No path-style access to secrets/settings — the extension never sees the file, only the handle.
- rekey mutates the stores field in place along with identity (the M2 lesson: the captured host object IS the final host).
- [ ] **Step 1: Write the failing tests** — a fixture arity-1 factory captures its host at load; asserts: `host.stores.secrets.get("k")` resolves only ITS section (pre-seed a foreign section `other` with a key `k` — the fixture must NOT see it); `host.stores.secrets.set("k", "v")` persists to secrets.json under the fixture's slug; `host.stores.settings.set({...})` lands in `settings/<slug>.json`; `host.stores.paths.cache` exists on disk after first access; after the rekey, the SAME host object identity exposes the slug-corrected identity (rekey coherence — the extension captured the host pre-rekey and its stores still work post-rekey).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `createSeamHost` signature gains the stores trio (constructed in boot.ts from the Task 4 classes + resolved roots, passed in); rekey re-points the scoped views. Update loader.ts's factory-context docstring (the "host context (src/harness/seam-host.ts ...)" paragraph) to name the new field.
- [ ] **Step 4: Run** — PASS; full root suite green (`test/interaction-seam*`, `test/memory-seam*` style suites must not regress — the SeamHost interface grows additively).
- [ ] **Step 5: Commit** — `feat(harness): extension stores handle — scoped secrets/settings + raw paths on the factory host`

### Task 6: Config env surface (`SIGRUN_DATA_DIR`/`SIGRUN_CACHE_DIR`/`SIGRUN_STATE_DIR`) + DB default move (clean break)

**Files:**
- Modify: `src/config.ts` (SigrunConfig type + loadConfig resolution ~:480), `src/harness/stores.ts` (consume resolved config over raw env where boot already resolved it), `src/harness/boot.ts`
- Test: `test/config-store-dirs.test.ts`, extend `test/config.test.ts` for the new envs

**Interfaces:**
- Consumes: Task 1's resolver (boot calls it with the final env; config.ts keeps precedence docs coherent with the resolver, no duplicate logic — config.ts may simply CALL `resolveStoreRoots` for its three new fields).
- Produces: `SigrunConfig` gains `dataDir`, `cacheDir`, `stateDir` (resolved absolute strings). `DEFAULT_STORAGE_PATH` changes from `"data/sigrun.db"` to the data-root join (`<dataDir>/sigrun.db`) — CLEAN BREAK, no migration detection (user ruling: only test DBs exist). Relative `SIGRUN_STORAGE_PATH` values resolve against the data root (documented behavior change; chart/compose use absolute paths and are unaffected). Chart/compose edits land in Task 8, not here.
- [ ] **Step 1: Write the failing tests** — config: env set → config.dataDir equals it; unset → XDG/HOME chain (Task 1 semantics via config); `SIGRUN_STORAGE_PATH` relative → resolves against dataDir; absent → `<dataDir>/sigrun.db`. settings.json `server.*` mirrors for the three new knobs (existing precedent: every SIGRUN_* knob has one — check `serverSettings` shape in settings.ts and mirror the three fields).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — config.ts calls the resolver; storage default moves; boot passes resolved config dirs INTO the stores layer (boot owns resolution-once; stores.ts functions stay env-param pure for testability).
- [ ] **Step 4: Run** — PASS; full root suite green (`test/config.test.ts`, `test/deploy-entry.test.ts` subprocess assertions on the listening line must not regress).
- [ ] **Step 5: Commit** — `feat(config): data/cache/state dir envs + DB default under the data root (clean break)`

### Task 7: Backup refactor — per-section, default off, DB folds in

**Files:**
- Modify: `src/config.ts` (`parseBackupConfig`), `src/backup/run-backup.ts`, `charts/sigrun/values.yaml` (backup section), `charts/sigrun/templates/common.yaml` (CronJob env)
- Test: `test/backup-sections.test.ts` (new), keep `test/backup.test.ts` green unchanged

**Interfaces:**
- Consumes: existing `BackupConfig` (`target: "path" | "s3"`, config.ts:41) and the CronJob wiring (values.yaml:124-152).
- Produces: `BackupConfig` gains `sections: { config: boolean; secrets: boolean; data: boolean; state: boolean }` (default all-false) while the DB part keeps today's env contract verbatim (`SIGRUN_BACKUP_PATH`/`SIGRUN_BACKUP_S3_*`). New envs: `SIGRUN_BACKUP_SECTIONS=config,secrets,data,state` (comma list; absent/empty → no sections; unknown name → fail loud at parse). `run-backup.ts`: after the DB backup steps, for each enabled section copy the directory into `<backup-target-dir>/<section>-<UTC timestamp>.tar.gz` (path target) or `s3 cp` the tarball (s3 target). Secrets section tarball gets `0600`. Cache NEVER backed up — not a valid section name (enforced by the fail-loud parse). DB-backup-only deployments (today's env contract, no SIGRUN_BACKUP_SECTIONS) behave byte-identically to before — the section loop is a no-op.
- IMPORTANT default-off semantics: enabling `sections` requires an explicit target as today; nothing auto-enables when a target exists.
- [ ] **Step 1: Write the failing tests** — parse: no SECTIONS env → sections all false (existing tests untouched and green); `SIGRUN_BACKUP_SECTIONS=config,data` → exactly those two true; `SIGRUN_BACKUP_SECTIONS=cache` → parse throws naming the invalid section; `SIGRUN_BACKUP_SECTIONS=config,config` → dedup or throw (implementer's pick, test pins it). run-backup: with a path target + sections=config,secrets and seeded fixture dirs → tarballs exist with expected entries; secrets tarball mode 0600; cache dir contents NEVER appear in any tarball; s3 target: assert the spawned `aws s3 cp` argv includes the tarball paths (mock spawn like the existing tests do — follow `test/backup.test.ts`'s spawn-mock idiom).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — parse extension, section tar loop (`tar -czf` via existing spawn idiom), CronJob env passthrough in `templates/common.yaml` + values.yaml docs for the new env. Chart backup section stays `enabled: false` default.
- [ ] **Step 4: Run** — PASS; `test/backup.test.ts` green UNCHANGED (byte-identical contract for DB-only deployments); `bash scripts/` chart sanity if the repo has a chart lint (check `charts/sigrun/` README).
- [ ] **Step 5: Commit** — `feat(backup): per-section opt-in backup — config/secrets/data/state, cache never, DB contract unchanged`

### Task 8: Chart + compose deployment wiring

**Files:**
- Modify: `charts/sigrun/values.yaml`, `charts/sigrun/templates/common.yaml` (deployment env), `docker/docker-compose.yaml`
- Test: `test/charts-manifests.test.ts`-style check — find the existing chart manifest test (`grep -rl "values.yaml" test/ --include="*.test.ts"`) and extend IT; no new test file.

**Interfaces:**
- Consumes: Tasks 1–7 (the env names are the contract).
- Produces: chart deployment env gains `SIGRUN_DATA_DIR=/data/data`, `SIGRUN_CACHE_DIR=/cache`, `SIGRUN_STATE_DIR=/data/state` (config dir already `/data/config`); a NEW `emptyDir` volume for `/cache` (values: `cache: { emptyDir: {} }` pattern matching the chart's existing volume style — read values.yaml volumes block and mirror it); compose gains the same three envs with a named volume for data/state mirroring the existing one and a tmpfs/anonymous volume for cache. `SIGRUN_STORAGE_PATH` stays `/data/sigrun.db` (unchanged, now under the data root semantically).
- [ ] **Step 1: Write the failing test additions** — manifest test asserts: deployment env contains the three new names with those exact values; the cache volume is `emptyDir` (not PVC); data/state/config mounts point at the PVC volume.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Edit** values.yaml (values + comments explaining WHY cache is emptyDir: regenerable, self-cleaning, never on the PVC) and common.yaml env block; mirror in docker-compose.yaml.
- [ ] **Step 4: Run** — PASS; `helm template charts/sigrun` renders without error (verification step; if the repo has a helm lint script, run it).
- [ ] **Step 5: Commit** — `feat(chart): store-dir envs + cache emptyDir — durable buckets on PVC, cache pod-local`

### Task 9: Docs — extension-author surface + scrub check

**Files:**
- Create: `docs/extending.md` (the extension-author doc: the five stores, the slug rule, resolution chain, precedence, container mapping, uninstall posture — written FOR outsiders, no private paths)
- Modify: `README.md` (one paragraph + link), `AGENTS.md` (stores.ts note under harness layout)
- Test: none (docs task); the Task 9 gate is the scrub check.

**Interfaces:**
- Consumes: the spec (content source) and everything Tasks 1–8 landed.
- Produces: the discoverable answer to "where does my stuff go" — the spec's §1 anti-example (pi's littered config dir) is the doc's motivating frame.

- [ ] **Step 1: Write `docs/extending.md`** — sections: the five stores (table from spec §2), directory map (spec §3 table), resolution chain (spec §4), secrets precedence with an example (env `SIGRUN_EXT_ACME_TOOL_API_KEY` + stored capture via `/settings`-style affordance note), the slug rule with the `@juicesharp/rpiv-ask-user-question` worked example, handle usage snippet (the Task 5 `host.stores` shape), uninstall posture. No private hostnames/paths — this doc ships publicly.
- [ ] **Step 2: README + AGENTS.md touch** — README: extending section pointer. AGENTS.md: one line (`src/harness/stores.ts` = store roots, slug, secrets/settings stores; boot ensures roots).
- [ ] **Step 3: Scrub check** — `grep -rn "personal-host.example\|personal-host.example\|personal-host.example\|/home/michael" docs/extending.md` → zero hits (repo publish posture; the global AGENTS.md in-repo discipline).
- [ ] **Step 4: Commit** — `docs: extension-author guide — stores, slugs, resolution, precedence`

---

## Self-review notes

- **Spec coverage:** §2 taxonomy (T4/T5 classes + T7 backup column), §3 map (T1/T2/T6), §4 resolution+containers (T1/T6/T8), §5 ownership+precedence (T4/T5/T6), §6 lifecycle (T3 slug-on-load; no-deletion is a constraint honored by NOT building deletion — no task ships one, correct by absence; T2 boot-ensure), §7 backup reform (T7), §8 constraints (T6 config coherence, T8 chart), §9 builder items resolved: handle shape (T5), capture affordance (NOT built — one channel must capture without restart is a webui panel task, deferred with the user's spec §9 note; documented in extending.md as "via the webui settings panel, coming with the settings-surface work"), env naming (T4's `SIGRUN_EXT_<SLUG>_<KEY>`), perms (T4), store-class shape (T4), chart patch (T8). Deliberate gap, stated: the interactive capture affordance is NOT in this plan — the wire/API for it (extension settings/secrets surfaced in /v1/settings) is its own small surface; the spec's §9 left the affordance shape to the builder and the user's ruling only fixed precedence. Flagged here so the gap is a decision, not an oversight.
- **Step scan:** each step is one artifact (test file, function, wiring, gate, commit); no TBD lines; bodies appear only where the algorithm isn't determined (atomic-write helper, slug fold).
- **Type consistency:** `resolveStoreRoots`/`StoreRoots` (T1) consumed by T2/T6; `slugifyName` (T3) consumed by T4's env-name conversion and T5's handle scoping; `SecretsStore`/`ExtensionSettingsStore` (T4) consumed by T5/T6; `ExtensionStores` (T5) documented in T9; `BackupConfig.sections` (T7) rendered in T8's env docs.
- **Review Focus:** all five lines have owning tests (T1 precedence matrix; T3 load-time rejection; T4 atomicity-under-failure; T4 stored-wins/never-write-down; T2 cache repair + no-fallback).
- **Proportion:** 9 tasks ≈ spec weight (the spec is 12 rulings + 9 sections); test-first throughout; no task exceeds ~2 files of production code except T7 (parse + script + chart, one concern).
