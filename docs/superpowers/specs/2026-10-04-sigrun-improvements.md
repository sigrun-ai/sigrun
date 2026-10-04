# Sigrun: Improvements — what hermes never had

**Status:** Draft v1
**Date:** 2026-10-04
**Consumes:** the core spec (`2026-10-04-sigrun-core.md`) and, for L4, the hermes-replacement
spec's landed state. No core-contract changes without a core revision.
**Goal:** the capabilities CONTEXT.md names that hermes does not provide today, plus the
the-work-fabric-scrubbed integration that makes sigrun's extensions reusable by other agents. This spec runs
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
- **No the-work-fabric-scrubbed dependency.** This is a pure tool extension on the core's tools surface.
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

### C5 — Twill integration (the fabric consumer phase)

Two decoupled pieces, both gated on the-work-fabric-scrubbed's own milestones:

- **C5a — Workspace swap** (gated on the-work-fabric-scrubbed T1: registry + resolve + Workspace kind): the
  core's `workspaceService` swaps static config for `registry.resolve(name,
  agentLocation)`; the wrapper signature is unchanged (core §4.4). Skill discovery extends
  to remote workspaces once the workspace is remote — this is where the core's skills v1
  scope lifts.
- **C5b — Cards/kanban** (`sigrun-ext-kanban`, gated on the-work-fabric-scrubbed's Card kind — currently
  deferred to the-work-fabric-scrubbed T5, **not** T1): claim/create/update cards; the "idea → repo + spec +
  card" demo; sigrun surfaces a pi session's Card `claimed_by` link so the assistant can
  point at ongoing coding work. Core App A's away-from-desk steering link lives here.
- Corrections inherited from review: sigrun's core/B extensions exercise **no** the-work-fabric-scrubbed
  object kinds today (the earlier "every kind except AgentProfiles" claim was false);
  Card consumption waits for the-work-fabric-scrubbed's Card revival.
- **Exit:** workspace resolves through the registry (C5a); a card created from the composer
  appears in the-work-fabric-scrubbed and is claimable by pi (C5b).

### C6 — Persona selection (per-conversation)

The core ships a single `SOUL.md` persona. This adds: `personas/` directory convention,
selection stored per conversation, the composer picker appearing when the list has more
than one item (the core's picker convention).

### C7 — Fallback provider (`sigrun-ext-direct-<provider>`)

A second provider contributor (e.g. direct ollama) so a bifrost outage doesn't take
sigrun's chat and jobs dark. Deliberately not in the MVP (core App B.20); buildable at any
time as just another contributor. Pair with a core-side consideration: gateway outage
detection in `GET /v1/meta` so the degraded state is visible.

### C8 — Richer context management (vcc-style)

Beyond the core's tuned compaction defaults: strategy extensions over
`CompactionHooks.beforeCompact` (e.g. selective retention, structured summaries).
The hooks are the seam; no core change needed.

## 3. Sequencing

C1 and C2 have no external gates — they can start any time after the core ships.
C3 needs honcho (spec B1). C4 is independent. C5 tracks the-work-fabric-scrubbed's milestones (T1 for C5a, T5
for C5b). C6/C7/C8 are small, unscheduled fillers.

## 4. What this spec does not do

- Anything that blocks the cutover (spec B owns hermes retirement).
- Multi-user/household auth (a separate future spec if wanted).
- Generalized "honcho-for-things" object memory (seam noted in the the-work-fabric-scrubbed spec; separate
  project).
- Write-side Discord (inbound ingestion only, C3).
