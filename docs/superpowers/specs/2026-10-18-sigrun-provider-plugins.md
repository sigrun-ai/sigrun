# Sigrun provider plugins — opencode, ollama, pareto, bifrost + core refresh policy

Status: implemented. Date: 2026-10-18.

## Why

The provider-contributor contract (`src/harness/providers/index.ts`) exists
and is tested — but only by fixtures and the env-driven degenerate provider.
No real provider plugin has ever shipped against it, so its ergonomics are
unproven. Separately, the contract merges provider catalogs once at boot;
sigrun is a long-running server and provider rosters change under it, so
dynamic catalog refresh is v1 scope, not a follow-up.

Building the four providers the author actually uses closes both gaps at
once: the contract gets four real consumers, and refresh gets built because
they need it.

## Provider plugins

Four new extension repos, named `sigrun-<name>` (user ruling: no `-ext-`
infix): `sigrun-opencode`, `sigrun-ollama`, `sigrun-pareto`,
`sigrun-bifrost`. Existing `sigrun-ext-*` repos keep their names.

Common shape for all four:

- A factory returning `{ name, providers: [...], health }` per the existing
  `ProviderContributor` contract — **which requires a new core loader seam**
  (see "Core: loader provider pathway"; today the loader never threads
  `providers` anywhere, so this contract is currently unreachable from an
  extension package). A pure provider contributor ships no pi-durable
  `extension` field at all; the loader contract gains provider-only
  contributors.
- Each provider is a pi-ai `createProvider()` result implementing
  `refreshModels()` (dynamic catalog — see below). Boot-time contribution
  carries whatever catalog is already known (possibly empty); the core
  refresh policy fills it. The pi-ai `createProvider` wrapper calls the
  plugin's `fetchModels` and publishes results (including persistence to
  the `ModelsStore`) itself — plugins implement `fetchModels`, not raw
  `refreshModels`.
- Auth resolution order: pi-ai's stored credential (bridged from sigrun's
  `auth.json` — see core section) wins; the env var is the ambient fallback
  pi-ai consults only when nothing is stored: `OPENCODE_GO_API_KEY`,
  `OLLAMA_API_KEY`, `PARETO_API_KEY`, and for bifrost the virtual key
  (`BIFROST_API_KEY`) plus `BIFROST_BASE_URL` (read through the injected
  `Env` seam, not `process.env`, for hermetic tests). Unconfigured providers
  register empty rather than failing boot — the degenerate-provider
  precedent. (Readiness semantics: see "Core: readiness & health".)
- Config beyond credentials (base URL overrides, publish toggles) goes
  through the extension's **scoped** settings store (`host.stores.settings`
  — one per-extension settings file, no new top-level settings keys per
  plugin), not new env vars. The core loader awaits Promise-returning
  factories (see core section), so factories read their settings at factory
  time and the returned provider is baked with them: **changes require a
  restart** (user ruling), matching the documented `extensions[]` contract.
  No live-apply provider-rebuild seam in v1.
- `health()` reports from the plugin's own last-refresh + credential tracker
  (see "Core: readiness & health"): the plugin tracks credential-resolved
  and last-refresh outcome in a closure and derives its `HealthStatus` from
  it.

Provider specifics:

- **sigrun-opencode** — the paid Go plan API (`https://opencode.ai/zen/go/v1`).
  The `/zen/v1` free tier is client-gated by design (FreeTierError for
  non-CLI requests) and is out of scope.
- **sigrun-ollama** — Ollama Cloud (`https://ollama.com/v1` with
  `OLLAMA_API_KEY`). A *local* Ollama is already reachable through the
  core's degenerate OpenAI-compat provider via `OPENAI_BASE_URL`; this plugin
  is the cloud service.
- **sigrun-pareto** — Pareto paygo, OpenAI-compat, `PARETO_API_KEY`.
- **sigrun-bifrost** — ports `pi-bifrost-gateway` (same author's pi plugin):
  chains mode = three-endpoint live catalog (`/v1/models` members +
  `/api/governance/virtual-keys` for VK self-identification +
  `/api/routing/rules` for chain resolution), chains published as models;
  member-only mode (`publishChains: false`) uses the single `/v1/models`
  inference endpoint and no management plane. Both modes port; the
  management-plane calls are conditional on chains mode. Adaptations: sigrun
  `auth.json` instead of pi's auth store, settings store instead of pi's
  config file, no `/login` flow (sigrun is a server, credentials are
  operator-provisioned).
  Porting decisions (builder-check + review resolutions):
  - Base URL is **configuration, not credential** (user ruling): the
    settings-store key wins, `BIFROST_BASE_URL` env (read via the injected
    `Env` seam) is the fallback. Pi's URL-on-credential precedence does not
    port; `auth.json` stays `{apiKey}`-only, no schema change.
  - `publishChains` (default **false** — user ruling, matching
    pi-bifrost-gateway 0.3.0's conservative default: other operators'
    bifrost usage is unknown, so the full `/v1/models` catalog is the
    default surface; chains are opt-in) and `publishUpstream` (default
    **true**) become scoped settings keys (restart-required).
  - The `TEXT_ONLY_MODELS` modality denylist ports as-is; consuming
    Bifrost's datasheet `architecture` enrichment instead is a follow-up.
  - `thinkingOverrides` per-member ladders **port** as a scoped-settings
    key (review correction: the ladders prevent 400s from members that
    reject unsupported effort levels — sigrun's `perModelThinking` can pin
    effort, so the failure mode is real). `thinkingLevelMap` construction
    ports unchanged.
  - **Native-protocol surfaces PORT in v1** (changed from the earlier
    deferral — the pi plugin gained them this morning in `fd89bd3`, and the
    author's gateway routes claude/gpt natively, so a completions-only port
    would regress those chains to translation): `nativeFamily()` (model
    NAME decides, never the serving prefix; `claude` → anthropic-messages
    at `<gateway-root>/anthropic`, `/^(gpt(?!-oss)|o\d|codex)/` →
    openai-responses, else completions), the per-surface compat pins
    (`forceAdaptiveThinking` + `thinkingLevelMap {off:null}` for anthropic,
    `{off:"none"}` for responses), and the `nativeProtocols` config gates
    (`responses`/`messages` booleans + optional exact-name override lists)
    as scoped settings keys. Default **false** (stock gateways serve
    completions); the author's deployment sets both true.
  - `managementApiKey` (separate management-plane bearer) **ports** as a
    scoped settings key — it's a settings read, cheap, and deployments with
    dashboard auth enabled need it. Auth-file impact (user question,
    verified against `auth.ts`): sigrun's `AuthEntry` is `{apiKey?}`-only
    and strict about that field, but the validator is explicitly permissive
    about unknown fields — and no schema change is needed anyway, because
    the design rule is **the primary credential lives in `auth.json`; an
    auxiliary credential lives in the plugin's scoped settings**. The VK
    goes under `"bifrost"` in `auth.json` (the inference credential —
    exactly what the file is for); the management key is a plugin setting
    (where pi-bifrost-gateway already keeps it). Caveat recorded: the
    settings file is plain JSON without the auth file's 0o600 discipline —
    consistent with sigrun's operator-provisioned-plaintext posture, and
    documented in the plugin's README.
  - Throw-and-degrade carries over, sharpened: `fetchModels` throws on bad
    credential / VK mismatch / zero chains / **unconfigured** (no key or no
    base URL) — a returned `[]` would reach pi-ai's `publish({persist:
    {models: []}})` and **wipe the persisted catalog**, defeating the
    persistence story. Only a genuinely successful discovery may publish.
  - Published catalog entries carry the registered provider id on every
    model (`model.provider === provider.id`); pi-ai's restore phase filters
    stored models by provider id, so a mismatch silently vanishes on cold
    boot.

  The port tracks pi-bifrost-gateway **0.3.0** (commit `5d15a28`,
  2026-10-18) as its source of truth: `src/catalog.ts` (family mapping,
  modality scoping, thinking maps), `src/config.ts` (config surface), and
  `src/index.ts` (discovery modes) were re-reviewed at that commit for this
  spec revision.

## Core: refresh policy

pi-ai already owns the refresh *protocol*: dynamic providers implement
`refreshModels(context)` (the `createProvider` wrapper implements it around
the plugin's `fetchModels`); `Models.refresh({providers, force,
allowNetwork})` drives it; failed refreshes retain the previous catalog by
contract (per-provider errors land in `ModelsRefreshResult.errors` without
rejecting, and the wrapper only publishes on success). What sigrun owns is
*policy* — when to call it:

1. **Boot refresh** — after `collectProviders`, `models.refresh()` with
   network allowed, **bounded by a deadline** (default 30s; builder-check
   ruling — a wedged upstream must not stall deploy readiness) and run
   **concurrently with listen** (review correction: even a bounded refresh
   would otherwise delay listen by up to 30s). Timeout or failure does not
   block: the server starts, readiness reports the provider's state, the
   interval refresh heals. The restore phase (`allowNetwork:false`, stored
   catalogs) runs *before* any network phase and works even unconfigured or
   network-dead, so a cold boot with a persisted catalog serves immediately.
2. **Interval refresh** — a timer re-refreshes on a configured cadence. New
   settings key **`server.providers.refreshIntervalMinutes`** (review
   correction: static boot knobs live under `server.*`, which is the
   documented restart-required section, and `update()` gains the matching
   sub-merge branch; env `SIGRUN_PROVIDER_REFRESH_MINUTES` overrides),
   default 15, `0` disables. The scheduler passes **no provider filter** —
   pi-ai skips static and unknown providers (`refreshModels !== undefined`),
   so no dynamic-provider bookkeeping in core. The timer is owned by the
   opened harness handle (`stop()`), called in shutdown before
   `harness.close()`, and `unref()`ed so tests and short-lived processes
   aren't held open. `force` is advisory: pi-ai's `createProvider` wrapper
   always fetches when network is allowed, so refresh-on-miss needs no
   special flag.
3. **Refresh-on-miss** — when submit resolution hits `UnservedModelError`,
   refresh the named provider once and re-resolve before returning the 4xx.
   A model added upstream five minutes after the last interval tick is
   immediately usable instead of an error. Applies at the submit call site
   only; the auto-namer's model resolution (background lane) does *not*
   refresh.

## Core: loader provider pathway (blocker fix)

Both reviews caught this: today **nothing** connects an extension package to
`collectProviders`. The loader (`resolvedFromFactory`) validates and retains
`extension/health/submit/runSettled/lifecycle/kinds/workers` — never
`providers` — and boot feeds the collector from `OpenHarnessOptions.extensions`,
which the deploy path (`serve.ts`) never populates. A factory returning
`{name, providers, health}` would be quarantined (no `extension` field); one
returning `{extension, providers}` would have `providers` silently dropped.

Core changes:

- `ResolvedExtension` retains an optional validated `providers` list (shape-
  checked like `health`: each entry is a pi-ai `Provider`-shaped object with
  an `id`).
- The loader contract gains **provider-only contributors**: a factory result
  with `providers` but no `extension` is valid (no pi-durable Extension is
  required; tools/sections/hooks simply don't exist for it).
- Boot collects contributor health producers and provider contributions from
  the loader results and passes them to `collectProviders` (ordering already
  works: `loadExtensions` runs before `collectProviders`).
- **The loader awaits Promise-returning factories** (review finding: the
  scoped settings store is async-only, so "factory-baked settings" is
  impossible with a sync factory call — `resolvedFromFactory` awaits the
  factory result before validating). This is the mechanism that makes
  restart-required settings real: the factory reads its scoped settings at
  factory time, bakes them into the provider, and nothing re-reads until the
  next process start.

## Core: auth bridge

Rationale corrected by review: pi-ai's default `AuthContext` exposes only
`env()` and `fileExists()` — it cannot read sigrun's `auth.json` file, and
pi-ai's ambient resolution order is stored-credential-first (a stored
credential owns the provider; env is the fallback). Without a bridge, each
plugin would hand-roll an `auth.json` read inside its `resolve()` closure
(the degenerate provider's trick), which works for streaming but leaves
pi-ai's store-first machinery — including the credential it hands to
`refreshModels` via `context.credential` — blind to the operator's
provisioned key. So core adds:

- A `CredentialStore` adapter bridging pi-ai's `{type:"api_key", key}` shape
  onto sigrun's `auth.json` (`AuthStore` read-through). The full interface
  is `read`/`list`/`modify`/`delete`; **`modify`/`delete` throw a clear
  "operator-provisioned; edit auth.json" error** — sigrun has no login flow,
  and `Models.login`/`logout` are unsupported in v1.
- A full `AuthContext` passed to `createModels` (env via the existing
  injected `Env` seam, `fileExists` from node:fs) so tests stay hermetic off
  `process.env`.

`/v1/auth/check` (which derives status from contributor health producers and
sigrun's own `AuthStore`, never from pi-ai `checkAuth`) is revisited under
"Core: readiness & health" below.

## Core: readiness & health (three-state)

Review finding: the spec's original "health reports ok/degraded by last
refresh" collides with reality twice. (1) `HealthStatus` is only
`"ok" | "degraded"` — there is no `not_ready`, so an unconfigured plugin
could only report `degraded`, which `/v1/auth/check` maps to `invalid`
(semantically wrong for "not configured"). (2) The route enumerates
`models.getModels()` per provider, so a provider with an **empty** catalog
(boot-time contribution, refresh never succeeded) never appears at all.
And pi-ai never invokes `fetchModels` for an unconfigured provider
(refresh short-circuits before the network phase), so a tracker fed only by
refresh outcomes has nothing to report — it must be seeded from credential
resolution.

Note: `/healthz` always returns 200 and does not aggregate provider health
(review correction of a mistaken `/readyz`-gating claim); the readiness
signal operators consume is `/v1/auth/check` + `/v1/meta`, so the three-state
convention lands there, not on the process probe.

Core changes:

- `/v1/auth/check` enumerates providers (`getProviders()` / the ownership
  map), not models, so empty-catalog providers appear.
- Three-state readiness per provider: **`not_configured`** (no credential
  resolved), **`degraded`** (credential resolved, last refresh failed),
  **`ready`** (credential resolved, last refresh succeeded or never
  attempted with a static catalog). The plugin's tracker seeds from
  credential resolution and updates per refresh; `health()` maps
  `not_configured` → `"ok"` (absence of a credential is not a degraded
  *process* — it's an unconfigured optional plugin) and reserves
  `"degraded"` for configured-and-failing. `/v1/auth/check` reports the
  three states directly from the tracker, decoupling its vocabulary from
  the two-state `HealthStatus`.

## Core: catalog persistence

User ruling: **persist catalogs across restarts.** pi-ai ships only
`InMemoryModelsStore`, so core implements the three-method `ModelsStore`
interface (`read`/`write`/`delete`) as per-provider JSON files under the
data root (atomic write: tmp + rename) and threads it into `createModels()`
inside `collectProviders`. Persistence happens because pi-ai's
`createProvider` wrapper publishes `{persist}` on successful fetch — which
is why plugins implement `fetchModels`, and why the bifrost port must
*throw* on unconfigured/failure rather than return `[]` (an empty success
would publish and wipe the persisted catalog).

## Contract changes implied

All in sigrun core (pi-durable and pi-ai need nothing new):

- **Loader provider pathway** (section above): retain factory `providers`,
  allow provider-only contributors, await Promise-returning factories, boot
  threads contributions + health producers into `collectProviders`.
- The `CredentialStore` adapter + injected `AuthContext` (section above).
- File-backed `ModelsStore` implementation + wiring (section above).
- `/v1/auth/check` per-provider enumeration + three-state readiness
  (section above).
- `requireServedModel` gains a refresh-and-retry wrapper at the submit call
  site (the function itself stays pure).
- `SETTING_KEYS`/`ServerSettings` gain `server.providers.refreshIntervalMinutes`,
  `loadConfig` resolves it, `update()` gains the sub-merge branch; env
  `SIGRUN_PROVIDER_REFRESH_MINUTES` overrides.
- The refresh scheduler: owned by the opened harness, `stop()` in shutdown,
  `unref()`ed.
- Boot refresh runs concurrently with listen, deadline-bounded.
- The `health()` producer convention: the plugin's credential+refresh
  tracker is the canonical input; `not_configured` → `"ok"`.
- **Plugin dependency posture** (review finding): `syncPackages` runs plain
  `npm install`, which auto-installs `peerDependencies` — a plugin declaring
  pi-ai as a peer would get its *own* pi-ai copy under the packages dir, and
  sigrun's loader (unlike pi's) does no host-module virtualization. Provider
  objects are structurally consumed so a second copy mostly works, but
  version drift is silent. Posture: plugins declare pi-ai/pi-durable as
  **devDependencies only** (build-time), rely on structural typing at
  runtime, and `syncPackages` installs with `--omit=dev` so no second pi-ai
  lands in the packages dir. (If a future plugin genuinely needs a runtime
  pi-ai import, revisit.)

## Surfacing

- `GET /v1/models` reads the live `Models` store (already true), so
  post-refresh catalogs appear without further work.
- `/v1/auth/check` gains the three-state per-provider readiness (section
  above).
- Refresh failures log via `console.warn` (repo convention — there is no
  shared logger) on state transitions only; repeated failure does not spam.

## Tests

- Per-plugin contract tests against hermetic fixture servers (no network):
  catalog parsing, auth resolution order (stored bridge → env), unconfigured
  boot, health/readiness transitions (not_configured → degraded → ready).
- Bifrost-specific: unconfigured `fetchModels` throws (never publishes `[]`);
  published models carry the registered provider id (survive restore
  filtering); member-only mode makes zero management-plane calls; chains
  mode resolves VK + rules.
- Core: loader threads factory `providers` (provider-only contributor valid;
  async factory awaited); interval scheduler fires and re-merges, `stop()`
  in shutdown, timer `unref()`ed; refresh-on-miss turns a would-be 4xx into
  a success when the fixture adds the model; failed refresh keeps the last
  good catalog and flips readiness to degraded; `ModelsStore` round-trips a
  catalog and cold-restores it with network dead; `/v1/auth/check` lists an
  empty-catalog provider as `not_configured`.
- Live verification post-deploy on the author's gateway is a deployment
  step, not a test.
- Pre-planning spike: **DONE 2026-10-18**, all six behaviors verified
  empirically against the installed pi-ai dist (script-driven, fixture
  provider): (1) unconfigured → `fetchModels` never invoked, no error;
  (2) success → catalog published AND persisted to the `ModelsStore`;
  (3) failure → previous catalog retained + per-provider `errors` entry
  (message surfaces the fetch error); (4) restore with `allowNetwork:false`
  repopulates from the store with no fetch; (5) restore drops stored models
  whose `provider` field ≠ the registered id; (6) static providers are
  skipped. Two plugin-implementation gotchas the spike surfaced:
  `createProvider` requires a baseline `models: []` (omitting it throws
  `baselineModels is not iterable`), and pi-ai's public package exports do
  NOT include `./models-store` — the `ModelsStore` interface is imported
  from `@earendil-works/pi-ai/models` (which re-exported it in this
  version) or re-declared structurally.

## Non-goals

- OAuth flows of any kind. API keys only, operator-provisioned.
- Live-apply of plugin settings (user ruling: restart-required).
- Model pickers or UI changes beyond the catalog simply being fresh.
- Cost/metadata enrichment beyond what each upstream's `/models` endpoint
  carries natively (bifrost carries pricing; the others may not — models
  register with zeroed costs in that case, matching the degenerate
  provider's precedent).
- Renaming the existing `sigrun-ext-*` repos.
- `CredentialStore` writes (`modify`/`delete` throw; `Models.login`/`logout`
  unsupported in v1).
- A standalone member-catalog *edit* UI; `GET /v1/models` reading the live
  store is the whole surface story.

## Review disposition

Builder check + two full reviews (deepseek-v4.1-flash, glm-5.3) folded in,
plus a re-review of pi-bifrost-gateway at 0.3.0 (`5d15a28`) after its
2026-10-18 native-protocol refresh. User rulings: persist catalogs;
restart-required settings; bifrost base URL is settings-only config;
**publish defaults reversed to `publishChains: false` / `publishUpstream:
true`** (the `/v1/models` catalog is the default surface; chains opt-in);
**native-protocol surfaces port in v1** (the author's gateway routes
claude/gpt natively; deferring would regress those chains to translation). Resolved in this revision: loader provider pathway
(both reviews' blocker/P0); async-factory settings contradiction (loader
awaits factories); auth-bridge rationale corrected (file-vs-`AuthContext`,
not the store-first/checkAuth claims); `refreshModels` throw semantics
corrected (throw = retain catalog + errors entry; never publish `[]`);
three-state readiness replacing the two-state health abuse; `/readyz`-gating
claim corrected (no such route; `/healthz` always 200); settings key placed
under `server.providers.*`; scheduler ownership/teardown/`unref` pinned;
boot refresh concurrent with listen; `thinkingOverrides` kept;
native-protocol surfaces port in v1; `managementApiKey` ports as a scoped
settings key; publish defaults pinned (chains false, upstream true);
plugin dependency posture pinned (devDeps + `--omit=dev`);
`CredentialStore` write-side specified (throws); `ModelsStore` is
sigrun-implemented; restore provider-id filtering noted; `BIFROST_BASE_URL`
via injected `Env`; `console.warn` convention; pre-planning spike executed
(2026-10-18, all six refresh behaviors verified + two plugin gotchas found:
baseline `models: []` required; no public `./models-store` export).
