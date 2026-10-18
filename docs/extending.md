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
  `packages/` and `git/` (the extension install machinery) and channel
  client configs such as `tui.json`.

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

**Dependency posture.** Declare `@earendil-works/pi-ai` (and
`@earendil-works/pi-durable` if you use its types) as **devDependencies
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
| `skills` | `sigrun.skills` | declared skills |
| `tool-guidance` | `sigrun.model-guidance` | per-model tool guidance |
| `execution-guidance` | `sigrun.model-guidance` | per-model execution guidance |

The registry itself permits duplicate section keys across extensions
(last writer wins at render), so a loaded extension could silently
replace a core surface. Boot asserts ownership instead: any extension
declaring a reserved key fails boot loud —

```
extension "<name>" declares reserved core section "<key>"
```

— naming your extension and the key. Sections under any non-reserved
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
