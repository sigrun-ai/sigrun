# W2 — Operational correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the operational traps from the review:
- readiness flapping on provider blips;
- uploads capped by Fastify's 1 MiB default;
- the workstation first-boot EACCES;
- frozen defaults in `settings.json`;
- extension/host pi-durable skew;
- reserved-key boot aborts;
- dead code;
- a backup badge that lies;
- no metrics;
- a root container.

**Architecture:** Each task is an independent fix with its own test, landing in any order after W0. The credential-precedence bug (spec §6.11) has its own plan and ships first: `docs/superpowers/plans/2026-10-19-credential-precedence.md`.

**Tech Stack:** TypeScript (NodeNext), Fastify 5, vitest, Helm (`helm lint`/`helm template`), Docker.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` §6.1–§6.10, plus the §10 W2 tests and ruling 5.

**Depends on:** W0 merged (route modules). Task 8 (`/metrics`) reads `config.metricsPublic` from W1 Task 1. If W2 lands before W1, `/metrics` is always public until W1, and the task notes the dependency in its commit.

## Global Constraints

- **Readiness:** `/readyz` = a real storage read only. Provider/memory health never fail it.
- **Uploads:**
  - `server.maxUploadBytes` defaults to 64 MiB (67 108 864), env `SIGRUN_MAX_UPLOAD_BYTES`;
  - the base64 routes' `bodyLimit` = `Math.ceil(max * 4 / 3) + 4096`;
  - over-limit → `413 {error:"too_large", maxBytes}`.
- **Workspace default:** `join(dataDir, "workspace")`.
- **Bootstrap** writes only env-sourced values (ruling 5).
- **Version guard:**
  - `@earendil-works/pi-durable` requires an exact version match, else quarantine;
  - `@earendil-works/pi-ai`, `@earendil-works/chord`, and `typebox` require the same major, else quarantine; a minor difference warns.
- **Backup marker:**
  - `<stateDir>/backup/last-success.json` = `{at: ISO string, target: "path"|"s3", bytes: number}`;
  - stale after `server.backup.staleAfterHours` (default 36).
- **Metrics:** Prometheus text exposition, `text/plain; version=0.0.4; charset=utf-8`.
- **Image:**
  - uid 1000 (`node`);
  - `git`, `sqlite3`, `ca-certificates` installed;
  - `tar` kept;
  - no `curl`.
- **Verification** per task: `npm test` + `npm run typecheck`; plus `helm lint charts/sigrun` for chart edits; plus `docker build .` for Task 9.

## Review Focus

1. **A `PUT` upload name arriving percent-encoded** (`%2e%2e%2f`). Fastify decodes params, so the check runs on the decoded value. Task 2 pins `..%2Fx` and `%2e%2e`.
2. **`Content-Type` missing on `PUT`.** Clients (curl) may omit it. The route registers the raw parser for `application/octet-stream` AND treats an absent content type as raw for this route only. Task 2 tests a `PUT` with no content-type → 201.
3. **The first boot with NO env and NO file** (the workstation case). Bootstrap now writes `{server: {}}` (or nothing), and the next boot must resolve identical defaults. Task 3 boots twice and compares resolved configs.
4. **An extension that imports pi-durable through a nested `node_modules`** (npm couldn't hoist). The guard resolves from the extension entry's directory, so it sees the nested copy. Task 5's fixture puts a fake `pi-durable@0.0.1` under the fixture package's own `node_modules`.
5. **The metrics scrape racing shutdown.** `harness.inspect()` throws after close. The `/metrics` handler catches it and emits `sigrun_up 0` instead of 500ing. Task 8 pins this.

---

### Task 1: Readiness is storage-only

**Files:**
- Modify: `src/server/routes/probes.ts`, the `/readyz` handler. Delete the memory/provider checks; keep the root-conversation read.
- Test: `test/server-probes.test.ts`.

- [ ] **Step 1: Write the failing test** `test("/readyz stays 200 when a provider and memory report degraded")`, using the existing degraded fixtures (`fixture-ext-degraded`, `fixture-memory-degraded`): `GET /readyz` → 200 and body `sigrun_readiness 1\n`. Rewrite or delete the existing assertions that expect 503 on degraded health. The closed-harness → 503 `checks.storage: "failed"` test stays.
- [ ] **Step 2: Run** `npx vitest run test/server-probes.test.ts`. Expected: FAIL (503).
- [ ] **Step 3: Implement.** The 503 body becomes `{ready:false, checks:{storage:"failed"}}`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "probes: readiness = storage read only (degraded upstreams stay in /v1/meta)"`.

### Task 2: Raw uploads and body limits

**Files:**
- Modify:
  - `shared/src/settings.ts` (`ServerSettings.maxUploadBytes?: number`);
  - `src/harness/settings.ts` (validate as a positive int);
  - `src/config.ts` (`SigrunConfig.maxUploadBytes`, env `SIGRUN_MAX_UPLOAD_BYTES`).
- Modify: `src/server/routes/files.ts`:
  - new `PUT /v1/conversations/:id/uploads/:name` (`preHandler: loadConversation(ctx, "write")` once W1 exists; `loadConversation(ctx)` before);
  - the existing `POST …/uploads` gets `bodyLimit`;
  - a shared `validUploadName(name)` (no `/` or `\`, not `.`/`..`, non-empty) used by both.
- Modify:
  - `src/server/routes/conversations.ts`: `POST /v1/conversations/import` gets `bodyLimit`;
  - `src/server/index.ts`: a Fastify `setErrorHandler` branch mapping `FST_ERR_CTP_BODY_TOO_LARGE` → `413 {error:"too_large", maxBytes}`.
- Modify: `webui/src/api.ts` (`upload` → `PUT` with the raw `Blob`) and `tui/src/api.ts` (if it uploads; `grep -n uploads tui/src/api.ts`).
- Test: `test/server-uploads.test.ts` (new); `webui/src/api.test.ts`.

**Interfaces:**
- **`PUT …/uploads/:name`:**
  - body `application/octet-stream` (or no content-type) → `201 {path: "uploads/<conversationId>/<name>"}`;
  - route `bodyLimit` = `config.maxUploadBytes`;
  - the raw parser is registered once on the app, `addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, …)`;
  - an absent content type is accepted for this route via `onRequest` setting `content-type: application/octet-stream` when absent and method is PUT on this route.

- [ ] **Step 1: Write failing tests:**
  - an 8 MiB raw `PUT` → 201, and the file bytes equal the input (via `GET …/files/content` size, or reading the workspace path);
  - with `SIGRUN_MAX_UPLOAD_BYTES=1024`, a 2 KiB `PUT` → `413 {error:"too_large", maxBytes:1024}`;
  - `PUT …/uploads/..%2Fx` → 400 `invalid_body`;
  - `PUT …/uploads/%2e%2e` → 400;
  - a `PUT` without content-type → 201;
  - a base64 `POST` of a 900 KB file under the default knob → 201 (was 413);
  - import of a 2 MiB JSONL → not 413.
- [ ] **Step 2: Run** `npx vitest run test/server-uploads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, including the webui client switch.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui test`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "uploads: raw PUT route, server.maxUploadBytes knob, 413 too_large for every body-limited route"`.

### Task 3: Workspace default and env-only bootstrap

**Files:**
- Modify: `src/config.ts`:
  - `DEFAULT_WORKSPACE_PATH` is removed in favor of `defaultWorkspacePath(dataDir) = join(dataDir, "workspace")`, used in `loadConfig`;
  - new `envServerSection(env: Env): ServerSettings`, which includes ONLY keys whose env var is set (non-empty).
- **The env-var → key table** for `envServerSection`:

  | env var | key |
  |---|---|
  | `SIGRUN_PORT` | `port` |
  | `SIGRUN_WORKSPACE_PATH` | `workspacePath` |
  | `SIGRUN_STORAGE_PATH` | `storagePath` |
  | `SIGRUN_DATA_DIR` | `dataDir` |
  | `SIGRUN_CACHE_DIR` | `cacheDir` |
  | `SIGRUN_STATE_DIR` | `stateDir` |
  | `SIGRUN_WEBUI` | `webui.enabled` |
  | `SIGRUN_WEBUI_BUNDLE` | `webui.bundle` |
  | `SIGRUN_COMPACTION_ENABLED` | `compaction.enabled` |
  | `SIGRUN_COMPACTION_RESERVE_TOKENS` | `compaction.reserveTokens` |
  | `SIGRUN_COMPACTION_KEEP_RECENT_TOKENS` | `compaction.keepRecentTokens` |
  | `SIGRUN_COMPACTION_BACKGROUND_TOKENS` | `compaction.backgroundTokens` |
  | `SIGRUN_HOOK_DEADLINE` | `memorySeam.hookDeadlineMs` |
  | `SIGRUN_IDLE_THRESHOLD` | `memorySeam.idleThresholdMs` |
  | `SIGRUN_WORKER_DEADLINE` | `memorySeam.workerDeadlineMs` |
  | `SIGRUN_QUEUE_MAX` | `memorySeam.queueMax` |
  | `SIGRUN_PROVIDER_REFRESH_MINUTES` | `providers.refreshIntervalMinutes` |
  | `SIGRUN_BACKUP_*` | `backup` |
  | `SIGRUN_MAX_UPLOAD_BYTES` | `maxUploadBytes` |

  Values are the parsed (typed) values, using the same parsers `loadConfig` uses.
- Modify: `src/serve.ts`. `settingsStore.bootstrap(envServerSection(env), { extensions: env-set ? envConfig.extensions : undefined, defaultModel: env SIGRUN_DEFAULT_MODEL/SIGRUN_MODEL set ? "<p>/<m>" : undefined })`. A `server` key with zero entries is omitted.
- Modify: `src/harness/settings.ts`, where `bootstrap` omits an empty `server`.
- Modify: `src/server/routes/settings.ts`. `GET /v1/settings` gains `effective: Record<string, {value: unknown, source: "env"|"file"|"default"}>`, flattened dotted keys (`"server.port"`, `"server.compaction.reserveTokens"`, …) for the server section.
- Modify: `shared/src/views.ts` (`SettingsResponse.effective`) and README (the "On first boot" paragraph + the defaults table row for `SIGRUN_WORKSPACE_PATH`).
- Remove: `resolvedServerSection` once no caller remains (`grep -rn resolvedServerSection src test`); delete it and its tests, keeping the webui-omission rule's tests by re-pointing them at `envServerSection`.
- Test: `test/config.test.ts`, `test/settings.test.ts`, `test/deploy-entry.test.ts`, `test/server-settings.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - `loadConfig({SIGRUN_DEFAULT_MODEL:"acme/m", SIGRUN_DATA_DIR: tmp})` → `workspace.path === join(tmp, "workspace")`;
  - `envServerSection({SIGRUN_PORT:"4000"})` deep-equals `{port: 4000}`;
  - `envServerSection({})` → `{}`;
  - `envServerSection({SIGRUN_COMPACTION_RESERVE_TOKENS:"9000"})` → `{compaction:{reserveTokens:9000}}`;
  - a deploy-entry first boot with only `SIGRUN_DEFAULT_MODEL` + `SIGRUN_PORT` writes `settings.json` deep-equal to `{defaultModel:"acme/m", server:{port:<n>}}`;
  - booting twice with the same env yields equal `loadConfig` results;
  - `GET /v1/settings` → `effective["server.port"].source === "env"` and `effective["server.compaction.reserveTokens"].source === "default"`.
- [ ] **Step 2: Run** `npx vitest run test/config.test.ts test/settings.test.ts test/deploy-entry.test.ts test/server-settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The `effective` builder compares `envServerSection(env)` (source env), the file's `server` (source file), and the resolved config (the remainder is default). The env used is `opened.providerEnv`'s source env — thread the boot `env` into `ServerContext` as `env: Env`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "config: workspace defaults under dataDir; bootstrap persists env-set values only; /v1/settings effective block"`.

### Task 4: Reserved section keys quarantine at load

**Files:**
- Modify: `src/harness/loader.ts`. Inside the per-extension `try` in `loadExtensions`, after the slug checks and BEFORE `options.hostContextFactory(...)` / `registry.install(...)`: if `extension?.sections` contains a key in `RESERVED_CORE_SECTION_KEYS`, throw `extension "<slug>" declares reserved core section "<key>"`. The existing catch quarantines; nothing was installed or collected.
- Modify: `src/harness/boot.ts`:
  - move `RESERVED_CORE_SECTION_KEYS` to `src/harness/reserved-sections.ts` (imported by both; `boot.ts` re-exports it for existing importers);
  - keep the post-install walk as a CORE-ONLY assertion (`RESERVED_CORE_SECTION_OWNERS`), which can now only fire on a core bug.
- Test: `test/boot-prompt-order.test.ts` (uses `fixture-section-collision`).

- [ ] **Step 1: Write the failing test.** `test("an extension declaring a reserved section key is quarantined and boot continues")`:
  - `openHarness` with `fixture-section-collision` resolves (no throw);
  - its outcome is `{status:"quarantined", error: /reserved core section "skills"/}`;
  - `registry.snapshot().extension(<slug>)` is undefined;
  - `providerContributors` and `seamHosts` contain no entry for it.

  Replace the existing "fails boot loud" assertion.
- [ ] **Step 2: Run** `npx vitest run test/boot-prompt-order.test.ts`. Expected: FAIL (boot throws).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green. Update `docs/extending.md` §"Prompt sections": the quoted error is now a quarantine message, not a boot failure.
- [ ] **Step 5: Commit** `git commit -m "loader: reserved prompt-section keys quarantine at load instead of aborting boot"`.

### Task 5: Host-module version guard

**Files:**
- Modify: `src/harness/packages.ts`:
  - `HOST_RUNTIME_MODULES` adds `"@earendil-works/chord"`;
  - new `hostModuleVersion(name): string | undefined` (reads the host copy's `package.json` version via the existing `resolveHostModuleDir`);
  - `ensureHostModuleLinks` warns `packages: <name>@<v> installed in <packagesDir> differs from host <hv>` when it leaves a real copy whose version differs.
- Modify: `src/harness/loader.ts`. A new `checkHostModules(moduleDir: string): void` runs after import and before install, for any extension with a resolvable `extensionModuleDir`. For each module in `HOST_RUNTIME_MODULES`:
  - resolve `<name>/package.json` with `createRequire(join(moduleDir, "package.json"))`;
  - skip when not resolvable (the extension doesn't depend on it);
  - compare with `hostModuleVersion`.

  A mismatch throws (quarantine) `host module skew: <name> resolves to <v> from <ext>, host runs <hv>`.
- Create: fixture `test/fixtures/fixture-skew/` = a package whose `node_modules/@earendil-works/pi-durable/package.json` says `"version": "0.0.1"`, plus a trivial `index.js` factory.
- Test: `test/loader.test.ts`, `test/packages.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - loading `fixture-skew` → quarantined with an error matching `/host module skew: @earendil-works\/pi-durable resolves to 0\.0\.1/`;
  - an existing healthy fixture (`fixture-ext`) still loads `ok`;
  - `ensureHostModuleLinks` on a tmp packages dir that holds a real `node_modules/@earendil-works/chord/package.json` with version `0.0.1` warns (spy `console.warn`) and leaves it in place.
- [ ] **Step 2: Run** `npx vitest run test/loader.test.ts test/packages.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** For the major comparison, split on `.` and compare the first segment.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "loader: quarantine extensions that resolve a different pi-durable (exact) or other host module major; link chord"`.

### Task 6: Dead code, deprecations, approvals touchpoints, seam guarantees

**Files:**
- **The submit pass-through.** The precondition is met: sigrun-ext-memory-markdown dropped `submit` in its commit `1ae6c90`. Delete:
  - `ExtensionSubmit` and `ExtensionSubmitBinding`;
  - `submitBindings` (`loader.ts`);
  - the `submit` field validation in `resolvedFromFactory`;
  - `memorySubmit` (`boot.ts`);
  - the `opened.memorySubmit` branch in `src/server/routes/submissions.ts`.

  A factory result still carrying `submit` is ignored with one warning `extension "<slug>": the submit pass-through was retired; ignoring`. It is not quarantined, so old packages keep loading.
- **`extensionsDir`:**
  - `src/config.ts`: `SIGRUN_EXTENSIONS_DIR` set → one warning `SIGRUN_EXTENSIONS_DIR is deprecated and ignored`;
  - `src/harness/settings.ts`: `server.extensionsDir` accepted with a deprecation warning;
  - remove `SigrunConfig.extensionsDir` and the README table row.
- **The named-export bridges** (`loader.ts`, `createMemory`/`createApprovals`): resolving through either logs `extension <specifier>: named-export factory "<name>" is deprecated — export it as default`. Behavior is otherwise unchanged; deletion is the next release.
- **Approvals touchpoints:**
  - rename `test/approvals-parity.test.ts` → `test/interaction-decide.test.ts` and `test/fixtures/fixture-approvals` → `test/fixtures/fixture-gate` (update the specifier references; `grep -rn fixture-approvals test`);
  - README: drop the "e.g. the approvals and memory extensions" wording and the `sigrun-ext-approvals@^0.1.0` examples, using `@acme/sigrun-ext-example@^0.1.0`;
  - `src/harness/tools.ts`: the trust-posture comment no longer names approvals ("an installed gating extension").
- **Seam guarantees** — new `test/seam-guarantees.test.ts`:
  - `test("core installs no tool that answers interactions")`: the core-installed tool names (`registry.snapshot().tools()` from a zero-extension `openHarness`) equal exactly `["read","write","edit","bash","find","grep","ls","load_skill"]` (sorted). A new core tool must update this list deliberately.
  - `test("codemode nested calls reach beforeTool with call.parent")`:
    - install `createCodemodeExtension` from `@earendil-works/pi-durable/codemode` plus a test extension with `hooks: [hook(ToolTask, { beforeTool })]` that records `call.name` + `call.parent`;
    - a faux provider scripts one `codemode` tool call whose script calls `tools.ls({})`;
    - assert the recorded calls include `{name:"ls", parent: {callId: <the codemode call id>}}`.
- Test: the files above; update `test/server-submissions.test.ts` (the memory-submit cases go away).

- [ ] **Step 1: Write failing tests:**
  - seam-guarantees (both);
  - a loader test that a factory result with `submit` loads `ok` and warns;
  - a config test that `SIGRUN_EXTENSIONS_DIR` warns and is absent from the config.

  The codemode test may PASS immediately (it pins upstream behavior). That is expected; it is a regression pin.
- [ ] **Step 2: Run** `npx vitest run test/seam-guarantees.test.ts test/loader.test.ts test/config.test.ts`. Expected: the loader/config tests FAIL; seam-guarantees may pass.
- [ ] **Step 3: Implement the deletions, deprecations, and renames.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Then `grep -rn "memorySubmit\|submitBindings\|ExtensionSubmit" src` returns nothing.
- [ ] **Step 5: Commit** `git commit -m "cleanup: retire submit pass-through + extensionsDir; deprecate named-export bridges; approvals-free core; seam guarantee pins"`.

### Task 7: Backup honesty

**Files:**
- Modify: `src/backup/run-backup.ts`. After a successful path rename or S3 upload, write `<SIGRUN_STATE_DIR>/backup/last-success.json` = `{at, target, bytes}` via `writeFileAtomic(…, 0o644)` (mkdir the `backup/` dir). With `SIGRUN_STATE_DIR` unset, warn and skip the marker (the backup itself still succeeds).
- Modify: `shared/src/settings.ts` / `src/harness/settings.ts` / `src/config.ts`: `server.backup.staleAfterHours` (positive number, default 36).
- Modify: `src/server/routes/meta.ts`:
  - `health.backup` = `"unconfigured"` | `"configured"` | `"degraded"`, where degraded means configured AND (marker absent OR `now - at > staleAfterHours`);
  - `MetaResponse.backup = {lastSuccessAt?: string}`;
  - the marker is read per request from `config.stateDir`.
- Modify: `shared/src/views.ts` (`MetaResponse.backup`) and the README backup section: the S3 lifecycle rule, with an example JSON expiring `sigrun-*.db` objects after 30 days.
- Test: `test/backup.test.ts` (the marker is written after a path backup); `test/server-meta-health.test.ts` (configured + a fresh marker → configured; a marker 37 h old → degraded; no marker → degraded; unconfigured → unconfigured).

- [ ] **Step 1: Write the failing tests** above.
- [ ] **Step 2: Run** `npx vitest run test/backup.test.ts test/server-meta-health.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "backup: last-success marker drives health.backup; S3 retention documented as a lifecycle rule"`.

### Task 8: `/metrics`

**Files:**
- Create: `src/server/routes/metrics.ts`, holding `GET /metrics`.
- Modify: `src/harness/event-bus.ts`. Expose `oldestLiveAdmissionMs(now: number): number | undefined` over the existing `#lastAdmission`/live-run maps (the admission instant of the oldest still-live input run).
- Modify: `charts/sigrun/values.yaml`:
  - the ServiceMonitor endpoint path `/readyz` → `/metrics`;
  - env `SIGRUN_METRICS_PUBLIC: "true"` on the main container. W1 Task 1 owns the parsing; if W2 lands first, add the strict `true`/`false` parse here and W1 keeps it.
- Modify: `charts/sigrun/templates/prometheusrule.yaml`. Add these rules:
  - `SigrunSubmissionWedged`: `sigrun_inflight_submission_oldest_seconds > 1800` for 5m;
  - `SigrunProviderNotReady`: `sigrun_provider_ready{status!="ready"} == 1` for 15m;
  - `SigrunBackupStale`: `time() - sigrun_backup_last_success_timestamp_seconds > 36*3600`, only when backup is enabled in values;
  - `SigrunJobFailed`: `increase(sigrun_job_runs_total{outcome="failed"}[1h]) > 0`. W4 defines the counter; the rule ships here and simply matches nothing until W4.
- Test: `test/server-metrics.test.ts` (new); `test/manifests.test.ts` (the ServiceMonitor path and the four alert names in `helm template` output).

**Interfaces:**
- **Metrics emitted:**
  - `sigrun_up` — 1, or 0 when `harness.inspect` throws;
  - `sigrun_live_runs`;
  - `sigrun_inflight_submission_oldest_seconds` — 0 when none;
  - `sigrun_tasks_live{status}` — from `(await harness.inspect(ctx)).tasks` grouped by status;
  - `sigrun_provider_ready{provider,status}` — 1 per provider at its current status;
  - `sigrun_extensions{status}`;
  - `sigrun_backup_last_success_timestamp_seconds` — omitted when there is no marker.

  W4 adds `sigrun_job_*`.
- **Format:** each metric has `# HELP` + `# TYPE … gauge` lines, label values escaped per the exposition format.
- **Access:** public when `config.metricsPublic`; otherwise the W1 pipeline requires a principal.

- [ ] **Step 1: Write failing tests:**
  - the response parses: every non-comment line matches `/^[a-z_]+(\{[^}]*\})? -?[0-9.e+]+$/`;
  - it contains `sigrun_up 1` and `sigrun_provider_ready{provider="faux",status="ready"} 1`;
  - after `opened.harness.close()`, `GET /metrics` → 200 with `sigrun_up 0`;
  - `helm template` output has ServiceMonitor `path: /metrics` and the four alert names.
- [ ] **Step 2: Run** `npx vitest run test/server-metrics.test.ts test/manifests.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && helm lint charts/sigrun`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "metrics: /metrics exposition (liveness, runs, wedge age, tasks, providers, extensions, backup) + chart scrape/alerts"`.

### Task 9: Non-root image with agent tooling

**Files:**
- Modify: `Dockerfile`. In the runtime stage:
  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends git sqlite3 ca-certificates \
      && rm -rf /var/lib/apt/lists/*
  COPY --from=build --chown=node:node /app /app
  USER node
  ```
  `tar` ships in the base image; leave it. Run `mkdir -p /data /cache && chown node:node /data /cache` before `USER node` so unmounted local runs work.
- Modify: `charts/sigrun/values.yaml`. Pod `securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000}` on the main controller AND the backup CronJob.
- Modify: `docker/docker-compose.yaml` comments: the named volumes are owned by uid 1000 (a fresh volume inherits the image dir's ownership).
- Test: `test/manifests.test.ts` (`helm template` renders `runAsNonRoot: true` + `fsGroup: 1000` on both pod specs); manual `docker build -t sigrun:w2 . && docker run --rm sigrun:w2 sh -c 'id -u && git --version && sqlite3 --version'`, expecting `1000` and two version lines.

- [ ] **Step 1: Write the failing manifest assertions.**
- [ ] **Step 2: Run** `npx vitest run test/manifests.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Dockerfile + chart + compose comment.
- [ ] **Step 4: Run** `npm test && helm lint charts/sigrun && docker build -t sigrun:w2 .`, then the `docker run` check above. Expected: green, with `1000` printed.
- [ ] **Step 5: Commit** `git commit -m "image: run as uid 1000 with git/sqlite3/ca-certificates; chart securityContext on app + backup pods"`.
