# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-10-22
### Fixed
- **ctrl+c hung whenever a webui tab was open**: hijacked SSE streams never
  end on their own and the shutdown drain waited on them; shutdown now ends
  every live stream before closing (plus the second-signal force exit).
- New conversations sort at the top of the list from creation (they used to
  sink to the bottom of "Earlier" until their first submission).
- Copy works on insecure origins (plain http on a LAN/tailnet host) via the
  execCommand fallback; the async clipboard API is secure-context-only.
- Composer auto-grows from one row (the fixed 3-row box made short prompts
  look wrapped early).
- `lastActivityAt` no longer spams a `conversation.changed` event per turn.

### Added
- Chronological timeline view (header toggle, persisted pref): assistant
  turns render thinking / tool calls / text interleaved in occurrence order
  instead of folded under the response.
- Live thinking renders expanded while a run streams and folds with a
  brief animation when the response text arrives.

## [0.1.2] - 2026-10-22
### Changed
- The built-in `@sigrun/ext-mcp` dependency pins 0.2.0: remote MCP servers
  (streamable HTTP + legacy SSE adoption, no adapter process) and
  config-dir `mcp.json` resolution.

## [0.1.1] - 2026-10-22
### Fixed
- `@sigrun/sigrun@0.1.0` shipped a correct tarball but a dev-shape packument
  (the `file:../sigrun-ext-*` specifiers reached the registry's manifest):
  clean installs resolved no built-in extensions and quarantined them at
  boot. The publish-deps restore now runs in `postpublish` only — npm 11
  runs pack → postpack → packument submission, so the old `postpack`
  restore raced the manifest write. Version bumped so the registry gets a
  clean packument; 0.1.0's tarball was byte-correct and remains installable
  by direct tarball URL.
## [0.1.0] - 2026-10-21
### Added (server)
- Conversation list fields: name, last-activity, parent (fork lineage),
  archived and pinned on the list payload — the per-conversation meta
  N+1 is gone; fork trees sort by newest activity anywhere in the tree.
- Automatic conversation naming: a one-shot naming call driven by the
  `namingModel` setting (a model id, or `false` to disable; defaults to
  the server default model with thinking off). Forks of named
  conversations inherit `"<name> (fork)"`.

### Added (tui)
- Fullscreen alt-screen UI with mouse support: per-keymap themes,
  status bar, and a turn-grouped transcript with foldable turns.
- Action layer with configurable keymaps (standard / vim / emacs):
  turn-aware search, prompt-jump and picker actions replace the
  alt-screen built-ins; vim mode has real insert / normal / command
  modes with `v` opening the prompt in vim.
- Key reference overlay (`?` in standard/emacs, `g?` in vim).

### Added (webui)
- Theme system: palette / accent / mode, applied across the rail,
  header and right-panel shell; visual design adapted from hermes-webui
  by nesquena and contributors (credited in THIRD_PARTY_NOTICES).
- Sidebar: named, grouped, searchable conversation list with pin and
  archive.
- Transcript: turn-grouped rendering with an activity line per turn
  ("Thinking · 2 tools"), markdown everywhere, filterable tables
  (filter bar above > 6 data rows), copy buttons on code blocks, a
  transcript outline, and a scroll fade.
- Composer model and thinking pickers.

- Thinking blocks: `thinking` content blocks render as collapsible
  `<details>` before each assistant message's text — expanded + pulsing
  while the generation streams (`pi.live.generation.message` partials
  render as a provisional entry), collapsed at rest, hidden entirely by
  the new Interface setting.
- A "working…" indicator (three pulsing dots) driven by `steer.busy`,
  reading "compacting…" while a compaction task is live, plus a persistent
  compaction-failure alert from `pi.live.compactionFailure`.
- Submit chords: Ctrl+Enter / Cmd+Enter submit; the Interface setting's
  "enter sends the prompt" adds plain-Enter submit (Shift+Enter stays a
  newline).
- Settings sections: the panel gains a left nav (General / Tools /
  Interface / Advanced). Interface holds the new client-only prefs
  (`enterToSend`, `showThinking`) — localStorage-backed (`sigrun.prefs`),
  applied live, never sent to the server.
- Workspace drawer: below 1000px the workspace panel opens as a right-side
  overlay drawer (top-bar toggle, backdrop click / in-panel ✕ to close)
  instead of being hidden.

### Changed (webui)
- Tool-call-only assistant messages render nothing — the empty bubble
  above a tool card is gone.
- The Compact button is removed (compaction is automatic server-side;
  `/compact` remains a slash command). Composer controls sit in one row
  (Attach · usage ring · Send) and the textarea matches their height.
- The settings gear is larger; the top bar wraps badges instead of
  overflowing horizontally at narrow widths.

### Fixed (webui)
- The Tools section's checkboxes collapsed into a vertical column with the
  explanatory note clipped off the right edge (a `flex-direction` leak from
  the `.settings-field` base), forcing a horizontal scrollbar.
- `pi.live` doc narrowing gained the `generation`/`compactions`/
  `compactionFailure` shapes the new consumers read.
- Unified `extensions` list (install-and-load): one settings.json array
  covers npm specifiers, `file:`/path checkouts, and git sources
  (`git:host/path[@ref]` cloned into `<config-dir>/git/` with fetch/reconcile
  + entry discovery: sigrun manifest > pi-compat manifest > dist/index.js >
  index.ts). `{enabled: false}` = present-but-not-loaded. The separate
  `packages` list is gone; `SIGRUN_EXTENSIONS` accepts the same grammar
  per CSV chunk (JSON-object entries included).
### Added
- pi-style extension packages: the settings file's top-level `packages`
  array (file-only — no `SIGRUN_PACKAGES`) declares npm specifiers boot
  installs into `<config-dir>/packages/` (a real npm root: synthetic
  private `package.json` + `node_modules/`, pi's `~/.pi/agent/npm` shape),
  pruning undeclared entries, with a no-subprocess fast path when the dir
  already matches. The loader resolves each `extensions` name against the
  packages dir FIRST (deployment-installed wins), then bare import
  resolution (paths, `file://` URLs, dev checkouts, image-bundled
  packages). Install failure/timeout (120s) fails the boot naming the
  specifier. Deployments declare extensions in `settings.json` and
  restart — no image rebuild. Compose mounts the config dir on the data
  volume (`SIGRUN_CONFIG_DIR=/data/config`); the chart defaults
  `SIGRUN_CONFIG_DIR=/data/config` onto the same PVC as the database.
- `server.webui` settings section (the webui channel surface):
  `enabled` (default `true`; `false` is a positively API-only deploy —
  nothing mounts even when a bundle is present) and `bundle` (the
  selector — a value matching `^[a-z][a-z0-9_-]*$` is a contributed-bundle
  NAME, a path-shaped value is a directory). `SIGRUN_WEBUI` is the strict
  env gate (`true`/`false`, anything else fails loud);
  `SIGRUN_WEBUI_BUNDLE` remains the env selector form.
  `PATCH {server:{webui:{…}}}` sub-merges per key (a partial update no
  longer drops a previously set `bundle`); a defaulted first boot
  persists no webui keys at all.
- Extension-contributed webui bundles: a factory result may carry
  `webuiBundles: [{name, dir}]` (contract in `docs/extending.md`) — `dir`
  resolves against the extension entry file's directory (the bundle lives
  in the extension's package, never the server cwd), the server owns the
  `index.html` check at serve time (a missing index is a boot error naming
  the extension), and name collisions are last-registered-wins with a
  warn. Selection by name via `server.webui.bundle`; the selected
  bundle mounts exactly like the built-in one and
  `capabilities.channels` reports its name (`"webui"` for the built-in
  default).
- `/v1/meta` gains a `collisions` field (`webui` + `providers`):
  boot-merge collision records surfaced for operator visibility — the
  provider collision sink was retained since the provider plan but never
  readable until now.

### Deprecated
- `server.webuiBundle` — the legacy flat key reads as a deprecated alias
  for `server.webui.bundle` for one release (accepted with a deprecation
  warn). Selector precedence: `SIGRUN_WEBUI_BUNDLE` >
  `server.webui.bundle` > legacy `server.webuiBundle` > the built-in
  default. Bootstrap never writes the legacy key; migrate to
  `server.webui.bundle`.

### Changed
- `charts/sigrun` is rewritten as a bjw-s common library (app-template
  5.2.1) wrapper: the hand-written Deployment/Service/PVC/CronJob/
  ServiceMonitor templates are replaced by
  `templates/common.yaml` (loader init + generate) over a 5.2.1-schema
  values.yaml (`controllers`/`service`/`persistence`/`serviceMonitor`).
  The PrometheusRule stays a small hand template (the library has no
  PrometheusRule class), gated independently on
  `monitoring.prometheusRule.enabled`. The backup CronJob and the
  ServiceMonitor are now opt-in defaults (public portable shape); the
  Deployment's Recreate strategy, /healthz + /readyz probes, sigrun-env
  envFrom secret, and the RWO sigrun-data PVC at /data are unchanged
  contracts. test/manifests.test.ts asserts against the new render.
- **BREAKING** (packaging): `@sigrun/tui` is a spawned package, not an
  in-process import — `sigrun run`/`attach` spawn the `sigrun-tui` bin
  (`tui/dist/launch.js`) as a child process; the agent-dies-with-the-TUI
  lifecycle is preserved by the parent watching the child's exit. The
  tui declares its own runtime deps (`@earendil-works/pi-tui` plus the
  new `@sigrun/shared` leaf package carrying the theme tokens and shared
  primitives) and core lists it as an optional dependency: `serve` needs
  no tui, and a missing tui degrades `run`/`attach` with an actionable
  "install @sigrun/tui" message instead of a module-not-found crash.
- The CLI is buildable and installable: `npm run build` compiles
  `@sigrun/shared` + `src` → `dist` (sourcemaps off; the `sigrun` bin is
  `dist/cli.js` under plain node — the tsx shebang is gone); `tsx` moves
  to devDependencies (dev `start`/`tui` scripts keep it); `prepublishOnly`
  builds core + webui. Deploy entries run the built form — the Dockerfile
  build stage gains `npm run build` with `CMD ["node", "dist/index.js"]`,
  the chart's container command and backup CronJob are
  `node dist/index.js` / `node /app/dist/backup/run-backup.js`, and
  docker-compose runs `node dist/index.js` (no tsx in any deploy path).
- The default webui bundle anchors to the package root instead of the
  process cwd — an installed `sigrun serve` finds the bundle it ships
  from any working directory; explicit path selectors keep cwd-relative
  semantics, and an absent default stays the supported API-only deploy.

### Removed
- **BREAKING**: the extension-loader `.ts`-entry fallback. Extension
  sources (`git:` and path checkouts) must ship a built `dist/index.js` —
  a `.ts` entry no longer loads — it resolves only to quarantine at load
  with a clear "build the package and ship its built entry
  (dist/index.js)" error instead of riding the dev tree's tsx loader
  (whose behavior under plain node depends on the host's
  type-stripping flags). npm packages were never affected.

### Changed (packaging)
- Published as `@sigrun/sigrun` (CLI command stays `sigrun`) with
  `@sigrun/shared` and `@sigrun/tui` as workspace-published companions —
  exact intra-family pins (`0.1.0`), `publishConfig` access/provenance,
  `repository.directory` for the workspace packages, and a manifest
  hygiene suite (`test/package-manifest.test.ts`) pinning the published
  shape. `webui` stays a private build input (its bundle ships inside
  core's tarball as `webui/dist`).
- The npm tarball is the runnable package only: `files` narrows to
  `dist`, `webui/dist`, and the docs files — deploy assets (`scripts/`,
  `docker/`, `charts/`, `Dockerfile`) live in the GitHub repo.
- The three built-in extensions (`codemode`, MCP, tool search) ship as
  core dependencies under their published names `@sigrun/ext-codemode`,
  `@sigrun/ext-mcp`, `@sigrun/ext-tool-search` — the working tree keeps
  `file:` dev links until the family publishes (Task 8).
- The extension contract surface is `@sigrun/sigrun/extension`
  (types-only subpath; every import, doc, and the consumer fixture
  re-keyed).
- The deprecated `createMemory` named-export loader bridge is DELETED
  (release-0.1): packages must export the factory as default —
  `@sigrun/memory-markdown` 0.1.0 does. The named `extension`
  export bridge remains deprecated (loads with one warning).

### Added
- Durable personal assistant on pi-durable 1.2.0: the Harness (durable sessions,
  tasks, compaction, settings store), the §5 server + webui, the skills/search
  tool surface, extension loader (quarantine-on-failure), deploy manifests
  (base + homelab overlay), and the pi-parity feature set (approvals, memory
  surface, settings panel, command surface).
- pi-durable upgraded 1.0.2 → 1.2.0: ToolExecutionResult `output` rename across
  core, registry-driven settings roster, `modelTools` two-layer filtering.
