# sigrun — example docker compose deployment

The single-node path: one container, sqlite + workspace on one named
volume, driven by a `.env` file. This is the smoke / deploy-in-one-node
option; for a durable/persistent deployment prefer the Helm chart
(`charts/` (Helm chart), landing as the deploy move migrates the historical
`deploy/` base manifests) or your own manifests.

## Build the image

The extension deps are git+ssh URLs, so first vendor them where `docker
build` can see them, then build from the repo root:

```sh
bash scripts/docker-vendor-exts.sh
docker build -t sigrun:local .
```

If your network can reach the forgejo host over SSH, the vendor step is
optional — `npm ci` inside the build resolves them directly.

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
`-shm` sidecar files sit beside it) and the static workspace root at
`/data/workspace`. `docker volume inspect sigrun_sigrun-data` shows where
that lands on the host. Back up the volume (or stop the container first)
— see the backup CronJob in the k8s manifests for the durable setup.

## Production

For a durable/persistent deployment use the Helm chart in `charts/`
(Helm chart) — or your own manifests; compose is the smoke /
deploy-in-one-node path.