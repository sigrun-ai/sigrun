# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.10.0] - 2026-11-06

- Extension views render in the main pane (mount, key routing, overlay-aware Esc
  back-to-list/close, dispose) with block navigation (`SurfaceState.onNavigate`), notice
  flashes on the status bar, and the ext-transport URL fix (suffix routes after `?params=`).

## [0.9.0] - 2026-11-05

- Decline on declinable interaction cards (`alt+s` in answer mode; `alt+d` is the
  notices dismiss), the armed-hint chord, and the stepper review fixes (answer
  labels, "Not answered yet" naming, Enter guard).

## [0.8.0] - 2026-11-04

- Notices: an inline line for the current conversation's newest notice (a key dismisses
  it), `notices:N` in the status bar, and an overlay listing all notices with the
  buttons (extension actions run, `open` prints the URL, navigate routes); ambient
  navigate/open are wired. No peek — the count is the announcement.

## [0.7.0] - 2026-11-04

- The 401 auth notice dedupes across streams and survives conversation switches; SSE
  backoff gained jitter and a give-up (one final notice, no 11th retry).
- Notices cap at ten (count only — nothing expires by time).

## [0.6.1] - 2026-11-03

- Version pin to the 0.6.1 core family (no tui-source changes beyond the version).

## [0.6.0] - 2026-11-02

Version-companion release for sigrun 0.6.0 (no tui changes).
## [0.5.0] - 2026-11-02

Version-companion release for sigrun 0.5.0 (no tui changes).
## [0.4.2] - 2026-10-31

### Fixed
- The published tarball carries `dist/` again (`prepublishOnly` builds
  before `npm publish` — releases 0.2.0–0.4.1 shipped without it, so
  the `sigrun-tui` bin did not exist for installing users).

## [0.4.1] - 2026-10-31

### Changed
- Version bump only (the 0.4.1 core hotfix release).

## [0.4.0] - 2026-10-31

### Changed
- A 401 from the server surfaces as a named auth failure (the token is
  missing, expired, or revoked — create one in Settings → API tokens)
  at startup, in the pane's error lines, and as a terminal SSE failure
  that never retries; forms omit disabled fields from unrelated saves.

## [0.3.0] - 2026-10-29
### Changed
- No user-facing TUI changes; versioned with the core family for the
  pi-durable 1.4.0 upgrade and shared settings type additions.

## [0.2.1] - 2026-10-28
### Fixed
- No user-facing TUI changes; versioned with the core family for the
  listener, interaction, notification, and webui draft-restore fixes.

## [0.2.0] - 2026-10-27
### Added
- Block rendering extended for the U5/U6/U7 workstreams: chat-block
  transcripts, interaction and ambient surfaces rendered from block trees,
  settings forms on the live surface revision, and the block transports.

## [0.1.1] - 2026-10-24
### Added
- Extension surfaces and live surface updates.
- Typed block rendering: content, braille charts, collections, forms,
  page shells, images, navigation, and all three keymaps.

## [0.1.0] - 2026-10-21
### Added
- First published release of the TUI (workspace package of
  [@sigrun/sigrun](https://github.com/sigrun-ai/sigrun)): fullscreen
  alt-screen UI with mouse support, per-keymap standard/vim/emacs
  keymaps, themes from the shared tokens, turn-grouped transcript,
  composer, help overlay, and OSC 52 clipboard.

