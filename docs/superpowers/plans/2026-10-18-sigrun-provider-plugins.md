# Sigrun provider plugins + core refresh policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four real provider plugins (opencode, ollama, pareto, bifrost) and the core seams they need: loader provider pathway, credential bridge, catalog persistence, refresh scheduler, three-state readiness.

**Architecture:** Core gains the seams (T1–T6); each plugin is its own repo (T7–T10) implementing pi-ai `createProvider({fetchModels})` + a credential/refresh tracker driving `health()`; bifrost ports pi-bifrost-gateway 0.3.0 (`5d15a28`) with native-protocol surfaces.

**Tech Stack:** TypeScript, pi-ai (`createModels`, `createProvider`, `ModelsStore`, `CredentialStore`, `AuthContext`), pi-durable 1.2.0, vitest, tsx, npm workspaces-per-repo.

**Spec:** `docs/superpowers/specs/2026-10-18-sigrun-provider-plugins.md`

## Global Constraints

- The pi-ai refresh spike (2026-10-18) verified: unconfigured → `fetchModels` never invoked (no error); success → published + persisted; failure → previous catalog retained + per-provider `errors` entry; restore with `allowNetwork:false` repopulates from store; restore drops models whose `provider` ≠ registered id; static providers skipped. Two plugin gotchas: `createProvider` REQUIRES a baseline `models: []`; pi-ai has no public `./models-store` export — `ModelsStore` is a structural interface (re-declare it or import the type from `@earendil-works/pi-ai/models`).
- Plugins implement `fetchModels(context)`, NOT raw `refreshModels` — the `createProvider` wrapper owns publish+persist. `fetchModels` THROWS on unconfigured/failure (never returns `[]` — that would publish an empty catalog and wipe persistence).
- Auth order: bridged `auth.json` credential wins; env var is pi-ai's ambient fallback (`OPENCODE_GO_API_KEY`, `OLLAMA_API_KEY`, `PARETO_API_KEY`, `BIFROST_API_KEY` + `BIFROST_BASE_URL`). Env reads go through the injected `Env` seam, never `process.env`, for hermetic tests.
- Plugin settings live in the scoped store (`host.stores.settings`), read in the factory (loader awaits factories), baked into the provider. Restart-required. No new top-level settings keys per plugin.
- `health()`: plugin tracks credential-resolved + last-refresh outcome in a closure; `not_configured` maps to `"ok"`, configured-and-failing maps to `"degraded"`.
- Three-state readiness on `/v1/auth/check`: `not_configured` / `degraded` / `ready`, enumerated per PROVIDER (not per model).
- Logging: `console.warn`, state transitions only.
- Every core task: `npm test` + `npm run typecheck` green before commit. Every plugin task: `npm test` + `npm run typecheck` + `npm run build` (dist is committed) green before commit.
- Plugin repos: MIT license, `CHANGELOG.md`, `package.json` `files: ["dist"]`, `repository` → `github.com/sigrun-ai/<repo>`, engines `node >=22.19.0`, pi-ai/pi-durable as **devDependencies** (build-time only; `syncPackages` installs `--omit=dev`).

## Review Focus

1. `createProvider` without baseline `models: []` throws `baselineModels is not iterable` (spike) — every plugin pins a test that its provider boots with an empty baseline.
2. `fetchModels` returning `[]` on failure wipes the persisted catalog (spike + review) — every plugin pins "unconfigured/failure throws, never returns empty".
3. A stored model whose `provider` field ≠ the registered id silently vanishes on cold-boot restore (spike) — bifrost's ported catalog entries must stamp the registered provider id; pinned in T10.
4. The refresh interval timer holding the process open after shutdown (review) — pinned in T5 (`unref` + `stop()` in shutdown).
5. `/v1/auth/check` enumerating models not providers hides empty-catalog providers (review) — pinned in T6.

---

### Task 1: loader provider pathway

**Files:**
- Modify: `src/harness/loader.ts` (`ResolvedExtension` gains `providers?`; `resolvedFromFactory` awaits factory results + validates `providers`; provider-only contributors valid)
- Modify: `src/harness/boot.ts` (collect loader `providers` + health producers; pass into `collectProviders`)
- Test: `test/loader-providers.test.ts` (new)

**Interfaces:**
- Consumes: `ProviderContributor`/`ProviderContribution` from `src/harness/providers/index.ts`.
- Produces: `ResolvedExtension.providers?: readonly ProviderContribution[]`; `loadExtensions` awaits Promise-returning factories; a factory result with `providers` and no `extension` is valid; boot passes collected contributors to `collectProviders`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a factory returning providers contributes them to collectProviders", async () => {
	// fixture extension whose factory returns { name, providers: [{ provider: <pi-ai createProvider fixture> }] };
	// openHarness; expect models.getProviders() to include it
});

test("a provider-only contributor (no extension field) loads without quarantine", async () => {
	// factory returns { name, providers: [...] } with NO extension; outcome is loaded, not quarantined
});

test("an async factory (Promise result) is awaited, not quarantined", async () => {
	// factory returns Promise.resolve({ name, providers: [...] }); loads cleanly
});

test("a malformed providers entry fails loud in the outcome", async () => {
	// factory returns { name, providers: [{ /* no provider.id */ }] }; outcome records the validation error
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/loader-providers.test.ts` → FAIL (loader drops/quarantines providers today).

- [ ] **Step 3: Implement** — in `resolvedFromFactory`: `await` the factory result before validating; validate each `providers` entry (has `provider.id` string); retain on `ResolvedExtension`; treat a result with `providers` and no `extension` as a valid provider-only contributor. In `boot.ts`: gather `ProviderContributor[]` from load outcomes (`{name, providers, health}`) and pass to `collectProviders` in place of `options.extensions ?? []` (keep the `options.extensions` seam for tests — concatenate: options first, then loader results).

- [ ] **Step 4: Run** — `npx vitest run test/loader-providers.test.ts test/loader.test.ts` PASS, then `npm test` + `npm run typecheck`.

- [ ] **Step 5: Commit** — `git add src/harness/loader.ts src/harness/boot.ts test/loader-providers.test.ts && git commit -m "loader: provider-contribution pathway (retain providers, provider-only contributors, await factories)"`

---

### Task 2: credential bridge + auth context

**Files:**
- Create: `src/harness/providers/auth-bridge.ts`
- Modify: `src/harness/providers/index.ts` (`collectProviders` wires `createModels({ credentials, modelsStore, authContext })`)
- Test: `test/provider-auth-bridge.test.ts` (new)

**Interfaces:**
- Produces:
  - `export function authStoreCredentialStore(auth: AuthStore): CredentialStore` — `read(providerId)` returns `{type:"api_key", key}` from `auth.json` (`"default"` then the provider's own entry, mirroring the degenerate provider's order) or `undefined`; `list()` maps the file's keys; `modify`/`delete` throw `Error("sigrun credentials are operator-provisioned; edit auth.json")`.
  - `collectProviders` accepts `options.modelsStore` (T3 wires it) and passes `credentials` + `authContext` ({`env: (name) => options.env?.[name] ?? env[name]`, `fileExists` from node:fs}) into `createModels`.
- Consumes: `AuthStore` (`src/harness/auth.ts`), pi-ai `CredentialStore`/`AuthContext` shapes (structural — re-declare; no public export path).

- [ ] **Step 1: Write the failing tests**

```ts
test("read returns the provider's apiKey from auth.json", async () => { /* AuthStore fixture with {"bifrost": {apiKey}} */ });
test("read falls back to the default key then the provider key", async () => { /* order assertion */ });
test("read returns undefined when no entry exists", async () => { /* empty file */ });
test("modify and delete throw operator-provisioned", async () => { /* expect throw /operator-provisioned/ */ });
test("createModels receives the bridged store (credential resolves for a dynamic provider)", async () => {
	// collectProviders with a fixture dynamic provider; Models.checkAuth(providerId) resolves from auth.json
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (no bridge; `createModels()` gets no credentials).

- [ ] **Step 3: Implement** the adapter + wire it in `collectProviders`.

- [ ] **Step 4: Run** — new suite + `test/providers*.test.ts` PASS, `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "providers: bridge auth.json into pi-ai CredentialStore + inject AuthContext"`

---

### Task 3: file-backed ModelsStore (catalog persistence)

**Files:**
- Create: `src/harness/providers/models-store.ts`
- Modify: `src/harness/providers/index.ts` (construct + pass the store)
- Test: `test/models-store.test.ts` (new)

**Interfaces:**
- Produces: `export function fileModelsStore(dir: string): ModelsStore` — one JSON file per provider at `<dir>/models/<providerId>.json` (provider id sanitized to a safe filename), atomic write (tmp + rename), `read` returns `undefined` on absent/corrupt file (corrupt logs `console.warn` and deletes the file — a poisoned catalog must not crash boot).
- Consumes: pi-ai `ModelsStore`/`ModelsStoreEntry` (structural re-declaration); the store dir derives from the boot `dataDir`.

- [ ] **Step 1: Write the failing tests**

```ts
test("write then read round-trips a catalog", async () => { /* entry with 2 models */ });
test("read of an absent file returns undefined", async () => {});
test("read of a corrupt file warns, deletes, returns undefined", async () => { /* write garbage bytes */ });
test("write is atomic (tmp+rename; no partial file left on the happy path)", async () => { /* assert no *.tmp remains */ });
test("provider ids are filename-sanitized", async () => { /* id with a slash → safe filename */ });
test("collectProviders wires the store (refresh persists to disk)", async () => {
	// fixture dynamic provider + real refresh; assert <dataDir>/models/<id>.json exists
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — new suite PASS, `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "providers: file-backed ModelsStore under dataDir (atomic, per-provider)"`

---

### Task 4: boot refresh + refresh-on-miss

**Files:**
- Modify: `src/harness/boot.ts` (boot refresh, concurrent with listen, deadline-bounded)
- Modify: `src/server/index.ts` (refresh-on-miss at the submit call site)
- Test: `test/provider-refresh.test.ts` (new)

**Interfaces:**
- Produces: `async function bootRefresh(models: Models, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<void>` (exported from `src/harness/providers/refresh.ts` — new file); `resolveServedModelRefreshing(models, ref)` wrapping `requireServedModel` with one refresh+retry on `UnservedModelError`.
- Boot deadline default `30_000` ms.

- [ ] **Step 1: Write the failing tests**

```ts
test("boot refresh populates dynamic providers", async () => { /* fixture fetchModels returns models; post-boot catalog non-empty */ });
test("boot refresh bounded: a hanging fetch does not block past the deadline", async () => {
	// fixture fetchModels never resolves; bootRefresh resolves ~deadline (fake timers or short timeoutMs)
});
test("refresh-on-miss turns an unserved-model 4xx into success when the provider gains the model", async () => {
	// fixture provider whose second fetch returns the newly-added model; submit path resolves after one refresh
});
test("refresh-on-miss still 4xxs when the model is genuinely absent", async () => { /* UnservedModelError with available ids */ });
test("the auto-namer's model resolution does NOT refresh", async () => { /* naming.ts path; assert no fetch call */ });
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** — `providers/refresh.ts`; boot starts `bootRefresh` without blocking listen (fire-and-track; errors logged); server submit wraps `requireServedModel` with the refresh+retry (naming.ts call site untouched).

- [ ] **Step 4: Run** — new suite PASS, `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "providers: bounded boot refresh (concurrent with listen) + refresh-on-miss at submit"`

---

### Task 5: interval refresh scheduler

**Files:**
- Modify: `src/config.ts` + `src/harness/settings.ts` (`server.providers.refreshIntervalMinutes`, env `SIGRUN_PROVIDER_REFRESH_MINUTES` override, `update()` sub-merge)
- Create: `src/harness/providers/scheduler.ts`
- Modify: `src/harness/boot.ts` + `src/serve.ts` (start on boot, `stop()` in shutdown, `unref`)
- Test: `test/provider-scheduler.test.ts` (new)

**Interfaces:**
- Produces: `function startProviderRefresh(models: Models, opts: { intervalMinutes: number; log?: (msg: string) => void }): { stop(): void }` — `setInterval` re-running `models.refresh()` with no provider filter; interval `0` disables; timer `unref()`ed; `stop()` clears it.
- Settings: `server.providers.refreshIntervalMinutes`, default `15`; env override wins.

- [ ] **Step 1: Write the failing tests**

```ts
test("the interval re-refreshes on cadence (fake timers)", async () => { /* fetchModels call count advances per tick */ });
test("interval 0 disables the scheduler", async () => { /* no timer; fetch count stays */ });
test("stop() clears the timer and shutdown calls it", async () => { /* serve fixture; post-shutdown no further ticks */ });
test("the timer is unrefed (does not hold the process)", () => { /* assert timer.hasRef() === false */ });
test("a failed tick logs once on the transition, not every tick", async () => { /* two consecutive failing ticks → one console.warn */ });
test("settings: default 15, file value respected, env override wins, update() merges", async () => { /* settings layer */ });
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** — scheduler + settings wiring + boot/serve lifecycle.

- [ ] **Step 4: Run** — PASS + `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "providers: interval refresh scheduler (server.providers.refreshIntervalMinutes, unrefed, stop on shutdown)"`

---

### Task 6: three-state readiness on /v1/auth/check

**Files:**
- Modify: `src/server/index.ts` (`/v1/auth/check` enumerates providers, three states)
- Modify: `src/harness/providers/index.ts` (expose the tracker registry boot collects)
- Test: `test/auth-check-readiness.test.ts` (new)

**Interfaces:**
- Produces: per-provider readiness shape `{ provider: string; status: "not_configured" | "degraded" | "ready"; detail?: string }` on the `/v1/auth/check` response, enumerated over `models.getProviders()` + contributor ownership, seeded from the plugin trackers (a contributor without a tracker behaves as today: producer `ok`→ready, `degraded`→degraded, absent→`not_ready` legacy mapping preserved for non-provider contributors).
- Wire format addition is additive (old `ready` consumers keep working).

- [ ] **Step 1: Write the failing tests**

```ts
test("an unconfigured contributor provider reports not_configured and APPEARS despite an empty catalog", async () => {});
test("configured + last refresh failed → degraded", async () => {});
test("configured + refresh ok → ready", async () => {});
test("the degenerate env provider keeps its env-presence readiness mapping", async () => { /* existing behavior preserved */ });
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** — enumerate providers; consult the contributor tracker (exposed from `collectProviders` as a `Map<providerId, () => Readiness>` the plugins register into via their contribution — add optional `readiness` to `ProviderContribution`); fall back to existing producer logic for contributors without one.

- [ ] **Step 4: Run** — PASS + `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "server: three-state per-provider readiness on /v1/auth/check"`

---

### Task 7: sigrun-ollama plugin (the reference plugin)

**Files:** new repo `~/repos/sigrun-ollama`: `package.json`, `tsconfig.json`, `src/index.ts`, `test/`, `README.md`, `LICENSE`, `CHANGELOG.md`

**Interfaces:**
- Produces: default export factory `(host) => ({ name: "sigrun-ollama", providers: [{ provider, defaultModel?, readiness }], health })` for Ollama Cloud (`https://ollama.com/v1`, `OLLAMA_API_KEY`).
- Consumes: core's loader pathway (T1), credential bridge (T2), readiness registry (T6).

- [ ] **Step 1: Scaffold the repo** — package.json per Global Constraints (devDeps pi-ai/pi-durable, files:["dist"], prepare build), tsconfig, vitest.

- [ ] **Step 2: Write the failing tests** — `fetchModels` against a fixture HTTP server: catalog parse (OpenAI `/models` shape → pi-ai `Model[]` with `provider: "ollama"` stamped); auth resolution (bridge credential → env fallback); **unconfigured throws** (never returns `[]`); **baseline `models: []`** present; tracker transitions (`not_configured` → `ready`; failed refresh → `degraded`).

- [ ] **Step 3: Implement** — `createProvider({ id: "ollama", models: [], fetchModels, auth: { apiKey: { resolve: ({credential, ctx}) => credential ?? env("OLLAMA_API_KEY") } }, api: openAICompletionsApi() })`; tracker closure; `health()` mapping.

- [ ] **Step 4: Run** — `npm test` + `npm run typecheck` + `npm run build` green.

- [ ] **Step 5: Commit** — initial commit; repo stays local until publish.

---

### Task 8: sigrun-opencode plugin

Same shape as T7 for the paid Go tier (`https://opencode.ai/zen/go/v1`, `OPENCODE_GO_API_KEY`). The `/zen/v1` free tier is client-gated and out of scope (spec). Clone T7's structure; the only deltas are id/baseUrl/env key and any catalog-shape quirks of the Go endpoint. Steps mirror T7 (scaffold → failing tests → implement → green → commit).

---

### Task 9: sigrun-pareto plugin

Same shape as T7 for Pareto (`PARETO_API_KEY`, its OpenAI-compat base URL). Steps mirror T7.

---

### Task 10: sigrun-bifrost plugin (the big port)

**Files:** new repo `~/repos/sigrun-bifrost` mirroring pi-bifrost-gateway 0.3.0's `src/` (`catalog.ts`, `config.ts`→settings-store adapter, `http.ts`, `index.ts`).

**Interfaces:**
- Consumes: pi-bifrost-gateway `5d15a28` as source of truth; core seams T1/T2/T6.
- Produces: factory contributing the bifrost provider with both discovery modes (chains via management plane when `publishChains`, member-only via `/v1/models` otherwise), native-protocol surfaces gated by scoped settings (`nativeProtocols.responses/messages` + optional exact-name lists, default false), `thinkingOverrides` + `thinkingLevelMap` ported, `TEXT_ONLY_MODELS` ported, `managementApiKey` from scoped settings, VK from `auth.json`/`BIFROST_API_KEY`, base URL from scoped settings/`BIFROST_BASE_URL`.

- [ ] **Step 1: Scaffold** (as T7).

- [ ] **Step 2: Write the failing tests** (fixture gateway server): member-only mode makes ZERO management-plane calls; chains mode resolves VK + routing rules; `nativeFamily` mapping (claude→anthropic-messages at `<root>/anthropic`, gpt→openai-responses, gpt-oss stays completions, else completions); compat pins per surface; TEXT_ONLY denylist; `thinkingOverrides` replace the default ladder; **unconfigured throws (never `[]`)**; published models carry `provider: "bifrost"`; `managementApiKey` overrides the VK on `/api/*`; settings values read once at factory time (restart-required).

- [ ] **Step 3: Implement** — port the three modules, swapping pi's config-file read for the scoped settings store and pi's auth store for the bridged credential.

- [ ] **Step 4: Run** — `npm test` + `npm run typecheck` + `npm run build` green.

- [ ] **Step 5: Commit.**

---

### Task 11: end-to-end integration in the sigrun repo

**Files:**
- Test: `test/provider-plugins-e2e.test.ts` (new, in the sigrun repo)
- Modify: `docs/extending.md` (provider-contributor contract: `providers`, `readiness`, restart-required settings, dependency posture)

- [ ] **Step 1: Failing e2e** — boot sigrun with all four plugins installed from their local paths into a fixture config dir; assert: catalogs populate post-boot-refresh, `/v1/models` lists them, `/v1/auth/check` reports per-provider readiness, a restart with dead fixture servers restores catalogs from disk.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Fix what the e2e exposes** (this is the seam-shakeout task; expected small wiring fixes in core).

- [ ] **Step 4: Full gate** — `npm test` + `npm run typecheck` green.

- [ ] **Step 5: Docs + commit** — `docs/extending.md` provider contract; spec status → implemented.

---

### Task 12: live verification (deployment step, not a test)

Against the author's real gateway: install `sigrun-bifrost`, point at the live Bifrost, confirm chains catalog, a native-protocol chain answers on its native wire, refresh picks up a gateway roster change without restart, and `/v1/auth/check` reflects a deliberately-misconfigured key as `degraded`. Recorded as a deployment checklist in the spec, executed by the author.
