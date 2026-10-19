# AGENTS.md — sigrun

Guidance for coding agents working in this repository.

## Layout

- `src/` — harness + server (`src/index.ts` = boot, `src/config.ts` = config
  surface, `src/harness/` = pi-durable wiring, `src/server/` = HTTP routes).
- `src/harness/stores.ts` — store roots, extension slug, secrets/settings
  stores; boot ensures roots (author-facing contract in `docs/extending.md`).
- `shared/` — npm workspace package (`@sigrun/shared`, the pure
  client-shared leaf — zero imports): theme tokens and other shared
  primitives consumed by `webui/`, `tui/`, and core.
- `webui/` — npm workspace package (`@sigrun/webui`, vite + react). Built
  bundle lands at `webui/dist` (the built-in default bundle; select via
  `server.webui.bundle`).
- `tui/` — npm workspace package (`@sigrun/tui`, pi-tui terminal
  client), spawned by the CLI as a child process (optional dep). Its
  wire types come from `@sigrun/shared` (NodeNext — no codegen or
  mirrored schemas).
- `charts/sigrun/` — the Helm chart (reference k8s deploy).
- `docker/` — compose reference. `Dockerfile` — image build.
- `docs/superpowers/` — internal specs/plans/audits (agent-session artifacts,
  not shipped to npm). `docs/private.md` is gitignored.
- `test/` — vitest suites for `src/`.

## Run and test

```sh
npm install            # workspaces: root + webui + tui
npm test               # vitest (src suites; the webui and tui workspaces
                       # run their OWN suites, excluded from the root run)
npm run typecheck      # tsc --noEmit (root)
npm run typecheck:webui
npm run build:webui    # vite build -> webui/dist
npm run test:e2e       # builds webui, then playwright
npm --workspace @sigrun/tui run test       # tui suite (vitest)
npm --workspace @sigrun/tui run typecheck
npm start              # tsx src/index.ts (== `sigrun serve`)
```

## Conventions

- **Installs**: users install via npm, git source, or file path —
  `extensions[]` in settings (spec §4.1). Git sources load `dist/index.js`
  directly (no build step runs in clones); extension repos commit their
  built `dist/` for that shape. This core repo runs from `src/` via tsx —
  it does NOT commit `dist/`.
- **Verification before completion**: run `npm test` + `npm run typecheck`
  before claiming done; the webui adds `build:webui` when its source moved,
  the tui adds its workspace test + typecheck when `tui/` moved.
- **Private artifacts**: never commit real hostnames, tokens, or session
  transcripts. `docs/private.md` and `.env` stay untracked by design.
- Tests own their literals: fixtures use synthetic hosts (`.example`,
  `example.invalid`), `acme/` names, no tailscale/forgejo values.

## Extension seams

Interaction records (pending human decisions) and ambient surfaces
(statusline/panel state) are core-owned channel-neutral records
extensions write through the factory's host context — see
`src/harness/seam-host.ts` and `docs/approval-ux-seams.md`. The chord
draft rule: never re-read a mutated doc draft inside a commit callback.

## Package surface

`package.json` `files` is a whitelist (src, webui source, deploy assets).
Anything new under `docs/`, `test/`, or `spikes/` stays out of the tarball —
add to `files` only when it is genuinely runtime-relevant to a published
npm install.
