# sigrun — example docker compose deployment

The single-node path: one container, sqlite + workspace on one named
volume, driven by a `.env` file. This is the smoke / deploy-in-one-node
option; for a durable/persistent deployment prefer the Helm chart
(`charts/` (Helm chart), landing as the deploy move migrates the historical
`deploy/` base manifests) or your own manifests.

## Build the image

The image is a COMMON CORE — sigrun plus its built-ins only. Extensions
are NOT baked in: declare them in `settings.json`'s unified `extensions`
list and restart; boot installs them into the packages dir on
the data volume (see **Configuration** below and the repo README's
Extensions section). The published image is
`ghcr.io/sigrun-ai/sigrun` — `docker compose up` pulls it. To run from a
local checkout instead, `docker build -t sigrun:local .` and swap the
compose `image:` line; no extension access is needed at build time.

## Run

```sh
docker compose -f docker/docker-compose.yaml up -d
```

No `--env-file` flag needed: with `-f`, compose's project directory is
the compose file's own directory (`docker/`), so `docker/.env` is loaded
automatically for variable interpolation — and the service's `env_file`
entry passes the same file's operator vars (`SIGRUN_EXTENSIONS`, below)
into the container. `SIGRUN_PORT` (host port), `SIGRUN_IMAGE_TAG`,
`SIGRUN_UID`/`SIGRUN_GID` can be set in that file or the shell.

## Configuration

Create `docker/.env` (next to this README). The minimum is:

```sh
SIGRUN_DEFAULT_MODEL=openai/gpt-4o-mini
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

`SIGRUN_DEFAULT_MODEL` is required (`SIGRUN_MODEL` still works as a
deprecated alias for one release cycle, with a boot warning).
`OPENAI_API_KEY` / `OPENAI_BASE_URL` are the degenerate env-provider
path — enough to run against any OpenAI-compatible endpoint (OpenAI
itself, a local ramalama/ollama exposing an OpenAI-shaped API, or a
remote/private gateway; point `OPENAI_BASE_URL` at it and set the model
id it serves).

That minimum provisions a model, not access: auth keys are env-shaped —
add `SIGRUN_API_TOKEN` (a service token clients must present) or
`SIGRUN_AUTH=none` (private networks only) to the same `docker/.env`,
since the `env_file` vars enter the container while the compose
`environment:` block carries no auth entries. The chart's analogue
keeps these in the operator Secret instead.

### Knobs

| Variable | Default | What it does |
| --- | --- | --- |
| `SIGRUN_IMAGE_TAG` | `0.1.5` | The published image tag (the compose analogue of the chart's `image.tag`). |
| `SIGRUN_UID` / `SIGRUN_GID` | `1000` / `1000` | The uid/gid the container runs as. The default matches the image's `USER`, so a fresh named volume inherits `node:node` ownership on first mount with no manual chown. Override when your `/data` volume is already owned by another uid. (A `SIGRUN_UID=0` root start needs the entrypoint's privilege-drop trampoline — which the `cap_drop: [ALL]` hardening blocks; re-add `CAP_CHOWN`, `CAP_SETUID`, `CAP_SETGID` if you truly want it.) |
| `SIGRUN_EXTENSIONS` | unset | The env-shaped extension fleet override: a comma-separated package list that REPLACES the settings file's `extensions` list when set (env wins — sigrun core's contract). When unset in `docker/.env` the variable is absent from the container, not empty — the settings file drives the fleet. Mutually exclusive with the file-driven flow under **Adding an extension** below; use one or the other, or the env silently shadows the file every boot. |

## Hardening

The compose service runs least-privilege by default:

- **Read-only root filesystem** (`read_only: true`) — the server writes
  only under `/data` (the named volume), `/cache`, and `/tmp` (both
  tmpfs; cache is regenerable, a wipe is a cold start). `npm`'s cache
  included: `NPM_CONFIG_CACHE=/cache/npm` is baked into the image, so
  boot's extension installs land on tmpfs, not the read-only layer.
- **No Linux capabilities** (`cap_drop: [ALL]`) and
  `no-new-privileges:true` — the server needs no caps, and nothing it
  starts may gain any.
- **`init: true`** — docker's init (tini) as PID 1 reaps zombies (the
  server spawns `git`/`npm`/agent-shell children) and forwards
  signals.
- **`user: 1000:1000`** by default — non-root, matching the image's
  `USER` (see `SIGRUN_UID`/`SIGRUN_GID` above).

## Data

Everything durable lives on the `sigrun-data` named volume, mounted at
`/data`: the sqlite db at `/data/sigrun.db` (WAL mode, so the `-wal` /
`-shm` sidecar files sit beside it), the static workspace root at
`/data/workspace`, and the config dir at `/data/config`
(`SIGRUN_CONFIG_DIR`) — `settings.json`, `auth.json`, and the packages
dir (`/data/config/packages/`) that boot installs the settings file's
`extensions` entries into. `docker volume inspect
sigrun_sigrun-data` shows where that lands on the host. Back up the
volume (or stop the container first) — see the backup CronJob in the
k8s manifests for the durable setup.

### Adding an extension

Edit `/data/config/settings.json` in the volume (from the host path the
volume inspects to, or `docker compose exec sigrun ...`), declaring the
extension in the unified `extensions` list — one list is both the
install and the load declaration:

```jsonc
{
  "extensions": ["@sigrun/memory-markdown@^0.1.0"]
}
```

Then `docker compose restart`. Boot runs `npm install` into
`/data/config/packages` (first install needs registry access from the
container; later boots are a no-op fast path unless the list changed).
Removing an entry from `extensions` uninstalls it on the next boot. A
failed install fails the boot, naming the specifier — the container
log says why. No image rebuild, ever.

## Production

For a durable/persistent deployment use the Helm chart in `charts/`
(Helm chart) — or your own manifests; compose is the smoke /
deploy-in-one-node path.