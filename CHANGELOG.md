# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
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
