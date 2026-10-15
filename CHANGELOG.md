# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added (webui)
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

## [0.1.0] - 2026-10-13
### Added
- Durable personal assistant on pi-durable 1.2.0: the Harness (durable sessions,
  tasks, compaction, settings store), the §5 server + webui, the skills/search
  tool surface, extension loader (quarantine-on-failure), deploy manifests
  (base + homelab overlay), and the pi-parity feature set (approvals, memory
  surface, settings panel, command surface).
- pi-durable upgraded 1.0.2 → 1.2.0: ToolExecutionResult `output` rename across
  core, registry-driven settings roster, `modelTools` two-layer filtering.
