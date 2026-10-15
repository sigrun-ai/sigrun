# @amaster.ai/pi-memory-mem0 — Memory-Architecture Inspection
Source: https://github.com/TGYD-helige/pi

Monorepo member: `packages/pi-memory-mem0` v0.1.2-beta.15 (package.json), Apache-2.0, deps `mem0ai@3.3.1` + `@qdrant/js-client-rest` + `@amaster.ai/pi-shared` (workspace).

## 1. ARCHITECTURE

**Mem0 client wrapper, three backends behind one `Mem0Provider` interface** (provider.ts:36-44: `add`, `search`, `getAll`, `getDedupGroups?`, `delete`):

- **platform** — Mem0 Cloud REST (`MemoryClient` from `mem0ai`, provider.ts:225-256; requires `MEM0_API_KEY`, index.ts:112).
- **embedded** — mem0 OSS in-process (`mem0ai/oss`, provider.ts:666): LLM fact-extraction + embedding + vector store. Default vector store `memory` is **SQLite-backed** at `<home>/memories/mem0-vectors.db` (default home `~/.pi/agent` via `resolveHome`); history SQLite at `<home>/memories/mem0-history.db`. External stores: qdrant/redis/pgvector/supabase (README "External Vector Store").
- **self-hosted** — raw fetch to a remote mem0 OSS REST server `/memories` + `/search` with optional `X-API-Key` (provider.ts:388-406).

Mem0 itself handles fact extraction (LLM call), dedup/conflict resolution, and embedding; locally the package owns only redaction, scoping, prefetch, and result formatting.

**Record shape** (types.ts:74-82):
```ts
interface MemoryItem { id: string; memory: string; score?: number; user_id?: string; created_at?: string; updated_at?: string; }
```

## 2. CAPTURE

Trigger: **`turn_end`** hook — pairs the persisted `lastUserText` (set in `input` hook, index.ts:206-209) with the assistant message, redacts both, and serializes writes through a `pendingWrite` promise chain (index.ts:218-247: `pi.on('turn_end', ...)` → `provider.add([{role:'user',...},{role:'assistant',...}])`). Capture is per-turn, user+assistant text only — no tool-call capture. Manual writes: `mem0_memory(action="add")` tool and `/mem0 add`. Scope is `userId:project:<sha256(cwd)[:12]>` (privacy.ts:7-14), optionally `agentId`. Dedup/idempotency: relies on mem0's own inference-time dedup; a separate maintenance `dedupMemories` (NFC/case/whitespace normalization, keep-newest, 10k platform cap, fail-closed; dedup.ts) is exposed via `/mem0 dedup [--apply]`. No crash-replay: failed turn captures are swallowed with a `console.error` (index.ts:241-246). Session binding: none per-session — scoping is project/user-level; `session_shutdown` awaits `pendingWrite` (index.ts:266-280).

## 3. RETRIEVAL

Two channels. **Automatic**: `input` hook queues a background `provider.search` (Prefetch.queue, prefetch.ts:29-39); `before_agent_start` consumes it with a 3s timeout and returns a **custom message** `{customType:'mem0-recall', content, display:true}` — delivered on the **user channel, never system prompt** (index.ts:249-259). Block shape `## Recalled Memories (Mem0)` with `- (date) [UNTRUSTED MEMORY DATA] "json-quoted"` lines; caps: 1000 chars/entry, 8 KiB / 50 lines per block (prefetch.ts:10-12, 56-70). `recallFrequency: session` searches only the first input per session, marker persisted via `pi.appendEntry('mem0-session-recall', sessionId)` and detected by scanning session entries (index.ts:190-198). **Model-invoked**: `mem0_memory` tool with actions `search/add/get_all/delete`, topK shared with recall (tools.ts). Ranking: mem0 vector similarity (score field, README shows `score >= 0.7` filtering example). Injection size is deliberately small (8 KiB cap); tool outputs bounded 12 KiB / 100 records.

## 4. STATE + LIFECYCLE

Durable: everything memory-shaped lives in mem0's stores (SQLite files or remote server) — the extension keeps **zero local memory state**; no snapshot fallback ("configured vector store always owns persistence", README). In-process only: provider/prefetch handles, session recall flag. Lifecycle: `session_start` re-inits provider (epoch-guarded against superseded async init, index.ts:66-186) and declares the tool *before* slow backend init so the system prompt stays stable. No compaction/decay/forgetting — no TTL, no summarization of old memories; growth is unbounded (deliberate: "no capacity limits", in contrast to pi-memory). No schema versioning of its own; versioning is mem0-internal. `/new` and `/fork` create new session ids → one more recall search under `session` frequency.

## 5. SEAM SURFACE

Registers: **1 tool** (`mem0_memory`, activated/deactivated via `pi.setActiveTools`), **1 command** `/mem0` (status/search/profile/add/dedup/delete), **4 event hooks** (`session_start`, `input`, `turn_end`, `before_agent_start`, `session_shutdown`), **1 status-line entry** (`ctx.ui.setStatus('mem0', 'mem0: <mode>/<preset>')`, index.ts:184) — the only host-facing human surface. No panel/webview. Durable-document fit: each MemoryItem has a stable `id` + text + timestamps — records could map to a doc-family, but writes are ephemeral LLM extractions (updated/merged by mem0), not human-approved artifacts; nothing here resembles approval/interaction records. The recall-injection block is transient per-turn context.

## 6. EXTERNAL DEPENDENCIES

- **mem0ai 3.3.1** npm SDK (mandatory).
- **platform mode**: Mem0 Cloud API + `MEM0_API_KEY` — data leaves the machine (README explicitly discloses this).
- **embedded mode**: an LLM extraction model + embedding model (defaults `gpt-4.1-nano` + `text-embedding-3-small`; keys/base URLs resolved from pi's model registry, fallback to env vars) — **online unless pointed at Ollama**; **`better-sqlite3` native addon** (ABI-sensitive; init detects breakage and disables history, provider.ts:670-677); optional Qdrant/Redis/Supabase/pgvector servers.
- **self-hosted**: remote HTTP mem0 server, optional API key — the only fully-third-party-free path short of embedded+Ollama.
Offline-capable only in embedded mode with local Ollama llm+embedder; platform/self-hosted are network-bound.

## 7. VERDICT

(a) **~15%.** The extension's entire state lives inside mem0's opaque stores (cloud/SQLite/REST) with its own extraction/dedup pipeline — a durable doc-family + generic panel could host *records* (id/text/score/timestamps map fine) but would not own extraction, ranking, or merging, so the seam covers at most the storage/rendering sliver, not the memory engine; it also has no human-decision surface for approvals-style documents.

(b) **"Capture-boundary pairing rule"** — the disciplined pattern of binding a user input to the assistant turn that answers it (`lastUserText` captured at `input`, flushed at `turn_end`, serialized through one pending-write chain) plus a session-marker entry to make once-per-session side effects replay-safe — a conversation-binding primitive the approvals/interactions/ambient seams (record-centric, not turn-paired) don't have. Secondary: the untrusted-recall injection contract (user-channel custom message + threat-scan wrapping + hard byte caps) is a reusable recall-shape precedent.
