# Sigrun: Improvements — what hermes never had

**Status:** Draft v1
**Date:** 2026-10-04
**Consumes:** the core spec (`2026-10-04-sigrun-core.md`) and, for C3, the hermes-replacement
spec's landed state. No core-contract changes without a core revision (C6b names one).
**Goal:** the capabilities CONTEXT.md names that hermes does not provide today. This spec runs
**after** (or alongside) the cutover; nothing here blocks hermes retirement.

---

## 1. What this spec is

Spec B restored parity. This spec is the wishlist — each item is something the user
explicitly wants that hermes never provided. Ordered by user value, not implementation
convenience.

## 2. Items

### C1 — Research that turns into work (`sigrun-ext-forgejo`)

The highest-value item. CONTEXT §2: "If finding out about X reveals a tool to build or
software to update, the assistant should open a ticket in Forgejo and hand the actual work
to pi."

- Tools: create repo, file issue, read PR/comment, commit spec files — against the Forgejo
  API.
- Flow: "turn this into a ticket" from the composer → Forgejo issue with the research
  findings attached → the pi side picks it up (existing herdr/forgejo workflows).
- **No card-system dependency.** This is a pure tool extension on the core's tools surface.
- **Exit:** "find out about X, then open a ticket for it" completes in one conversation.

### C2 — Away-from-desk attention (completion notifications)

The webui on a phone is the away surface (core App A). What hermes never had: knowing when
a long-running task finished without watching.

- v1 shape: browser notifications on submission completion, driven by the existing watch
  stream (Notification API, no server push infra). The core dropped hermes's
  service-worker plumbing deliberately; this re-adds the *feature* as a thin client-side
  concern.
- **Exit:** a cron-ish long task completes while the phone screen is off; a notification
  arrives.

### C3 — Ambient awareness: Discord ingestion (`sigrun-ext-discord`)

CONTEXT §2: catch up on what was missed, gauge community impressions, track events.

- Read-only ingestion: channels as **synthetic honcho peers** with ingested transcripts.
  "Catch me up on #model-talk" is a dialectic query. Ingestion writes to honcho only — it
  does **not** inject into user conversations (an explicit decision this spec records).
- Channel plumbing cribbed from `pi-chat`'s message handling (reply-to, formatting,
  attachments) minus its VM machinery.
- **Exit:** "catch me up on #model-talk" returns an accurate digest of the last 24h.

### C4 — Household chores: calendar + context

CONTEXT §2 names calendar access and household context as the "wants more of this" class
that hermes never had. Spec B correctly deferred them here.

- `sigrun-ext-calendar`: read (then write) calendar access — likely a CalDAV client against
  an existing server (Radicale/Baïkal if present, else scope down to read-only ICS).
- Household context: a small structured store (documents) the assistant can read/write —
  the seam is the core's document model; shape decided when this lane starts.
- **Exit:** "what's on the calendar this weekend" works.

### C5 — Dynamic workspaces + cards/kanban

Two decoupled pieces, both unscheduled future work:

- **C5a — Workspace swap:** the
  core's `workspaceService` swaps static config for a dynamic resolver; the wrapper
  signature is unchanged (core §4.5). Skill discovery extends
  to remote workspaces once the workspace is remote — this is where the core's skills v1
  scope lifts.
- **C5b — Cards/kanban** (`sigrun-ext-kanban`):
  claim/create/update cards; the "idea → repo + spec +
  card" demo; sigrun surfaces a pi session's card `claimed_by` link so the assistant can
  point at ongoing coding work. Core App A's away-from-desk steering link lives here.
- Corrections inherited from review: sigrun's core/B extensions exercise **no** card-
  system object kinds today (the earlier "every kind except AgentProfiles" claim was false);
  card consumption waits for a card system to exist.
- **Exit:** workspace resolves dynamically (C5a); a card created from the composer
  is claimable by pi (C5b).

### C6 — Persona selection (per-conversation)

The core ships a single `SOUL.md` persona. This adds: `personas/` directory convention,
selection stored per conversation, the composer picker appearing when the list has more
than one item (the core's picker convention).

### C6b — Per-conversation extension selection

Core §4.1 makes v1 extension selection boot-time-global (conversation-stored names exist
only for resume-tolerance). This lane adds the deliberate per-conversation selection: an
extension-set field on `POST /v1/conversations/:id/configure`, per-conversation resolution
of the enabled set, and the webui picker (same picker convention). **Requires a core
revision** — core §5 fixes `configure()` to exactly `model` and `thinking`, so the
configure surface widens under that revision, not by extension. Lands with or after C6 —
both are per-conversation selection over a stored conversation value.

### C7 — Fallback provider (`sigrun-ext-direct-<provider>`)

A second provider contributor (e.g. direct ollama) so a bifrost outage doesn't take
sigrun's chat and jobs dark. Deliberately not in the MVP (decision 20, `2026-10-02-sigrun.md`
App B); buildable at any time as just another contributor. **Pairs with the core's
`health.providers` meta field** (core §5) so the degraded state is visible.

### C8 — Richer context management (vcc-style)

Beyond the core's tuned compaction defaults: strategy extensions over
`CompactionHooks.beforeCompact` (e.g. selective retention, structured summaries).
The hooks are the seam; no core change needed.

### C9 — Approval-policy configuration

The core ships the conservative approvals policy as a fixed default (write/exec prompt;
read-only pass). This lane adds per-conversation policy configuration: read/write of the
approval-policy document via the configure/planning surface, and the webui affordance.
Lands with the extension-selection lane (C6b) or independently.

## 3. Sequencing

C1 and C2 have no external gates — they can start any time after the core ships.
C3 needs honcho (spec B1). C4 is independent. C5 is unscheduled future work (C5a then
C5b). C6/C7/C8 are small, unscheduled fillers.

## 4. What this spec does not do

- Anything that blocks the cutover (spec B owns hermes retirement).
- Multi-user/household auth (a separate future spec if wanted).
- Generalized "honcho-for-things" object memory (seam noted in the improvements spec;
  separate project).
- Write-side Discord (inbound ingestion only, C3).
