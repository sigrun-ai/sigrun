# Sigrun build, packaging, and webui channel surface

Status: implemented 2026-10-19 (feat/build-webui). Date: 2026-10-18.

## Why

Three converging needs:

1. **The CLI isn't installable.** The package is `private: true` and runs
   through tsx at runtime — `sigrun` only works inside a full repo
   `npm install` with tsx present. A published/linked binary needs a real
   build step.
2. **The webui should be optional and replaceable.** Today "off" = "absent
   bundle directory" — implicit, and there is no positive switch. The user
   wants `server.webui` on/off, and a way to select among multiple bundles.
3. **Extensions should contribute web UI bundles.** Today the bundle path is
   config-only, resolved before extensions load. A third-party UI should ship
   as an extension and be selectable without a separate service.

## Design

### Build step

- New `tsconfig.build.json`: `src` → `dist` (NodeNext, sourcemaps off, no
  declarations — the package stays `private`, no consumer of `.d.ts`).
  Explicit `rootDir: "src"` + `include: ["src"]` (review: the base config's
  `noEmit: true` + `include: ["src","test"]` don't pin the emit layout).
  `dist` is build OUTPUT — gitignored, never committed (the AGENTS.md
  "runs from src via tsx, does NOT commit dist" convention stays for dev;
  dist is tarball-only).
- **The tui becomes a spawned child process** (user ruling): today
  `src/cli.ts` dynamically imports `../tui/src/launch.js` IN-PROCESS (both
  reviews caught this — it's an import, not a shell-out, and it makes
  `dist/cli.js` unbuildable: the cross-package import breaks `rootDir` and
  the tarball can't contain the tui source). Under this ruling:
  - `@sigrun/tui` becomes a publishable package: `private` removed, its own
    `tsconfig.build.json` → `dist`, `bin: {"sigrun-tui": "dist/launch.js"}`,
    real `dependencies` (`@earendil-works/pi-tui` is used at runtime but
    declared nowhere today — it only works via root workspace hoisting),
    `exports`. Its relative reaches into core are replaced — the FULL
    touch-list (re-review): `tui/src/api.ts` (type-only imports from
    `src/server/{commands,session-meta,views}.js` — the load-bearing
    "client of the API" coupling, replaced by the wire), `theme.ts` +
    `launch.ts` (`src/shared/themes.js` → `@sigrun/shared`),
    `ui/sidebar.ts` (`src/shared/conversations.js`),
    `ui/conversation-pane.ts` (`src/shared/turns.js`).
  - `src/cli.ts` `run`/`attach` SPAWN `sigrun-tui` as a child process
    (`node <resolved sigrun-tui bin>`) instead of importing it. The
    lifecycle rule (agent dies with the TUI) is preserved by the parent
    watching the child exit, not by sharing a process.
  - `sigrun`'s `package.json` gains `@sigrun/tui` as an OPTIONAL dependency
    (the TUI is not needed for `serve`; its absence degrades `run`/`attach`
    with a clear "install @sigrun/tui" error, not a crash).
- `package.json` (sigrun):
  - `bin`: `"sigrun": "dist/cli.js"`.
  - `files`: `dist` + `webui/dist` (the built bundle) + the docs/licenses
    already whitelisted. `webui/src` and the tui source drop out (the tui
    is its own package now). The other whitelist entries (`scripts`,
    `docker`, `charts`, `Dockerfile`, `CONTEXT.md`, webui configs) stay
    unchanged — they're deployment references, harmless in the tarball.
  - `scripts`: `build` → `tsc -p tsconfig.build.json`; `prepublishOnly`
    (NOT `prepare` — review: `prepare` runs on every dev `npm install` and
    on the Dockerfile's deps stage where no `src/` exists yet, breaking
    `npm ci`) → `build + build:webui`. Dev `start`/`tui` keep tsx.
  - `tsx` moves from `dependencies` to `devDependencies`.
  - `private: true` STAYS for now (publishing is a later decision; local
    `npm link` testing of the CLI works regardless).
- `src/cli.ts` shebang: `#!/usr/bin/env -S npx tsx` → `#!/usr/bin/env node`.
- **Default bundle path anchors to the package root** (review blocker:
  today `webui/dist` resolves against process cwd, so an installed
  `sigrun serve` from `$HOME` looks for `$HOME/webui/dist` and silently
  goes API-only). The DEFAULT resolves against the installed package
  (`import.meta.url`-relative from the built module); EXPLICIT user paths
  keep cwd-relative semantics.
- **Extension-entry contract under plain node** (review finding): today
  `findExtEntry` falls back to `<repo>/index.ts`, which works only because
  tsx loads the process. Under plain `node`, a `.ts` entry throws
  `ERR_UNKNOWN_FILE_EXTENSION`. Post-change contract: git/path extension
  sources must ship a BUILT `dist/index.js` (the `index.ts` fallback is
  removed; npm packages already resolve built entries). Documented as a
  breaking change in the changelog.
- **Deploy invocations** (all four sites — reviews): the Dockerfile's
  build stage gains `RUN npm run build` and its CMD becomes `node
  dist/index.js` (the deps stage also gains `COPY tui/package.json` so the
  optional `@sigrun/tui` workspace dep resolves under `npm ci`); the
  chart's `npx tsx src/index.ts` → `node dist/index.js` (the SIGTERM
  comment stays accurate — `node` is the direct entry, no npm in the
  signal path); the chart's backup CronJob `npx tsx
  /app/src/backup/run-backup.ts` → `node /app/dist/backup/run-backup.js`
  (the backup source compiles into `dist` with everything else);
  `docker/docker-compose.yaml`'s `npx tsx src/index.ts` → `node
  dist/index.js`. The chart's "must carry tsx" comments are rewritten to
  reserve tsx language for dev only.

### Webui config surface

`server.webui` becomes a first-class settings section — a nested section
under `server`, which needs (review touch-list): `validateServer`'s
allowed-keys list gains `webui`; `update()`'s `server` branch gains a
per-key sub-merge for `webui` (the same second-level treatment
`compaction`/`memorySeam` get, so `PATCH {server:{webui:{enabled:false}}}`
doesn't drop a previously set `bundle`); `resolvedServerSection` projects
it. Validation: `enabled` boolean, `bundle` non-empty string.

- `server.webui.enabled` — boolean, default `true`. `false` = API-only
  deploy, positively. Overrides everything: no bundle is mounted even if
  present. Env `SIGRUN_WEBUI` maps here, parsed strictly (`true`/`false`,
  empty = unset, anything else fails loud — the `parseCompactionEnabled`
  pattern).
- `server.webui.bundle` — the selector. Discriminated SYNTACTICALLY
  (review): a value containing `/` or `\`, or starting with `.`, is a
  PATH; a value matching `^[a-z][a-z0-9_-]*$` is a contributed-bundle NAME.
  Anything else is a validation error. Default: the built-in bundle
  (package-root-anchored).
- `SIGRUN_WEBUI_BUNDLE` keeps working as the env form of the selector
  (deprecated in docs in favor of the file setting; env still wins when
  both set).
- **Migration** (review): existing deployments' `settings.json` carry
  `server.webuiBundle` (bootstrap writes the resolved section on first
  boot). `server.webuiBundle` reads as a DEPRECATED ALIAS for
  `server.webui.bundle` for one release (precedence: env >
  `server.webui.bundle` > legacy `server.webuiBundle` > default), then is
  removed. `validateServer` accepts it with a deprecation `console.warn`
  rather than throwing.
- **Bootstrap** (review): `resolvedServerSection` OMITS both webui keys
  when defaulted (the `backup` optional-key pattern) — otherwise a
  defaulted first boot persists `webuiBundle: "webui/dist"`, which the
  NEXT boot reads as an explicit legacy selection, re-introducing the
  cwd-relative default bug and making absent-default → API-only
  unreachable. A defaulted first boot writes neither `server.webui` nor
  `server.webuiBundle` to the file.

Resolution order at serve time (not config-parse time — extension bundles
only exist after `loadExtensions`):

1. `server.webui.enabled === false` → no mount, API-only.
2. Selector is a NAME matching a contributed bundle → that bundle.
3. Selector is a PATH → that directory (explicit-but-missing-index → boot
   error, today's rule).
4. Unset → the default built-in bundle; absent → API-only.

An explicit selector (name or path) that resolves to nothing is a boot
error naming it — never silently API-only on an explicit choice.

### Extension-contributed bundles

- A contribution field on the factory result: `webuiBundles?: readonly
  { name: string; dir: string }[]` — `name` matches
  `^[a-z][a-z0-9_-]*$`, `dir` is the bundle root. `dir` resolves relative
  to the EXTENSION MODULE's URL (an npm-installed extension's bundle lives
  in its own package, not the server's cwd); the server owns the
  `index.html` existence check at serve time (the loader has no filesystem
  coupling today and stays that way).
- The loader retains `webuiBundles` by mirroring the **provider-contributor
  pathway** (which now exists — provider plan Task 1, `loader.ts`: the
  factory result's `providers` is validated and collected into
  `LoadedExtensions.providerContributors`, boot concatenates them into
  `collectProviders`). `webuiBundles` follows the same shape: validate in
  `resolvedFromFactory` (name matches the key regex, `dir` is a string),
  collect a `webuiBundles` array on `LoadedExtensions` paired with the
  slug identity, expose on `OpenedHarness`, thread to `createServer`.
- Name collisions: last-registered-wins with a `console.warn` and a
  recorded sink — mirroring the provider-collision shape (warn + retained
  sink on `OpenedHarness`). Surfacing that sink in `/v1/meta` is NOT
  current behavior (the provider sink is recorded but never read by the
  meta route); adding a `collisions` field to `/v1/meta` for webui bundles
  is a plan step, and the same field can carry the provider sink.
- A contributed bundle is mounted identically to the built-in one — same
  `@fastify/static` + SPA fallback seam, same `/v1/*` precedence. No
  separate service, no extra port.
- `capabilities.channels` reports the selected bundle's name (the built-in
  default reports `"webui"` as today; a contributed selection reports its
  name) so a client can identify the UI it is talking to.

## Non-goals

- Hot-swapping the bundle at runtime (restart-required, same as extensions).
- Serving multiple bundles simultaneously on different paths (one mount at
  `/`; selection is singular).
- Publishing to npm (the build step enables it; `private` stays).
- npm publishing of `@sigrun/tui` / `@sigrun/shared` (they become
  publishABLE; the publish itself is the release decision).

## Tests

- Build: `npm run build` emits `dist/cli.js` + `dist/index.js`; a zero-args
  `node dist/cli.js` invocation runs with no tsx (NOT `--help` — the CLI
  has no help path and rejects unknown flags; the smoke test asserts a real
  invocation).
- tui spawn: `run`/`attach` spawn the `sigrun-tui` bin as a child process;
  a missing optional dep yields the clear "install @sigrun/tui" error, not
  a module-not-found crash.
- `server.webui.enabled: false` with a present bundle → API-only,
  `capabilities.channels` empty.
- Selector by contributed NAME mounts that bundle and reports its name in
  `capabilities.channels`; a name matching no contributed bundle → boot
  error; a value with `/` is treated as a path (syntactic discrimination).
- Selector by path preserves today's behavior incl. the explicit-missing
  boot error; explicit paths stay cwd-relative while the DEFAULT anchors
  to the package root (an installed-CLI fixture asserts the default
  resolves from any cwd).
- Migration: a `settings.json` carrying legacy `server.webuiBundle` boots
  with a deprecation warn and honors it; `server.webui.bundle` wins over
  the legacy key; env wins over both.
- Bootstrap: `resolvedServerSection` omits a defaulted `webui` (the
  absent-default → API-only case stays reachable after first boot).
- Settings: `PATCH {server:{webui:{enabled:false}}}` preserves an existing
  `bundle` (the second-level sub-merge); invalid `enabled`/`bundle` values
  fail validation.
- Extension contributing `webuiBundles` registers; collision warns +
  records for `/v1/meta` and last-wins; a contribution whose dir lacks
  `index.html` fails at serve time naming the extension.
- Extension-entry contract: a `.ts`-entry extension quarantines with a
  clear error under plain `node`; a built `dist/index.js` entry loads.
- Default unchanged for the repo-run case: no `server.webui` at all →
  built-in bundle when present, API-only when absent.

## Review disposition

Two reviews folded in (deepseek-v4.1-flash, glm-5.3 — independent, highly
convergent), then updated after the provider + system-prompt workstreams
merged (2026-10-18): the loader provider-contributor pathway now EXISTS
(provider plan Task 1), so `webuiBundles` mirrors it directly (the earlier
bindings-list correction is superseded by the real seam), and the four
provider plugins exist as reference implementations. Re-review
(deepseek-v4.1-flash, post-merge) verified all four load-bearing premises
against current code and folded two should-fixes: the `/v1/meta` collision
surface is NOT current behavior (the provider sink is retained, never read
by the route — the meta field is a plan step), and bootstrap omits BOTH
webui keys when defaulted (the legacy `webuiBundle` write would otherwise
re-arm the cwd bug on the next boot). Nits folded: full tui cross-package
touch-list; compose is the fourth tsx deploy site; Dockerfile deps stage
gains `COPY tui/package.json`. Both caught the same blocker: `src/cli.ts` imports the tui
workspace IN-PROCESS (`../tui/src/launch.js`), making `dist/cli.js`
unbuildable and the tarball broken — resolved by the user's ruling to make
`@sigrun/tui` a spawned, separately-published package (with `@sigrun/shared`
carrying the theme tokens). Also folded: `prepare` → `prepublishOnly` (the
Docker deps stage has no `src/`); default bundle anchors to the package
root; `server.webui` settings touch-list (validateServer + second-level
sub-merge + projection); legacy `server.webuiBundle` deprecated alias +
bootstrap omits defaulted `webui`; syntactic name-vs-path discrimination;
loader bindings-list pattern (not the nonexistent providers seam);
collisions warn + record for `/v1/meta`; contributed `dir` resolves against
the extension module URL with the server owning the `index.html` check;
`capabilities.channels` reports the selected bundle name; the extension
`.ts`-entry contract breaks under plain node (breaking change, documented);
all three tsx deploy sites covered (Dockerfile CMD, chart entry, backup
CronJob); the `--help` smoke test replaced with a real invocation.
