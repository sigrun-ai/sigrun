# @pify/memory — Memory-Architecture Inspection
Source: https://github.com/pifydev/memory

## 1. ARCHITECTURE

**Model: transcript-index + curated markdown store, not a summarizer/vector/knowledge-graph.** Two tiers of plain markdown the user can read, edit, and commit:

- Global: `~/.pi/agent/memory/` — `MEMORY.md` (durable facts) + `daily/YYYY-MM-DD.md` (activity log keyed to LOCAL calendar day) + `recovery/` (undo records). `PI_MEMORY_DIR` / `PI_CODING_AGENT_DIR` override (`src/paths.ts:9-25`).
- Project: `.pi/memory/MEMORY.md` per repo, gated behind an explicit once-per-project consent dialog (`extensions/memory.ts:123-160`, `src/consent.ts`), persisted in `<agentDir>/pify-project-consent.json`; `PIFY_TRUST_PROJECT=1` for headless.

Optional opt-in third layer: **session notes** — an LLM observer distilling the conversation, stored as branch-local entries that die with the session (`src/observe.ts:1-30`).

**Backing store: files only.** The FTS5 index (`node:sqlite`, `:memory:`) is built in-process per search and invalidated on writes; Node 22 hosts fall back to a zero-dep paragraph scan (`src/fts.ts:13-16`, `src/search.ts:1-14`).

**Record shape:** a single markdown bullet, not a typed object. Lessons embed the category inline: `- [failure] npm ci fails behind the proxy, use --offline` (`src/lessons.ts:19-25`, `formatLesson`); daily bullets carry a time prefix (`- HH:MM text`, `src/store.ts:73-75`). Structured shapes exist only for sidecars — `RecoveryRecord { id, timestamp, removals[{file,text}], replacements?[] }` written as JSON (`src/types.ts:41-46`, `src/store.ts:147-152`), and the session-note ledger entry `ObservationEntry { notes: Observation[], coversUpToId }` (`src/observe.ts:51-55`).

## 2. CAPTURE

Three trigger classes, all deliberate:

1. **Explicit agent tool** `memory_write` — user asks, or a correction should stick. Hook is `pi.registerTool({ name: "memory_write", ... })` (`extensions/memory.ts:584-628`). Secret gate on every write (`assertNoSecrets`); multi-line input joined to one bullet.
2. **Automatic LLM observer (opt-in)** — fired on `pi.on("agent_end")` when ≥ `OBSERVE_AFTER_CHARS` (default 24,000) new unobserved chars have accumulated (`extensions/memory.ts:404-461`, `src/observe.ts:37-44`), plus a second independent trigger on `pi.on("session_before_compact")` for any non-trivial slice (≥2,000 chars) about to be folded away (`extensions/memory.ts:462-485`). Fire-and-forget, never awaited by a turn; runs capture model/modelRegistry synchronously because ctx goes stale across compaction (`extensions/memory.ts:433-443`). Notes are secret-scanned before recording (`extensions/memory.ts:395-399`) and deduped against prior notes (`dedupeObservations`).
3. **Never automatic at shutdown** — explicit design promise: "no surprise model call at shutdown that summarises your session" (README "Why"; consolidation only on `/memory consolidate`).

**Idempotency/crash-safety:** concurrent writers protected by OS-level `appendFileSync` instead of read-modify-write (`src/store.ts:30-57`); `forget` writes the recovery record BEFORE rewriting any file, so a crash always leaves undo on disk (`src/store.ts:160-190`); injection dedupe checks `buildContextEntries()` (what the model sees) not the raw branch, so resume/reload/compaction don't double-inject (`extensions/memory.ts:547-553`, `src/inject.ts:47-60`); observer coverage marker (`coversUpToId`) advances only on successful parse — a failed run retries the same stretch (`extensions/memory.ts:399-403`). **Not tied to a session id** — durability is file-based, session notes are branch-local.

## 3. RETRIEVAL

- **Automatic injection, not model-invoked:** a hidden custom message `{ customType: "memory-context", content, display: false }` sent once per session via `pi.sendMessage` at `session_start`, and RE-sent at `session_compact` if absent from context (`extensions/memory.ts:526-583`). This survives compaction without any model call — the block is re-attached after pi's summariser folds it, verified 3/3 vs 0/3 control (README, `test/live/compact-survival.mjs`).
- **Injection shape** (`src/inject.ts:62-113`): `<memory>` block with an anti-instruction preamble (prior-context-not-instructions, stale-replay fence, evidence-wins), sections: global (cap 6,000 chars), project (6,000), today's log (3,000), yesterday's log (3,000), recalled lessons, notes (only post-compaction), plus a one-line archive overview of older daily logs. Block tags neutralised so hand-edited files can't break out.
- **Lessons recall:** `[failure]`/`[correction]` bullets recalled unprompted, newest-first (dated daily entries before undated), cap 8, 30-day window for dated ones (`src/lessons.ts:65-70`, `recallLessons`).
- **Model-invoked recall:** `memory_search` tool — BM25/FTS5 ranked (OR'd quoted terms), limit default 8 max 25 (`extensions/memory.ts:672-698`); scan fallback does substring matching. No embeddings anywhere.
- **Human recall:** `/memory search|read|notes` (`extensions/memory.ts:742+`).
- **Max context cost:** ~6k + 6k + 3k + 3k chars + lessons (8 bullets) + notes (≤40 × 240 chars = ~9.6k), bounded by caps in `src/types.ts:50-51` and `src/observe.ts:44-47`.

## 4. STATE + LIFECYCLE

- **Durable:** MEMORY.md tiers + daily logs + recovery JSON records + consent file — all on disk, all markdown/JSON, no schema version. Ecosystem-compatible layout (jayzeng `pi-memory` files carry over).
- **Session-scoped:** session notes (branch-local entries, `coversUpToId` cursor); they "live and die with the session" — promotion to durable memory is an explicit user act (`src/observe.ts:7-14`). In-process only: the FTS index, the `observing` flag, `lastObserveError`, the per-session consent memo (reset rules at `session_start:529-536`).
- **Compaction handling:** re-injection at `session_compact` (model-free); pre-compaction observe pass to salvage the fold.
- **Decay/forgetting:** no automatic decay; user-driven `memory_forget` (pattern substring, recovery-record-first) + `memory_restore`; `/memory consolidate <target>` asks a model to merge duplicates/superseded entries but only proposes — refuses if it invents entries, empties the file, or drops >60%; preview + confirm + recovery snapshot (`extensions/memory.ts:186-256`, `src/consolidate.ts`). 30-day window only gates lesson recall, not the files.
- **Session boundaries:** resume/reload/restart handled by context-entry dedupe; observer flag reset on non-reload starts; stale-ctx avoidance by value capture.

## 5. SEAM SURFACE

Registers with the pi harness (`extensions/memory.ts`):

- **5 tools:** `memory_write` (scope global|project|daily, text, category?), `memory_read`, `memory_search`, `memory_forget`, `memory_restore` (`extensions/memory.ts:584-739`).
- **1 command:** `/memory` with subcommands search|read|consolidate|restore|notes|observe on|off|skill — the human-facing surface (`extensions/memory.ts:742+`). Status line shows paths, sizes, active search engine, and the *computed* injection verdict for the project tier (`injected` / `NOT injected: refused` / `not yet asked` / no file) — an honest host-facing status readout.
- **1 skill promotion path:** `/memory skill <name> <query>` writes confirmed lessons into pi's `<agentDir>/skills/<name>/SKILL.md` (capped 64KB, never overwrites foreign skills).
- **Events:** `session_start`, `session_compact`, `session_before_compact`, `agent_end` — plus `pi.sendMessage` for the hidden memory block.
- **No UI widgets/panels/statusline**; no host-rendered records. Everything user-visible is markdown files + the `/memory` command.

**Doc-family mapping:** the durable tiers (MEMORY.md, daily logs, recovery records, consent ledger) are exactly durable per-record documents — recovery records in particular are structured JSON with ids, timestamps, and payloads, a natural fit for an approvals/interactions-style doc-family; the consent ledger (per-project decisions, remembered, headless-refused) is essentially an interaction record already. Session notes and the in-process FTS index are the genuinely private extension state that a doc-family seam should NOT have to own.

## 6. EXTERNAL DEPENDENCIES

- **Runtime:** Node ≥22.19 (package.json engines); FTS5 via `node:sqlite` needs Node 24+/Bun, silent scan fallback otherwise. **Zero npm dependencies** beyond the pi host (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`).
- **Model calls:** observer + consolidation use the session's own configured model through pi's model registry (`src/model-call.ts`) — no separate API keys; AbortSignal timeouts (120s observe / 180s consolidate) fail loudly instead of wedging.
- **No external services, no embedding models, no binary deps.** Fully offline-capable (search included). Secret gate is pure regex/value-matching against session env (`src/secrets.ts`).

## 7. VERDICT

**(a) Durable doc-family + generic panel coverage: ~80%.** The durable half is almost ideal for the seam — memory entries, recovery records, and the consent ledger are per-record durable documents a doc-family could own directly, and `/memory`'s status/injection-verdict readout is a natural panel. The gap: this extension's value hinges on the *markdown-file* contract (user-editable, committable, ecosystem-compatible) and on conversation-coupled auto-injection/re-injection semantics that the seam would need to let the extension keep privately; session notes (branch-local, transcript-coupled) have no doc-family analogue and shouldn't get one.

**(b) Most valuable missing seam primitive: a host-owned, compaction-surviving injection channel — i.e., a seam API that lets an extension (1) declare a context block that must be re-attached automatically after every compaction/session-resume with context-presence dedupe (`isInjectedInContext` over `buildContextEntries()`), and (2) read post-compaction injection status back for a human-facing verdict.** Approvals/interactions/ambient cover pending decisions and status surfaces, but none own the "durable bytes re-enter the model context after the harness folds history" lifecycle, which is the load-bearing mechanism here (and is measured, not assumed: 0/3 vs 3/3 survival test). Secondary primitive worth noting: crash-safe append-only writes with recovery-record-first deletion (idempotency across crash-replay), which sigrun's interaction records could adopt for any extension that mutates durable docs.
