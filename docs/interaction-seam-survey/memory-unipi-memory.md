# @pi-unipi/memory — Memory-Architecture Inspection
Source: https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/memory

Monorepo member (`@pi-unipi/memory` 2.20.5). Depends on siblings `@pi-unipi/core` (event bus, `emitEvent`, `UNIPI_EVENTS`) and `@pi-unipi/info-screen` (via `globalThis.__unipi_info_registry`, not a direct import — index.ts:17-19). Files inspected: index.ts (367L), storage.ts (609L), tools.ts (432L), mempalace.ts (1149L), embedding.ts, commands.ts, settings.ts, bridge/mempalace_bridge.py (683L), skills/memory/SKILL.md.

## 1. ARCHITECTURE

Hybrid: **vector store (external service) + durable markdown tier**. Primary backend is **MemPalace** — a separate Python tool auto-installed via `uv` (`uv tool install mempalace`, mempalace.ts install-flag logic) — reached through a per-operation JSON-line Python bridge (`bridge/mempalace_bridge.py`: `python mempalace_bridge.py <palace_path> <command> [args_json]`, one JSON line on stdout). Palace lives at `~/.mempalace/palace` (DEFAULT_PALACE, mempalace.ts:20); backends selectable via `UNIPI_MEMPALACE_BACKEND` = chroma (default) / sqlite_exact / qdrant / pgvector. Embeddings are computed **inside MemPalace** (default ONNX MiniLM, ~80MB cached at `~/.cache/chroma/onnx_models/`); the TS side never passes vectors through the bridge (bridge docstring, mempalace_bridge.py:1-22). A legacy **SQLite fallback** (`better-sqlite3` + `sqlite-vec`) exists in package.json deps but in current storage.ts all real paths route through MemPalace; if MemPalace/uv is unavailable `init()` throws and memory silently disables (storage.ts init, index.ts session_start catch).

The **durable tier is markdown files with YAML frontmatter** at `~/.unipi/memory/<project>/<id>.md` (and `global/`), parsed/written by `parseMemoryContent`/`writeMemoryFile` (storage.ts:130-220). Record shape (storage.ts:53-63):

```ts
interface MemoryRecord {
  id: string; title: string; content: string; tags: string[];
  project: string;
  type: "preference" | "decision" | "pattern" | "summary";
  created: string; updated: string;
  embedding?: Float32Array | null;  // vestigial; MemPalace embeds internally
}
```

`id` derives from the title (`title.toLowerCase().replace(/[^a-z0-9]+/g,"_")`, storage.ts store()); `project` is the sanitized cwd basename (`getProjectName`, storage.ts:110-124) — so **capture is tied to project (cwd), not conversation/session id**. Palace-side records get deterministic ids via `make_drawer_id_from_chunk(wing, room, source_uri, 0)` so upserts are idempotent (bridge docstring).

## 2. CAPTURE

Capture is **model-invoked, not hook-distilled**. There is no automatic transcript capture; the extension nudges the model into calling tools:

- `before_agent_start` injects a hidden first-turn reminder listing up to 20 memory titles and instructing "BEFORE starting work, call memory_search… AFTER completing the task… call memory_store" (`buildMemoryRecallReminder`, index.ts:44-74, injected at index.ts:296-340 as a display:false custom message).
- `agent_end` fires a follow-up "memory reminder" message if the agent responded without storing (`deliverAs: "nextTurn"`, index.ts:344-359) — a re-prompt loop, one per session, gated by `recallDone`/`storeDone` flags.
- Manual: `/unipi:memory-process <text>` and `/unipi:memory-consolidate` both just inject a user message telling the agent to extract memory-worthy items and call `memory_store` (commands.ts:28-80). README claims the compactor sibling auto-extracts on compaction, but compactor source contains no memory coupling — only the README's claim and index.ts:357 resetting `recallDone` on `session_compact`. Treat auto-consolidation as prompt-coordinated, not wired.

Dedup/idempotency: `memory_store` checks exact title match (same content → gentle refusal; same title different content → update, tools.ts:80-120), then fuzzy `findSimilarByTitle` (threshold 0.6) → warns with similar list but still stores. Palace upserts are idempotent by deterministic drawer id. Sync durability is ledger-driven: `.mempalace-ledger.json` maps `project/id` → sha256 of markdown bytes; `store()` updates the ledger **only after a confirmed palace upsert** (storage.ts:344-353), so a crashed write is retried by the incremental catch-up; `MineAlreadyRunning` lock contention is recorded as *deferred* with exponential backoff 15m→1h→6h→24h (mempalace.ts:67-80), never a failure. Orphaned hand-edited .md files sync lazily on first storage access (`ensureOrphanSync`, index.ts:96-113).

## 3. RETRIEVAL

Two recall channels:

1. **Title injection (automatic)**: the first-turn hidden reminder includes up to 20 memory titles (titles only, never content) — cheap context priming, not semantic retrieval.
2. **Model-invoked tool**: `memory_search { query, limit=10, scope: "all"|"project" }` — searches **all projects by default**, results prefixed `[project]` with a snippet (tools.ts:163-220). `global_memory_search` is a legacy alias. Ranking is MemPalace's internal vector similarity (query_texts); the TS-side OpenRouter embedding path (`embedding.ts`, openai/text-embedding-3-small @384 dims) is effectively dead in the MemPalace path — `generateEmbedding` results are stored on the record but MemPalace ignores them. Without config it's "fuzzy-only mode."

What reaches the model: ≤20 titles at session start + per-search ≤10 snippets. Hard cap guardrail in the reminder: "read max 10 memory results per search" (index.ts:69). No automatic content injection, no size explosion risk.

## 4. STATE + LIFECYCLE

- **Durable**: markdown files (the source of truth), palace vectors, ledger/ping/migration flag files at `~/.unipi/memory/`. Sessions share state across projects via wings.
- **In-memory only**: `recallDone`/`storeDone` lifecycle flags, `projectStorage` handle, 60s TTL cross-project count cache for UI (storage.ts:490-520).
- **Session boundaries**: `session_start` re-inits storage, resets flags; `session_compact` resets `recallDone` so the reminder re-injects post-compaction (index.ts:357-359); `session_shutdown` closes storage.
- **Decay/forgetting**: none automatic — only explicit `memory_delete`/`/unipi:memory-forget`. No TTL, no scoring-based pruning.
- **Schema versioning**: `MIGRATION_STATE_VERSION = 2` for migration semantics (mempalace.ts:33); memory records themselves have no version field. Embedder identity is enforced by the palace — a model change causes write rejection and session fallback; `hasModelChanged()` shows a ⚠ status (settings.ts `lastModel`).

## 5. SEAM SURFACE

- **Tools** (7): memory_store / memory_search / memory_delete / memory_list / global_memory_search (alias) / global_memory_list (tools.ts).
- **Commands** (7): `unipi:memory-process`, `memory-search`, `memory-consolidate`, `memory-forget`, `global-memory-search`, `global-memory-list`, `memory-settings` (TUI settings panel, tui/settings-tui.ts).
- **Hooks/events**: `session_start`, `before_agent_start` (hidden message injection), `agent_end` (follow-up message), `session_compact`, `session_shutdown`; emits `UNIPI_EVENTS.MODULE_READY`, `UPDATE_APPLIED` and (per README) `MEMORY_STORED`/`MEMORY_DELETED`/`MEMORYCONSOLIDATED` consumed by the `@pi-unipi/footer` sibling (footer/src/events.ts:45-57 reads the info registry's memory group).
- **UI**: info-screen dashboard group `memory` 🧠 (projectCount/totalCount/projects/recent; index.ts:150-215) + status bar `🧠 mem 12p/40all` (index.ts:222-245) + footer event segments + settings TUI.
- **Skill**: `skills/memory/SKILL.md` (when-to-store guidance, naming convention).

**Doc-family mapping**: each memory is *already* a durable per-record markdown document with frontmatter — exactly the sigrun doc-family shape (human-readable, hand-editable, id/title/type/timestamps). What's extension-private is only the vector index and the sync ledger; the record documents would port to a doc-family almost verbatim. The `project` scoping field and the `type` enum (preference/decision/pattern/summary) are record taxonomy a generic panel would need to render.

## 6. EXTERNAL DEPENDENCIES

- **MemPalace** (Python, auto-installed via `uv` — requires uv on PATH; else memory silently off).
- **ONNX MiniLM embedding model** (~80MB, downloaded on first palace use) — local, offline after download.
- **OpenRouter API key** (optional, embedding.ts) — only for the legacy TS embedding path; `provider: "none"` default, so offline-capable without it.
- Node deps: `better-sqlite3`, `sqlite-vec` (fallback), `js-yaml`; siblings `@pi-unipi/core`, `@pi-unipi/info-screen`.
- `mempalaceAutoUpdate` does a ~daily PyPI check + `uv` upgrade in background (index.ts:118-131).

## 7. VERDICT

**(a) Durable doc-family + generic panel coverage: ~85%.** The memory records are already durable markdown documents with rich frontmatter — a doc-family plus a generic list/detail panel covers storage, human editing, project/type taxonomy, and the info-screen counts almost natively; the remaining 15% is the vector index + incremental sync ledger, which is genuinely private backend state (like an index over documents, not the documents themselves).

**(b) Most valuable new seam primitive: a "recall/annotation-on-observe" contract — records that are *content-addressable by semantic query* and injected into future-conversation prompts (title-list + search-tool contract), i.e. a first-class "recall source" a host renders as a prompt section and exposes as a search tool.** Approvals/interactions record decisions for humans to review; memory needs write-on-learn (model-invoked store with dedup-by-title semantics), cross-project scoping, and a recall query surface — none of which approvals/interactions/ambient model today. Secondary motivator: the ledger-backed "durable doc → derived index with idempotent backfill + deferred-retry" sync pattern is a reusable reference for any doc-family that feeds a derived store.
