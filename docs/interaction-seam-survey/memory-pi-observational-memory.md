# pi-observational-memory — Memory-Architecture Inspection
Source: https://github.com/elpapi42/pi-observational-memory

## 1. ARCHITECTURE

Model: a **session-transcript-native observational ledger with LLM-distilled tiers** — not a vector store, not a summarizer-only design. It is the "Mastra observational memory" pattern reimplemented as a pi extension (README credits line). There is **no external store**: the ledger lives *inside pi's own session file* as `custom` entries appended via `pi.appendEntry(customType, data)` (`src/hooks/consolidation-trigger.ts:63-64,570,632,730`), and memory state is always *re-projected* by folding ledger entries on the current branch (`docs/concepts.md`: "In V3, the ledger is the source of truth"; `src/session-ledger/projection.ts`). So persistence = pi's durable session JSONL; no sqlite/files/JSON sidecar (only opt-in debug NDJSON under `observational-memory/debug/<session-id>.ndjson`, README config table).

Two record types (`src/session-ledger/types.ts:22-40`):
```ts
type Observation = { id: string /* 12-char hex */, content: string, timestamp: string,
  relevance: "low"|"medium"|"high"|"critical", sourceEntryIds: string[], tokenCount: number };
type Reflection = { id: string, content: string, supportingObservationIds: string[], tokenCount: number };
```
Observations = timestamped factual events with **source-entry provenance**; Reflections = durable conclusions citing supporting observation ids. Ledger entry payloads are `{observations, coversUpToId}` / `{reflections, coversUpToId}` / `{observationIds, coversUpToId}` (types.ts:42-56), and compaction writes an `om.folded` details record `{type, version: 1, fullFold, observations, reflections, foldThroughEntryId?}` (types.ts:58-74) — the only schema-versioned artifact (version: 1).

**What it observes**: raw conversation entries (`message`, `custom_message`, `branch_summary` — `src/session-ledger/recall.ts:8 SOURCE_TYPES`) serialized in bounded chunks (`observerChunkMaxTokens`, overflow = head/tail excerpt) into an *observer sub-agent* LLM run that emits observations; a *reflector* distills reflections; a *dropper* prunes the active observation pool. It does not observe tool calls or UI events separately — only the conversation transcript stream.

## 2. CAPTURE

Triggers are **token-clock-driven background workers**, not per-turn writes: `pi.on("turn_end")` + `pi.on("agent_start")` + `pi.on("agent_settled")` launch consolidation when `observeAfterTokens` (10k) / `reflectAfterTokens` (20k) clocks are due (`src/hooks/consolidation-trigger.ts:303-328`); `agent_settled` also drives proactive auto-compaction (`src/hooks/compaction-trigger.ts:29`). Writes are the worker results (observation batches), plus compaction-time `om.folded` via `session_before_compact` (`src/hooks/compaction-hook.ts:291-306`).

Idempotency/dedup: the `coversUpToId` marker per record entry defines an observation **frontier** — re-derivation scans ledger entries and only processes past the latest coverage index (`src/session-ledger/progress.ts:41-58`, used by projection). So crash-replay is safe: ledger entries are append-only and the frontier prevents double-capture. A "deliberate-empty backoff" skips observer re-fires over the same span (`src/runtime.ts:124-128 observerEmptyBackoff`). Capture is bound to the **pi session/branch** (`ctx.sessionManager.getBranch()`; session id only for debug logs — `consolidation-trigger.ts:142,338`), i.e. branch-scoped, not cross-session.

## 3. RETRIEVAL

- **Automatic injection**: at compaction, the hook renders visible memory (reflections + chronological observations, bounded by `compactionSummaryMaxTokens`) as the new compaction summary — no model call when prepared memory exists (`compaction-hook.ts:159-198`; README "Fast compaction"). Shape: markdown header + `## Reflections` / `## Observations` lines with `[id] timestamp [relevance] content`.
- **Model-invoked tool**: `recall` (one tool, `src/tools/recall-observation.ts:432-481`) takes exactly `{id: 12-hex}` — **not semantic search**; it re-derives the observation/reflection plus its raw `sourceEntries` from the branch ledger and returns them, with `status active|dropped`, missing-source reporting, and collision flags. Prompt guidelines explicitly forbid using it as browse/search.
- **Ranking/embeddings**: none. Ordering is chronological + relevance labels; size bounds are token budgets (pool max/target 20k/10k, worker memory 16k) not similarity.

## 4. STATE + LIFECYCLE

- **Durable**: everything — ledger entries live in pi's session file and survive compaction (folded entries stay in the ledger; projections are re-folded on demand). `/om:view full` vs `/om:view` distinguishes full ledger state from the currently-visible post-compaction projection (drift shown as `+N/-N` in `/om:status`, `src/commands/status.ts:46-48`).
- **In-memory only**: `Runtime` fields — in-flight guards, abort controller, backoff state, last worker errors (`src/runtime.ts:110-130`).
- **Forgetting**: the dropper prunes the *active observation pool* toward `observationsPoolTargetTokens` after each successful reflection, balancing age/relevance/reflection-coverage (`none|partial|strong` coverage tiers as evidence); drops remove observations from active memory, never from ledger history (`OM_OBSERVATIONS_DROPPED` entries). Compaction full-folds under pool-max pressure.
- **Session boundaries**: memory is branch-local; nothing crosses sessions (V2→V3 migration explicitly says "no rollback continuity"). Schema versioning: `om.folded` carries `version: 1`; ledger entry shapes are validated by guards (`isObservation` etc.).

## 5. SEAM SURFACE

Registers with pi: 3 lifecycle/event hooks (`agent_start`, `turn_end`, `agent_settled` — consolidation + compaction triggers), 1 compaction hook (`session_before_compact`), 1 agent tool (`recall`), 2 commands (`/om:status`, `/om:view [full]`), and UI notifications (`ctx.ui.notify`, toggleable for routine worker progress). **No statusline widget, no panel, no server route.**

Host-facing human surfaces: `/om:status` (counts, drift, progress clocks, pool pressure, last worker errors) and `/om:view` (rendered memory, clipboard copy). Nothing maps naturally to a durable per-record *document family* — records are already durable in the session ledger and branch-scoped; the closest analogue is the `om.folded` details blob. This extension would keep private-in-ledger storage; the host surface worth exposing is the status/view rendering.

## 6. EXTERNAL DEPENDENCIES

- **LLM calls for memory workers** (observer/reflector/dropper): session model by default, or `config.model`/`fallbackModel` (any provider, incl. local llama.cpp — README sizing notes). This is the only external dependency.
- No API keys of its own, no embedding models, no native/binary deps; peer deps are pi packages (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`). Offline-capable except that worker LLM runs need a reachable model (a local server satisfies this); recall/projection/commands are fully offline ledger reads.

## 7. VERDICT

- (a) **Durable doc-family + generic panel coverage: ~35%.** The core insight — capture via a write-boundary pass plus recall against a durable record store with provenance — maps, but this extension's records are branch-scoped session-ledger entries with a fold/drop lifecycle and compaction replacement semantics, not host-owned per-record documents; a doc-family seam would force an awkward second store, and what it really needs from the host is compaction-hook + turn-clock triggers, which approvals/interactions seams don't model.
- (b) **Most valuable missing primitive: a session-boundary/compaction hook contract** — a host seam that lets an extension observe and *replace/augment what survives compaction* (plus a token-clock trigger), i.e. lifecycle capture tied to context evolution rather than discrete human decisions. Secondary: a provenance-backed recall primitive (id → source records) is genuinely novel versus approvals/interactions' flat records.

**Special-attention note (observational model)**: what it observes is *only the conversation transcript*, chunked and sent to a cheap worker LLM that emits structured event sentences; what it stores is those sentences (observations, with source-entry ids) plus LLM-distilled durable facts (reflections, citing observation ids), all appended into pi's own session ledger and folded on demand — the "observational" novelty is (1) writes happen continuously *before* compaction, (2) every memory line is traceable to raw source entries via ids, and (3) forgetting is coverage-driven pool pruning while history stays immutable.
