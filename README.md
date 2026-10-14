# Sigrun

Sigrun is a durable personal-assistant harness built on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable):
long-lived conversations over a SQLite store (surviving restarts, with
resumable generation), an HTTP API plus an optional web UI, and an
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
| `SIGRUN_STORAGE_PATH` | path | `data/sigrun.db` | `server.storagePath` | SQLite database location. |
| `SIGRUN_WORKSPACE_PATH` | path | `/home/sigrun` | `server.workspacePath` | Root of the static local workspace every conversation's tools run against. |
| `SIGRUN_EXTENSIONS_DIR` | path | `extensions` | `server.extensionsDir` | Directory for extension package resolution. |
| `SIGRUN_EXTENSIONS` | csv | *(none)* | `extensions` (top-level array) | Deploy-time extension LOAD list (bare names). |
| — | — | *(none)* | `packages` (top-level array) | Extension INSTALL list (npm specifiers boot installs into the packages dir). File-only — installing is not an env-shaped act, so there is no `SIGRUN_PACKAGES`. |
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
  "packages": ["sigrun-ext-approvals@^0.1.0"], // non-empty npm specifiers → boot installs into <config-dir>/packages
  "extensions": ["sigrun-ext-approvals"], // non-empty package names → boot loads
  "defaultProvider": {
    "baseUrl": "https://api.openai.com/v1" // non-empty URL
  },
  "server": {
    "port": 3000,                    // positive integer
    "workspacePath": "/home/sigrun", // non-empty path
    "storagePath": "data/sigrun.db", // non-empty path
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

**Restart requirement:** `server.*`, `extensions`, `packages`,
`defaultModel`, and `defaultProvider` changes — whether by hand edit or
`PATCH /v1/settings` — apply on the **next boot** only; the live
settings (`steeringMode`, `retry`, `stream`, `defaultTools`,
`perModelThinking`) take effect immediately on the next submission.

## Extensions

Extensions are separate npm packages. Two lists in `settings.json` keep
the two acts distinct (pi's model):

- **`packages`** — the INSTALL list: npm package specifiers
  (`"sigrun-ext-approvals@^0.1.0"`, `"@scope/name"`, a `file:` path)
  that boot installs into the packages dir,
  **`<config-dir>/packages/`** (a sibling of `settings.json` and
  `auth.json` — the PVC-backed path in every deployment shape, so
  installed packages persist across restarts). The directory is a real
  npm root — a synthetic private `package.json` plus `node_modules/`,
  exactly pi's `~/.pi/agent/npm` shape. Boot diffs the declared
  specifiers against the dir's own `package.json` dependencies: missing
  or range-changed → `npm install`, no-longer-declared → `npm uninstall`,
  no diff → no subprocess at all. An install that fails or times out
  (120s) fails the boot, naming the specifier — a declared but
  uninstallable extension is a config error, like a bad `SIGRUN_*`
  value. `packages` is file-only (no env var — installing is not an
  env-shaped act) and the settings bootstrap never writes it (the package
  dir's manifest is the resolved state).
- **`extensions`** — the LOAD list: bare package names boot loads and
  installs into the registry, from `SIGRUN_EXTENSIONS` (env wins) or the
  top-level `extensions` array. A name is resolved against the packages
  dir FIRST (what `packages` installed wins over anything the image
  bundles), then by bare import resolution (paths, `file://` URLs, dev
  checkouts, image-bundled packages).

The split means a package may be installed-but-not-loaded (disabled
without uninstalling) and a loaded extension may come from somewhere
else (a dev checkout) — most deployments list an extension in both.
Deployments therefore **declare extensions in `settings.json` and
restart** — no image rebuild, no manual npm:

```jsonc
{
  "packages": ["sigrun-ext-approvals@^0.1.0", "sigrun-ext-memory-markdown"],
  "extensions": ["sigrun-ext-approvals", "sigrun-ext-memory-markdown"]
}
```

- **Docker compose** — `SIGRUN_CONFIG_DIR=/data/config` puts the config
  dir (settings + auth + packages) on the `sigrun-data` volume (see
  `docker/`); edit `settings.json` in the volume, `docker compose
  restart`.
- **Kubernetes** — the chart defaults `SIGRUN_CONFIG_DIR=/data/config`
  onto the same PVC as the database; edit the file
  (`kubectl exec` into the pod, or your GitOps seeding of the PVC),
  `kubectl rollout restart`. (Seeding a first-boot `settings.json` from
  a ConfigMap via an initContainer is a deployment choice, not something
  the chart implements.)
- **Source** — edit `~/.config/sigrun/settings.json` (or
  `$SIGRUN_CONFIG_DIR`), restart the process.

**Security note:** `npm install` executes the installed packages'
lifecycle scripts. The packages dir is operator-configured — the
specifiers you declare carry the same trust level as the extension code
they name (which runs in the harness with full tool authority).
Documented, not sandboxed — the same posture pi takes.

A failing extension LOAD is quarantined (logged and reported in
`GET /v1/meta` as `extensions[].status`) and never aborts the boot; a
bare sigrun (zero extensions) still runs with no-op memory and approval
surfaces. Extensions that need credentials read the environment or the
sibling `auth.json` — they load into the same harness, no separate auth
path. The MCP extension's own configuration is extension-owned at
`~/.config/sigrun/mcp.json` — core never reads it.

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
