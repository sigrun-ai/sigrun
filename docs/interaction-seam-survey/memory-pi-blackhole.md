# pi-blackhole — Memory-Architecture Inspection
Source: https://github.com/k0valik/pi-blackhole

## 1. ARCHITECTURE

Hybrid: **deterministic structural compactor (VCC, regex extraction, zero LLM)** merged with **observational memory (OM): LLM-distilled facts via three background workers**. No vector store, no external service — storage is (a) custom entries appended to the pi session JSONL itself ("session ledger") and (b) per-session pending JSON files at `~/.pi/agent/pi-blackhole/<sessionId>-pending.json` (`src/om/pending.ts:99-113`, with `.stale.json` backup = crash-replay).

Record shapes (`src/om/ledger/types.ts:24-42`):
```ts
type Observation = { id: string /* 12-hex */; content: string; timestamp: string;
                     relevance: "low|medium|high|critical"; sourceEntryIds: string[]; tokenCount: number };
type Reflection  = { id: string; content: string; supportingObservationIds: string[]; tokenCount: number };
```
Ledger custom types: `om.observations.recorded`, `om.observations.unanchored`, `om.reflections.recorded`, `om.observations.dropped` (tombstones), `om.folded` (types.ts:7-11). Folding applies first-valid-wins + tombstones into a `FoldedLedger` (active vs dropped views). Provenance is first-class: every observation cites `sourceEntryIds` back into the raw transcript.

## 2. CAPTURE — memory-worker architecture (DECISION-CRITICAL)

Three background workers, **each a full LLM agent-loop with tool-calling** (not single calls): Observer → Reflector → Dropper, run sequentially by `runConsolidationPipeline()` in `src/om/consolidation.ts`.

- **Observer** (most frequent): compresses the new conversation chunk (capped `observerChunkMaxTokens`, oldest-first prefix; overflow drains in bounded batches in-run) into timestamped observations via the `record_observations` tool (array of `{content, relevance, sourceEntryIds}`, optional `complete: true` early-terminate). Timestamps derived from cited entries, never trusted from the model.
- **Reflector** (runs at `reflectAfterTokens`): distills observations into durable reflections via `record_reflections` `{content, supportingObservationIds[]}`; strict validation (unknown support id rejects the batch — coverage evidence must not be inflated).
- **Dropper** (pool pressure): LLM proposes `drop_observations {ids, reason}`, but a **deterministic ranker** re-orders and hard-caps (`maxDropsAllowed` interpolates 10%→50% of non-critical pool by fullness; skip entirely below 10% fullness). Coverage tiers (`none/partial/strong` = # reflections citing the id, recomputed every run, never persisted) decide drop safety.

**Triggers** (`index.ts:83-84`): `registerConsolidationTrigger` on `agent_start` + `turn_end` (token-threshold gates, not every turn); auto-compaction on `turn_end` + `agent_end`; VCC content injected via the `session_before_compact` hook (`src/hooks/before-compact.ts`). Manual mode buffers in pending files, flushed by `/blackhole`.

**Idempotency/dedup**: record identity is a content hash (`src/om/ids.ts hashId`); unknown `sourceEntryIds` are filtered not rejected; cursors (`PipelineCursor`: initial/recorded/empty/error/skipped/not_due) persisted to pending file, validated against branch on reload. Fail-closed contracts: a run that ends without a clean stop throws with `discardedCount`, cursor never advances over unproven content; partial coverage commits only a verified head-anchored cited prefix (`partialCoverageId`), unanchored facts stored as coverage-inert `unanchoredObservations`. Per-worker model fallback chains (primary → stage fallbacks → base → session model, ≤10 resolutions) with persisted cooldowns (`pi-blackhole-cooldown.json`), plus measured prompt-budget fit checks and shrink-to-fit batching.

**Session binding**: everything is keyed to the pi session id / branch (pending files per sessionId, cursors validated against branch, prompt-cache scoped per run via forwarded sessionId).

## 3. RETRIEVAL

One unified `recall` tool (`src/tools/recall.ts`) + `/blackhole-recall` command; model-invoked, not auto-injected. Inputs: `#N` entry expansion, `#N:path` / `#N:text` drill-down paging, 12-hex memory-id → ledger source evidence, free-text **BM25** (k=1.2, b=0.75, ~70 stopwords, rare-term weighting — no embeddings), regex, `mode:file|touched`, `scope:all` across session lineages. Expanding an entry auto-attaches related observations/reflections. Hard response budget `recallResponseMaxChars` default 48k chars (~12k tokens) with line-boundary paging continuation markers. OM facts also reach context via the compaction preamble ("visible projection" of the ledger, relevance-tiered selection with recency scoring) — that injection, not recall, is the steady-state memory surface.

## 4. STATE + LIFECYCLE

Durable: session JSONL (ledger entries + full transcript — compaction never deletes, append-only), pending files, cooldown file. In-process: worker phases, status-bar timers. Forgetting = Dropper tombstones (active-pool removal only; ledger history + sources retained) plus compaction trimming of the visible projection (bounded by `observationsPoolMaxTokens` with safety cap `selectPriorObservations`). Session boundaries: cross-session corpus exists (`src/project-recall/corpus.ts` walks past-session JSONL + pending buffers, cwd/git-root-scoped) powering `/blackhole-export` markdown of distilled memory; schema evolution handled by tolerant folding (old builds read new branches as unknown custom types). No explicit schema version field — migration via config merge + permissive type guards.

## 5. SEAM SURFACE

Registers: 1 tool (`recall`); ~10 commands (`/blackhole` + settings/changelog/cleanup/om-on/off, `/blackhole-memory` status/view/full, `/blackhole-recall`, `/blackhole-export`); hooks (`agent_start`, `turn_end`, `agent_end`, `session_before_compact`, turn-cap hooks); and a **statusline widget** (`src/om/status-bar.ts`, `ctx.ui.setStatus("blackhole")`: O/P/X token gauges + worker spinner/✓ events). Host-facing human reads: status bar, `/blackhole-memory` token counters, changelog viewer. Best doc-family fit: observations/reflections-with-provenance are already durable per-record documents living in a shared transcript — they map naturally to durable doc-family records; but they are session-scoped, not cross-conversation first-class objects.

## 6. EXTERNAL DEPENDENCIES

LLM APIs only (worker models, any provider; per-worker fallback chains, cheap/free models recommended). No embedding models, no external services, no binaries; BM25 + regex are stdlib. Fully offline-capable except the LLM worker calls (and compaction itself is always offline).

## 7. VERDICT

(a) **~45%** — the seam covers durable records + panel rendering of OM facts, but the core value here is the *worker pipeline* (agent-loop distillation, cursors, coverage contracts) and transcript-anchored recall over raw session JSONL, which a doc-family + generic panel neither hosts nor exposes; recall is intrinsically private per-session machinery.
(b) **"coverage/provenance contract"** — observations citing `sourceEntryIds` + reflections citing `supportingObservationIds`, with a derived recomputed coverage tier gating destructive drops — a primitive (provenance links + derived safety evidence on durable records) that approvals/interactions/ambient do not have, and the piece a sigrun memory seam would most want to generalize.
