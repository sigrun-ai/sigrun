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
  extensions) loaded from `SIGRUN_EXTENSIONS`; a failing extension is
  quarantined and reported, never a boot abort.
- **Web UI** — a static bundle served from `SIGRUN_WEBUI_BUNDLE`
  (default `webui/dist`); API-only deploys simply omit it.

## Quickstart

Minimum configuration is a model plus OpenAI-compatible credentials:

```bash
export SIGRUN_MODEL=openai/gpt-4o-mini      # provider/model-id
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # any compatible endpoint

npm install
npm start        # tsx src/index.ts — listens on :3000
```

Then open `http://localhost:3000/` (web UI) or drive the API:

```bash
curl localhost:3000/v1/meta
curl -X POST localhost:3000/v1/conversations -H 'content-type: application/json' -d '{}'
```

Or with Docker: see [`docker/`](docker/README.md) —

```bash
cd docker && cp .env.example .env   # set SIGRUN_MODEL + OPENAI_* in .env
docker compose up --build
```

For a durable cluster deployment, use the Helm chart in `charts/`.

## Configuration

Sigrun is configured by environment variables and a settings file at
`~/.config/sigrun/settings.json` (`SIGRUN_CONFIG_DIR` relocates the
directory). Precedence, per setting:

1. **Environment variable** (always wins — and an *invalid* env value is
   a boot error even if the file has a valid one).
2. **`settings.json`** `server.*` field (applies only where the env var
   is absent).
3. **Code default** (listed in the table below).

On first boot (settings file absent), sigrun writes the resolved
`server` section — env values plus defaults — into `settings.json`, so
the effective configuration is visible and hand-editable. On later boots
the file is never rewritten by bootstrap: edit it, and env vars still
override it per field.

| Variable | Type | Default | File key | Purpose |
|---|---|---|---|---|
| `SIGRUN_MODEL` | `provider/model-id` | — (**required**) | *env-only* | Boot default model; bare `model-id` implies the OpenAI-compat provider. |
| `OPENAI_API_KEY` | string | — | *env-only* | Credential for the env-driven OpenAI-compatible provider. |
| `OPENAI_BASE_URL` | URL | OpenAI | *env-only* | Endpoint for the env-driven provider (any compatible host). |
| `SIGRUN_PORT` | positive int | `3000` | `server.port` | HTTP listen port. |
| `SIGRUN_STORAGE_PATH` | path | `data/sigrun.db` | `server.storagePath` | SQLite database location. |
| `SIGRUN_WORKSPACE_PATH` | path | `/home/sigrun` | `server.workspacePath` | Root of the static local workspace every conversation's tools run against. |
| `SIGRUN_EXTENSIONS_DIR` | path | `extensions` | `server.extensionsDir` | Directory for extension package resolution. |
| `SIGRUN_EXTENSIONS` | csv | *(none)* | *env-only* | Deploy-time extension package specifiers. |
| `SIGRUN_WEBUI_BUNDLE` | path | `webui/dist` | *env-only* | Web UI bundle directory; explicit-but-missing = boot error, default-missing = API-only. |
| `SIGRUN_CONFIG_DIR` | path | `~/.config/sigrun` | *env-only* | The settings file's own directory. |
| `SIGRUN_COMPACTION_ENABLED` | `true`/`false` | `true` | `server.compaction.enabled` | Context compaction on/off. |
| `SIGRUN_COMPACTION_RESERVE_TOKENS` | positive int | `16384` | `server.compaction.reserveTokens` | Headroom reserved for the model's reply. |
| `SIGRUN_COMPACTION_KEEP_RECENT_TOKENS` | positive int | `20000` | `server.compaction.keepRecentTokens` | Recent context retained verbatim through a compaction. |
| `SIGRUN_COMPACTION_BACKGROUND_TOKENS` | non-negative int | `32768` | `server.compaction.backgroundTokens` | Background compaction threshold; `0` disables background compaction. |
| `SIGRUN_BACKUP_PATH` | path | *(unset)* | `server.backup.path` | Path backup target (mutually exclusive with the S3 target). |
| `SIGRUN_BACKUP_S3_BUCKET` | string | *(unset)* | `server.backup.s3.bucket` | S3 backup bucket. |
| `SIGRUN_BACKUP_S3_PREFIX` | string | *(unset)* | `server.backup.s3.prefix` | Key prefix within the bucket. |
| `SIGRUN_BACKUP_S3_ENDPOINT` | URL | AWS default | `server.backup.s3.endpoint` | Custom S3 endpoint (S3-compatible stores). |

### settings.json `server` schema

```jsonc
{
  "server": {
    "port": 3000,                    // positive integer
    "workspacePath": "/home/sigrun", // non-empty path
    "storagePath": "data/sigrun.db", // non-empty path
    "extensionsDir": "extensions",   // non-empty path
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

**Restart requirement:** `server.*` changes — whether by hand edit or
`PATCH /v1/settings` — apply on the **next boot** only; the live
settings (`steeringMode`, `retry`, `stream`, `defaultTools`,
`perModelThinking`) take effect immediately on the next submission.

## Extensions

Extensions are separate packages, selected at deploy time via
`SIGRUN_EXTENSIONS` (comma-separated specifiers) and resolved against
`SIGRUN_EXTENSIONS_DIR`. A failing extension is quarantined (logged and
reported in `GET /v1/meta` as `extensions[].status`) and never aborts
the boot; a bare sigrun (zero extensions) still runs with no-op memory
and approval surfaces. The MCP extension's own configuration is
extension-owned at `~/.config/sigrun/mcp.json` — core never reads it.

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
