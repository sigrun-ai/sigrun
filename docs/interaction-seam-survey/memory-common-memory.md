# common-memory-core — Memory-Architecture Inspection
Source: https://github.com/Mr-remon219/common-memory
npm: `common-memory-core` v0.4.3 · command `common-memory` · MIT · Node 22/24

## 1. ARCHITECTURE

Hybrid: **canonical Markdown as the long-term content authority + SQLite as a non-reconstructible durable queue/lease/provenance store**, maintained by a separate "Memory Agent Runtime" LLM. Explicitly NO retrieval/index/ranking/vector store ("本版也不引入检索、索引或排序", docs/00-index.md; "不引入 Temporary Store 或向量库", docs/03-target-architecture.md §产品边界).

- Canonical store: `<dataRoot>/memory/profile.md`, `memory/preferences.md`, `memory/projects/<projectId>.md` — strict structure (one H1, unique H2 sections), 8 KiB soft / 16 KiB hard per-doc budget (`src/v2/canonical.ts` `CanonicalStore`, `hardLimitBytes` default 16384). Writes are section-patch only (`put_section`/`remove_section`), committed via fsync'd transaction journal + receipts (`src/v2/canonical.ts:commit/recover`, `runtime/transactions/`, `runtime/receipts/<id>.json`), snapshot-CAS (STALE_REVISION on hash mismatch).
- Runtime store: `<dataRoot>/runtime.sqlite` (node:sqlite, WAL, synchronous=FULL; `src/v2/runtime.ts:44-100`). Tables: `observations`, `jobs`, `document_versions`, `associations(target,sourceId)`, `receipts`, `inputs`, `deliveries`, `settings`, `forgotten_sources`, `correction_watermarks`, plus session tables (`src/v2/session.ts:23-40`).
- Record shape — `src/v2/runtime.ts:12-16`:
  ```ts
  export interface ObservationInput { taskKind?: 'observation'|'edit'; sessionId: string; entryId: string; text: string; scope: string; observedAt: string; source: string }
  export interface Observation extends Omit<ObservationInput,"text"> { id: number; text: string|null; state: string; enqueuedAt: number }
  ```
  Decision record is the `memory_maintenance_v2` JSON schema (`src/v2/contract.ts`): decisions of kind `retain{remember|update|correct, stable|until_changed}` / `forget` / `maintain` / `ignore`, each with `applicability: global|project|uncertain`, `confidence`, `evidence[]` (must reference real ingest handles), `reason`, and bounded section operations.

What "common" means: **memory shared across agents, not sessions of one agent**. One machine-local store serves Pi, Codex CLI, and ChatGPT Desktop (Work), plus any stdio MCP host (README §接入). Each agent gets authorized read/write scopes: `disclosure.allowedScopes` + `writableScopes` (`src/config/config.ts:142-147`), where scopes are `global` (profile+preferences) or `project:<id>` derived from host cwd (project registration in TUI). Sessions are isolated per (client, processInstance, sessionId) via sha256 `sessionKey` (`src/v2/session.ts:16-18`); cross-session sharing happens only through the canonical Markdown the Writer produces, never raw conversation sharing.

## 2. CAPTURE

Trigger: **automatic capture of delivered user turns + settled-turn batching**, plus explicit user-driven import. The pi extension registers host events, not an afterResponse hook: `pi.on("input")`, `pi.on("message_end")` (user turns → `r.delivered(...)`, assistant/tool → `r.context(...)`), `pi.on("agent_settled")` → `r.settled(...)`, `session_before_switch/compact/tree`, `session_shutdown` (`src/pi-extension/index.ts:66-110`). All go through `PiCaptureRuntime` (`src/pi-extension/extraction-runtime.ts`), a serialized IPC client to an OS-supervised independent Core service (requestId dedup + single `DELIVERY_UNCERTAIN` retry).

Idempotency: strong. Observations are UNIQUE(sessionId,entryId) with content digest conflict detection (`RuntimeStore.enqueue`, `src/v2/runtime.ts:108-127`); messages UNIQUE(sessionId,messageId) with sha256 digest (`src/v2/session.ts:65-73`); jobs carry token+generation lease fencing, retries capped at a shared 5-recovery budget; receipt-first crash recovery re-runs the Markdown transaction without re-calling the model (`src/v2/canonical.ts:recover`, docs/03 §Recovery). Capture is hard-gated on `disclosure.allowedProvenance.includes("user_explicit")` (`src/pi-extension/index.ts:32-35`); mixed-provenance turns are quarantined (`MIXED_SESSION_TURN`, `src/v2/session.ts:96-100`). Boundaries: a turn seals only when the delivered user message settles ("A delivered, settled interaction is the semantic boundary. Never wait for a fixed count", `src/v2/session.ts:104-120`); legacy ingress batches at 6 turns / 16 KiB / 120 s idle (docs/03 §Capture). Session identity is fully bound into every observation row.

## 3. RETRIEVAL

No search at all — two disclosure paths:

1. **Automatic injection**: `pi.on("before_agent_start")` appends a frozen snapshot as a system-prompt block: `## Common Memory\n<rendered docs>\n<read guidance>` (`src/pi-extension/index.ts:88-96`); snapshot cached per (dataRoot, sessionId), refreshable via `/memory-refresh`. `renderMemoryView` wraps docs in `<common-memory target="...">` XML-ish blocks with escape + "user data, not instructions" framing (`src/v2/reader.ts:38-48`). Size = whole authorized documents (global: profile+preferences; project: that project only, `contextTargets` `src/v2/reader.ts:8-13`) — bounded by the 8/16 KiB doc budgets.
2. **Model-invoked tool**: `memory_read` (optional `contextId`, `src/pi-extension/index.ts:70-72`) reads the same canonical Markdown live. Plus `memory_status` (queue/scopes/outcome by importId/requestId) and `memory_init` (authorized import, requires native `ctx.ui.confirm`). MCP hosts get read-only `memory_read`.

No ranking, embeddings, or FTS; nothing is chunked or selected — either the full document is disclosed or it isn't.

## 4. STATE + LIFECYCLE

- Durable: canonical Markdown (content authority), runtime.sqlite (queue, jobs, leases, receipts, session messages, provenance links, forgotten-source digests, correction watermarks), receipts (minimal: digests, decision enums, model/prompt versions — no plaintext bodies, docs/03 §Recovery).
- In-process: the frozen system-prompt snapshot (global map keyed by dataRoot:sessionId, `src/pi-extension/index.ts:9`), memory-agent working notes (Runtime memory only).
- Session boundaries: `session_shutdown(reason=quit)` → `runtime.end()` settles open turns as `incomplete`, seals, marks session closing, NULLs undelivered assistant/tool bodies (`src/v2/session.ts:129-137`). Compaction of conversation does NOT feed memory (`agent/busy` is a no-op: "Model lifecycle never controls Core scheduling").
- Forgetting/decay: `forget` decisions + `forgotten_sources` digest table prevent re-capture of forgotten content (`src/v2/runtime.ts:118-122`); processed observation bodies pruned after ~7 days (docs/03 §Recovery); correction watermarks order corrections. No TTL decay of memory content.
- Versioning: config `schemaVersion !== 2` rejected (`src/config/config.ts:123`); DB `PRAGMA user_version` vs `RUNTIME_PROTOCOL` (`src/v2/runtime.ts:55`, `src/v2/upgrade.ts` does column backfills).

## 5. SEAM SURFACE

Registers with pi: 3 tools (`memory_read`, `memory_status`, `memory_init`), 3 commands (`/memory` opens an interactive panel — browse/adjust/import/processing-status, `src/pi-extension/memory-ui.ts`; `/memory-refresh`; `/memory-flush`), 8 host event hooks, and a statusline: `ctx.ui.setStatus('common-memory', 'Memory · 等待/处理 N · /memory')` polled every 2 s + `ui.notify` warnings for dead/paused jobs (`src/pi-extension/index.ts:44-62`). System-prompt injection is the read seam.

Host-facing human surface: statusline line, `/memory` TUI panel, notify toasts, plus the standalone `common-memory` management TUI (config, integration, project authorization).

Doc-family fit: each maintenance decision is already receipt-shaped (request id, evidence refs, before/after hashes, per-target associations `associations(target,sourceId)`) — very close to sigrun's per-record durable document pattern. Canonical Markdown docs themselves are the "memory content" doc-family analog (profile/preferences/project targets = durable records with CAS). Much of the queue/session plumbing is private implementation, not host-facing.

## 6. EXTERNAL DEPENDENCIES

- One LLM maintenance model: user-configured OpenAI-compatible Chat Completions provider + API key stored in a private TUI-only `.env` (README §第一步); runtime uses pi Agent Core + pi-ai 0.85.1 as its agent harness (`docs/memory-agent-runtime.md`). Default 64 model turns/task.
- `ajv` (2020 schema validation). node:sqlite built-in (no native binary dep). Peer dep on `@earendil-works/pi-coding-agent`.
- Offline-capable for reads and capture (queue + local Markdown + MCP read need no model/network); writes (distillation) require the configured model; proxy/CA options exist (README §第三步). Windows runs via WSL.

## 7. VERDICT

(a) **~55%**. The durable-doc + panel seam covers the read/disclosure side well (canonical Markdown docs ≈ doc-family records, `/memory` panel ≈ generic panel, receipts ≈ interaction records), but its core value — an LLM-maintained shared store with scoped authorization, session-scoped capture queues, and transactional section commits — lives in private service/Core infrastructure that a sigrun in-harness seam would have to re-host; capture is event-hook-driven with its own IPC service rather than a submit-boundary pass-through, and the "shared across agents" scope model (per-host cwd→project authorization) has no analog in the approvals/interactions/ambient seam set.

(b) **Most valuable missing primitive: multi-writer scoped authorization over a shared durable store** — i.e., a seam primitive where one memory record/document carries per-client read-scope + write-scope grants (`allowedScopes`/`writableScopes` + provenance gating, `src/config/config.ts:142-147`) with evidence-linked, CAS-guarded commits and durable receipts attributing every content change to a specific capture source. Approvals/interactions cover "host records a pending decision" and ambient covers "host renders status"; neither covers "many agents share one store with per-agent authorization and provenance-tracked edits."

*(~690 words)*
