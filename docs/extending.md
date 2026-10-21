# Extending sigrun: where your extension's stuff goes

This is the contract between sigrun and extension authors. It answers
one question — *where does my extension's stuff go?* — once, uniformly,
so an extension that follows it gets backup-safe persistence,
container-safe cache handling, and secret hygiene without inventing
any of it.

**The anti-example.** Sigrun's reference harness, pi, offers no store
surface: every extension blazes its own path, and the result is
visible on any installed machine — a config directory littered with
per-extension dotfiles, duplicate `snake-case`/`camelCase` variants of
the same config, and ad-hoc state files at the top level. Sigrun's
rule is the opposite: **every file an extension touches lives in a
named bucket, or it doesn't exist.** Nothing at the top level of the
config directory is yours.

**The one-sentence contract:** sigrun gives every extension two
mediated stores (settings, secrets — server-owned files, scoped
get/set through a handle) and three raw stores (data, state, cache —
extension-owned directories), all under XDG-respected roots, keyed by
the extension's slug, resolved by one chain.

## The five stores

| kind | what it is | durability | who writes it | backup |
|---|---|---|---|---|
| **secrets** | credentials, tokens, API keys | durable, sensitive | server-mediated (the handle) | yes (securely) |
| **settings** | user-tunable configuration | durable | server-mediated (the handle) | yes |
| **data** | user-meaningful content the extension produces or ingests | durable | extension (raw files) | yes |
| **state** | operational bookkeeping: cursors, dedup markers, trust stores | durable, meaningless to humans | extension (raw files) | optional |
| **cache** | regenerable derivations: indexes, compiled artifacts, scratch | disposable | extension (raw files) | **never** |

Choosing the right bucket is the author's main design decision, and
the one that matters most is **cache vs. state**: they have opposite
accident profiles. Deleting state silently breaks correctness (a lost
dedup marker re-processes work); deleting cache only costs time. A
single "stuff" bucket would force every backup tool and every purge
story to guess.

## The directory map

| store | sigrun's own files | your extension's surface |
|---|---|---|
| config | `<configDir>/settings.json` | `<configDir>/settings/<slug>.json` |
| secrets | `<configDir>/auth.json` — *provider* credentials | your section in `<configDir>/secrets.json` |
| data | `<dataDir>/sigrun.db` (the harness DB) | `<dataDir>/<slug>/` |
| state | harness bookkeeping | `<stateDir>/<slug>/` |
| cache | — | `<cacheDir>/<slug>/` |

- **`auth.json` is provider credentials only.** Extension secrets
  never go there — they live in `secrets.json`, one top-level key per
  extension slug, contents arbitrary per extension.
- **One settings file per extension** (`settings/<slug>.json`),
  contents entirely your shape. There is no schema language and no
  validation DSL: sigrun stores the object; validating it is the
  extension's job.
- **The data, state, and cache directories are free-form.** Sigrun
  mandates nothing about their contents — not file formats, not
  structure. The surface is "a directory that is yours."
- The config root's other top-level entries are named, not litter:
  `packages/` and `git/` (the extension install machinery), `skills/`
  (your user-wide skills — the same SKILL.md convention the workspace
  ships, listed under the reserved `skills` section for every
  conversation), the identity surfaces `users.json` and `api-tokens.json`
  (mode 0600, sigrun-owned — user accounts and token digests), and
  channel client configs such as `tui.json`.

## One resolution chain — workstation and container

Every root resolves through the same three tiers, per root:

1. **Explicit env** — `SIGRUN_CONFIG_DIR`, `SIGRUN_DATA_DIR`,
   `SIGRUN_CACHE_DIR`, `SIGRUN_STATE_DIR`, used verbatim.
2. **XDG** — `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` / `$XDG_CACHE_HOME`
   / `$XDG_STATE_HOME` + `/sigrun`, when set and non-empty.
3. **Defaults** — `~/.config/sigrun`, `~/.local/share/sigrun`,
   `~/.cache/sigrun`, `~/.local/state/sigrun`.

An empty env var counts as unset at every tier. For data, cache, and
state, a deployment may also set the settings-file keys
(`server.dataDir` / `server.cacheDir` / `server.stateDir`) between the
env var and the fallback tiers — env wins, then the file, then the
chain. `SIGRUN_STORAGE_PATH` remains the finer DB-file override on top
of the data root (relative values join it; absolute values stay
verbatim).

Containers set no XDG vars — deployments override everything
explicitly. The Helm chart maps the durable buckets onto the PVC
(`SIGRUN_CONFIG_DIR=/data/config`, `SIGRUN_DATA_DIR=/data/data`,
`SIGRUN_STATE_DIR=/data/state`) and **cache onto a pod-local
`emptyDir`** (`SIGRUN_CACHE_DIR=/cache`): regenerable data is exactly
what you don't spend a PVC on, and a scratch directory that
self-cleans on restart is a feature, not a bug. Compose deployments
mirror the shape (cache on tmpfs). For an extension this means one
thing: **treat `paths.cache` as disposable at any moment.**

## Your extension's identity is its slug

Sigrun computes the slug from the name your factory's `extension`
declares, once, at load:

> everything after the last `/` → strip a trailing `@version` →
> lowercase → fold `[^a-z0-9_-]+` runs to a single `-` → trim edge
> `-`/`_`

Worked example: `@juicesharp/rpiv-ask-user-question` →
`rpiv-ask-user-question` (a trailing `@2.0.0` would be stripped the
same way).

- **Scoped names collapse to the last segment by design.** `@a/tool`
  and `@b/tool` share the slug `tool` — the one-fork assumption. Two
  loaded extensions colliding on a slug fails the load loud (the
  second is quarantined, naming both declared names); a name nothing
  survives of (empty slug) fails the same way.
- **The slug is the extension's name everywhere** — the registry key,
  store sections, interaction and ambient records, worker names. It is
  not just a path concern.
- **Renaming changes the slug.** Old directories and store sections
  stay where they were; migrating them is the operator's move, never
  automatic.

## The stores handle

Your package's default export is a factory; if it declares a first
parameter, sigrun calls it with the **host context**. `host.stores` is
the scoped view — the only store surface extension code ever sees:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

/** An env read with sigrun's ""-means-unset semantics. */
function fromEnv(name: string): string | undefined {
	const value = process.env[name];
	return value === "" ? undefined : value;
}

export default function createAcmeTool(host: {
	readonly stores: {
		/** Your section of secrets.json. */
		readonly secrets: {
			get(key: string): Promise<string | undefined>;
			set(key: string, value: string): Promise<void>;
		};
		/** Your settings/<slug>.json (absent reads as {}). */
		readonly settings: {
			get(): Promise<Record<string, unknown>>;
			set(value: Record<string, unknown>): Promise<void>;
		};
		/** data and state are yours to create; cache exists from the
		 *  first read (sigrun mkdirs it, self-healing after a wipe). */
		readonly paths: {
			readonly data: string;
			readonly cache: string;
			readonly state: string;
		};
	};
}) {
	const { secrets, settings, paths } = host.stores;

	// stored wins, env bootstraps — resolve per use, never memoize the
	// result (see "Secrets precedence")
	const apiKey = async () =>
		(await secrets.get("api-key")) ??
		fromEnv("SIGRUN_EXT_ACME_TOOL_API_KEY");

	// settings: your file, your shape
	const interval = async () => {
		const stored = await settings.get();
		return typeof stored.interval === "number" ? stored.interval : 60;
	};

	// data/state: the ROOT is ensured at boot; your <slug> subdir is not
	const persist = async (index: string) => {
		await mkdir(paths.data, { recursive: true });
		await writeFile(join(paths.data, "index.json"), index, "utf8");
	};

	// cache: read the path, get a directory — never memoize it (an
	// access after a wipe must self-heal)
	const scratch = () => paths.cache;

	return {
		extension: defineExtension({
			name: "@acme/tool", // slugs to "acme-tool"
			sections: [section("acme-note", () => "acme tool loaded")],
		}),
	};
}
```

What the snippet encodes:

- **Secrets and settings are mediated.** You call get/set on *your*
  section and *your* file; you never see a path, and you cannot name
  another extension's slug. Sigrun owns serialization: every write is
  atomic (temp file + rename), `secrets.json` is mode `0600`, settings
  files `0644`. A malformed file — unparseable JSON, or JSON that is
  not an object — fails loud naming the path; it is never silently
  reset.
- **Data, state, and cache are raw.** You own the I/O (fs, sqlite,
  whatever). Sigrun ensures the roots at boot and creates **only**
  your cache directory — lazily, on the first read of `paths.cache`,
  so a wiped cache root (the container `emptyDir` case) never breaks
  boot or your next access.
- **Store calls are safe at any time** — plain file I/O with no
  harness dependency; calling the handle inside the factory body is
  fine. The other surface on the same host — the interaction/ambient
  seams, see [approval-ux-seams.md](approval-ux-seams.md) — binds the
  harness lazily: call those from tool execute or hooks, not from the
  factory body.
- **Settings have no env bootstrap.** The store is their only source;
  the env pattern below is for secrets.

## The factory result

The factory's return value is ONE documented contract type, shipped
from the main package as the **types-only** subpath `sigrun/extension`.
Consume it with `import type`, so nothing loads at runtime:

```ts
import type { SigrunExtensionResult, SigrunHost } from "sigrun/extension";
```

There is no runtime entry behind the subpath — importing it as a value
fails loud by design. Every field is optional; the fields, their types,
what core does with each, and where its rules are documented:

| field | type | what core does with it | documented in |
|---|---|---|---|
| `extension` | pi-durable `Extension` | installed into the registry before `Harness.open`; its declared name is the slug source | this page ("The stores handle", "Prompt sections") |
| `name` | `string` | the identity of a contributor-only result (no `extension`) | "Contributing model providers" |
| `providers` | `readonly ProviderContribution[]` | merged into the boot model catalog; last-registered-wins, collisions recorded and surfaced | "Contributing model providers" |
| `webuiBundles` | `readonly WebuiBundleContribution[]` | each `dir` anchored at the entry; the name-keyed registry `server.webui.bundle` selects from | "Contributing webui bundles" |
| `health` | `() => HealthStatus` | aggregated into `/v1/meta` `health` — any `"degraded"` degrades the surface | "Contributing model providers" |
| `runSettled` | `ExtensionRunSettledHandler` | registered on the event bus; one call per settled run, deadline-bounded | this table |
| `conversationCreated` | `ExtensionLifecycleHandler<"conversationCreated">` | fired when a conversation is created (fork children included) | this table |
| `conversationForked` | `ExtensionLifecycleHandler<"conversationForked">` | fired with the child, parent, and fork point | this table |
| `conversationArchived` | `ExtensionLifecycleHandler<"conversationArchived">` | fired on archive flips (both directions) | this table |
| `conversationIdle` | `ExtensionLifecycleHandler<"conversationIdle">` | fired per quiet period once the idle threshold passes and no run is live | this table |
| `harnessShutdown` | `ExtensionHarnessShutdownHandler` | the ordered flush window (handlers may commit); runs after workers stop | this table |
| `userDeleted` | `ExtensionUserDeletedHandler` | fired after a user delete transferred ownership — move your per-user records here | this table |
| `interactionKinds` | `readonly string[]` | gates your interaction-seed writes and feeds the capability inventory | [approval-ux-seams.md](approval-ux-seams.md) |
| `ambientKinds` | `readonly string[]` | gates your ambient-surface writes and feeds the capability inventory | [approval-ux-seams.md](approval-ux-seams.md) |
| `workers` | `readonly ExtensionWorker[]` | host-owned wake timers + one-run-at-a-time execution; statuses in `/v1/meta` | "Idle workers: `wakeOn` only" |
| `jobs` | `readonly JobSpec[]` | declared jobs under `ext:<slug>:<name>` ids; jobs are the only time-based scheduler | "Declaring jobs" |
| `routes` | `readonly ExtensionRouteContribution[]` | HTTP routes mounted at `/v1/ext/<slug>/<path>` | ["HTTP routes"](#http-routes) |
| `commands` | `readonly ExtensionCommandContribution[]` | slash commands merged into `/v1/commands` | ["Slash commands"](#slash-commands) |
| `skills` | `readonly string[]` | absolute skill directories your package contributes (validated: existing dirs; a bad entry quarantines) | ["Skills"](#skills) |
| `notifiers` | `readonly NotifierContribution[]` | notification transports core delivers events to (best-effort, per-recipient) | ["Notifiers"](#notifiers) |

**The host rule.** The factory's first parameter is the host — `SigrunHost`
above — **never a defaulted options object**. Sigrun passes the host only
when `factory.length > 0`: a factory that wants the host must DECLARE the
parameter, and a length-0 factory may carry a defaulted first parameter
(a real dependency) that would otherwise consume the host and break the
extension at runtime. The host's conversation/identity/access members bind
lazily post-open — call them from tools, hooks, routes, commands, workers,
and jobs, never from a factory body.

A malformed field (wrong shape, wrong element type) quarantines the
extension at load — a package that THINKS it declared something must
never silently lose it.

## Secrets precedence: stored wins, env bootstraps

For every secret, the resolution order is:

1. the **stored** value — your `secrets.json` section has the key;
2. else the **env var** `SIGRUN_EXT_<SLUG>_<KEY>` — slug and key
   uppercased, `-` folded to `_`;
3. else undefined.

Worked example — the extension above (slug `acme-tool`), key
`api-key`:

```bash
export SIGRUN_EXT_ACME_TOOL_API_KEY=sk-...
```

- **Env values are never written down.** A boot that resolves a
  secret from env leaves `secrets.json` byte-identical; the write
  path is the handle (and future server affordances) alone.
- **Once a value is captured into the store by any channel — your own
  `secrets.set`, the webui settings panel (coming with the
  settings-surface work), or any future channel affordance — the
  stored value wins from then on**, without a restart: every `get`
  reads the file fresh, so a mid-flight capture is visible to the
  next call. The precedence rule is fixed now so affordances can land
  later without changing extension code.
- The name conversion is mechanical: uppercase, `-` → `_`. A
  camelCase key such as `apiKey` maps to `APIKEY` (no separator is
  invented), so prefer kebab-case or snake_case keys.
- An empty-string env var counts as unset — the same
  ""-means-unset reading the directory tiers use.

## Contributing model providers (provider plugins)

An extension package can contribute pi-ai providers — dynamic catalogs
that boot merges, refreshes, persists, and serves on `/v1/models` —
without any pi-durable surface at all. The factory result carries a
`providers` array of contributions; **a result with `providers` and no
`extension` is a valid provider-only contributor** identified by its
`name` field (which must equal the package name for factory-time scoped
settings reads to resolve — see below):

```ts
import { createProvider } from "@earendil-works/pi-ai/models";

export default async function sigrunAcme(host: {
	readonly stores: {
		readonly settings: {
			get(): Promise<Record<string, unknown>>;
		};
	};
}) {
	const settings = await host.stores.settings.get();
	// ...build the provider (see the rules below)...
	return {
		name: "sigrun-acme",
		providers: [{ provider, readiness }],
		health, // optional, "ok" | "degraded"
	};
}
```

The contract rules, all load-bearing:

- **Baseline `models: []`.** `createProvider` requires the field
  (omitting it throws); an empty array is the purely-dynamic shape and
  boots with an empty catalog the refresh fills.
- **Stamp `provider: "<your-id>"` on every model `fetchModels` returns.**
  pi-ai's restore path drops persisted models whose `provider` differs
  from the registered id, so an unstamped catalog silently vanishes on
  the next cold boot.
- **`fetchModels` throws, never returns `[]`.** The createProvider
  wrapper publishes and persists whatever the fetch returns — an empty
  array would wipe the catalog and the persisted store. Unconfigured,
  unreachable, or garbage upstreams throw (the refresh retains the last
  known catalog by contract).
- **`readiness` is the three-state tracker** sigrun's `/v1/auth/check`
  reports verbatim: `not_configured` (no credential resolved — an
  unconfigured optional plugin, not a broken process), `degraded`
  (credential resolved, last refresh failed), `ready` (credential
  resolved, refresh succeeded or a static catalog serves). Seed it from
  credential resolution — pi-ai never refreshes an unconfigured
  provider, so refresh outcomes alone cannot express `not_configured` —
  and update it per refresh outcome. It must be a synchronous read over
  plugin-owned state: never network, never storage.
- **Without a tracker**, `/v1/auth/check` falls back to the legacy
  producer mapping: `ok` → `ready`, `degraded` → `invalid`, absent →
  `not_ready`. The three-state vocabulary applies only to tracker-backed
  providers.
- **Credentials resolve through the auth bridge, never your own I/O.**
  The stored credential arrives as `credential` on your auth resolver
  (auth.json's `"default"` entry first, then your provider's own — sigrun
  reads it for you); ambient env arrives via `ctx.env(NAME)`. Do not
  read `auth.json` or `process.env` yourself. Resolve `undefined` when
  nothing is configured — pi-ai then skips the refresh phase and
  requests fail loud instead of boot failing.
- **Scoped settings are restart-required.** Whatever your factory reads
  from `host.stores.settings` is baked into the provider at factory
  time; changing `settings/<slug>.json` applies on the next restart, not
  mid-run. (The loader pre-keys the factory host on the slug derived
  from your package name, so a factory-time read resolves your file
  when the declared `name` matches the package name.)

**Dependency posture.** Declare `@earendil-works/pi-ai`,
`@earendil-works/pi-durable`, and `@sigrun/shared` (whose types the
`sigrun/extension` contract references) as **devDependencies
only**. Sigrun ships them at runtime, the packages-dir install omits dev
dependencies, and the loader links the host's own copies into the
packages dir so your bare imports resolve — you consume the SAME module
instances the host runs, matched structurally at runtime (never by
`instanceof`). `typebox` (pi-ai's own dependency) resolves the same way.
Reference plugins: [sigrun-ollama](https://github.com/sigrun-ai/sigrun-ollama)
(the minimal shape), [sigrun-opencode](https://github.com/sigrun-ai/sigrun-opencode),
[sigrun-pareto](https://github.com/sigrun-ai/sigrun-pareto) (scoped-settings
base URL), and [sigrun-bifrost](https://github.com/sigrun-ai/sigrun-bifrost)
(multi-surface discovery).

## Contributing webui bundles

An extension can ship a replacement web UI as a **contributed bundle**: a
factory-result field, the same contributor pathway as `providers`. The
result carries a `webuiBundles` array of `{ name, dir }` entries —

```ts
import { defineExtension } from "@earendil-works/pi-durable";

export default function createAcmeWebui() {
	return {
		extension: defineExtension({
			name: "@acme/webui", // slugs to "acme-webui"
			sections: [],
		}),
		webuiBundles: [{ name: "acme-webui", dir: "../webui" }],
	};
}
```

- **`name` is the selection key** and must match `^[a-z][a-z0-9_-]*$`
  (lowercase first letter, then lowercase letters, digits, `-`, `_`).
  It is INDEPENDENT of your extension slug — any string in the grammar
  is yours to pick — but naming it after your own slug (as the example
  does for readability) is the most collision-prone choice under
  last-registered-wins: a co-installed replacement extension reusing
  that name silently shadows your bundle (a warned, recorded collision
  — see `/v1/meta` `collisions.webui`). Prefer a distinctive name.
  A malformed `webuiBundles` field — not an array, a name outside the
  grammar, a missing or empty `dir` — **quarantines the extension at
  load**, fail-loud: a package that thinks it contributed a bundle must
  never silently lose it.
- **`dir` is the bundle root** — the directory containing `index.html`
  and its assets — and a relative value resolves against the
  **extension ENTRY FILE's directory**, your package, never the
  server's cwd. The npm footgun: a package whose entry is
  `dist/index.js` anchors at `<pkg>/dist`, so a bundle shipped at
  `<pkg>/webui` is `"../webui"` (or build the bundle under `dist/`
  beside the entry and say `"./webui"`). Absolute dirs pass through
  verbatim.
- **The server owns the `index.html` check.** A contributed bundle
  lacking `index.html` fails at SERVE time with a boot error naming
  your extension — not at load; the loader stays filesystem-free by
  contract.
- **Name collisions are last-registered-wins** with a `console.warn`
  and a retained record surfaced at `/v1/meta` under `collisions.webui`
  — a co-installed replacement bundle is a deployer-visible choice,
  never a silent shadowing.
- **Selection is configuration, resolved at serve time** (contributed
  bundles only exist after extensions load): set the selector to your
  name — `server.webui.bundle: "acme-webui"` or
  `SIGRUN_WEBUI_BUNDLE=acme-webui`. An explicit name that matches no
  contributed bundle is a boot error naming it. The gate applies first:
  `server.webui.enabled: false` (`SIGRUN_WEBUI=false`) mounts nothing
  at all, contributed or built-in.
- **A selected contributed bundle mounts exactly like the built-in
  one** — same static + SPA-fallback seam, `/v1/*` API precedence
  unchanged, no separate service or port — and `/v1/meta`'s
  `capabilities.channels` reports the selected bundle's name
  (`"webui"` for the built-in default and explicit paths, your `name`
  for yours), so a client can identify the UI it is talking to.
- **A bundle-only contributor needs a `name`.** As with `providers`, a
  factory result carrying `webuiBundles` and no `extension` is a valid
  contributor — identified by its `name` field.

## Declaring jobs (the only time-based scheduler)

A factory result may declare `jobs` — scheduled work sigrun runs for you,
surviving restarts:

```js
export default function createMyExtension() {
	return {
		extension: defineExtension({ name: "acme" }),
		jobs: [
			{
				name: "nightly-prune",                    // ext:acme:nightly-prune
				schedule: { cron: "0 3 * * *" },          // or { every: "15m" } / { at: "<ISO>" }
				action: { kind: "task", task: "prune" },  // a task YOUR extension registers
			},
		],
	};
}
```

Each entry is a full job spec (the §8.2 grammar of the core design doc:
`name`, exactly one of `cron`+optional `timezone` / `every` / `at`, and a
`prompt` or `task` action). Extension-declared jobs are read-only through
the API — edit the extension to change them. A malformed declaration
( bad grammar, duplicate names) quarantines the extension at load.

## HTTP routes

A factory result may declare `routes` — HTTP endpoints sigrun mounts at
`/v1/ext/<slug>/<path>` (webhooks, OAuth callbacks) using web-standard
`Request`/`Response` (Node ≥ 22; no server type crosses the contract):

```js
routes: [
	{
		method: "POST",            // GET | POST | PUT | PATCH | DELETE
		path: "webhook",           // RELATIVE: no leading "/", no ".."
		auth: "public",             // "user" | "admin" | "public"
		bodyLimit: 262144,         // optional; default 1 MiB
		async handler(request, ctx) {
			// ctx.principal is present on user/admin routes, absent on public
			return new Response(await request.text(), { status: 200 });
		},
	},
]
```

- **`public` skips authentication only** — the Host/Origin checks and
  the unclaimed-server gate still apply, and no principal is attached.
  The handler verifies its own caller (a webhook signature, an OAuth
  `state`). `user` routes require a credential; `admin` additionally
  requires an admin principal (403 otherwise).
- The handler receives a fresh `Request` per call, its URL absolute
  (`server.publicUrl` / `SIGRUN_PUBLIC_URL` when set, else
  `http://<Host header>`); its body may be read **once** per the web
  standard (a second `text()` rejects).
- Return a `Response` (or throw): a throw or a non-`Response` return
  answers `500 {error: "extension_route_failed", extension}` — logged,
  never a crash.
- A body over `bodyLimit` (default 1 MiB) answers `413 too_large`.
- A malformed declaration (bad verb, escaping path, unknown `auth`)
  quarantines the extension at load.
- `server.publicUrl` (`SIGRUN_PUBLIC_URL`, settings `server.publicUrl`)
  is the deployment's absolute base URL — trailing slashes are
  stripped; without it, notification deep links are omitted.

## Slash commands

A factory result may declare `commands` — slash commands that appear in
the clients' `/` menu (`GET /v1/commands` merges them after the core
table). Unlike core commands, an extension command executes ON THE
SERVER: the client POSTs the invoke route and renders the returned
notice (a transient banner in the webui, a status-bar flash in the TUI).

```js
commands: [
	{
		name: "standup",        // ^[a-z][a-z0-9-]*$; core names reserved
		description: "Post today's standup summary",
		args: "[team]",           // optional argument hint for the / menu
		async run(ctx) {
			// ctx: { conversationId, args, principal, host }
			// args is the raw text after the command word ("" when absent)
			return { notice: "posted" };   // {notice?} — optional
		},
	},
]
```

- The invoke endpoint is `POST /v1/conversations/:id/commands/<name>`
  with body `{args?: string}` — **write-gated** (a read-only sharee gets
  403; the conversation must exist, else 404).
- `ctx.host` is the same seam host `routes` receive; `ctx.principal` is
  the caller.
- A throw answers `500 {error: "command_failed", extension}` naming
  your slug — logged, never a crash.
- **Core command names are reserved** (`new`, `fork`, `compact`,
  `export`, `import`, `name`, `model`, `thinking`, `jobs`): a command
  naming one is DROPPED at boot with one warning — it never appears in
  the menu and invoking its name is 404.
- Two extensions declaring the same name: **last-registered-wins**
  (load order), warned at boot and recorded in `GET /v1/meta`
  `collisions.commands` — a co-installed replacement is a deployment
  choice the operator can see, never a silent shadowing.
- A malformed declaration (bad name shape, missing `description`,
  non-function `run`) quarantines the extension at load.

## Idle workers: `wakeOn` only

A factory result may also declare `workers` — in-process handlers woken
by conversation lifecycle events (a curator reacting to
`conversationIdle`):

```js
workers: [
	{
		name: "curator",
		wakeOn: ["conversationIdle"],   // REQUIRED, non-empty
		async run(context, wake) { /* … */ },
	},
]
```

**`every` is retired** (2026-10-19, ruling 12): a worker declaring
`every` quarantines its extension with `workers.every was retired —
declare a job with a task action`. Jobs are the only time-based
scheduler; an extension that needs a timer declares a job with a `task`
action (see above). Workers keep their run deadline, queued+coalesced
wakes, and the `/v1/meta` status projection.

## Prompt sections: six keys are reserved

pi-durable composes the system message from **sections** — a key plus
a render function — declared on every loaded extension, in registry
install order. Core installs its own extensions before `Harness.open`
reads the registry, so core sections lead the prompt; the per-model
guidance extension installs last, so its sections trail. The
`acme-note` section in the snippet above is one of yours; six keys are
core-owned surface:

| key | owned by | what renders |
|---|---|---|
| `identity` | `sigrun.context-files` | static identity paragraph (runtime facts) |
| `persona` | `sigrun.context-files` | `SOUL.md`, else the shipped default persona |
| `workspace-instructions` | `sigrun.context-files` | `AGENTS.md` from the conversation cwd (absent file → section omitted) |
| `skills` | `sigrun.skills` | the three-root skill list (see [Skills](#skills)) |
| `tool-guidance` | `sigrun.model-guidance` | per-model tool guidance |
| `execution-guidance` | `sigrun.model-guidance` | per-model execution guidance |

The registry itself permits duplicate section keys across extensions
(last writer wins at render), so a loaded extension could silently
replace a core surface. The loader quarantines instead: any extension
declaring a reserved key fails its LOAD — boot continues without it,
`GET /v1/meta`'s `extensions[].status` reports the quarantine — with
the message

```
extension "<name>" declares reserved core section "<key>"
```

naming your extension and the key. Sections under any non-reserved
key are yours, freely; there is no registration and no schema.

Two of the reserved keys carry a convention worth knowing even if you
never declare a section yourself:

- **Per-model guidance keys off the request's model string.** Core's
  model-guidance extension resolves `tool-guidance` and
  `execution-guidance` from an ordered, first-match-wins table of
  substrings matched case-insensitively against the request's resolved
  `${provider}/${modelId}` (table strings are lowercase by convention).
  For an unmatched model both sections render absent — the designed
  empty case, not an error. Section renderers have no `Models` catalog
  access: `PromptInput.agent.model` is the only model input, so a
  model-keyed section of your own keys off the same string.
- **Persona replacement is wholesale.** A present `SOUL.md` — including
  an empty file — owns the `persona` section outright, and an absent
  `SOUL.md` (or no env) renders the shipped `DEFAULT_PERSONA`. The
  default is never merged with a user file.

## Skills

The reserved `skills` section (owned by the core `sigrun.skills`
extension) lists skills from THREE roots, first-wins in this order:

1. **the workspace** — `skills/<dir>/SKILL.md` under the conversation's
   workspace;
2. **the user dir** — `<configDir>/skills/<dir>/SKILL.md`, your
   deployment-wide skills (a named config-root entry; no extension
   involved);
3. **package roots** — skills your package ships, in `extensions[]`
   install order.

A name present in several roots keeps the higher root's copy and logs
the shadowing. `load_skill` serves the winning copy.

A package ships skills either through its manifest —

```json
{
  "name": "my-skill-pack",
  "sigrun": { "skills": ["./skills"] }
}
```

(the pi-compat `pi.skills` spells the same thing) — or through the
factory-result `skills` field (absolute directories, useful when the
dirs only exist at runtime). Manifest dirs resolve against the package
root; nonexistent entries are dropped. A package that declares skills
and ships **no loadable entry** is a valid **skills-only** package:
outcome `ok`, nothing imported — this is how
`git:github.com/obra/superpowers` loads (its only pi extension is
TypeScript, which plain node cannot import; each `.ts` pi entry is
skipped with one warning). A package that declares an entry which does
not resolve still quarantines.

The rendered section is capped at `skills.sectionMaxBytes` (default
4096, a live setting) with a truncation notice.

## Prompt templates

A package may also ship **prompt templates** — the `/name` commands
whose bodies are Markdown files — through a conventional `prompts/`
directory at the package root:

```
my-package/
  package.json
  prompts/
    review.md      → /review
    deploy.md      → /deploy
```

No manifest field is needed: any `prompts/` directory at an installed
package's root is discovered (attributed to the package, in
`extensions[]` install order). Template files are direct `.md`
children only; frontmatter `description` (else the first non-empty
line) feeds the `/` menu and optional `argument-hint` hints the
arguments. Templates substitute shell-quoted arguments
(`$1`, `$@`, `${1:-default}`, `${@:N}`, `${@:N:L}`) and are expanded
server-side at admission — see README's “Skills and prompt
templates”. The user dir `<config-dir>/prompts/` and the workspace's
`prompts/` are the other two roots, with the same workspace > user >
packages precedence as skills; a template whose name collides with a
core or extension command is skipped with one warning.

## Notifiers

A factory result may declare `notifiers` — transports core delivers
events to. **Core ships none**: every transport (ntfy, Signal, web
push, ...) lives in an extension.

```js
notifiers: [
	{
		name: "ntfy",
		async notify(event, ctx) {
			// ctx.host is your seam host; event is one notification
			await fetch(`https://ntfy.example/${event.user ?? "sigrun"}`, {
				method: "POST",
				body: `${event.title} — ${event.body}`,
			});
		},
	},
]
```

Core emits one event per **recipient** (`user` is who it is for):

```ts
{
	type: "interaction.pending" | "job.failed" | "run.settled",
	conversationId?: number,   // the conversation, when one is involved
	jobId?: string,            // the failed job's id
	user: string | undefined,  // the recipient
	title: string,
	body: string,
	url?: string,              // `${server.publicUrl}/#/c/<id>` when set
}
```

- **Emitted events.** `interaction.pending` — always (an agent needs a
  human). `job.failed` — always, once per failed run. `run.settled` —
  per the `notifications.runSettled` setting: `"unwatched"` (default)
  only when no client stream is attached to the conversation (the
  away-from-desk case), `"cron"` only for job-run conversations,
  `"always"` every settle, `"never"` none. The setting is live — a
  `settings.json` PATCH reaches the next settle without a restart.
- **Recipients.** Each event goes to the resource's owner. For
  `interaction.pending` it also goes to every directory user with
  `write` access — anyone who can answer.
- **Titles.** `interaction.pending` → `"Sigrun needs you"` with the
  conversation's display name; `job.failed` → `"Job <name> failed"`
  with the run's error; `run.settled` → `"Reply ready"` with the
  display name. The display name is `name ?? autoName ??
  "Conversation <id>"`.
- **Delivery is best-effort.** Each `notify` call runs deadline-bounded
  on the event bus's side lane; a throwing or over-deadline notifier is
  logged and isolated — the other notifiers still receive the event —
  and nothing is retried durably (reliability is a notifier's own
  concern).
- A malformed declaration (missing name, non-function `notify`)
  quarantines the extension at load.

## Uninstall

There is no automatic deletion, anywhere. Removing an entry from
`extensions[]` stops the extension from loading; its retained settings
file and secrets section are **inert** — nothing reads them — and
sigrun deliberately refuses to destroy credentials on a typo'd edit.
`{ "enabled": false }` never deletes anything either. Data, state, and
cache directories stay in place for the same reason: the operator may
still want them. Forced removal belongs to future extension-management
commands; none ship today.

## Backup

Backup is **optional and off by default**, opted in per section:
`SIGRUN_BACKUP_SECTIONS` takes a comma list of `config`, `secrets`,
`data`, `state` — cache is never a valid section. Each enabled section
tars its store root alongside the harness DB backup; the `config` and
`secrets` tarballs carry `auth.json`/`secrets.json` and are written
mode `0600`. An extension that follows the buckets gets backup-safe
persistence by deployment choice alone — no extension code involved.
