# Sigrun roadmap after 0.1

Status: planning. Date: 2026-10-21. Order is the user's: UI blocks first; the rest in no fixed order, except where a dependency below forces one.

Each item names what it needs from core, the seam it uses, and its first step. Every extension lives in its own repo (`sigrun-ext-<name>`), is published as `@sigrun/ext-<name>`, declares `@sigrun/sigrun` and the host modules as peer dependencies, and imports its contract types from `@sigrun/sigrun/extension` (and builders from `@sigrun/sigrun/blocks` once UI blocks lands).

## 1. UI blocks (first)

- **Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md`.
- **Plans:** `docs/superpowers/plans/2026-10-19-ui-blocks-u0…u7`.
- **Needs:** sigrun published as `@sigrun/sigrun`. The release plan's Task 3 renames `sigrun/blocks` to `@sigrun/sigrun/blocks` throughout, and `HOST_RUNTIME_MODULES` gains `"@sigrun/sigrun"`.
- **Order:**
  1. U0;
  2. then U1, U2 and U3 Tasks 1–4 in parallel;
  3. then U3 Task 5;
  4. then U4, U5, U6 and U7.
- **Unblocks:** every extension below that shows UI (questions, warden, to-do, kanban), because U6 makes interaction and ambient records block trees and U3 gives extensions views and panels.

## 2. Pi-as-installed parity

These are the extensions on the user's own pi install. Porting them makes a sigrun install feel like that pi.

### 2a. User questions (port of `@juicesharp/rpiv-ask-user-question`)

- **Needs:** U6 (interaction trees, `{values}` answers) and U1/U2 (the multi-question stepper, `choice` with `preview` and `allowOther`). All are already specified for exactly this port (ui-blocks §9.1).
- **Seam:** an `ask_user_question` tool whose execution writes an interaction and waits for its answer (the same blocking pattern as `fixture-gate`).
- **First step:** a short spec mapping rpiv's schema (1–4 questions, 2–4 options, `multiSelect`, `preview`) onto the interaction tree, and its timeout and abort behaviour.

### 2b. Warden (port of pi-warden: permission and safety)

- **Needs:** U6, and the `beforeTool` hook pi-durable already provides (codemode's inner calls go through it, as `interaction-decide.test.ts` proves).
- **Scope for the first cut:**
  - rule-matched tool gating (allow, deny, confirm through an interaction) for `bash`, `write`, `edit` and MCP tools;
  - the verdict stack as an ambient surface with `quiet` folding;
  - an audit log.
- **Out of the first cut:** pi-warden's completion challenges, loops, recall and lessons. Those are agent-discipline features; decide separately whether they belong in sigrun at all.
- **First step:** survey pi-warden's rule format and decide whether sigrun reads the same config file (portable rules) or its own.

### 2c. To-do (port of `@juicesharp/rpiv-todo`, or one of the forks surveyed 2026-10-08)

- **Needs:** U6 for the ambient checklist above the composer; U3 optionally, for a panel with the full list.
- **Seam:** a `todo` tool writing a conversation-scoped document family. The ambient `collection` uses `status` (with `spinner` for in-progress) and `deps` for `blockedBy`.
- **First step:** pick the base (rpiv-todo's dependency graph versus pi-checklist's 10-task cap), and decide whether lists survive forks (`fork: "current"`, like chat blocks).

### 2d. Honcho memory (port of `@agney/pi-honcho-memory`)

- **Needs:**
  - the memory seam (2026-10-15 spec): `runSettled` for capture, conversation lifecycle events, and idle workers with `wakeOn` for deriving;
  - jobs (W4) for periodic dream and summary passes, as a `task` action;
  - extension secrets (W3) for the Honcho API key.
- **Doesn't need UI blocks.** It can run in parallel with UI blocks; a settings section can follow U4.
- **Decide:** peer naming (one Honcho peer per sigrun user, mapped from the principal); fork continuity (Honcho `session.clone` versus a fresh session, the memory-seam spec's open choice); and whether `sigrun-ext-memory-markdown` and Honcho can be installed together.
- **First step:** a spec covering the peer and session mapping, and the recall tool and prompt section.

### 2e. Compression: VCC and/or OptChat

- **Needs:** pi-durable's `CompactionHooks.beforeCompact` (decline, or return a summary). That is the only compaction seam (pi-parity spec slice 4); pi-vcc's per-model thresholds need a policy override that pi-durable 1.3.0 doesn't expose.
- **Doesn't need UI blocks.**
- **Decide:** VCC (deterministic summary, overrides compaction thresholds) versus OptChat (replaces compaction with a sliding view). OptChat needs a context-shaping hook pi-durable may not have; check before choosing. A per-model threshold may need an upstream pi-durable change; file it if so.
- **First step:** a spike: implement a VCC-style `beforeCompact` summary in an extension and measure against the default summarizer on a long fixture conversation.

### 2f. Knowledge (port of pi-knowledge)

- **Needs:**
  - tools (`knowledge_add`, `knowledge_search`, `knowledge_symbol_search`, …);
  - jobs with a `task` action for background indexing and refresh;
  - extension settings for the embedding model;
  - U3 optionally, for a knowledge-base browser view.
- **Constraint:** pi-knowledge uses native modules (onnxruntime, tree-sitter, better-sqlite3). The extension must install inside the sigrun image (glibc, non-root, arm64 included). Check the prebuilt-binary story for every native dependency on both architectures before committing.
- **First step:** a native-dependency feasibility check in the published image on amd64 and arm64.

## 3. Hermes parity

### 3a. Kanban

- **Needs:**
  - U3: a view with `collection(display: lanes)`, moves, `sharedData` boards, watchers;
  - W1: `owner`/`sharing` and `accessOf` through `host.access`;
  - W5: `host.conversations.create/submit`, to open a card as a conversation or dispatch an agent;
  - W4 jobs, for a dispatcher.
- **Reference:** hermes-webui's kanban view (sizing doc H2), including boards, the assignee and tenant filters, bulk status changes and the dispatcher.
- **First step:** a spec; the sizing doc's H2 and S1 sketches are its starting UI.

### 3b. Curator

- **What it is:** hermes' background curator, which reviews recent activity and curates memory and skills while the user is away.
- **Needs:** the memory seam's idle workers (`wakeOn` conversation idle, ruling 12: no `every`), plus jobs with a `task` action for scheduled passes, and a memory extension to curate (2d or memory-markdown).
- **Decide:** whether curated changes apply directly or arrive as an interaction for approval (U6); the latter matches sigrun's "human decides" posture.
- **First step:** a spec scoped to one curation job (for example, merging duplicate memory notes) before generalising.

## Dependency summary

| item | UI blocks needed | other core needs |
|---|---|---|
| User questions | U1/U2, U6 | — |
| Warden | U6 (U3 optional) | `beforeTool` |
| To-do | U6 (U3 optional) | — |
| Honcho | — (U4 for settings) | memory seam, jobs, secrets |
| VCC / OptChat | — | `beforeCompact`; possibly upstream pi-durable |
| Knowledge | — (U3 optional) | jobs, settings; native deps in the image |
| Kanban | U3 | sharing, host APIs, jobs |
| Curator | U6 if approval-gated | idle workers, jobs, a memory extension |

So Honcho, compression and the knowledge feasibility check can start while UI blocks is still in flight, in separate sessions and repos.
