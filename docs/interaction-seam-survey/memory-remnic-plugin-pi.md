# @remnic/plugin-pi — Memory-Architecture Inspection
Source: https://github.com/joshuaswarren/remnic

## 1. ARCHITECTURE
A thin daemon-client over a hybrid external memory service. The plugin holds NO store of its own: everything (observe, recall, MCP tools, LCM) goes over HTTP to the local Remnic daemon (default `http://127.0.0.1:4318`, `client.ts:152-160`). The daemon owns the real model: durable markdown records in `<memoryDir>/{facts/,entities/,profile.md}` with categories (fact/decision/preference/correction/relationship/principle/commitment/skill/rule), plus a rebuildable search index behind six pluggable backends (QMD default = BM25+vector+rerank; Orama, LanceDB, Meilisearch, remote, no-op) and an opt-in Lossless Context Management transcript archive (root `README.md:380-393`, `docs/search-backends.md`). So: LLM-extracted fact store + hybrid index + full-transcript archive. Record shape on the wire (`plugin-pi/src/client.ts:10-26`):

```ts
interface ObserveMessagePart { kind: "text"|"tool_call"|"tool_result"|"patch"|"file_read"|"file_write"|...; payload; toolName?; filePath?; createdAt? }
interface ObserveMessage { role: "user"|"assistant"; content: string; sourceFormat?: "pi"; rawContent?: unknown; parts?: ObserveMessagePart[] }
```

`RecallResponse = { context, results[{id,content,score,category}], count, storageCorpusVersionsAtRecallStart }` (`client.ts:2-8`).

## 2. CAPTURE
Hooks (`src/index.ts:218-243`): `message_end` (user messages), `turn_end` (final message + toolResults), and a `session_shutdown` sweep of any branch messages not yet observed (crash-replay). Batching is hash-deduped: `hashObservedMessage` (`messages.ts:75`) over a stable content identity; observed hashes persist as a Pi custom entry at shutdown (`persistObservedState`, `index.ts:746-750`, capped `MAX_OBSERVED_HASHES`) so replayed sessions aren't re-sent; retries are safe because observe is explicitly "dedupe-safe" (`client.ts:258-259`, `#1602`). Payloads are chunked under a byte cap with per-turn wall-clock budget. Capture is tied to `sessionKey` + `cwd` + `namespace` (the observe envelope, `client.ts:548-556`). No LLM distillation in the plugin — extraction happens daemon-side (`observeSkipExtraction` toggles it).

## 3. RETRIEVAL
One recall, once per session, NOT per turn: on the first `before_agent_start` the user prompt drives `client.recall()` (`index.ts:168-200`); the result is cached and injected byte-identically into the system prompt every turn afterward for KV-cache prefix stability (`index.ts:203-213` — appending `context` to `systemPrompt` instead of Pi's context hook, whose "system" role produces invalid provider payloads). Size is capped by `recallBudgetChars` (default 12000 chars). Model-invoked retrieval arrives via daemon MCP tools registered as Pi tools (`remnic_recall`, `remnic_remember`, …, name-mapped in `index.ts:64-86`). Six slash commands (`/remnic-status`, `/remnic-recall`, `/remnic-remember`, `/remnic-lcm-search`, `/remnic-why`, `/remnic-compact`, `index.ts:304-390`) expose the same surface to humans. Ranking is daemon-side (QMD hybrid); the plugin only trims to budget. A rolling-window timeout breaker permanently disables recall after 7 timeouts in 10 calls (`recall-timeout-breaker.ts`).

## 4. STATE + LIFECYCLE
Durable across sessions: everything daemon-side (memory files, index, LCM transcripts); locally only the observed-hash custom entry inside Pi's session log. In-memory only: per-session `PiSessionState` (observedHashes, cachedContext, recallCompleted) keyed by sessionKey, deleted at shutdown (`index.ts:75-92`, 245-248). Session boundaries: sessionKey → deterministic channel identity + storage paths daemon-side (`remnic-core/src/session-identity.ts:53-101`, `transcripts/session/<hash>/YYYY-MM-DD.jsonl`). Compaction coupling is the distinctive lifecycle piece: `session_before_compact` triggers an LCM flush, records token deltas, writes a context checkpoint, and returns a structured `compaction` payload with `details.remnic {version:1, source:"pi"}` — a schema-versioned compaction record (`index.ts:250-292`). Decay/consolidation (dreams, tiering, expiry) is daemon-side, invisible to the plugin.

## 5. SEAM SURFACE
Registers: 6 events (`session_start`, `before_agent_start`, `message_end`, `turn_end`, `session_shutdown`, `session_before_compact`), 6 slash commands, dynamic MCP-derived tools, a statusline entry via `session.setStatus("remnic", …)` (`index.ts:160-166`), and a startup namespace-writability preflight that can fail loudly (`index.ts:756-830`). Host-facing human artifacts: the statusline label and `/remnic-why` (last recall explanation). No webui panel. Nothing here is approvals/interaction-shaped — all records are memory-internal markdown in the daemon; the only per-record durable structure a host could own is the compaction checkpoint (already version-tagged).

## 6. EXTERNAL DEPENDENCIES
Remnic daemon (local HTTP process) + its auth token (`0600` config file); daemon's embedding/search stack (QMD: BM25+vector+rerank; optional LanceDB/Meilisearch) and an extraction LLM. The pi plugin itself is dependency-light (only `@remnic/core`), offline-degrades gracefully (unreachable-daemon cooldown, breaker, startup timeout 1s), but recall/observe are no-ops without the daemon.

## 7. VERDICT
(a) **~55%.** A doc-family + panel seam covers the compaction checkpoint, status line, and command surface, but the core memory lives behind an external daemon with its own namespace/storage model — a sigrun MemoryBackend contract would replace, not host, this plugin; its one-session-recall + KV-stable injection pattern is the transferable design.
(b) **Compaction-coordination hook**: a host-level "before-compaction" seam where an extension may flush external state, record token deltas, and contribute a versioned summary back into the compaction payload — no existing sigrun seam (approvals/interactions/ambient) has a compaction-bound lifecycle primitive.
