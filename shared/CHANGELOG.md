## [0.16.0] - 2026-11-12

- Version-locked bump with the 0.16.0 core line (no changes).

## [0.15.0] - 2026-11-11

- Version-locked bump with the 0.15.0 core line (no changes).

## [0.14.0] - 2026-11-11

- Version-locked bump with the 0.14.0 core line (no changes).

## [0.13.4] - 2026-11-10

- Version-locked bump with the 0.13.4 core line (no changes).

## [0.13.3] - 2026-11-10

- Version-locked bump with the 0.13.3 core line (no changes).

## [0.13.2] - 2026-11-10

- Version-locked bump with the 0.13.2 core line (no changes).

## [0.13.1] - 2026-11-10

- Version-locked bump with the 0.13.1 core line (no changes).

## [0.13.0] - 2026-11-09

- Version-locked bump with the 0.13.0 core line; new `@sigrun/shared/embeddings` carried forward, plus the settings-rework additions: the `entries`/`variant` form field types (spec §5.6) and `SettingsSectionEntry.page`.

## [0.12.0] - 2026-11-09

- Version-locked bump with the 0.12.0 core line; new `@sigrun/shared/embeddings` subpath (the `EmbeddingResult` type) and the three embedding settings keys.

## [0.11.6] - 2026-11-08

- Version-locked bump with the 0.11.6 core line (no changes).

## [0.11.5] - 2026-11-08

- Version-locked bump with the 0.11.5 core line (no changes).

## [0.11.4] - 2026-11-08

- Version-locked bump with the 0.11.4 core line (no changes).

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.11.3] - 2026-11-08

- Version-locked bump with the 0.11.3 core line (no changes).

## [0.11.2] - 2026-11-08

- Version-locked bump with the 0.11.2 core line (no changes).


## [0.11.1] - 2026-11-07

- Version-locked bump with the 0.11.1 core line (no changes).

## [0.11.0] - 2026-11-07

- Version-locked bump with the 0.11.0 core line (the pi-durable 1.5.0 release).

## [0.10.2] - 2026-11-06

- Version-locked bump with the 0.10.2 core line (no changes).

## [0.10.1] - 2026-11-06

- Version-locked bump with the 0.10.1 core line (no changes).

## [0.10.0] - 2026-11-06

- `JobSpec.description?: string` (and the flattened `JobWire.description`): the optional,
  trimmed, ≤500-char human description shown in the Jobs view.

## [0.9.0] - 2026-11-05

- `InteractionRecord` gains optional `declinable: true` and settled `declinedVia:
  "button" | "message"` (the ask-user decline wire surface — additive, optional).
- `InteractionDeclined` wire type beside `InteractionAnswered` (the decline route's
  200 body).

## [0.8.0] - 2026-11-04

- New `./notices` subpath: the `UserNotice*` wire types, `NOTICE_LIMITS`, and the
  key/action-id regexes (the client-shared contract for the notices feature).

## [0.7.0] - 2026-11-04

- New `./model-label` subpath: `modelBreadcrumb` collapses every non-leaf path segment of
  a model id to its first character and prepends the provider (`bifrost` +
  `chain/acme-flash` → `b/c/acme-flash`).
- New `./auth` subpath: the one `isProxyOnly` predicate (server, webui, CLI), treating
  absent/empty method lists as proxy-only (fail safe).

## [0.6.1] - 2026-11-03

- Version pin to the 0.6.1 core family (no shared-source changes beyond the version).

## [0.6.0] - 2026-11-02

Version-companion release for sigrun 0.6.0 (no shared changes).
## [0.5.0] - 2026-11-02

Version-companion release for sigrun 0.5.0 (no shared changes).
## [0.4.2] - 2026-10-31

### Fixed
- The published tarball carries `dist/` again (`prepublishOnly` builds
  before `npm publish` — releases 0.2.0–0.4.1 shipped without it).

## [0.4.1] - 2026-10-31

### Changed
- Version bump only (the 0.4.1 core hotfix release).

## [0.4.0] - 2026-10-31

### Added
- `SettingsResponse.managed`: the deployment-managed top-level settings
  keys (read fresh from the seeder's managed-settings.json; a missing
  file means nothing is managed). Computed by the server, not part of
  the PATCH type.

## [0.3.0] - 2026-10-29

### Added
- The `./usernames` export for shared username derivation and validation.
- `ServerSettings.compaction.modelOverrides` declares per-model compaction
  policy overrides in the shared settings wire type.

## [0.2.1] - 2026-10-28
### Added
- Additive listener metadata on the meta response: host, port, and
  measured address families.

## [0.2.0] - 2026-10-27
### Added
- Surface and block wire types extended for the U5/U6/U7 workstreams:
  chat-block entry and state families, interaction and ambient bindings,
  block transport contracts, and settings-section types.

## [0.1.2] - 2026-10-24
### Added
- Extension-surface wire types, including block-instance and live-view
  contracts shared by the server, webui, and TUI.

## [0.1.1] - 2026-10-23
### Added
- `./live` and `./blocks` export subpaths.

## [0.1.0] - 2026-10-21
### Added
- First published release of the shared leaf (workspace package of
  [@sigrun/sigrun](https://github.com/sigrun-ai/sigrun)): theme tokens,
  conversation/turn shaping, the channel wire types, session-meta,
  commands, interactions, ambient records, access, settings, views,
  view-delta, and jobs — the surfaces the webui, TUI, and server share.

