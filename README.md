# Sigrun

Sigrun is a durable personal-assistant harness built on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable):
long-lived conversations over a SQLite store (surviving restarts, with
resumable generation), an HTTP API plus web and terminal UIs, and an
extension system that installs extra tools, providers, prompt sections,
and capabilities at boot.

- **Durable** — conversations, submissions, and schedules live in one
  SQLite database (`SIGRUN_STORAGE_PATH`); a restart resumes where it
  stopped.
- **pi-durable core** — the harness primitives (conversations, inbox
  steering/follow-up modes, retries, streaming, compaction) come from
  pi-durable; sigrun is the deployable shell around them.
- **Extensions** — separate npm packages loaded from `SIGRUN_EXTENSIONS` (or the settings file's
  top-level `extensions` list); a failing extension is quarantined and
  reported, never a boot abort.
- **Web UI** — a static bundle served from `SIGRUN_WEBUI_BUNDLE` (or the
  settings file's `server.webuiBundle`; default `webui/dist`); API-only
  deploys simply omit it. The web UI's visual design is adapted from
  [hermes-webui](https://github.com/nesquena/hermes-webui) by nesquena and
  contributors — see THIRD_PARTY_NOTICES.md.
- **Terminal UI** — a pi-idiom terminal client over the same HTTP + SSE
  API the web UI consumes (feature parity by design): conversation
  sidebar, streaming conversation pane, fork, the interaction and
  ambient seams, slash commands. See [Launch modes](#launch-modes).

## Quickstart

Minimum configuration is a model plus OpenAI-compatible credentials:

```bash
export SIGRUN_DEFAULT_MODEL=openai/gpt-4o-mini      # provider/model-id
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # any compatible endpoint

npm install
npm start        # tsx src/index.ts — listens on :3000
```

(`SIGRUN_MODEL` still works as a deprecated alias for
`SIGRUN_DEFAULT_MODEL` — one release cycle, with a boot warning.)

Then open `http://localhost:3000/` (web UI) or drive the API:

```bash
curl localhost:3000/v1/meta
curl -X POST localhost:3000/v1/conversations -H 'content-type: application/json' -d '{}'
```

Or with Docker: see [`docker/`](docker/README.md) —

```bash
cd docker && cp .env.example .env   # set SIGRUN_DEFAULT_MODEL + OPENAI_* in .env
docker compose up --build
```

For a durable cluster deployment, use the Helm chart in `charts/`.

## Launch modes

The `sigrun` binary (`package.json` `bin`, run via tsx) has three
entrypoints:

| Command | Behavior |
|---|---|
| `sigrun [--user <name>]` | Workstation mode: boot the harness + server **in-process** and launch the terminal UI against the loopback port — the server binds **loopback (`127.0.0.1`) only**, so the naive-identity API never answers the LAN. The agent dies with the TUI — when the TUI exits, server and harness shut down with it. |
| `sigrun serve` | Headless: boot the API + web UI statics, no TUI. This is exactly the `npm start` / `src/index.ts` composition the Docker image and Helm chart run. Binds all interfaces (`0.0.0.0`) — the container default; workstation `sigrun` (run) binds loopback only. |
| `sigrun attach [--server <url>] [--user <name>]` | TUI only, against a harness it can reach — the remote-client mode (e.g. attaching to a cluster or tailnet deployment). |

Resolution chains for `attach` (and for the workstation-mode user):

- **server**: `--server` → `tui.json`'s `server` →
  `http://localhost:$SIGRUN_PORT` (default `3000`)
- **user**: `--user` → `SIGRUN_USER` → `tui.json`'s `user`

`tui.json` lives in the config directory (`SIGRUN_CONFIG_DIR`, default
`~/.config/sigrun`) next to `settings.json`, and holds the TUI client's
own small config: `{ "user": "...", "server": "..." }` (both optional;
a malformed file is a boot error). The configured `user` rides every
request as the `X-Sigrun-User` header and is stamped as the
conversation's `owner` on create/fork/import (the identity seam — naive
mode, no auth flow yet; omitting the user omits the header and behavior
is unchanged).

## Configuration

Sigrun is configured by environment variables and a settings file at
`~/.config/sigrun/settings.json` (`SIGRUN_CONFIG_DIR` relocates the
directory — `SIGRUN_CONFIG_DIR` itself stays env-only, since it locates
the file). Precedence, per setting:

1. **Environment variable** (always wins — and an *invalid* env value is
   a boot error even if the file has a valid one).
2. **`settings.json`** field (applies only where the env var is absent).
3. **Code default** (listed in the table below).

When an env var and the settings file both set a knob, the env var wins
— this is documented behavior, not enforced: sigrun never warns about or
detects env/file conflicts.

On first boot (settings file absent), sigrun writes only what the
environment explicitly set — the env-sourced `server` fields plus
`extensions` and `defaultModel` when env supplied them — into
`settings.json`; defaults are never persisted, so later releases'
default changes reach existing installs (the file records intent, not
reality). The full resolved server section is visible instead in
`GET /v1/settings`'s `effective` block: every flattened server key
(`server.port`, `server.compaction.reserveTokens`, …) with its resolved
value and its source — `"env"`, `"file"`, or `"default"`. On later
boots the file is never rewritten by bootstrap: edit it, and env vars
still override it per field.

| Variable | Type | Default | File key | Purpose |
|---|---|---|---|---|
| `SIGRUN_DEFAULT_MODEL` | `provider/model-id` | — (**required**: env or file) | `defaultModel` | Boot default model; bare `model-id` implies the OpenAI-compat provider. `SIGRUN_MODEL` is a deprecated alias (boot warning; one release cycle). |
| `OPENAI_API_KEY` | string | — | `auth.json` (see below) | Credential for the env-driven OpenAI-compatible provider; the `auth.json` fallback after file entries. |
| `OPENAI_BASE_URL` | URL | OpenAI | `defaultProvider.baseUrl` | Endpoint for the env-driven provider (any compatible host). |
| `SIGRUN_PORT` | positive int | `3000` | `server.port` | HTTP listen port. |
| `SIGRUN_STORAGE_PATH` | path | `<dataDir>/sigrun.db` | `server.storagePath` | SQLite database location. Relative values resolve against the data root (absolute values verbatim; the cwd-relative `data/sigrun.db` default is retired). |
| `SIGRUN_WORKSPACE_PATH` | path | `<dataDir>/workspace` | `server.workspacePath` | Root of the static local workspace every conversation's tools run against. The default rides the data root (chart/compose deploys set the path explicitly); it is never persisted on first boot. |
| `SIGRUN_DATA_DIR` | path | `$XDG_DATA_HOME/sigrun` or `~/.local/share/sigrun` | `server.dataDir` | Data root (the DB default and extension data dirs). Env/file values win verbatim. |
| `SIGRUN_CACHE_DIR` | path | `$XDG_CACHE_HOME/sigrun` or `~/.cache/sigrun` | `server.cacheDir` | Cache root (regenerable; never ensured at boot). Env/file values win verbatim. |
| `SIGRUN_STATE_DIR` | path | `$XDG_STATE_HOME/sigrun` or `~/.local/state/sigrun` | `server.stateDir` | State root (operational bookkeeping). Env/file values win verbatim. |
| `SIGRUN_EXTENSIONS` | csv | *(none)* | `extensions` (top-level list) | Deploy-time extension list (string entries; env wins over the file). |
| — | — | *(none)* | `gitDir` is always `<configDir>/git` | Git extension checkouts clone here (pi layout). Not env-configurable. |
| `SIGRUN_WEBUI_BUNDLE` | path | `webui/dist` | `server.webuiBundle` | Web UI bundle directory; explicit-but-missing = boot error, default-missing = API-only. |
| `SIGRUN_CONFIG_DIR` | path | `~/.config/sigrun` | *env-only* | The settings file's own directory. |
| `SIGRUN_COMPACTION_ENABLED` | `true`/`false` | `true` | `server.compaction.enabled` | Context compaction on/off. |
| `SIGRUN_COMPACTION_RESERVE_TOKENS` | positive int | `16384` | `server.compaction.reserveTokens` | Headroom reserved for the model's reply. |
| `SIGRUN_COMPACTION_KEEP_RECENT_TOKENS` | positive int | `20000` | `server.compaction.keepRecentTokens` | Recent context retained verbatim through a compaction. |
| `SIGRUN_COMPACTION_BACKGROUND_TOKENS` | non-negative int | `32768` | `server.compaction.backgroundTokens` | Background compaction threshold; `0` disables background compaction. |
| `SIGRUN_BACKUP_PATH` | path | *(unset)* | `server.backup.path` | Path backup target (mutually exclusive with the S3 target). |
| `SIGRUN_BACKUP_S3_BUCKET` | string | *(unset)* | `server.backup.s3.bucket` | S3 backup bucket. |
| `SIGRUN_BACKUP_S3_PREFIX` | string | *(unset)* | `server.backup.s3.prefix` | Key prefix within the bucket. |
| `SIGRUN_BACKUP_S3_ENDPOINT` | URL | AWS default | `server.backup.s3.endpoint` | Custom S3 endpoint (S3-compatible stores). |

### settings.json schema

```jsonc
{
  "defaultModel": "openai/gpt-4o-mini", // non-empty provider/model-id; bare id = openai provider
  "extensions": [ // the desired install+load state — see Extensions
    "@acme/sigrun-ext-example@^0.1.0",         // npm specifier
    "git:github.com/obra/superpowers@main",     // git skills-only package: its SKILL.md
                                               // dirs load; its .ts pi extension is skipped
    { "source": "./dev-checkout", "enabled": false }  // object form
  ],
  "defaultProvider": {
    "baseUrl": "https://api.openai.com/v1" // non-empty URL
  },
  "server": {
    "port": 3000,                    // positive integer
    "workspacePath": "/home/sigrun", // non-empty path
    "storagePath": "data/sigrun.db", // non-empty path; relative resolves against the data root
    "dataDir": "/var/lib/sigrun",   // non-empty path (SIGRUN_DATA_DIR; verbatim)
    "cacheDir": "/var/cache/sigrun", // non-empty path (SIGRUN_CACHE_DIR; verbatim)
    "stateDir": "/var/lib/sigrun/state", // non-empty path (SIGRUN_STATE_DIR; verbatim)
    "webuiBundle": "webui/dist",     // non-empty path
    "compaction": {
      "enabled": true,
      "reserveTokens": 16384,        // positive integer
      "keepRecentTokens": 20000,     // positive integer
      "backgroundTokens": 32768      // non-negative integer (0 = off)
    },
    "backup": { // target: { "path": "/backups" } XOR { "s3": { "bucket": "...", "prefix": "...", "endpoint": "..." } }
      "staleAfterHours": 36            // positive number: health.backup degrades past this marker age
    }
  }
}
```

The file also carries the live harness settings (`steeringMode`,
`followUpMode`, `retry`, `stream`, `defaultTools`, `perModelThinking`)
and is read fresh at every resolution.

### auth.json

API keys live in `<config-dir>/auth.json` — the same directory as
`settings.json` — keyed by provider name, never in `settings.json`:

```jsonc
{
  "default": { "apiKey": "sk-..." },  // the resolved default provider's key
  "openai": { "apiKey": "sk-..." }    // a provider's own entry
}
```

The env-driven OpenAI-compatible provider resolves its key in this
order: `auth.json`'s `"default"` entry → the resolved provider's own
`auth.json` entry → the `OPENAI_API_KEY` environment variable (compat
fallback, still honored). `"default"` is used only by the provider of
the resolved default model; every other provider reads its own entry.
With no key anywhere the provider registers unconfigured — requests
fail loud, boot does not. The file is created
with mode `0600` (owner-only) whenever sigrun writes it. Key material is
never logged, echoed, or served by the API (`GET /v1/providers` reports
key *presence* only).

**Restart requirement:** `server.*`, `extensions`,
`defaultModel`, and `defaultProvider` changes — whether by hand edit or
`PATCH /v1/settings` — apply on the **next boot** only; the live
settings (`steeringMode`, `retry`, `stream`, `defaultTools`,
`perModelThinking`, `skills.sectionMaxBytes`) take effect immediately on
the next submission.

## Authentication

One pipeline authenticates every request into a *principal* (user,
admin flag, method) before any route runs. `/healthz` and `/readyz` are
always public; the browser surface, `/v1/onboarding*`, and login/logout
are public too; everything else needs a resolved principal. An
unclaimed server (empty user directory) answers 403 `setup_required` on
every gated route — onboarding is the only usable surface until the
first claim.

**Defaults.** The effective method list derives from the listen host:
a loopback bind (`127.0.0.1` / `[::1]` — `sigrun` workstation mode and
loopback `serve`) requires nothing (the naive single-operator path,
where an optional `X-Sigrun-User` header names the acting user); any
other bind requires `token`.

**The override.** `SIGRUN_AUTH` (csv of `token` and/or `proxy`; `none`
= the empty list) or the settings file's `server.auth.methods` sets the
list explicitly — explicit always wins, including `[]` on a non-
loopback bind, which boots with a warning that any reachable client is
trusted. The related env knobs: `SIGRUN_AUTH_TRUSTED_PROXIES` (CIDR
csv), `SIGRUN_PROXY_SECRET` and `SIGRUN_API_TOKEN` (credentials —
env-only, never in `settings.json`). Every auth setting is
restart-required.

**Tokens.** API tokens are `sgr_`-prefixed secrets shown once at
creation (the store keeps only SHA-256 digests) and are self-service:
an authenticated user lists and mints their own via
`GET`/`POST /v1/auth/tokens` (`DELETE /v1/auth/tokens/{id}` revokes;
admins may revoke anyone's). A token whose user was deleted is dead.
A browser exchanges a token for a `sigrun_session` cookie at
`POST /v1/auth/login` — invalid attempts are delayed and rate-limited —
and `GET /v1/auth/whoami` returns the resolved principal.

**Proxy method (forward auth).** A trusted reverse proxy vouches for
the caller through headers (Authelia's `Remote-*` defaults,
configurable) when the request comes from a peer inside
`server.auth.proxy.trustedProxies` (CIDRs). Setting
`SIGRUN_PROXY_SECRET` additionally requires that shared secret in the
`secretHeader` on every request. Scope the CIDR list to exactly the
proxy and nothing else: every peer in `trustedProxies` can forge any
identity, including an admin.

**Onboarding (the first claim).** An unclaimed server serves
`GET /v1/onboarding` + `POST /v1/onboarding/claim`. On a loopback bind
or through a trusted proxy identity the claim needs no code; otherwise
the one-shot setup code is required — printed once in the log at boot
and written to `<cacheDir>/setup-code` (in the Helm chart: the pod log
and `/cache/setup-code`; `SIGRUN_SETUP_CODE` pins it instead). The
claimant becomes the first admin and owns the reserved root
conversation. Later users join by invite code (`POST /v1/users/invites`,
admin) or by trusted-proxy auto-provision; admins can transfer or remove
users (`PATCH`/`DELETE /v1/users/{user}` — deletion transfers their
conversations).

**Sharing.** Conversations are private to their owner by default. The
owner can share one — household-wide or with named users, `read` or
`write` — through the web UI's ⋯ menu or the TUI's `/share`; `write`
lets a recipient submit, answer, and fork, but only the owner can
re-share. Household sharing defaults to `read`.

## Backup

Set a target (`SIGRUN_BACKUP_PATH` or `SIGRUN_BACKUP_S3_BUCKET`+`SIGRUN_BACKUP_S3_PREFIX`,
via env or `server.backup` in `settings.json`) and schedule the backup
script — the chart ships a nightly CronJob; bare deployments run
`npx tsx src/backup/run-backup.ts` (or the built `dist/backup/run-backup.js`)
with `SIGRUN_STORAGE_PATH` pointing at the database. Each run takes an
online-safe `sqlite3 .backup`, ships it to the target (`sigrun-<UTC
timestamp>.db`), and folds in any enabled `SIGRUN_BACKUP_SECTIONS`
tarballs (config/secrets/data/state — see
[`docs/extending.md`](docs/extending.md)).

**Retention differs by target kind:**

- **Path targets** retain in-process: each run prunes `sigrun-*.db`
  files older than 30 days from the target directory (mtime-based;
  non-matching files are never touched).
- **S3 targets are pruned by the BUCKET, not the script** — configure a
  lifecycle rule expiring the backup objects after 30 days. The rule's
  filter must match your key layout: object keys are
  `<SIGRUN_BACKUP_S3_PREFIX>sigrun-….db` (plus `<section>-….tar.gz` when
  sections are enabled — cover those too, or drop the filter on a
  dedicated bucket):

  ```json
  {
    "Rules": [
      {
        "ID": "sigrun-backup-retention",
        "Status": "Enabled",
        "Filter": { "Prefix": "sigrun-" },
        "Expiration": { "Days": 30 }
      }
    ]
  }
  ```

  Applied with `aws s3api put-bucket-lifecycle-configuration --bucket
  <bucket> --lifecycle-configuration file://rule.json` (adjust `Prefix`
  to your `SIGRUN_BACKUP_S3_PREFIX`, or remove `Filter` on a dedicated
  bucket). S3-compatible stores accept the same rule shape through
  their own tooling, with `--endpoint-url` selecting yours.

**Backup honesty (`GET /v1/meta`):** a configured target reports
`health.backup: "configured"` only while backups actually SUCCEED — the
script writes `<stateDir>/backup/last-success.json` after each
successful run, and `/v1/meta` reads it per request: absent, corrupt,
or older than `server.backup.staleAfterHours` (default 36 h) reports
`"degraded"`, with the last success's timestamp in `backup.lastSuccessAt`.
This requires the server and the CronJob to resolve the SAME state root
— set `SIGRUN_STATE_DIR` on both (the chart does); with it unset on the
job, the script warns and skips the marker (the backup itself still
succeeds), and the badge honestly reads `"degraded"`.

## Extensions

One list in `settings.json` — **`extensions`** — is the desired
install-and-load state. Every entry is both installed (or fetched) at
boot and loaded into the registry; removing an entry uninstalls it.
Entry grammar:

| entry | what happens |
|---|---|
| `"name"` / `"name@range"` / `"@scope/name@range"` | npm install into the packages dir, then load |
| `"file:/abs/path"` | npm `file:` install (symlinked source — the dev-checkout shape), then load |
| `"./rel/path"` / `"/abs/path"` | load in place (nothing installed) |
| `"git:host/path"` / `"https://…git"`, optional `@ref` | clone into `<config-dir>/git/<…>`, reconcile to the ref, then load |
| `{ "source": …, "entry"?: "./x.js", "ref"?: "v1.2", "enabled"?: false }` | the explicit form: entry-point override, ref override, or install-but-don't-load |

```jsonc
{
  "extensions": [
    "@acme/sigrun-ext-example@^0.1.0",
    "git:github.com/obra/superpowers@main",
    { "source": "./my-dev-checkout", "enabled": false }
  ]
}
```

- **Packages dir** — `<config-dir>/packages/`, a real npm root (a
  synthetic private `package.json` + `node_modules/`, pi's
  `~/.pi/agent/npm` shape). Boot diffs the declared npm/file entries
  against the dir's own manifest: missing or range-changed → `npm
  install`, removed → `npm uninstall`, no diff → no subprocess. Install
  failures (or the 120s timeout) fail the boot, naming the specifier.
- **Git dir** — `<config-dir>/git/`, pi's host/path layout. Absent →
  clone; present with a declared `ref` → `git fetch origin <ref>` +
  checkout `FETCH_HEAD`; present without a ref → fetch only (the
  checkout stays where you left it). Entry discovery: the object form's
  `entry` → a `sigrun` manifest (`{"sigrun": {"extension": "./index.js"}}`)
  → a pi-compat manifest (the first non-`.ts` `pi.extensions` entry; each
  `.ts` entry is skipped with one warning — it cannot load under plain
  node) → `dist/index.js`.
- **Skills from packages** — a package may ship skills instead of (or
  beside) extension code: manifest `sigrun.skills` or pi-compat
  `pi.skills` (`["./skills"]`, the same SKILL.md format), or a
  factory-result `skills` field (absolute dirs). A package that declares
  skills and has no loadable entry is a valid **skills-only** package
  (`git:github.com/obra/superpowers` is exactly this shape): outcome `ok`,
  nothing imported. A declared entry that does not resolve still
  quarantines. Discovery merges three roots — the workspace's `skills/`,
  the user dir `<config-dir>/skills/`, and package roots in install order
  — with workspace > user > packages precedence (a collision keeps the
  higher root and logs). The section cap is `skills.sectionMaxBytes`
  (default 4096, live).
- **Resolution** — npm/file names resolve against the packages dir
  first (the deployment's declared version wins over anything the image
  bundles); `git` entries resolve to their discovered checkout entry;
  then bare import resolution (dev checkouts, image-bundled packages).
- **Disabled entries** — `{enabled: false}` keeps the directory state
  (installed, cloned) but is never loaded. Re-enable by flipping the
  boolean and restarting.

`SIGRUN_EXTENSIONS` overrides the list (env wins, per Configuration's
rule): comma-separated, and the same grammar per chunk — including
JSON-object entries.

**Restart to change:** everything extension-shaped is boot-time. Docker
compose (`SIGRUN_CONFIG_DIR=/data/config` on the `sigrun-data` volume —
see `docker/`): edit `settings.json` in the volume, `docker compose
restart`. Kubernetes (the chart defaults the config dir onto the same
PVC as the database): edit the file (`kubectl exec`, or your GitOps
seeding), `kubectl rollout restart`. Source: edit
`~/.config/sigrun/settings.json`, restart the process. No image rebuild,
no manual npm.

**Security notes:** `npm install` executes the installed packages'
lifecycle scripts — operator-configured specifiers carry the same trust
as the extension code they name (full tool authority in the harness).
Git sources execute nothing at install (clone/fetch/checkout): the
extension code loads through the upstream discovery, and git extensions
must be dependency-light — their repos are loaded directly, NOT
npm-installed, so a loadable entry (`.js` dist, a sigrun manifest, or a
ts-loadable source under the tsx-started process) is the contract.
Load failures quarantine in `GET /v1/meta` (`extensions[].status`) and
never abort the boot — install failures fail loud at boot.

**Writing an extension:** an extension is a plain npm package — a
default-export factory returning `{ extension }` — and every file it
touches has exactly one place to live: five stores (settings, secrets,
data, state, cache) under XDG-respected roots, scoped by the extension's
slug, with one resolution chain and a fixed secrets precedence (stored
wins, env bootstraps). The author-facing contract — the store taxonomy,
the directory map, the slug rule, the `host.stores` handle, uninstall
and backup posture — is [`docs/extending.md`](docs/extending.md).

## Jobs

A job is a schedule plus an action, durable by construction — one
SQLite-backed record per job, one immutable revision per change, and
one record per run. Jobs are the only time-based scheduler in sigrun
(extensions that need a timer declare a job with a `task` action).

**Three sources:**

| source | where it is declared | id | mutable via the API |
|---|---|---|---|
| `api` | `POST /v1/jobs` | `api:<uuid>` | yes (owner or admin) |
| `file` | the settings file's `jobs[]` list | `file:<name>` | no — edit the file |
| `extension` | an installed extension's factory result | `ext:<slug>:<name>` | no |

`file` and `extension` declarations reconcile into job records at
boot and on change; the declaration is the source of truth, so the API
is read-only for them (`PATCH`/`DELETE` return `409 job_declared`).

**The shape** (spec §8.2):

```jsonc
{
  "name": "morning-brief",
  "schedule": { "cron": "0 7 * * *", "timezone": "America/Toronto" }, // or { "every": "15m" } or { "at": "<ISO 8601>" }
  "action": { "kind": "prompt", "prompt": "Summarize …", "model": "bifrost/glm-5.3-flash",
              "conversation": "new" },  // or a fixed conversation id
  "overlap": "skip",     // default; "queue" admits anyway (the conversation's inbox queues it)
  "catchUp": "once",     // default; "none" skips fires missed while the server was down
  "enabled": true
}
```

A `prompt` action submits its prompt as a conversation — `"new"`
creates one per fire (ownerless, `source: "cron"`), a fixed id submits
into that conversation (the job's `model`/`thinking` apply only to
`"new"`). A `task` action creates a pi-durable task owned by the
schedule task (deleting the job cascades): `{"kind": "task",
"task": "<registered task name>", "input": …}`.

**Runs:** a cron run is an ORDINARY CONTINUABLE CONVERSATION — open the
run conversation in either UI and keep talking; it is never a
disposable side effect. `overlap: "skip"` (the default) records a
`skipped` run when the previous fire is still live; `catchUp: "once"`
(the default) fires once after downtime, `"none"` skips missed fires
entirely. Runs carry the job `version` that fired them, so an outcome
always maps to the exact definition it ran.

**Run now:** `POST /v1/jobs/{id}/run` (write access) fires immediately
— the same hook external triggers (CI, Alertmanager) use with a token.
In the web UI the Jobs panel (the clock icon in the header) lists jobs
with a “Run now” button; in the TUI `/jobs` prints the table (name,
next run, last outcome).

## API sketch

- `GET /v1/meta` — version, extensions, health, auth posture
  (`methods`, `claimed`), capabilities.
- `GET`/`PATCH /v1/settings` — the settings file (see above).
- `GET /v1/jobs`, `POST /v1/jobs`, `PATCH`/`DELETE /v1/jobs/{id}` —
  the jobs surface (see [Jobs](#jobs)); `POST /v1/jobs/{id}/run` fires
  now; `GET /v1/jobs/{id}/runs` and `GET /v1/jobs/{id}/revisions` are
  the history (newest first).
- `POST /v1/conversations`, `POST /v1/conversations/{id}/submissions`,
  `GET /v1/conversations/{id}` — the durable conversation surface
  (SSE streaming views included).
- `GET /v1/providers` — per-provider readiness, statuses only (never
  credentials); `GET /v1/auth/check` is the deprecated alias.
- `GET /v1/onboarding`, `POST /v1/onboarding/claim` — the unclaimed
  state and the first-user claim.
- `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/auth/whoami` —
  the browser session and the resolved principal.
- `GET`/`POST /v1/auth/tokens`, `DELETE /v1/auth/tokens/{id}` —
  self-service API tokens.
- `GET /v1/users`, `PATCH`/`DELETE /v1/users/{user}`,
  `POST /v1/users/invites` — the user directory and invite codes
  (admin-gated).
- `GET /healthz`, `GET /readyz` — probes.

## Development

```bash
npm test            # full suite (vitest)
npm run typecheck   # tsc --noEmit
npm start           # tsx src/index.ts
```
