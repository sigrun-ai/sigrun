# openlore — Memory-Architecture Inspection
Source: https://github.com/clay-good/openlore

## 1. ARCHITECTURE

Not a conversation-memory extension at all — a **code-index memory**: a persistent structural knowledge graph (call graph, types, tests, specs, IaC, decisions) built by one-time static analysis, served over a local HTTP daemon. The memory layer proper ("code-anchored memory", v3.x) stores durable facts *anchored to code symbols*, plus an architectural-decision store with a full lifecycle pipeline. Backing store is plain JSON files under `.openlore/` in the repo (`memory-store.ts:8` — "CRUD for .openlore/memory/notes.json"; decisions in the decision store with atomic write+rename and CAS sequence counters, `memory-store.ts:52-90`, `store.ts:54-59`). Quarantine-on-corruption: torn JSON is moved aside, never silently emptied (`memory-store.ts:44-53`).

A memory record (`src/types/index.ts:1137-1165`):

```ts
interface AnchoredMemory {
  id: string;              // 8-char id from content + anchors (dedup)
  kind: 'note';
  content: string;
  anchors: StructuralAnchor[];  // nodeId, stableId, symbolName, filePath, contentHash
  recordedAt: string;
  tags?: string[];
  type?: MemoryType;       // closed set, never inferred
  validFromCommit?: string;    // bitemporal: HEAD SHA at record time
  invalidatedAt?: string;  supersedes?: string;  // lifecycle
}
```

Decisions (`types/index.ts:856+`) add title/rationale/consequences, status draft→consolidated→verified→approved→synced/phantom, `sessionId` provenance, disposition fields.

## 2. CAPTURE

Capture is **model-invoked only** — no auto-capture hooks. The `remember` tool (`src/cli/commands/mcp.ts:2241`, handler `src/core/services/mcp-handlers/memory.ts`) persists a note when the agent explicitly calls it; `record_decision` triggers optional LLM consolidation in the background ("by commit time, decisions are already verified" — `docs/mcp-tools.md:206,289`). The Pi extension itself registers no afterResponse/submit hooks at all (see §5). Dedup/idempotency: content+anchor-derived 8-char id means "re-recording the same content+anchor updates in place" (`docs/mcp-tools.md:301`); store writes are atomic-rename + CAS `sequence` counter (`memory-store.ts:52-90`). Capture is repo-scoped, not session-scoped (decisions carry `sessionId` as provenance only); memories survive across all sessions and agents on the repo.

## 3. RETRIEVAL

Two paths. **(a) Tool recall**: `recall` tool (opt-in `--preset memory`; included in the `substrate` default as a read) takes `task`, optional `asOf`/`changedSince`/`type`; returns notes + decisions with a deterministic **freshness verdict** — `fresh` / `drifted (verify)` / `orphaned` — and orphaned memories are "NEVER served as authoritative" (`memory.ts:5-11`). Ranking is lexical scoring (`memory-ranking.ts` `queryTerms`/`scoreMemory`), no embeddings for memory; a separate optional vector index (embeddings via configurable endpoint, e.g. local Ollama) powers `search_specs`/`search_code` fallback. **(b) Automatic injection**: the Pi extension's `before_agent_start` hook (first turn only, `src/pi/extension.ts:2297+`) appends to the system prompt: an architecture digest (≤8000 chars), a spec index, and a task-scoped `orient(prompt)` result gated by a turn-intent classifier and relevance gate with a token budget — degrading to a single pointer line when weak. Injection is once-per-cwd per session, not per-turn. Bounded: digest 8000 chars, orient render budgeted (`PI_STANDING_CONTEXT_BUDGETS` ~1300 tokens for memory preset).

## 4. STATE + LIFECYCLE

Durable: everything — notes.json, decision store, digest, spec index, vector index — lives in the repo's `.openlore/` (committed project content), shared across sessions/tools/agents. In-process only: daemon handle cache, health cache, keepalive, primed-cwd set. Lifecycle is unusually rich: **bitemporal validity** (`validFromCommit`/`invalidatedByCommit`), `supersedes` chains, symbol-identity continuity — on `openlore analyze`, renames/moves carry anchors forward with `carriedAcross` provenance; ambiguous moves stay `orphaned` with `possiblyMovedTo` candidates (`docs/mcp-tools.md:304`). Decision lifecycle ends in `sync_decisions` writing ADRs/spec files, after which inactive decisions are **purged from the store** ("their content lives in ADRs and git" — `docs/mcp-tools.md:292`). Schema versioning: `MemoryStore.version: '1'` plus additive-field defaults for legacy records (`types/index.ts:1167-1174`).

## 5. SEAM SURFACE

The Pi extension entry is `src/pi/extension.ts` (2404 lines), declared via package.json `"pi"` field so `pi install npm:openlore` auto-registers. It registers: **tools** — `NAV_TOOLS` (`mcp.ts:1012`) rendered as `openlore_*` (orient, search_code, trace, analyze_impact, …), `remember`/`recall` (when the daemon preset includes them), `openlore_prepare_spec_generation/repair`, `openlore_configure`, `openlore_activate_tools` (lean default tool surface + on-demand activation); **commands** — `/openlore` config wizard; **hooks** — `session_start` (lean tool surface, onboarding wizard, daemon warmup), `agent_end` (status refresh), `session_shutdown` (keepalive teardown), `before_agent_start` (context injection, §3); **UI** — footer status via `ctx.ui.setStatus(PI_STATUS_KEY, …)` showing daemon + index health (`extension.ts:973,2040-2075`), custom `renderCall`/`renderResult` display-only renderers. Host-facing human surface = the footer status + `/openlore`. Notes are repo files (private JSON), but decisions already flow OUT to durable per-record documents (ADRs, spec.md) — the closest existing analog to sigrun's doc-family pattern.

## 6. EXTERNAL DEPENDENCIES

**Fully offline-capable core**: static analysis via tree-sitter (the `stubs/tree-sitter-cli-stub` is a vendored stub of the tree-sitter CLI used during analysis — it IS code-index memory, verified), no API key, no LLM in the hot path. Optional: an LLM provider for decision consolidation / spec generation (config `generation.provider`, OpenAI-compat), an embeddings endpoint for semantic search (`embedding.baseUrl/model`, `OPENLORE_EMBEDDING_API_KEY`, local Ollama works), and the warm daemon (local HTTP, may be auto-spawned by the extension).

## 7. VERDICT

**(a) Durable doc-family + generic panel seam coverage: ~35%.** Its memory surface is code-anchored, repo-scoped, machine-consumed JSON with structural freshness verdicts — a human-facing doc-family of per-record markdown would fit decisions (which already sync to ADRs) but is the wrong shape for anchored notes whose value is graph join against the call index; the panel/footer status maps well, though.

**(b) Most valuable missing seam primitive: freshness-attested records** — a durable-record contract carrying machine-verifiable validity state (`fresh/drifted/orphaned` + `carriedAcross` provenance + bitemporal commit bounds) computed by the host against a mutable referent. Approvals/interactions/ambient records are immutable facts about events; nothing in the seam suite expresses "this record's *subject* has since changed, here's its current truth status."
