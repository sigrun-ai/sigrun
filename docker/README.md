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
Extensions section). Building the image is a plain `docker build -t
sigrun:local .` — no extension access is needed at build time.

## Run

```sh
docker compose --env-file .env -f docker/docker-compose.yaml up -d
```

`SIGRUN_PORT` is read from the environment for the host-side port mapping;
everything else comes from the env file.

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
  "extensions": ["@sigrun/ext-memory-markdown@^0.1.0"]
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