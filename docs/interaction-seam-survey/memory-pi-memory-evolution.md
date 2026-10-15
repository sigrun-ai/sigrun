# pi-memory-evolution — Memory-Architecture Inspection
Source: https://github.com/btnalit/pi-memory-evolution

## 1. ARCHITECTURE

Hybrid: **LLM-distilled claim store + lexical (non-vector) retrieval + durable SQLite job scheduler**. No vector store, no embedding service, no external retrieval client — ranking is local `Intl.Segmenter` word features, exact path/filename literals, IDF weighting, and a curated bilingual (en/zh) concept map (`docs/design.md` "Conversation-aware recall"; `src/memory/search.ts`, `src/memory/retriever.ts`).

Backing store: **one SQLite database** (WAL + FULL synchronous, private file perms), built-in Node/Bun sqlite (`src/memory/sqlite.ts:15` lines total — no external DB dep), at `~/.pi/agent/agent-suite/memory-evolution/` (respects `PI_CODING_AGENT_DIR`; README "Data and limits"). Tables (`src/memory/memory-store.ts:113-162`): `memories` (id/scope/hash/data JSON), `sources` (evidence + job state/lease/attempt/backoff), `blocked` (origin-qualified suppression hashes), `events` (before/after audit), `feedback_receipts` (idempotency), `metadata` (schema marker, v7), `model_calls`, `route_health`, `recovery_notices`.

A record (`DurableMemory`, `src/memory/memory-store.ts:31-53`):

```ts
export type MemoryKind = "fact" | "preference" | "decision" | "project_state";
export interface DurableMemory {
  id: string; kind: MemoryKind; content: string;
  scope: string;              // capture origin (canonical cwd), NOT a recall boundary
  sourceEntryId: string; createdAt: string; updatedAt: string; revision: number;
  layer: "durable" | "pinned";
  status: "provisional" | "confirmed" | "forgotten" | "conflicted";
  suppressedHashes?: string[]; searchTerms?: string[];   // model-written bilingual aliases
  reinforcedAt?: string;      // last confirmation; decay runs from this, not updatedAt
  evidence?: Evidence;        // host-assigned provenance (never model-generated)
  feedback?: MemoryFeedback;
}
```

Model output per source is a `Claim[]` (`src/memory/extractor.ts:7-14`): `{kind, content, replaces?, searchTerms?}` — max 16 claims of 4–800 chars per call.

## 2. CAPTURE

Three hook-registered triggers (`src/index.ts:118-165`):
- `session_compact` — sanitized compaction summary captured as a `summary` source (`src/index.ts:120-126`).
- `agent_end` — per user message: explicit feedback cues (`feedbackCue`) go straight to receipts; `learningIntent`-gated prose captured as `user` sources. Work turns with linked tool operations produce a bounded `progress` source (`src/adapter/progress-observation.ts`: ≤8 observations, ≤28KB evidence, completion=interrupted on failed final response).
- No per-turn/tool-call writes; **assistant/tool text never becomes a memory directly** — the LLM distiller is the only writer of claims.

Distillation (`src/memory/evolution.ts`, one model call per source via `ctx.modelRegistry.complete`): prompt requires evidence-grounded claims; the host pre-filters ≤32 existing claims *the source actually mentions* (≥0.4 vocabulary containment) as the only replaceable candidates; output is schema-validated JSON, malformed batches rejected, refusals (pinned/cross-origin/stale) recorded transactionally.

Idempotency/dedup: capture IDs are content-fingerprinted (`user:<sessionId>:<ts>:<hash>`); exact forgotten content is hash-blocked per origin (`blocked` table); `feedback_receipts` give replay-safe feedback; job state is durable in `sources` with lease/attempt/backoff so crash-replay resumes from the DB, not transcript rescans. Capture is session-scoped in ID but recall is global across sessions/directories (scope is provenance only).

## 3. RETRIEVAL

Two paths:
1. **Automatic injection** — `before_agent_start` (`src/index.ts:151-158`): builds a query from the prompt + ≤6 recent user texts (≤2048 bytes each, `src/adapter/session-context.ts`), selects via `retrieveMemories`, and appends a digest to the system prompt — **no model call**. Digest (`src/injector/digest.ts`): ≤3 claims within 2,048 UTF-8 bytes, JSON rows with id/kind/status/origin/evidence-basis/aging flag/≤400-byte excerpt, plus a trust-guidance header.
2. **Model-invoked tool** `memory_recall` (read-only, `query` string ≤512, includes dormant records, same 3-claim/2048-byte bound) for mid-task lookup.

Ranking: two-sided gating (current-focus coverage ≥0.45, or the prompt *names* the topic via rare exact/concept/alias features, df ≤ max(3, 2%)); ≥3 focus features need 2 matches; literal constraints must match; relative cutoff 75% of best score; then freshness/evidence/feedback multipliers. No recency fallback, no minimum result count, no filler injection. Max context cost per turn ≈2KB — tightly bounded.

## 4. STATE + LIFECYCLE

Durable: all memories, sources (with pending/failed job state), events, feedback, schema marker (v7, migrations from 2–6, unsupported versions rejected before DDL). In-process only: recall diagnostics snapshots, serial task chain, recovery timer.

**Evolution/forgetting (the scheduler, precisely)** — `src/memory/quality.ts:75-99` + `docs/design.md` "Persistence and lifecycle":
- **Dormancy horizons** per kind: project_state 7d, fact 180d, decision 365d, preference 730d. Past the horizon a record becomes `dormant` — *not deleted*: excluded from automatic injection, still recallable via explicit tool/`search`, still replaceable so later evidence can revive or retire it. No kind is ever auto-deleted.
- **Gradual freshness decay**: exponential half-life per kind (project_state 3d, fact 60d, decision 120d, preference 240d) with floors (0.5–0.7) as a freshness multiplier in ranking; pinned records exempt. Both run from `reinforcedAt` (last confirmation), not `updatedAt` — confirmation refreshes evidence date without granting replacement authority.
- **Job scheduler**: `session_start` starts a recovery timer (every 15s after the previous check ends, `RECOVERY_POLL_MS`) draining persisted pending/failed sources; leases (attempt budget + 30s = 150s default) prevent two processes stealing work; expired leases → `interrupted` failure with backoff 1m→5m→15m→1h (+≤20% jitter), pause after 3 output / 5 generic failures, per-source caps (4 calls/2 models/300s) and shared ceilings (20 reservations/hour) all transactionally reserved; provider/model cooldowns in `route_health` with cross-provider fallback allowlist. Shutdown returns cancelled jobs to pending without failure-count penalty and closes SQLite. Undo is event-sourced with before/after validation; deletion is tombstones, never physical erasure ("Forget/undo is not secure erasure").

## 5. SEAM SURFACE

Registers with pi:
- **Hooks**: `session_start`, `session_compact`, `agent_end`, `before_agent_start` (system-prompt append), `session_shutdown` (all in `src/index.ts`).
- **Tool**: `memory_recall` (read-only).
- **Command**: `/memory` with 17 subcommands — list/search/show/learning/explain/evolve/import/archive-legacy/undo/feedback/history/correct/forget/pin/unpin/conflict/resolve/adopt.
- **UI**: `ctx.ui.notify` toasts (deduped via `recovery_notices`), no panel/statusline widget.

Host-facing human reads: `/memory status` (schema, model, route chain, budgets, capture origin, poll interval), `/memory learning` (last capture diagnostics), `/memory explain` (last automatic recall snapshot — actual digest bytes, lifecycle counts, top scored candidates, capped at 8KB). Records themselves would map naturally to a **durable per-record doc-family** (id/kind/status/evidence/provenance/history is exactly an interaction-record shape); the `sources` job ledger + scheduler state are genuinely private extension machinery.

## 6. EXTERNAL DEPENDENCIES

None external: no API keys (uses pi's active model + auth via `ctx.modelRegistry.complete`, `src/adapter/pi-api.ts`), no embedding service, no vector DB, SQLite is the runtime's built-in. Fully offline-capable for *storage and recall*; **learning requires a live model** (quota-billing, cross-provider fallback configurable via `recovery.json` policy file). Node 22.19+ (or Bun). Subagent processes (`PI_SUBAGENT_AGENT_ID`) are skipped.

## 7. VERDICT

(a) **Durable doc-family + generic panel coverage: ~40%.** The claim records themselves (kind/content/provenance/status/evidence/events) fit a per-record durable doc-family well, but the load-bearing machinery — the `sources` job ledger with leases/backoff, routing budgets, and the 15s scheduler — is private, high-frequency, and record-*unlike*; and the recall path is a whole-store index scan (fine for SQLite, wrong shape for doc-family documents), so a generic panel would cover `/memory status`/`explain` nicely but not the retrieval engine.

(b) **Most valuable missing seam primitive: an asynchronous background-work ledger seam** — a host-owned durable record of *pending/leased/failed background jobs with attempt counts, backoff timestamps, and lease ownership* (plus a "wake me on session_start" timer grant). Approvals cover one-shot human decisions and interactions cover turn records; nothing in the existing seams expresses "crash-recoverable deferred work that survives process restarts and competes across sessions," which is exactly what this extension had to build privately in SQLite.
