# Sigrun extension config surfaces

> Status: design, pending approval. Written 2026-10-16 from the
> post-TUI conversation. Companion to the channel-contract work that
> landed the same day (`views.ts` as the sole wire contract, `77029db`
> + `52e4a1d`): sigrun's HTTP surface is now typed from one leaf and
> shaped for a future OpenAPI generator. This spec designs the other
> half of the third-party story — the on-disk and API surfaces an
> extension author touches.

## 1. Intent

Sigrun should be buildable-for by strangers. The near case is us: the
extension repos we own (approvals, memory, MCP, tool-search, codemode)
each need somewhere to keep credentials, configuration, and state. The
far case is the glide path: third-party channels — Discord, Telegram,
Signal — written by people who never read our source. Both need the
same thing: a small, discoverable surface that answers "where does my
stuff go" once, uniformly, so an extension that follows the rules gets
backup-safe persistence, container-safe cache handling, and secret
hygiene without inventing any of it.

pi, our reference harness, does not provide this. Its `extensions.md`
offers session-state advice only; every pi extension blazes its own
path, and the result is visible on any installed machine: a config
directory littered with `pi-bifrost-gateway.json`, `twill-pi.json`,
duplicate `ollama-cloud.json`/`ollama_cloud.json`, and ad-hoc state
files at the top level. Sigrun's extension surface exists to be the
anti-example of that.

**The one-sentence contract:** sigrun gives every extension three
mediated stores (settings, secrets, state — server-owned paths, keyed
writes) and two raw stores (data, cache — extension-owned files), all
under XDG-respected roots, with one resolution chain and no per-store
surprises.

## 2. The taxonomy (five kinds, not three)

The user's original three — secrets, settings, data — are right for
everything user-meaningful. The pi survey and the storage-design
tradition add two:

| kind | what it is | durability | who writes it | backup |
|---|---|---|---|---|
| **secrets** | credentials, tokens, API keys | durable, sensitive | server-mediated API | yes (securely) |
| **settings** | user-tunable configuration | durable | server-mediated API | yes |
| **data** | user-meaningful content the extension produces or ingests | durable | extension (raw files) | yes |
| **state** | operational bookkeeping: cursors, dedup markers, trust stores | durable, meaningless to humans | extension (raw files) | optional |
| **cache** | regenerable derivations: indexes, compiled artifacts, scratch | disposable | extension (raw files) | **never** |

Cache and state are separated because they have opposite accident
profiles: deleting state silently breaks correctness (a lost dedup
marker re-processes work), while deleting cache only costs time. A
single "stuff" bucket would force every backup tool and every
`--purge` story to guess.

## 3. The directory map

All roots respect the XDG Base Directory Specification from day one
(sigrun is a native workstation citizen first; the XDG
`~/.local/share` vs `~/.config` split is honored, not collapsed):

| store | core | extension |
|---|---|---|
| config | `$XDG_CONFIG_HOME/sigrun/settings.json` | `$XDG_CONFIG_HOME/sigrun/settings/<ext>.json` |
| secrets | `$XDG_CONFIG_HOME/sigrun/auth.json` (provider creds) | `$XDG_CONFIG_HOME/sigrun/secrets.json` |
| data | `$XDG_DATA_HOME/sigrun/sigrun.db` (the harness DB) | `$XDG_DATA_HOME/sigrun/<ext>/` |
| state | `$XDG_STATE_HOME/sigrun/` | `$XDG_STATE_HOME/sigrun/<ext>/` |
| cache | — | `$XDG_CACHE_HOME/sigrun/<ext>/` |

Decisions encoded above, each the user's ruling unless marked:

- **`auth.json` keeps its pi-compatible meaning**: provider
  credentials (`{provider: {type, key, env?}}`), written through the
  provider-auth flow. Extension secrets do NOT go there — conflating
  the two breaks the meaning future provider plugins will import.
  Extension secrets get their own `secrets.json`, keyed by extension
  name, contents arbitrary per extension (JSON object, one top-level
  key per extension).
- **Separate settings files, not a shared one** (`settings/<ext>.json`):
  arbitrary per-extension shapes make one shared file a merge problem;
  file-per-extension makes server writes trivially atomic and uninstall
  trivially clean. Contents are arbitrary JSON owned by the extension.
- **Extension data/state/cache are free-form** directories. Sigrun
  mandates nothing about their contents — not file formats, not
  structure. The surface is "a directory that is yours."
- **The DB moves under the data root** (`$XDG_DATA_HOME/sigrun/sigrun.db`),
  retiring the current cwd-relative default (`data/sigrun.db` — today a
  bare `sigrun` spawns its DB in whatever directory it launched from).
  **Clean break, no migration machinery** (user ruling 2026-10-16: the
  only existing DBs are test DBs; sigrun is not yet a daily driver).
  Chart and compose installs are unaffected either way (explicit
  `SIGRUN_STORAGE_PATH`).
- **Core operational state** (the harness's own cursors/bookkeeping,
  outside the DB) lives at the state root, not mixed into extension
  areas. **Existing top-level config-dir entries are hereby named and
  stay put** (the anti-goal's "or be named in this spec" clause):
  `packages/` and `git/` (the extension install machinery — derived
  from `extensions[]` and needed offline at container boot, so NOT in
  the cache root; config root keeps them beside the intent that drives
  them), and the conversation workspace root (`SIGRUN_WORKSPACE_PATH`),
  which is deliberately out of scope for this spec — moving it changes
  existing conversations' working directories and risks more than
  tidiness buys.
- Channel client configs (`tui.json`, and any future webui/desktop
  client config) stay at the config root as purpose-scoped files — the
  pi-shaped convention formalized in the TUI spec §3.1. They are
  channel concerns, not extension concerns.

## 4. Resolution and containers

One resolution chain, applied per root:

1. Explicit env: `SIGRUN_CONFIG_DIR`, `SIGRUN_DATA_DIR`,
   `SIGRUN_CACHE_DIR`, `SIGRUN_STATE_DIR` (new: the latter three join
   the existing `SIGRUN_CONFIG_DIR`).
2. `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` / `$XDG_CACHE_HOME` /
   `$XDG_STATE_HOME` + `/sigrun`, when the XDG var is set and non-empty.
3. The spec defaults: `~/.config/sigrun`, `~/.local/share/sigrun`,
   `~/.cache/sigrun`, `~/.local/state/sigrun`.

`SIGRUN_STORAGE_PATH` remains as the finer DB-file override on top of
the data root (the deploy already uses it).

**Containers set no XDG vars** — minimal images run no desktop session,
so the `$HOME` fallbacks would land on the ephemeral filesystem.
Deployment overrides everything explicitly: durable buckets on the PVC
(`SIGRUN_CONFIG_DIR=/data/config`, `SIGRUN_DATA_DIR=/data/data`,
`SIGRUN_STATE_DIR=/data/state` — chart values, same PVC as today),
**cache on an `emptyDir`** (`SIGRUN_CACHE_DIR=/cache`) because
regenerable data is exactly what you don't spend a PVC on, and a
pod-local scratch that self-cleans on restart is a feature for
extensions. Compose deployments mirror the same shape with named
volumes.

## 5. Ownership and write authority

- **Extensions run in-process with the server.** Therefore
  "only writes its own section" is enforced **against accidents, not
  malice** — the same trust posture as the packages feature (an npm
  extension can already run arbitrary code at install). The spec says
  so plainly; the API is a guardrail, not a security boundary.
- **Secrets and settings are server-mediated.** The extension receives
  scoped handles through its factory context — read/write on its own
  `secrets.json` section and its own `settings/<ext>.json`, nothing
  else. The server owns serialization, atomic writes (temp-file +
  rename), and key isolation. Exact handle shape is a builder decision
  (§9).
- **Data, state, and cache are raw directories.** The extension
  receives resolved absolute paths through the same factory context and
  does what it likes: fs.writeFile, sqlite, whatever. Sigrun creates
  the directories on extension load and otherwise stays out of the way.
- **Env vs stored — stored wins, env bootstraps.** For secrets and
  extension settings alike: an env var (when present) seeds the value
  only while nothing is stored; once a value is captured into the store
  — via a slash command, the webui settings panel, or any future
  channel affordance — the stored value wins, **without a container
  restart** (the user's ruling: long-lived services modify secrets
  mid-flight; the interactive capture path is what makes
  stored-wins workable). Provider credentials in `auth.json` follow the
  same precedence, matching pi's precedent and unifying the rule.

## 6. Lifecycle

- **On extension load**: sigrun ensures `settings/<ext>.json` exists
  (may be `{}`), the extension's section may be absent from
  `secrets.json` until first write, and `data/`, `state/`, `cache/`
  directories exist. A scoped-read quarantine failure (the loader's
  existing behavior) does not delete any of it.
- **On uninstall**: no automatic deletion. Removal of an entry from
  `extensions[]` (today's only uninstall path — file-only, operator
  intent, boot's `syncPackages` prunes the package) stops the extension
  from loading; its retained **settings file and secrets section are
  inert and harmless** with nothing to read them, and silent credential
  destruction on a typo'd edit is the failure this ruling refuses
  (user ruling: forced removal belongs to future extension-management
  commands). `enabled: false` is likewise never a deletion. Data,
  state, and cache directories are left in place for the same reason —
  the operator may still want them.
- **On rename**: extension identity is its registered name — the
  manifest-declared name, which the loader reads before the factory
  runs, so it is available even on the quarantine path (a factory
  failure happens after manifest read; a package that fails before
  manifest read has no declared name and no stores to strand).
  Store keys are the declared name sanitized to a path-safe form
  (lowercased, `[^a-z0-9_-]` sequences folded to `-`; npm-scope `@` and
  `/` cannot survive as one directory name). A declared-name collision
  between two installed extensions fails loud at load — sharing a store
  section silently is worse than refusing to boot the second one.
  Renaming changes the directory key; migration of old directories is
  the operator's move (documented, not automated).

## 7. Goals / non-goals / anti-goals

**Goals**: one discoverable answer to "where does my stuff go";
uniform resolution across workstation and container; backup-honest
separation (secrets+settings+data backed up, cache never); secret
hygiene without a vault dependency; a surface an outsider can follow
from the docs alone.

**Non-goals**: encryption-at-rest for `secrets.json` (v1 matches pi's
plaintext-JSON posture, file perms 0600; an encrypted store is a future
spec); per-extension access control between extensions (impossible
in-process, §5); a settings schema language or validation DSL for
extensions (contents arbitrary; validation is the extension's job);
watch/notification when another channel edits a store (poll-or-refetch
is the extension's business in v1); DB migration machinery (clean
break, §3).

**Backup (user ruling)**: backup becomes **optional, default off**, and
each store section (config, secrets, data, state — never cache) is
separately configurable. The existing DB backup CronJob folds into this
same opt-in structure. The user further wonders whether backup should
be an **extension** rather than core — deliberately deferred to its own
design session; this spec only fixes the data layout that makes either
shape possible (store buckets = backup units).

**Anti-goals**: top-level config-dir litter (the pi failure mode —
every file must live in a bucket or be named in this spec); a daemon
or sidecar owning extension state; extending the harness HTTP surface
for extension-internal I/O (data/cache/state never transit the server);
on-by-default backup.

## 8. Constraints

- The existing env contract is preserved: `SIGRUN_CONFIG_DIR` keeps its
  meaning; `SIGRUN_STORAGE_PATH` stays; the three new vars are additive.
- The chart's single-PVC posture is preserved; cache moves off it.
- The `tui.json` client config (T5/T6) is unaffected except that its
  directory resolution inherits the new chain.
- First-party extension repos (approvals, memory, MCP, tool-search,
  codemode) migrate onto this surface as a follow-up task per repo;
  this spec defines the target, not the migrations.

## 9. What's left to the builder

- The factory-context handle shape for secrets/settings (method names,
  async vs sync, error surface on missing keys).
- The interactive capture affordances: the webui settings panel gains
  extension sections (it already renders server settings; extension
  settings/secrets join it), and the TUI gains at minimum a readable
  view — the write path may be webui-only in v1 provided one channel
  can capture without restart.
- The env-seeding mechanics: which env names an extension's secret
  binds to (convention: `SIGRUN_EXT_<NAME>_<KEY>` uppercased? builder
  proposes; the doc must name it).
- File-permission handling (0600 on secrets.json, 0700 on data dirs —
  builder confirms platform behavior).
- Whether `SettingsStore` grows an extension-settings sibling or a new
  small store class lands (implementation shape).
- The chart values patch (new env names, cache emptyDir) — mechanical,
  after the code lands.

---

## Decisions ledger (user rulings, for the reviewer's checklist)

1. `auth.json` = provider credentials only; extension secrets in
   `secrets.json`.
2. Separate extension settings files under `settings/`, not a shared
   file.
3. XDG from day one, all five roots honored (config/data/state/cache +
   the existing config dir); DB under the data root.
4. Cache is a first-class kind, container-mapped to emptyDir.
5. Core operational state at the state root.
6. Extension data/state/cache are raw, extension-owned directories.
7. Stored-wins-with-env-bootstrap for secrets AND settings; interactive
   capture works without container restart.
8. Uninstall: NO automatic deletion — retained settings/secrets are
   inert; forced removal belongs to future extension-management
   commands; `enabled: false` never deletes.
9. No schema-first/OpenAPI workflow yet (pre-release churn); the wire
   contract keeps the door open instead. (Landed already as the
   views.ts work; recorded here as the ruling it was.)
10. DB move is a clean break — no migration machinery (no real-world
    DBs exist yet).
11. Backup: optional, default OFF, per-section configurable (config /
    secrets / data / state; never cache); existing DB backup folds in.
    Extension-shaped backup deferred to its own design session.
12. Controller calls (settled in the builder check, §6): packages/ and
    git/ stay at the config root (container boots must not need the
    network); workspace root out of scope; store key = manifest-declared
    name, path-sanitized, collisions fail loud.
