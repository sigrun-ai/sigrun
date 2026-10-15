# @luxusai/pi-hindsight — Memory-Architecture Inspection
Source: https://github.com/luxus/pi-hindsight

## 1. ARCHITECTURE

Hybrid **external-service memory core + local durable queue/receipts**. All extraction/embedding/ranking lives in a Hindsight server (Hindsight Cloud, self-hosted, or embedded `@vectorize-io/hindsight-all`); the extension is a stateful client around it. Backing stores:
- **Server side (authoritative):** Hindsight banks — facts, entities, events, relationships (graph), observations, and "mental models" (distilled answers built from facts). Server does semantic + keyword + graph + temporal + tag ranking (`docs/hindsight-core-functions.md:58`).
- **Local disk:** JSONL retain queue at `<cwd>/<config.retain.queuePath>` with `.dead.jsonl` and `.malformed.jsonl` siblings (`extensions/queue/queue.ts:15-22`); retain receipts at `<cwd>/.pi/hindsight/retain-receipts.json` (`extensions/lifecycle/retain-receipts.ts:27`).

A "record" is a RetainJob (`extensions/types.ts:285-308`): `{id, bankId, createdAt, documentId, updateMode, item: {content, context, timestamp?, async?, tags?, metadata?, observationScopes?, documentTags?, entities?, strategy?}, retries, lastError?, deadLetteredAt?}`. Recall results carry `occurred_start?`, `source_fact_ids?`, `scores {semantic, reranker, final, keyword}` (`types.ts:243-261`) — a light timeline field exists (`occurred_start`) but no episode/timeline object; temporal ranking is server-side.

## 2. CAPTURE

Triggers (extension entry `extensions/index.ts:24-40`):
- `context` hook → recall (query-time, not capture).
- `agent_end` → `lifecycle.retain(event, ctx)` — capture is **per completed agent run**, not per turn.
- Explicit user commands/tools (`hindsight_retain`, `hindsight_retain_global`, imports).
- Git-seed tool for bootstrapping a bank from history.

Jobs are enqueued (optionally coalesced) into the JSONL queue and flushed to the server; receipts (`version: 1` schema) record delivered jobs for idempotency/replay (`retain-receipts.ts`). Retries + dead-letter + malformed-line quarantine in the queue store. Content-type policy exists (`RetainUserContent/AssistantContent/ToolResultContent`, `types.ts:25-27`); secrets are redacted before retain. Sessions tag records with stable session/project identity — project scope via stable `project:<id>` tags (plus legacy `repo:<path-hash>`), and `source:pi`/`harness:pi` provenance tags (`docs/memory-behavior.md`).

## 3. RETRIEVAL

**Model-invoked tool:** `hindsight_recall` (+ `hindsight_reflect` for synthesized answers, `hindsight_mental_model`) with optional `tagGroups` AND-ed with automatic scope. **Automatic injection:** the `context` hook composes a deterministic query from recent transcript messages (role-filtered, last-N turns, max query chars, `isInjectedHindsightMemory` excluded to avoid feedback, `lifecycle/recall.ts:117-136`) and injects an **ephemeral** `<hindsight-memory>` block (`recall.ts:143-160`) — append position, topK 12, optional source-fact evidence lines, per-scope token budgets (`recall.maxTokens` vs smaller `userMaxTokens`). Not written into transcripts, never re-retained. Cached by bank-IDs + last-user-message identity for `recall.cacheTtlMs` (60s). Retrieval model = server-side hybrid: semantic, reranker, keyword, graph, temporal; local min-score floors on those fields only.

## 4. STATE + LIFECYCLE

- **Persists:** everything in the Hindsight server (banks scoped project vs global/user); local JSONL queue + dead-letter + receipts (survives crash/restart — durable outbox pattern).
- **In-memory only:** the recall injection (ephemeral, TTL-cached), session id binding on `session_start`.
- **Session boundaries:** `session_start` initializes, `session_shutdown` flushes (`index.ts`). Retain is bound to completed runs, not raw turns.
- **Decay/forgetting:** none local; consolidation/observation-scoping is server-side ("facts learned from repetition"). Mental models are refreshed artifacts with `lastRefreshedAt`. Receipts capped at MAX_RECEIPTS. Schema versioning: receipt file has `version: 1` (`retain-receipts.ts:31,37`).
- Profile gating: Project+User / Project Only / User Only / Recall Only.

## 5. SEAM SURFACE

Registers with pi: **10 tools** (`hindsight_recall/retain/retain_global/reflect/status/seed_git/scope/config/bank/mental_model/knowledge`, `operations/operation-catalog.ts`), **/hindsight commands** (setup TUI wizard, plus `hindsight_knowledge`, `hindsight_scope_migrate`), **3 hooks** (`context`, `agent_end`, `session_start`/`session_shutdown`), and an **event emission** `hindsight:retrieval` telemetry (`index.ts:8-11`) consumed by a status widget (statusline-style rendering with style/detail levels, `utils/status.ts:103`). Human-facing: `hindsight_status` tool + status widget + setup TUI. The receipt file and queue are private extension storage; the closest durable-per-record analog is the retain receipt (queue-job → bankId/documentId/outcome), which would map naturally to a doc-family, but banks/facts/observations must stay in the server.

## 6. EXTERNAL DEPENDENCIES

Hindsight server (HTTP API) — required for all memory function; local/offline mode possible via self-hosted + built-in llama.cpp embeddings, or embedded `hindsight-all` (needs `uv`/Python). No API keys in the extension itself beyond the server URL/auth. Pure TS client (`fetch`-based, retry/timeout wrappers) — no binary deps. Offline without a server = no-op memory.

## 7. VERDICT

**(a) ~35%.** The durable payload lives in an external memory server with graph/observation semantics that a doc-family cannot express; only the local queue/receipts/telemetry surface would fit a `{durable doc-family + generic panel}` seam (receipts as interaction-style records, `hindsight:retrieval`/status as an ambient panel).
**(b) An async delivery outbox pattern** — durable enqueue → flush with retry/dead-letter/malformed-quarantine + idempotency receipts — none of approvals/interactions/ambient has; also notable: ephemeral (never-persisted) recall injection as a distinct "ambient read" vs "durable write" contract distinction.
