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
- **Extensions** — separate npm packages (e.g. the approvals and memory
  extensions) loaded from `SIGRUN_EXTENSIONS` (or the settings file's
  top-level `extensions` list); a failing extension is quarantined and
  reported, never a boot abort.
- **Web UI** — a static bundle served from `SIGRUN_WEBUI_BUNDLE` (or the
  settings file's `server.webuiBundle`; default `webui/dist`); API-only
  deploys simply omit it.
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

On first boot (settings file absent), sigrun writes the resolved
configuration — the `server` section (env values plus defaults) plus the
resolved `extensions` list and `defaultModel` — into `settings.json`, so
the effective configuration is visible and hand-editable (the file
records reality). On later boots the file is never rewritten by
bootstrap: edit it, and env vars still override it per field.

| Variable | Type | Default | File key | Purpose |
|---|---|---|---|---|
| `SIGRUN_DEFAULT_MODEL` | `provider/model-id` | — (**required**: env or file) | `defaultModel` | Boot default model; bare `model-id` implies the OpenAI-compat provider. `SIGRUN_MODEL` is a deprecated alias (boot warning; one release cycle). |
| `OPENAI_API_KEY` | string | — | `auth.json` (see below) | Credential for the env-driven OpenAI-compatible provider; the `auth.json` fallback after file entries. |
| `OPENAI_BASE_URL` | URL | OpenAI | `defaultProvider.baseUrl` | Endpoint for the env-driven provider (any compatible host). |
| `SIGRUN_PORT` | positive int | `3000` | `server.port` | HTTP listen port. |
| `SIGRUN_STORAGE_PATH` | path | `<dataDir>/sigrun.db` | `server.storagePath` | SQLite database location. Relative values resolve against the data root (absolute values verbatim; the cwd-relative `data/sigrun.db` default is retired). |
| `SIGRUN_WORKSPACE_PATH` | path | `/home/sigrun` | `server.workspacePath` | Root of the static local workspace every conversation's tools run against. |
| `SIGRUN_DATA_DIR` | path | `$XDG_DATA_HOME/sigrun` or `~/.local/share/sigrun` | `server.dataDir` | Data root (the DB default and extension data dirs). Env/file values win verbatim. |
| `SIGRUN_CACHE_DIR` | path | `$XDG_CACHE_HOME/sigrun` or `~/.cache/sigrun` | `server.cacheDir` | Cache root (regenerable; never ensured at boot). Env/file values win verbatim. |
| `SIGRUN_STATE_DIR` | path | `$XDG_STATE_HOME/sigrun` or `~/.local/state/sigrun` | `server.stateDir` | State root (operational bookkeeping). Env/file values win verbatim. |
| `SIGRUN_EXTENSIONS_DIR` | path | `extensions` | `server.extensionsDir` | Directory for extension package resolution. |
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
    "sigrun-ext-approvals@^0.1.0",              // npm specifier
    "git:github.com/obra/superpowers@main",     // git source (or {source, ref, entry})
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
    "extensionsDir": "extensions",   // non-empty path
    "webuiBundle": "webui/dist",     // non-empty path
    "compaction": {
      "enabled": true,
      "reserveTokens": 16384,        // positive integer
      "keepRecentTokens": 20000,     // positive integer
      "backgroundTokens": 32768      // non-negative integer (0 = off)
    },
    "backup": { "path": "/backups" } // XOR { "s3": { "bucket": "...", "prefix": "...", "endpoint": "..." } }
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
fallback, still honored). With no key anywhere the provider registers
unconfigured — requests fail loud, boot does not. The file is created
with mode `0600` (owner-only) whenever sigrun writes it. Key material is
never logged, echoed, or served by the API (`GET /v1/auth/check` reports
key *presence* only).

**Restart requirement:** `server.*`, `extensions`,
`defaultModel`, and `defaultProvider` changes — whether by hand edit or
`PATCH /v1/settings` — apply on the **next boot** only; the live
settings (`steeringMode`, `retry`, `stream`, `defaultTools`,
`perModelThinking`) take effect immediately on the next submission.

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
    "sigrun-ext-approvals@^0.1.0",
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
  → a pi-compat manifest (first `pi.extensions` entry, warned) →
  `dist/index.js` → `index.ts`.
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

## API sketch

- `GET /v1/meta` — version, extensions, health, capabilities.
- `GET`/`PATCH /v1/settings` — the settings file (see above).
- `POST /v1/conversations`, `POST /v1/conversations/{id}/submissions`,
  `GET /v1/conversations/{id}` — the durable conversation surface
  (SSE streaming views included).
- `GET /healthz`, `GET /readyz` — probes.

## Development

```bash
npm test            # full suite (vitest)
npm run typecheck   # tsc --noEmit
npm start           # tsx src/index.ts
```
