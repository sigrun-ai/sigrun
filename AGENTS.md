# AGENTS.md — sigrun

Guidance for coding agents working in this repository.

## Layout

- `src/` — harness + server (`src/index.ts` = boot, `src/config.ts` = config
  surface, `src/harness/` = pi-durable wiring, `src/server/` = HTTP routes).
- `webui/` — npm workspace package (`@sigrun/webui`, vite + react). Built
  bundle lands at `webui/dist` (the default `server.webuiBundle`).
- `charts/sigrun/` — the Helm chart (reference k8s deploy).
- `docker/` — compose reference. `Dockerfile` — image build.
- `docs/superpowers/` — internal specs/plans/audits (agent-session artifacts,
  not shipped to npm). `docs/private.md` is gitignored.
- `test/` — vitest suites for `src/`.

## Run and test

```sh
npm install            # workspaces: root + webui
npm test               # vitest (src suites)
npm run typecheck      # tsc --noEmit (root)
npm run typecheck:webui
npm run build:webui    # vite build -> webui/dist
npm run test:e2e       # builds webui, then playwright
npm start              # tsx src/index.ts
```

## Conventions

- **Installs**: users install via npm, git source, or file path —
  `extensions[]` in settings (spec §4.1). Git sources load `dist/index.js`
  directly (no build step runs in clones); extension repos commit their
  built `dist/` for that shape. This core repo runs from `src/` via tsx —
  it does NOT commit `dist/`.
- **Identity**: commits use the maintainer-configured signing key and email
  `the maintainer commit email`. This repo's git config
  carries it (the global includeIf only fires on matching remote URLs).
- **Verification before completion**: run `npm test` + `npm run typecheck`
  before claiming done; the webui adds `build:webui` when its source moved.
- **Private artifacts**: never commit real hostnames, tokens, or session
  transcripts. `docs/private.md` and `.env` stay untracked by design.
- Tests own their literals: fixtures use synthetic hosts (`.example`,
  `example.invalid`), `acme/` names, no tailscale/forgejo values.

## Package surface

`package.json` `files` is a whitelist (src, webui source, deploy assets).
Anything new under `docs/`, `test/`, or `spikes/` stays out of the tarball —
add to `files` only when it is genuinely runtime-relevant to a published
npm install.
