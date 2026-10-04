# Context: why sigrun exists

> Companion to the sigrun specs in `docs/superpowers/specs/` (the *what*):
> `2026-10-04-sigrun-core.md` (core, zero external dependencies),
> `2026-10-04-sigrun-hermes-replacement.md` (parity extensions + cutover),
> `2026-10-04-sigrun-improvements.md` (post-hermes capabilities). The original
> `2026-10-02-sigrun.md` is superseded and retained as decision history.
> This document is the *why* — what the assistant is for, what it replaces, and
> the constraints that shaped it. Written 2026-10-02.

---

## 1. What sigrun replaces, and why

user has run `hermes-agent` (in-cluster, via the `hermes-pantheon`
chart) plus `hermes-webui` as a personal assistant. The assistant is genuinely
useful — the memory system especially — but the software has become a bad fit:

- **It is heavy.** The local config is ~800 lines. After the 2026-09-25
  gateway-only cleanup, the overwhelming majority of it is dead: bedrock
  discovery, docker sandbox variants, personalities, Mixture-of-Agents presets,
  per-provider fallback plumbing, image-generation providers. The features that
  actually get used are a handful of tools, cron, memory, and the webui.
- **The webui runs a second agent loop.** hermes-webui imports the hermes code
  and re-implements the agent loop independently of the primary CLI agent. Two
  loops, two state paths, one codebase that has to keep them in sync.
- **The workspace went away.** When hermes ran locally in the same WSL instance
  as pi and opencode, everything shared a filesystem, and code written by pi was
  immediately visible to hermes. Moving hermes into the cluster bought
  always-on availability and lost that adjacency.
- **It is not a good coding agent.** Attempts to use it as one produced poor
  results. Coding stays in pi.

Sigrun keeps the parts that earn their place (memory, scheduled jobs, the
agentic-maintenance/media-tools tools, web research, the webui as the primary surface) and discards
the rest by construction.

---

## 2. What the assistant is actually for

Stated by the user, in their words:

- **Research.** The most common use. "Go find out about X." Which naturally
  escalates:
- **Research that turns into work.** If finding out about X reveals a tool to
  build or software to update, the assistant should open a ticket in Forgejo and
  hand the actual work to pi — not attempt the coding itself.
- **Steering coding work from away from the desk.** Not doing the work, but
  being able to answer a pi session's questions or prompt it to continue while
  on a phone or laptop. Heavy lifting stays in pi inside herdr.
- **Routine maintenance.** Existing cron jobs against the media-tools/agentic-maintenance/agentic-maintenance
  ecosystem. The user wants *more* of this and keeps not getting to it —
  calendar access, household context, and similar assistant-ish chores.
- **Ambient awareness.** Ingesting data sources such as Discord logs so the user
  can catch up on what they missed, gauge community impressions of new models,
  and track events. Read-only to start.
- **Memory.** Honcho is described as "incredibly valuable." Parity with the
  current honcho behavior is a v1 requirement, not an enhancement.
- **Household multi-user, eventually.** "An agent that can assist my entire
  household has clear value," with guardrails around data sharing. Authelia is
  already the IdP, so this is an SP problem, not an identity problem.

---

## 3. Constraints that shaped the design

### 3.1 The workspace problem

The single most concrete complaint. A shared workspace between agents was
valuable and the cluster migration broke it. But running a whole-home assistant
from a personal workstation is not a good answer either — the workstation sleeps,
and the assistant should not.

Resolution: the assistant's *core* lives in-cluster (always on, durable), and the
*workspace* is resolved rather than fixed. Day one uses a static workspace
configuration; the swap to dynamic resolution through the `the-work-fabric-scrubbed` registry is a
wrapper change, not a rewrite. The interaction surfaces (webui now, TUI and
audio later) attach to the in-cluster core from anywhere over the tailnet.

Precedent the user liked and lost: `opencode serve` on the workstation with
`opencode attach` from any of three machines, working over the tailnet. That
serve/attach model is exactly what a durable harness gives back — one long-lived
process owning state, thin clients attaching.

### 3.2 pi-durable is the substrate

Chosen because it is the only option that makes the "second agent loop" problem
structurally impossible: the loop lives in the harness, and every surface
(webui, TUI, cron trigger, future channels) is a client submitting to and
watching conversations. It also brings crash survival and idempotent
submissions (requestId dedup — exactly-once-across-crash semantics are
pending M1 verification), which the current stack lacks.

Known constraints accepted at choice time:

- Experimental; the API changes between releases (`1.0.2` at spec time;
  pinned exactly, with a captured-schema drift fixture and an upgrade drill
  in the core spec).
- One process owns a storage file at a time; no cross-process locking. Matches
  the single-harness design anyway.

Resolved since the choice (2026-10-04 probes against the pinned package):
image input **works** (base64 inline in submissions — verified live), and the
async-approval mechanism works across crash+restart (`beforeTool` + durable
memo — verified live). These were open questions at choice time; they are now
verified facts recorded in the core spec's Appendix C.

### 3.3 Keep pi's philosophy

The user's stated preference: **minimal core, well-defined interfaces for
extensibility, and an ecosystem.** Their pi install is the proof it works — 19
packages, each doing one thing, composed into a workflow.

So sigrun is: a small harness, a webui, and a set of extensions that are
individually replaceable. Not a platform.

### 3.4 The webui is the primary surface

Called out twice in the design conversation. The plan is to take hermes-webui's
UX shamelessly (three-panel layout, composer footer, tool cards, context ring)
while replacing everything beneath it with thin client calls to the harness API
— which is why the stack decision in the spec is *port the frontend, gated on a
60% reuse measurement*, with a rebuild as the documented fallback.

### 3.5 Cross-agent tools belong in the fabric, not the agent

Hard-won: the assistant needs a work ledger that spans repositories and
outlives any particular agent. If the kanban is a hermes plugin, moving to a
different assistant means re-doing the integration. So cards live in `the-work-fabric-scrubbed`
(skuld), and sigrun is just a client — as pi will be, as anything else will be.

---

## 4. What sigrun deliberately does not do

- **Coding.** pi + herdr own that. Sigrun creates the ticket and the card.
- **Reinvent remote shells.** Workspace sharing is the-work-fabric-scrubbed's job; sigrun consumes
  it.
- **Provider management.** Bifrost already routes models with virtual keys,
  budgets, and failover chains. Sigrun points at one VK.
- **Multi-user UI in v1.** The `owner` field exists; the auth flow does not.
- **Write-side Discord, voice, generalized object memory.** Deferred, each with
  a documented seam so it can be added without redesign.

---

## 5. Relationship to the-work-fabric-scrubbed

Two projects, deliberately separate repos:

- **the-work-fabric-scrubbed** — the agent-agnostic fabric (registry, resolve/route protocol,
  adapters, cards).
- **sigrun** — an assistant that happens to be the fabric's first large
  consumer.

The decoupling test: if the-work-fabric-scrubbed disappeared, sigrun would still run, with static
workspace config. If sigrun disappeared, the-work-fabric-scrubbed would still be a coherent
product for pi and the workplace scenario. Neither is a feature of the other.

---

## 6. Names

**sigrun** — a Norse valkyrie; a messenger/attendant figure. Chosen over:

- **iris** — reads as the lesser-known female counterpart to hermes; the user
  disliked the implicit gender-flip construction.
- **argus** — the watcher; also the guy hermes slew, which is an odd name for
  hermes's replacement.
- Various scribe/messenger deities (thoth, seshat, ogma, muninn) — all already
  taken in the agent/AI space, several by direct competitors.
- Norse fits: the bifrost gateway already lives in that mythology.

**skuld** — held in reserve for the work-item side of the fabric ("that which
shall become").
