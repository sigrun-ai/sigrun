# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A Continue button on a failed run's line (webui) and a `/continue` command (webui and TUI) resume the run without a message. A failed job run rescued only by Continue loses its `Failed · ` label.

### Changed

- `runSettled` now fires for runs started by Continue: such a run's input has empty text, and the event carries `continued`. Host `run.admitted`/`run.settled` events now cover continued runs.

## [0.11.3] - 2026-11-08

### Added

- Jobs: per-job turn limit for unattended runs — `action.maxTurns`
  (integer ≥ 1) on new-conversation prompt jobs, the live
  `jobDefaults.maxTurns` settings fallback, default 150; a run that
  reaches it settles `failed` with `turn_limit`.
- Jobs: writing in a job-run conversation adopts it (the list row stops
  being quiet and the run's turn cap lifts), a `job:` fire never adopts,
  and a fork of a job run is an ordinary conversation (source reset to
  `user`, the job stamps and turn cap dropped).
- Quiet job runs stay out of both sidebars and sidebar search until the
  webui's **Job runs** toggle reveals them; failed runs stay visible
  with a `Failed · ` label and archive to resolve.

### Fixed

- Jobs: fires commit their run record and `lastRun` atomically, and a
  boot sweep settles crash-orphaned runs instead of leaving them running.
- Two jobs firing into one conversation settle their own runs, and a
  new-conversation run records its terminal outcome on the conversation.

### Changed

- The conversation list summary carries the server-owned `jobOutcome` and
  `adopted` fields when present.

## [0.11.2] - 2026-11-08

### Fixed

- Skills: a deleted or archived skill opened from the sidebar shows
  *Restore deleted*, and restoring always uses the deletion commit.
- TUI: a notice action carrying a confirm asks before running (y/n in the notices overlay).

## [0.11.1] - 2026-11-07

### Changed

- Multi-select collections with bulk actions always show the bulk bar
  (it used to appear only after the first tick, so checkboxes read as
  broken): a tri-state select-all checkbox, the selection count, and the
  actions disabled until something is selected. List group headings get
  their own select-all (e.g. every escalation from one job).

### Fixed

- A bulk action only counts and sends ids still present in the data; an
  item removed elsewhere drops out of the selection instead of riding a
  stale id into the action.
- Surface data could lose updates when two answers landed before the next
  render: an action's toast vanished when a refetch arrived in the same
  tick (a bulk dismiss's "Dismissed N" often never showed), and a burst
  of change events (one per dismissed item) sent overlapping fetches from
  the same base whose ops were applied more than once. Every snapshot
  write now builds on the latest state, ops apply only on the base they
  were fetched from (otherwise one full refetch), and stale answers are
  ignored.
- Opening an item on an extension page (e.g. reading an escalation) no
  longer remounts the whole page: the page transport was gated on a
  vestigial async key hash, so every params change unmounted the view,
  flashed "loading…" and dropped its state — including ticked
  selections. The transport now swaps in place; answers from the
  previous transport are discarded (an action's toast still shows). A
  collection's selection resets when a different collection takes its
  place (switching tabs).
- Surface toasts expire after 6 s, at most three show at once, and they
  stack in one column instead of painting over each other.
- Companion published first: @sigrun/ext-gateway 0.1.23 (its
  @sigrun/shared peer gains 0.11.1).

## [0.11.0] - 2026-11-07

### Changed

- BREAKING: pi-durable 1.5.0. Conversation data written by this release cannot be read by 0.9.x;
  the first boot under a NEWER pi-durable minor writes `<db>.pre-pi-durable-1.5.0-<stamp>.bak`
  (when no schema-migration snapshot was already taken this boot — a store jumping several
  schema versions snapshots at the schema guard instead); downgrade = restore that file.
- BREAKING: Transcripts now show the full raw history: turns before a compaction stay above the
  "context compacted" divider.
- BREAKING: `POST /v1/admin/tasks/:id/retry` removed; a schedule that hits the restart limit
  blocks its job; resume with `POST /v1/jobs/:id/resume`.
- BREAKING: Durable report metric labels follow pi-durable 1.5.0 (`session_failed` →
  `storage_failed`, `task_parked` removed, `task_interrupted` added); the live-task status label
  `ready` is now `pending`.
- BREAKING: Every conversation read (SSE connect, `GET /v1/conversations/:id`, extension
  watches) now loads the full history; very long conversations cost more until windowed
  streaming lands.
- BREAKING: A host killed mid-answer no longer resends the request on restart; the run retries
  per `settings.retry` or ends `interrupted`.
- BREAKING: Extensions built for pi-durable 1.4 are quarantined with a peer-range message.

## [0.10.2] - 2026-11-06

### Fixed

- The multi-select bulk action bar stays on screen: it rendered at the top
  of the list, so ticking rows further down a scrolled list (the escalation
  inbox sidebar) left "Dismiss selected" out of view. It is now sticky to
  the collection's scroll container and shows "N selected".

### Changed

- The family bumps to 0.10.2; companion: `@sigrun/ext-gateway` 0.1.21
  (shared peer gains 0.10.2).

## [0.10.1] - 2026-11-06

### Fixed

- Extension views scroll. The surface never got a definite height (the
  `.blk-surface` wrapper was a content-sized flex child, so a page's
  `height: 100%` resolved to auto) while the app root clips, so long views
  — the escalation inbox, a skill's SKILL.md — could not be scrolled at
  all. The surface now fills the main body and scrolls; a `page` root is
  sized to it, so its header stays put and its regions scroll.

### Added

- Code blocks in Markdown get a **Wrap** toggle beside Copy (soft-wraps long
  lines; macOS overlay scrollbars hide the horizontal bar otherwise).

### Changed

- The family bumps to 0.10.1 (shared, tui, sandbox platform packages);
  companion: `@sigrun/ext-gateway` 0.1.20 (shared peer gains 0.10.1).
- The published-hooks loader test scopes its built-in-shadowing check to
  its own hook (the real ext-mcp built-in publishes `mcp.tool-annotations`
  since 0.2.3, which had turned CI red on main).

## [0.10.0] - 2026-11-06

### Added

- Jobs editor in the `core/jobs` view: a New job form (prompt jobs, schedule cron/every/once,
  model + thinking pickers from the served catalogue), Edit/Delete for api jobs (edit preserves
  conversation/deliver/runSharing/task targets; clearing the description removes it), details
  and provenance rows (Defined in / Owner / action fields) with a read-only callout for declared
  (`file:`/`ext:`) jobs, and the job description as the sidebar row subtitle.
- `description` on `JobSpec` (optional, trimmed, ≤ 500 chars) for every job source — settings.json
  boot-gates an invalid one; an extension's declaration quarantines.
- TUI: extension views (Jobs, Skills, every extension surface) now render in the main pane with
  key routing, Esc back-to-list/close, overlay-aware Esc, notice flashes on the status bar, and
  block navigation (row activation, page actions like New job, post-action navigation) — plus a
  fix for the TUI ext-transport URL builder (suffix routes were appended after `?params=`).
- Live refresh for principal-scoped views (`core/jobs`, `core/skills`, curator): both clients'
  surface hubs now dispatch `surface.changed` by (slug, id) instead of a client-side params hash
  that never matched the server's principal-scoped key — background job runs now appear in an
  open view without a reload.

## [0.9.0] - 2026-11-05

### Added

- Decision providers: a factory result's `decisionProviders` contributes typed-question models
  (noul / choice / score) keyed in `auth.json` with a `credentialEnv` fallback; credentials write
  through `PUT/DELETE /v1/providers/:id/credential` (a decision-only id re-reads readiness
  instead of refreshing). `host.decisions.evaluate` (never throws; validated against the wire
  schema and the model's limits; a 15 s deadline capped by `server.decisions.timeoutMs` /
  `SIGRUN_DECISION_TIMEOUT_MS`), the `decisionModel` setting (live), decision entries with
  `kind` + model ids on `GET /v1/providers`, a `decisions` projection on `GET /v1/meta`, and the
  opt-in `decision_evaluate` tool (`decisions.tool`, default false). Docs:
  "Contributing decision providers" in docs/extending.md.
- `host.jobs.activeRun(conversationId)`: the job whose fire is CURRENTLY running in a
  conversation (both fire shapes), with its effective owner — the unattended-run marker
  extensions need to route destructive calls. Fixed-conversation fires settle their runs via the
  submission's `job:` requestId (no meta stamp; a fire into an existing conversation does not
  mark its later runs job-driven).
- `host.models.complete(input)`: one-shot chat completions for extensions (no conversation);
  explicit model → `namingModel` → default, `role: "utility"`, a 60 s default timeout, both the
  timer and the caller's signal bounding the wait.
- Declinable interaction records: `declinable: true` marks a pending record declinable;
  `POST /v1/conversations/:id/interactions/:callId/decline` (write access) settles it
  `skipped` with `declinedVia: "button"` (404 `no_such_interaction` / 404 `not_pending` /
  409 `not_declinable`); `host.declineInteraction(conversationId, callId, context, {user})`
  is the extension-side peer; `interactionSettled` payloads carry `declinedVia`. Declining
  sweeps the record's unread secret delivery inside the same commit.
- Interactive tools: a factory result's `interactiveTools` names the registered tools that
  need a human present. Core hides them in job-run conversations (`conversation: "new"`
  fires, `host.conversations.create({job})`) and curator runs (digest agents exclude them;
  every run's `allow` list loses them with one warning; fork reviews keep them listed for
  prompt-cache parity and the gate blocks a call instead). `host.jobs.isJobRun` tells an
  interactive tool's execute whether the current run is job-driven (a job firing into an
  existing conversation is not covered by the creation-time filter — refuse there).

## [0.8.0] - 2026-11-04

Core notices: a per-user notice system for extensions. An extension posts a short notice
(title, body, tone, up to 3 actions) to ONE directory user; only that user ever sees it,
by route or by event; it clears on dismiss, the user's own next prompt in the conversation,
acting on it, clear-all, eviction past the caps, or deleting the user (the file is removed
and a re-created username starts empty). Notices are transient by design — nothing expires
on a timer.

### Core

- `host.notices` (`post`/`clear`/`list`, extension-scoped keys, capped 10 per extension and
  50 per user), the `noticeActions` factory field (handlers run with the clicker's
  principal, idempotent, 10s timeout, dedup + rate limit reusing the surface-action
  primitives), `/v1/notices` routes (404-never-403 for foreign ids; `GET` prunes notices
  whose conversation share was revoked), and the user-only `notice.changed` event.
- Storage: one stamped, atomically-written `notices.json` per user under
  `<dataDir>/users/<user>/` (backup-archived by the existing `data` section); invalid
  entries are dropped on load; the agent sandbox cannot write it.
- Ambient `navigate`/`open` buttons work in the web UI (the no-op dispatcher is gone;
  `open` uses `noopener noreferrer`).

### Web UI

- Bell with a count (rail on desktop, every tab's header on phones), a notices pane
  (docked right panel on Chats, overlay on other tabs, full-height sheet on phones),
  inline notices above the composer (max 3, then "N more"), and a 6s peek (pause on
  hover, arrivals merge, none for an on-screen conversation's notice or while the tab
  is hidden).

### TUI

- Inline notice line above the editor, `notices:N` in the status bar, and an overlay
  with dismiss, Clear-all-free navigation, and the buttons (`open` prints the URL; no
  peek — the count is the announcement).

### Companions

- ext-curator 0.3.0 (published first): the "Learned: …" review notice moved onto core
  notices with Undo as an extension action on the notice; ext-gateway 0.1.16 widened its
  `@sigrun/shared` peer to the 0.8.0 line (0.1.15 is a dead scar — tagged before its fake
  host carried `SigrunHost.notices`, CI failed against core main).

## [0.7.0] - 2026-11-04

The polish pass: three waves of behaviour fixes, the full deferred-minors sweep, and a
fresh-eyes clean-room install verification.

### Core

- **Host-bridge fail-fast** (breaking for embedders): bridged host members now reject
  immediately with `HostBridgeUnavailableError` when no server will ever bind the bridge
  (`openHarness` gains `expectHostBridge`; `createServer` marks it expected on entry).
  Handlers log once per extension+member instead of stalling the hook deadline.
- Date-range presets (`PnD`/`PnW`) count calendar days; the `T…` part stays elapsed time.
- `modelBreadcrumb` in `@sigrun/shared/model-label`; the webui shows the provider as a
  breadcrumb (`b/c/acme-flash`) with the full id on hover.
- `isProxyOnly` lives once in `@sigrun/shared/auth` (empty/absent methods fail safe);
  the CLI onboarding gate keys on proxy identity (its claim can never carry the loopback
  vouch; `sigrun run`'s own loopback companion is exempt).
- Curator: empty-text skill writes refused; `.tmp` sweep; pruned undos report-and-continue
  (siblings still revert); two-targets-one-tool validated at load; scan caps gained
  cursors; the 10k guard reports truncation.
- serializePolicy has one writer; smoke scripts fail loudly (the registry smoke's
  false-green fixed); `-h/--help` accepted at every CLI level.
- Onboarding claim errors list the accepted body keys; token-create against fresh roots
  blames the roots.
- e2e suite: zero fixed sleeps (condition waits + boot barriers); a stale-closure in the
  composer's answered-refetch was found and fixed by the strictness.

### Fresh-eyes fixes (clean-room verified)

- The compose route boots (tmpfs `/cache:uid=1000`); the container documents its token
  path and the image puts `sigrun` on PATH (next build); the README documents the
  submission and claim body shapes and where the setup code lands per deploy shape.

## [0.6.1] - 2026-11-03

### Fixed

- Packages dirs now link `@sigrun/shared` like the other host runtime modules: the first packages-dir extension importing it at runtime (`@sigrun/recall`) quarantined without the link. One shared copy, the host's.

### Changed

- Release-pin bump to 0.6.1 (root, shared, tui, sandbox platform packages, chart appVersion, compose defaults).

## [0.6.0] - 2026-11-02

### Added
- **Escalations core.** Extensions send notices through `host.notify`
  (validated targets, delivered on the bounded side lane), look jobs up
  with `host.jobs.get`, create job-scoped conversations, and read a
  conversation's history through the trusted `host.conversations.entries`
  / `entry` (callers enforce access themselves).
- **Per-job state.** Each job gets a state folder under its owner's jobs
  root (jail-granted to the run); the run's prompt names it. State follows
  the job through delete, transfer and retire, and resets on request
  (`POST /v1/jobs/{id}/state/reset`, and a Reset button in the jobs tab).
- Extension views and panels render through the block renderer (they were
  a JSON placeholder in 0.5.0 — the curator view showed raw data).
- The settings page gains the `builtinExtensions.gateway` toggle.

### Changed
- **Ownerless jobs belong to the primary admin** (the earliest-created
  directory admin): run conversations, access checks, `host.jobs.get` and
  job state all use that effective owner. A single-operator install with
  an empty directory stays ownerless.
- The identity prompt section is multi-user and no longer names the agent
  (naming is persona territory, `SOUL.md`).
- Built-in documentation says six built-ins everywhere (codemode, MCP,
  tool search, gateway, OAuth, curator); everything else is optional.

### Fixed
- The web conversation list heals after the events stream drops: it
  reloads on every reconnect and when the tab becomes visible again, and
  reopens an EventSource the browser gave up on (5-60 s backoff).
  Conversations created on another device no longer stay invisible until
  a reload.
- Leaving an extension view: the Chats rail entry works and picking a
  conversation in the sidebar returns to the chat.
- Phone layout: a long URL in a user message no longer makes the chat
  slide sideways; tables keep readable columns and scroll inside their
  card; the composer's controls stay on one row.
- Extension surfaces: params-carrying action/data URLs, zero-width surface
  pages, and cadence refreshes.
- `SIGRUN_EXTENSIONS` without a model env no longer crashes boot.

## [0.5.0] - 2026-11-02

### Added
- **The curator** (sixth built-in, `@sigrun/ext-curator`): per-user
  curation over learned skills and curation targets. Message attribution
  records the submitting user per input; fork reviews (loop 1) run after
  conversation activity past a threshold; the idle maintenance pass
  (loop 2, the `curator-tick` job) digests mixed-authorship
  conversations — per-entry attribution keeps other users' turns out of
  the digest input; the versioned per-user skill store (feed, pins,
  content scan, undo); usage telemetry; internal runs hidden from every
  owner-keyed path; the curation-target contract (`@sigrun/memory-markdown`
  0.2.0 is the first target: per-user USER.md/MEMORY.md with hard limits
  and versions); notices + the undo view; hint-by-wrapping interception
  with provable authorship.
- A default `stream.timeoutMs` (5 minutes) via the boot settings getter:
  a model request with no explicit timeout could wedge forever (the
  OpenAI SDK's timeout is a headers-arrival deadline; a request that
  never reaches the provider never gets headers). Caller seam and
  settings file override field-wise.

### Fixed
- The seam host's pre-bind `curation.skills(user)`/`overlays(user)`
  returned a promise of the store instead of a store (loop 2's archive
  step read `.list` off a promise). A lazy store proxy now preserves the
  sync-store contract through the pre-bind window.

### Added
- `host.notify` lets extensions send validated explicit notices through
  every declared notifier, with optional conversation or declared-view
  deep links. Delivery is enqueued on the bounded side lane and is not
  gated by `notifications.runSettled`.
- Extension host job hooks: `host.jobs.get(id)` returns a read-only live-job
  projection with its effective owner, and `host.conversations.create({job})`
  stamps a validated job association in the session-meta creation commit.
  Unknown, retired, and owner-mismatched jobs are rejected before storage
  writes; creating the conversation does not create a job run or `lastRun`.

### Changed
- Ownerless and orphaned-owner jobs now run as the primary admin; their
  runs are no longer visible to every user. The effective owner is
  resolved live without rewriting the declared record.
- Reworded the `pi` manifest handling so it no longer implies pi
  extension compatibility. Sigrun reads `pi.extensions`/`pi.skills` only
  to LOCATE files and shares the SKILL.md format; it does not implement
  pi's `ExtensionAPI` (a pi extension's `registerTool`/`registerCommand`
  have no counterpart here). `docs/extending.md` gains a "Not pi
  extensions" section stating the two ABIs are unrelated and that only
  the skills layer transfers. The `.ts` skip and empty-entry warnings now
  say `pi manifest:` instead of `pi-compat:`.

## [0.4.2] - 2026-10-31

### Fixed
- `@sigrun/shared` and `@sigrun/tui` tarballs ship their `dist/`
  again (a missing `prepublishOnly` published four-file, dist-less
  packages since 0.2.0 — project installs quarantined `ext-gateway` on
  `shared/dist/live.js`).

## [0.4.1] - 2026-10-31

### Fixed
- Extension fleet entries pinned as `name@version` (e.g.
  `@sigrun/provider-bifrost@0.2.0`) install but never LOAD: the loader
  passed the versioned specifier to npm's module resolver, which does
  not resolve versioned specs — the extension quarantined at boot with
  "Cannot find package …". The resolver now retries the bare package
  name against the packages dir (the installed version already
  satisfied the declared range at install time). Found live on the
  0.4.0 homelab rollout.

## [0.4.0] - 2026-10-31

### Added
- Settings is a full page on the hash router (`#/settings`,
  `#/settings/<section>`) instead of a modal: back/forward work, the
  rail's Settings button navigates there and shows as active, and the
  server's path-form account-link `returnTo` is rewritten to the hash
  route at boot. (W1)
- API tokens in Settings: a self-service list, create (the token is
  shown once with a copy button and a ready-to-paste `sigrun attach`
  snippet), and revoke with a confirm. The CLI's in-pod admin path is
  unchanged. (W2)
- Python in the image's agent userland: `python3` with `venv` and `pip`,
  plus `uv` pinned exactly at `ghcr.io/astral-sh/uv:0.13.6` (`/uv` and
  `/uvx` copied to `/usr/local/bin`). Agents reach for Python constantly;
  installs go through venvs or uv, never global pip — no `pip install`
  runs in the image and Debian's EXTERNALLY-MANAGED marker stays. The
  image smoke now proves both plain and jailed: `python3 --version`, a
  `python3 -m venv`, `uv venv`/`uv run` as plain runs, and a per-user
  Landlock policy (built via `buildUserPolicy`, the same shape as the
  sandbox integration suite) under which `python3 -m venv` and `uv venv`
  both work inside the jail. Image size (actual, `docker image ls`):
  the additions grow the registry-mode build of this tree from 733MB to
  882MB on disk (155MB → 195MB content) — the isolated python3/venv/pip
  + uv 0.13.6 delta. Against the published 0.3.0 image (760MB) the
  total growth is 122MB, which also carries this branch's other tree
  changes; the 0.3.0 image predates them. (W7)
- Deployment-managed settings are visibly locked: the docker seeder
  writes `config/managed-settings.json` (the top-level keys it asserts),
  `SettingsResponse` gains `managed`, and both HTTP write paths refuse a
  PATCH that touches any managed key with `409 managed_by_deployment`
  (whole-request refusal). The webui renders managed fields read-only
  with a "Managed by deployment" note; the TUI form omits disabled
  fields from unrelated saves. A deployment without the file manages
  nothing (compose users get no lock, as intended). (W10)

### Changed
- The webui's empty state keeps the composer always live: a short
  welcome replaces "Select or create a conversation", and the first
  send creates the conversation (the server's default model), selects
  it, then submits the captured text; a failure leaves the text in the
  composer with the error shown. (W4)
- The transcript outline clamps inside the content box (an inner text
  element owns the line clamp) and fades long prompts; the full prompt
  stays available as the `title` tooltip. (W5)
- New wing brand mark (the "Gull Wing" candidate, user-picked from four
  mockups): `BrandMark`, `favicon.svg`, PNG/`apple-touch`/maskable app
  icons and a `manifest.webmanifest`; no runes anywhere. (W6)
- The conversation namer resolves its model per attempt —
  `settings.namingModel` (live) → the settled conversation's own agent
  model → skip without burning an attempt — instead of the boot-time
  default read once. An unserved model logs once per model id and does
  not count toward the attempt limit. (W8)
- Per-turn model meta in the webui now shows the bare chain name (the
  gateway-routed model) rather than the `chain/` display id, following
  provider-bifrost 0.2.0's wire-name change.

### Fixed
- `sigrun attach` (CLI/TUI) reaches forward-auth deployments: the token
  rides `Authorization: Bearer` on REST, the SSE stream, and both block
  transports (no CLI change was needed; the 401 failure mode now names
  the fix — `SIGRUN_TOKEN` is missing, expired, or revoked, with a
  pointer to Settings → API tokens). (W3)

### Breaking
- `@sigrun/provider-bifrost` 0.2.0 changes chain model ids from
  `bifrost/bifrost/<chain>` to `bifrost/chain/<chain>`, and requests now
  carry the gateway's bare chain name on the wire instead of the
  display id. Model references naming the old id shape must be updated
  (e.g. `settings.namingModel`, `server.defaultModel`, homelab
  `defaultModel`). (W9)

## [0.3.0] - 2026-10-29

### Added
- Parked-task visibility and recovery: pi-durable reports now reach logs,
  metrics, alerts, and job status, and administrators can list and retry
  parked tasks through the admin API.
- Proxy identity links with case-insensitive matching, plus typed-username
  normalization for `user add --proxy`, `link`, and `unlink`.
- An optional chart `networkPolicy`, `OnboardingState.proxyIdentity.subject`,
  the ProxyUnidentified screen, and the shared `./usernames` export.

### Changed
- Upgraded the Earendil runtime to pi-durable 1.4.0 (with chord and pi-ai
  1.4.0), including durable schedule sleeps, retry backoffs that survive
  restarts, and the crash-loop parked-task guard.
- Extension shutdown now runs in parallel within a fixed budget, with the
  chart's termination grace period matched to that budget.
- The loader quarantines extensions whose declared Earendil peer range
  excludes the host version instead of allowing an incompatible extension
  to fail later at runtime.
- `settings.compaction.modelOverrides` supports per-model compaction
  settings while preserving environment-over-file precedence.
- Proxy-only non-loopback boots refuse unvouched account creation, including
  login and code paths, and mint no setup code there. Login derives from the
  full email; boot sweeps orphaned proxy links, gates own-host peers, and
  throttles proxy diagnostics.

### Fixed
- CLI empty-string identity values now mean "unset".

### Breaking
- When `SIGRUN_API_TOKEN` is set, `SIGRUN_API_TOKEN_USER` must be a valid
  username key (the validation error includes a derivation suggestion). The
  user value is validated only when the token is set.

### Upgrade notes
- **One-way storage migration:** the first 0.3.0 boot migrates the SQLite
  durable schema to pi-durable 1.4.0's format. Before opening storage, boot
  writes a crash-consistent snapshot beside the database named
  `<storagePath>.pre-durable-schema-v<CURRENT>-<UTC stamp>.bak`. Snapshots
  are never deleted automatically. If a needed snapshot cannot be written,
  boot stops before migration. `SIGRUN_SKIP_MIGRATION_SNAPSHOT=1` is the
  emergency opt-out for an operator with an independent backup.
- **Rollback to 0.2.x (SQLite):** stop sigrun, restore the `.bak` over the
  database file, remove the database's `-wal` and `-shm` sidecars, then
  deploy 0.2.x. Anything committed after the upgrade is lost.
- **JSONL storage:** there is no snapshot because its schema does not
  change. A 0.2.x process nevertheless never resumes a task left `sleeping`
  by 0.3.0, so rollback can strand that task.

## [0.2.1] - 2026-10-28

### Added
- `GET /v1/meta` now reports the effective listener: `listener.host`,
  `listener.port`, and `listener.families` — the address families the
  live listener accepts, measured once at listen (the `::` wildcard
  probes both loopbacks and reports exactly the families that connect;
  a hostname bind reports the bound socket's family, never a concrete
  peer address). Additive wire field: pre-upgrade servers omit
  `listener`; clients consuming it must tolerate its absence.
- `SIGRUN_LISTEN_HOST` is now honored as the environment equivalent of
  the programmatic `serve({host})` option. One host value is resolved
  at the serving boundary (`options.host` → `SIGRUN_LISTEN_HOST` → `::`)
  and drives the bind AND both auth derivations — the previously split
  defaults (the boot auth derivation's independent env read, and the
  harness-side `0.0.0.0` fallback) are gone.
- Proxy-auth rejections (401) now log one sanitized `warn` per rejected
  request: the socket peer, the method, a short reason (`untrusted
  proxy`, `missing or wrong shared secret`, `missing identity header`,
  `untrusted identity source`), and the resolved route template — never
  tokens, cookies, identity-header values, query strings, or the full
  URL. Token-auth failures and successful proxy authentications stay
  silent.
- The normal core build now emits real `dist/blocks/**/*.d.ts`
  declarations, including the `dist/blocks/index.d.ts` named by the
  `@sigrun/sigrun/blocks` export. Pack/type-resolution coverage compiles
  an external consumer against those declarations; extension consumers
  no longer need an ambient block-module shim.

### Fixed
- Successful `PUT /v1/me/extensions/:slug/settings` writes now publish
  through the same post-commit settings-change seam as section saves:
  one per-user failure-fence clear, one observing-extension reconciliation,
  and the extension slug plus changed body keys. Invalid, unknown, and
  otherwise rejected writes publish nothing; repeated successful writes
  retain the existing notification semantics.
- `host.peekInteraction(conversationId, callId, context)`: a
  non-consuming interaction inspection read beside
  `snapshotInteraction`. It returns the same stored record projection
  (secret values stay masked) but NEVER touches the one-shot raw-secret
  delivery — safe to repeat for notifiers, outcome edits, and answer
  correlation. `snapshotInteraction` remains the ONLY read that merges
  and consumes an unread delivery, reserved for the interaction's
  owning extension; its first-read/second-read semantics are unchanged.
- `NotificationEvent` is now a discriminated union (shared base plus
  `interaction.pending` / `job.failed` / `run.settled` variants), and
  the `run.settled` variant carries a structured
  `outcome: { status: "answered" } | { status: "unanswered"; reason: string }`
  translated directly from the host event's existing `outcome`/`reason`
  (no second answer read, no inferred status). The other variants do
  not gain the field; exhaustive narrowing on `type` now typechecks.

### Fixed (continued)
- Restored per-user worker startup by placing the selected device paths
  under read-only Landlock rules. Their ordinary I/O works, while
  `/dev/shm` and writes outside workspace/home/tmp remain denied.
- Preserved composer text and attachments when a slow conversation-meta
  restore resolves after a local edit or clear. The interaction visual
  drain now covers required secrets and multi-step forms, and the visual
  e2e gate passes all 163 cases.

### Changed
- Settled-run notifications are truthful: an answered run keeps the
  `"Reply ready"` title, while an unanswered run (model error, abort,
  or a missing answer) is titled `"Run ended without a reply"` with the
  settle reason appended to the body — a failed run no longer
  masquerades as a ready reply. Recipient, dedup, and
  `notifications.runSettled` gating are unchanged.

## [0.2.0] - 2026-10-27
### Added
- Per-user extension surface (multi-user M2): lifecycle events carry the
  conversation owner; `stores.user(user)` provides per-user secrets,
  settings, and data/state/cache paths; `/v1/me` exposes self-service
  settings, secret-key management, and service status.
- Per-user tool publications (`perUserTools` and
  `host.tools.setUserTools`) with `<slug>@<user>` registry entries,
  owner-driven selection on create/fork/transfer and boot reconciliation.
  Every tool is wrapped with a committed-owner execution check: selection
  is convenience, not the authorization boundary.
- Per-user service processes (`userServices` and `services.connect`),
  launched under the user's own sibling jail policy with idle stopping,
  crash fencing, and lifecycle cleanup on deletion, quarantine, and
  shutdown. Settings sections can use `scope: "user"` for personal
  configuration.
- The §10.6 deletion sequence: transfer ownership and remove external
  identity access, stop per-user execution and tool entries, emit
  `userDeleted` while credential revocation remains possible, remove the
  record, then delete per-user credentials, settings, and cache. Data and
  state remain extension-owned.
- Multi-user login (M3b): extension-contributed `loginProviders` with
  core-owned, single-use state and callback routes; first-login setup and
  invite resolution with optional policy-gated auto-provisioning; webui
  provider sign-in; and self-service account links that are never silently
  re-pointed to another user.
- Gateway built-in: `@sigrun/ext-gateway` supervises channel adapters,
  with pairing and self-linking, group conversations, live responses,
  durable outbound delivery, agent tools, home notifications, and job
  delivery. Enabled by default; operators can disable it with
  `builtinExtensions.gateway: false`.
- Expiring, revocable browser sessions (`server.auth.sessionDays`, default
  30 days). A session can mint the user's API tokens; revoking it leaves
  those tokens independent.
- Stored groups per authenticating source, effective group-derived admin,
  and people-scoped group sharing. Groups refresh at the next login or
  validated proxy request. The separately shipped `@sigrun/oauth`
  package provides OIDC, GitHub, and Discord login providers.
- `@sigrun/oauth` is the fourth built-in extension. It loads by default,
  resolves from core's dependencies, and supports the same disable,
  replacement, and quarantine behavior as the other built-ins. The
  `builtinExtensions.oauth` toggle defaults to true and is restart-required.
- Chat blocks (U5): an entry and state family plus `show`/`update` tools,
  surface routes with authored change records, change notes before every
  turn admission, block answers as `InputEntry` turns, transcript
  rendering, and the webui and TUI transports.
- Interactions and ambient surfaces on block trees (U6): `{values}` answers
  with write-only secrets, channel renderers, and the ambient
  literal-content ruling.
- Images (U7): an HMAC-signed proxy, a rebinding-safe fetcher, an LRU cache
  with `sharp` conversion, and CSP headers.

### Changed
- Family versions move together to 0.2.0: `@sigrun/shared` 0.2.0
  (surface, block, interaction, ambient, and settings-section wire types)
  and `@sigrun/tui` 0.2.0 (chat-block transcripts, interaction and ambient
  rendering, settings forms).
- Retired persisted `groupAdmin` in favor of stored groups; its user-wire
  compatibility field is now derived and retained for one release.
- The execution jail (multi-user M1): per-user workers are Landlock-confined
  and multi-user fails closed when the boundary is unavailable.

### Fixed
- Kept the extension inventory available to non-admin clients while limiting
  service status projections to admins; quarantine now removes per-user
  tools as well as services.
- Preserved service crash fences across explicit stops and skipped the
  per-user selection sweep when no per-user extensions are configured.

### Security
- Added the opt-in Landlock kernel boundary suite for two-user execution
  isolation, with a hard ABI 6+ CI gate and explicit local skip reasons.
  Documented the isolation boundary, trusted-extension and resource limits,
  kernel requirements, OS-account setup, and proxy trust posture.
  The suite also covers abstract sockets, ptrace, worker lifecycle, IPC
  descriptors, and privileged-runner osUser switching; outside-jail controls
  distinguish Landlock denials from Yama or missing-capability conditions.

## [0.1.7] - 2026-10-24

*Correction (2026-10-28): the original entry omitted substantial scope
that shipped in this release — the U4 settings rebuild, the M3a
account-link store and routes, and the accompanying `@sigrun/shared` /
`@sigrun/tui` settings-surface work. Those entries are restored below;
the Service-migration claim is also corrected (adding a secondary
family while retaining the primary is an in-place patch, not a
recreate).*

### Added
- Core settings sections rebuilt on blocks (U4): one settings renderer
  for webui and TUI, extension-declared sections, a `/v1/settings`
  sections route, `pendingRestart` with an admin restart route,
  live/restart metadata for every core key, label search, and
  `settings.changed`/`onSettingsChanged`. The shared and TUI packages
  carry the matching settings-surface and settings-form work (live
  surface revs, default-on toggle handling, roster-driven tool
  defaults, walk-based search).
- Account links (multi-user M3a): the core account-link store plus
  routes to list and remove an account's linked external identities.

### Fixed
- The deploy entry binds the dual-stack wildcard (`::`) instead of the
  IPv4-only `0.0.0.0`. On a dual-stack pod whose Service is IPv6-only
  (`ipFamilies: ["IPv6"]` — the default shape on a cluster with an
  `fd00::/8` ClusterIP range) the EndpointSlice advertises only the
  pod's IPv6 address; the gateway dialed it, got connection-refused,
  and answered `upstream connect error or disconnect/reset before
  headers. reset reason: remote connection failure` while the
  IPv4-loopback probes kept the pod Ready. `::` accepts both families
  (`net.ipv6.bindv6only` is 0 on Linux), matching every other workload
  in a dual-stack cluster. The reported listen line brackets the host
  (`http://[::]:3000`).

### Changed
- The chart's main Service is `PreferDualStack` over `[IPv6, IPv4]`,
  so it advertises both pod addresses regardless of the cluster's
  default family. Adding a secondary family while retaining the
  primary is an in-place patch (`spec.ipFamilies` gains the new
  family); only changing the PRIMARY family requires recreation
  (`spec.clusterIPs` is immutable). *Corrected 2026-10-28: the
  original entry claimed every conversion is a recreate.*
- `sigrun run` (workstation mode) still binds `127.0.0.1` only.

## [0.1.6] - 2026-10-24
### Added
- Extension surfaces: typed block rendering, actions and uploads, live
  transports, per-principal access control, and web/TUI surface views.
- Web and TUI block renderers: content, charts, collections, forms,
  navigation, live updates, and extension-provided views.

### Fixed
- The container image preserves the core, webui, shared, and TUI build
  output paths and compiles the TUI workspace. The published 0.1.5 image
  flattened core `dist/` into `/app`, so `node dist/index.js` could not
  start. CI now smoke-checks the built image's runtime layout.

### Changed
- `@sigrun/shared` 0.1.2: surface and block-instance wire types.
- `@sigrun/tui` 0.1.1: extension surfaces and the full block renderer.
- Fastify 5.12.7 and `@fastify/static` 10.1.7 address the server's
  header-validation and static-file path/authorization advisories; the
  patched `fast-uri` transitive releases address its URI-normalization
  advisories. `npm audit` reports zero vulnerabilities.

### Security
- Agent shells no longer inherit sigrun's environment. pi-durable's bash
  tool ran every command with the server's full environment, so an
  agent's `env` printed `SIGRUN_API_TOKEN`, `SIGRUN_PROXY_SECRET` and
  provider keys. Every command now gets an allowlist (`PATH`, `HOME`,
  `TMPDIR`, `LANG`, `LC_*`, `TZ`, `TERM`, `USER`, `LOGNAME`, `SHELL`,
  `NPM_CONFIG_CACHE`, `SSH_AUTH_SOCK`) plus whatever the calling tool
  sets. `NODE_ENV=production` from the image no longer reaches agent
  shells, so an agent's `npm install` installs devDependencies again.
  The bundled MCP extension's stdio servers get the same allowlist.

## [0.1.5] - 2026-10-23
### Added
- The image + chart release pipeline: multi-arch (amd64/arm64) container
  image on `ghcr.io/sigrun-ai/sigrun` and the Helm chart on GHCR's OCI
  registry (`charts/sigrun/sigrun`), built and published by GitHub Actions
  on `v*` tags. CI builds and lints both on every PR and main push.
- The chart manages the extension fleet declaratively: a `sigrun:` values
  block seeds `settings.json` (fleet list + chart-owned keys re-asserted
  every boot, per-slug extension settings seed-once), passes secret
  references through envFrom (never values), and installs deploy-time
  tools (kubectl/helm/talosctl/flux/k9s) hash-cached onto persistent
  storage via an initContainer.
- Deploy hardening: non-root image with a privilege-drop entrypoint (uid
  1000 default, overridable), agent userland baked in (ripgrep, fd, jq,
  git, sqlite3), hardened compose defaults (read-only rootfs, caps
  dropped, init, no-new-privileges).
- Block-set foundation (`@sigrun/shared/blocks`): the canonical block
  tree wire types, ops, text rendering and transport shared by server and
  clients.
- Gateway core seams: extension `channels` contribution field, the
  gateway engine field with lifecycle + shutdown ordering, host-surface
  conversation ops, upload/readFile/models/commands, interaction answer
  attribution (`interactionSettled`), group-derived admin persisted for
  host-side checks, and deliver-targets on prompt jobs
  (`@sigrun/shared/live` narrows the live-doc wire).

### Changed
- `@sigrun/shared` 0.1.1: new `./live` and `./blocks` export subpaths
  (all 0.1.0 subpaths unchanged).
## [0.1.4] - 2026-10-22
### Added
- The version is visible where operators look: the boot log line (`sigrun
  v0.1.4 listening on …`) and `GET /v1/meta`'s new `version` field; the webui
  Settings → General renders `sigrun vX · pi-durable vY`.

### Fixed (webui round 2)
- Live turns render IN PLACE: thinking / tool calls / text stream where they
  occur and stay there (no fold-to-bottom relocation); settled turns default
  to the interleaved chronological view (the header toggle flips to grouped).
- The transcript auto-scrolls with new content while at the bottom and holds
  position when the user scrolls up.
- The token meta label splits input / cache / output.
- User prompts no longer wrap absurdly early — the bubble's percentage
  max-width resolved against a shrink-wrapped ancestor (~157px); capped in
  absolute `60ch` now.

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

