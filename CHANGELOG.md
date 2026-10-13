# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Changed
- `deploy/` (kustomize base + homelab overlay) is replaced by a real Helm
  chart, `charts/sigrun` (spec §4.4 chart name: sigrun; version 0.1.0). The
  portable base manifests became chart templates; the homelab instantiation
  (Tailscale LB, iSCSI storage class, RustFS backup endpoint, worker
  placement) moved to the consumer's GitOps repo as values overrides
  (`flux-app-llm/sigrun`). test/manifests.test.ts now gates `helm lint` +
  `helm template` output instead of kustomize renders.

## [0.1.0] - 2026-10-13
### Added
- Durable personal assistant on pi-durable 1.2.0: the Harness (durable sessions,
  tasks, compaction, settings store), the §5 server + webui, the skills/search
  tool surface, extension loader (quarantine-on-failure), deploy manifests
  (base + homelab overlay), and the pi-parity feature set (approvals, memory
  surface, settings panel, command surface).
- pi-durable upgraded 1.0.2 → 1.2.0: ToolExecutionResult `output` rename across
  core, registry-driven settings roster, `modelTools` two-layer filtering.
