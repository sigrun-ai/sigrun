# Task 20 report: webui workspace scaffold + channel-bundle serving

Status: COMPLETE.

## What was built

- `webui/` workspace package `@sigrun/webui` (Vite 8 + TypeScript + React 19):
  `package.json`, `vite.config.ts` (`base: "./"` relative assets, react
  plugin), `tsconfig.json` (bundler resolution, react-jsx, DOM libs),
  `index.html`, `src/main.tsx` (StrictMode mount, fail-loud on missing
  #root), `src/App.tsx` (renders "sigrun" + the `/v1/meta` badges:
  harness/schema versions, memory/providers/backup health, channels),
  `src/api.ts` (typed §5 client — `getMeta`/`listConversations`/`listModels`,
  fail-loud on non-2xx, injectable fetch + baseUrl),
  `src/api.test.ts` (stub-fetch client tests, webui-local vitest).
- Root `package.json` → npm workspace root (`"workspaces": ["webui"]`),
  `@fastify/static@^9.1.0` added (v10 rides fastify-plugin ^6 while registry
  fastify is still 5.12.5 — the ^9 line is the fastify-5-era plugin);
  convenience scripts `build:webui` / `typecheck:webui`. Root
  `start`/`test`/`typecheck` unchanged in behavior.
- `src/config.ts`: `SigrunConfig.webuiBundle` (env `SIGRUN_WEBUI_BUNDLE`,
  default `DEFAULT_WEBUI_BUNDLE = "webui/dist"`, relative → process cwd) +
  `SigrunConfig.webuiBundleExplicit` (true iff env set non-empty).
- `src/server/static.ts`: `resolveWebuiBundle` (absent default → undefined;
  explicit-but-missing index.html → throw naming SIGRUN_WEBUI_BUNDLE; index
  document read once at boot) + `serveWebuiBundle` (fastify-static at
  prefix `/`; `setNotFoundHandler` SPA fallback: GET outside `/v1` → cached
  index.html, else Fastify-default-shape 404 JSON) + `WEBUI_CHANNEL`.
- `src/server/index.ts`: `createServer` resolves + mounts the bundle before
  route registration (explicit routes beat the static wildcard);
  `/v1/meta` `capabilities.channels` = `["webui"]` iff mounted, else `[]`.
- `vitest.config.ts` (root): `exclude: [...defaultExclude, "webui/**"]` — the
  webui suite runs under its own workspace vitest, exactly once.
- `test/server-static.test.ts` (14 tests) + hand-written fixture
  `test/fixtures/webui-dist/` (index.html + assets/app.js, marker strings).

## Decisions (locked as implemented)

## Decisions (locked as implemented)

- **Workspace shape:** npm workspaces, root `package.json` gains
  `"workspaces": ["webui"]` (the minimal member glob — the root itself is
  already the root package; `[".", "webui"]` would be redundant). The root
  package stays the sigrun core package; `webui/` is `@sigrun/webui`
  (private). Root scripts (`start`/`test`/`typecheck`) unchanged in behavior;
  added convenience `build:webui` / `typecheck:webui` scripts.
- **Serving seam:** `@fastify/static@^9.1.0` (the fastify-plugin ^5 line —
  v10 moved to fastify-plugin ^6 while registry fastify is still 5.12.5).
  Mounted at prefix `/` only when the bundle resolves. `GET /` serves the
  bundle's `index.html` (fastify-static default index behavior); assets serve
  under their built paths.
- **Bundle absent (default path):** supported API-only deploy — no static
  mount, `capabilities.channels: []`, `GET /` is Fastify's default 404 JSON
  (`{ message, error: "Not Found", statusCode: 404 }`). Chosen over a bespoke
  "api only" body so the absent-bundle surface is exactly the stock Fastify
  surface (nothing to document beyond "no webui channel").
- **Bundle explicit-but-missing (`SIGRUN_WEBUI_BUNDLE` set, no index.html):**
  FAIL LOUD — `createServer` rejects at boot. A set-but-missing bundle is a
  misconfigured deploy that intended the webui; booting API-only would hide
  it. A default-path absence is the supported API-only deploy.
- **SPA fallback:** `setNotFoundHandler` — GETs whose path is not `/v1` and
  not under `/v1/` receive the bundle's `index.html` (200, text/html); `/v1/*`
  and non-GET unknowns receive Fastify's default-shape 404 JSON
  (`{ message: "Route M:/p not found", error: "Not Found", statusCode: 404 }`)
  so the API error surface is unchanged whether or not a bundle is mounted.
  The index document is read once at boot (a channel bundle is a deploy-time
  asset — a redeploy restarts the process; no per-request fs read).
- **Bundle-path config:** `SigrunConfig.webuiBundle` (default `webui/dist`,
  relative paths resolve against the process cwd = the repo/deploy root) +
  `SigrunConfig.webuiBundleExplicit` (true iff `SIGRUN_WEBUI_BUNDLE` was set
  non-empty — drives the fail-loud branch above).
- **Channels:** `capabilities.channels` is `["webui"]` when the bundle
  resolved, `[]` otherwise.
- **Tests:** `test/server-static.test.ts` uses a HAND-WRITTEN fixture
  (`test/fixtures/webui-dist/` — index.html + assets/app.js, marked
  "fixture"); vitest never runs the vite build. `webui/src/api.test.ts` tests
  the typed client against a stub fetch and runs under the WEBUI workspace's
  own vitest (`npm run test -w @sigrun/webui`); root vitest excludes `webui/**`
  so each suite runs exactly once (root stays node-environment).

## Evidence

### TDD red (before implementation)

```
 FAIL  test/server-static.test.ts > ... (8 failures incl. createServer rejects)
 Test Files  1 failed (1)
      Tests  8 failed | 6 passed (14)
```

### TDD green (after implementation)

```
$ npx vitest run test/server-static.test.ts
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

### Typecheck (root AND webui)

```
$ npx tsc --noEmit            # root   → exit 0, no output
$ (cd webui && npx tsc --noEmit)   → exit 0, no output
```

### Full root suite

```
$ npx vitest run
 Test Files  28 passed (28)
      Tests  208 passed (208)
```

### Webui suite

```
$ (cd webui && npx vitest run)
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Webui build

```
$ (cd webui && npm run build)
vite v8.3.4 building client environment for production...
✓ 16 modules transformed.
dist/index.html                  0.30 kB │ gzip:  0.23 kB
dist/assets/index-B0gPgqxU.js  221.24 kB │ gzip: 69.31 kB
✓ built in 86ms
```

### Manual smoke (real bundle, default path)

Server booted via `npm start` equivalent (`npx tsx src/index.ts`) with
`SIGRUN_MODEL=openai/smoke` + throwaway storage/workspace, real `webui/dist`
present (default path resolved from cwd):

```
sigrun listening on http://0.0.0.0:3999

=== GET / ===                       HTTP/1.1 200 OK, text/html, etag, 304 B (the built index.html)
=== GET /v1/meta ===                {"backup": false, "channels": ["webui"]}
=== GET /some/client/route ===      HTTP/1.1 200 OK, text/html, 304 B (SPA fallback = the index)
=== GET /v1/unknown ===             HTTP/1.1 404 {"message":"Route GET:/v1/unknown not found","error":"Not Found","statusCode":404}
=== GET /assets/index-B0gPgqxU.js   200 application/javascript
=== /healthz /readyz ===            sigrun_liveness 1 / sigrun_readiness 1
```

### Headless browser render (App.tsx verified, not just served)

curl only proves the HTML SHELL serves — the React mount executes JS, so the
App was additionally verified in headless chromium (playwright's cached
`chromium_headless_shell-1228`, the same tooling the M2 mockup audit used)
against the live smoke server:

```
$ chrome-headless-shell --headless --no-sandbox --virtual-time-budget=8000 \
    --dump-dom http://127.0.0.1:3999/
EXIT 0; console/stderr carried only a benign vaapi GPU warning (no JS errors).
Rendered DOM: <div id="root"><main ...><h1>sigrun</h1>
<section aria-label="server meta"> with all six badges populated from a REAL
/v1/meta fetch: harness: 1.0.2 · schema: 5de49367… · memory: ok ·
providers: ok · backup: unconfigured · channels: webui
(no "loading…", no "meta fetch failed" — the fetch completed)
```

Screenshot captured at `/tmp/sigrun-webui-smoke.png` (1280x800). The author
model cannot view images, so non-blank rendering was verified
programmatically: the raw PNG decodes to 11 distinct sampled byte values
mixing dark text/border pixels (0, 1, 48, 88) with background (232, 255) — a
blank page would decode to ~1 uniform value. The screenshot file is left for
human inspection.

### Webui suite re-run (post all file changes, per review)

```
$ (cd webui && npx vitest run)   # 17:43, after every file change
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

## Test count / result

- Root: 28 files, 208 tests, all pass (14 new in server-static.test.ts).
- Webui: 1 file, 5 tests, all pass.
- `npx tsc --noEmit` clean in root and webui.

## Commit

`60905206a352e83d6165be572b956973809fe400` — `feat: webui workspace
scaffold + channel-bundle serving` on branch `feat/m2-webui` (unsigned,
matching the branch's existing commits; `.superpowers/` stays untracked per
repo convention). Working tree clean after commit.

## Notes for the record

- `@fastify/static` pinned to `^9.1.0` deliberately: v10.x moved to
  `fastify-plugin@^6` while registry fastify is still 5.12.5 — the ^9 line
  is the fastify-5-era plugin.
- The in-memory index.html is used ONLY by the SPA fallback; `GET /` itself
  is served from disk by fastify-static (verified in the smoke: `/` carries
  etag/last-modified, the fallback response carries neither).
- Smoke caveat: the server booted with dummy `OPENAI_BASE_URL`/key (no
  generation exercised — none needed to prove the serving seam).

## What T21 needs

- The bundle is served at `/` and the typed client exists; T21 (the real UI
  shell per the mockup) builds inside `webui/src/` against `api.ts`, extended
  with the remaining §5 endpoints it consumes (conversations CRUD,
  submissions, SSE `GET .../stream` — the client deliberately starts as a
  subset; add methods + wire mirrors as the UI needs them).
- The SPA fallback already serves deep links, so T21 can add client-side
  routing without server changes.
- Deploy/chart work (a later task) must run `npm run build:webui` in the
  image build or set `SIGRUN_WEBUI_BUNDLE` to a prebuilt bundle; without
  either, the deploy boots API-only by design.
- `api.ts` wire types mirror `src/server/views.ts` BY HAND (webui cannot
  import server sources: NodeNext vs bundler resolution) — when a §5 wire
  shape changes, update both; the schema-drift test guards the server side.
