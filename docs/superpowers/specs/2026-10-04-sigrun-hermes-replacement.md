# Sigrun: Hermes Replacement — parity extensions and cutover

**Status:** Draft v1
**Date:** 2026-10-04
**Consumes:** the core spec (`2026-10-04-sigrun-core.md`) — its surface contracts and
milestones. Nothing here may change a core contract; extensions consume as-is.
**Goal:** restore every hermes capability the user actually uses, then **scale hermes to 0**
(the cutover gate). This spec's exit is hermes decommissioned.
**Context:** `CONTEXT.md` §1–2 defines what hermes provided and what the assistant is for.

---

## 1. What this spec is

The core (spec A) ships a working assistant with degenerate defaults. This spec builds the
extension packages that turn it into *user's* assistant — the ones matching
hermes's used functionality — and defines the gate at which hermes is retired.

Non-goals: improvements hermes never had (spec C), the-work-fabric-scrubbed integration (spec C), multi-user
(spec C).

## 2. Extensions

| Extension | Core surface | Purpose | Parity source |
|---|---|---|---|
| `sigrun-ext-bifrost` | provider-contributor | Gateway routing, VK, chain catalog as the model list; default model `glm-5.3-flash` | hermes gateway config (2026-09-25 migration) |
| `sigrun-ext-honcho` | MemoryBackend | User peer config: observe user+assistant, dialectic recall, injection | hermes honcho block (same workspace `user`, same observation policy) |
| `sigrun-ext-web-research` | tools | searxng + crawl4ai via their HTTP APIs | hermes web tools |
| `sigrun-ext-cron` | scheduled jobs | Port of the hermes crontasks actually in use | hermes crontasks |
| `sigrun-ext-agentic-maintenance` | tools | media-tools/agentic-maintenance/agentic-maintenance/agentic-maintenance/agentic-maintenance | hermes toolsets, 1:1 |

Notes:

- **Memory:** each user = a honcho peer; sigrun = a honcho AI peer. Observe rides the
  `afterResponse` hook per the core contract; the observe-record schema is fixed by the
  core's degenerate implementation, so this extension maps records → honcho observations.
  Recall = honcho dialectic/hybrid query; `section()` = the dialectic injection hermes
  performs today. **Replaces** the degenerate backend (the stable-placeholder section means
  the prompt surface doesn't fork when it lands).
- **Servarr safety:** all mutating agentic-maintenance tools declare `replay: "unsafe"`; the core's
  M1 crash battery establishes the replay semantics before any of these ship.
- **Web research:** searxng (keenable + braveapi engines) and crawl4ai as tools, not MCP —
  thin HTTP clients in the extension.

## 3. Deployment deltas

- Chart `sigrun` gains: SealedSecrets for honcho, bifrost VK, searxng, crawl4ai; the
  extension list in the boot ConfigMap.
- In-cluster endpoints (already deployed): honcho
  (`http://honcho-app-api.honcho.svc.cluster.local`), bifrost
  (`https://llm-gateway.tailnet.example.test`), searxng, crawl4ai.

## 4. Lanes

Lanes are independent in implementation order. The cutover gate is a property of the whole
lane set, not any single lane.

### Lane B1 — Memory (`sigrun-ext-honcho`) — *first, user requirement*
- `MemoryBackend` → honcho: observe mapping, hybrid-recall tool, dialectic section.
- Parity with current hermes honcho values.
- **Exit:** "what did we discuss about X last week" works; search works from the composer.

### Lane B2 — Research (`sigrun-ext-web-research`)
- searxng + crawl4ai tools.
- **Exit:** "go find out about X" works from the composer.

### Lane B3 — Cron + agentic-maintenance (2 days)
- `sigrun-ext-cron`: port the crontasks actually used (durable by construction); webui cron
  panel reading the read-only `GET /v1/jobs` enumeration added with this lane (per core §5).
- `sigrun-ext-agentic-maintenance`: 1:1 port of hermes toolset logic; unsafe-replay semantics verified
  against a side-effect-free dummy before any agentic-maintenance tool ships.
- **Exit:** one concrete scheduled job runs on schedule and survives a pod restart; one
  concrete agentic-maintenance action works end-to-end (observation, not a parity vibe).

### Lane B4 — Bifrost provider
- Small; can land any time after the core's contributor contract exists (it is the
  contract's first proof and may even land during core M1).
- **Exit:** model picker lists the gateway chains; `SIGRUN_MODEL` override works.

## 5. The cutover gate

**Cutover gate (hermes → 0) = B1 + B3 exited, plus B2 if daily research matters before
decommissioning (expected — CONTEXT §2 calls research the most common use).**

When it passes:

1. A final data handoff: anything in hermes's stores the user wants retained (session
   history, crontask definitions) is exported before shutdown. **hermes's honcho memory
   needs no migration** — same workspace, same peers; sigrun continues observing where
   hermes stopped.
2. hermes namespace scaled to 0 or deleted; PVCs retained as archive.
3. hermes-specific repo cruft (flux-app-llm hermes/, hermes-pantheon chart, hermes-webui
   deployment) evaluated for deletion or archival.
4. `herdr --remote` and any direct-hermes habits re-pointed to sigrun-webui.

## 6. What this spec does not do

- Improvements over hermes (spec C) — including discord ingestion, forgejo/cards, calendar,
  household context. Calendar access and household-context tools are named in CONTEXT §2 as
  wanted-but-not-yet; they are **spec C** items (documented deferral, not silent drops).
- Twill/kanban integration (spec C).
- Multi-user (spec C).
