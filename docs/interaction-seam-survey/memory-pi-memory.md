# pi-memory — Memory-Architecture Inspection
Source: https://github.com/jayzeng/pi-memory

Single-file extension (`index.ts`, ~2490 lines, zero deps beyond pi runtime + optional qmd). Memory = plain markdown files under `~/.pi/agent/memory/` (`MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, `recovery/*.json`), indexed by qmd (BM25 keyword ~30ms / vector semantic ~2s / hybrid "deep" ~10s). No sqlite, no separate index, no schema.

## 1. ARCHITECTURE
Transcript-index + distiller hybrid, file-backed. The index is external (qmd indexes the markdown directory; tags `#decision` and `[[wiki-links]]` are content conventions searchable via full-text — design.md "Tags and Links"). A distiller exists for capture: LLM exit-summary (session_shutdown → `complete()` over serialized conversation, `EXIT_SUMMARY_*` envs, index.ts:1500-1555) and compaction handoff. No "record" type for memories — records are markdown lines with an HTML comment timestamp marker (`<!-- 2026-06-07 10:12:03 [a1b2c3d4] -->`, index.ts:623 regex). The one TS record type is the deletion recovery doc (index.ts:628-636):

```ts
interface RecoveryRecord {
  version: 1; id: string; createdAt: string;
  target: MemoryTarget; date?: string;
  removedContent: string[]; restoredAt?: string;
}
```

## 2. CAPTURE
No per-turn automatic capture. Writes are model-invoked tools: `memory_write` (MEMORY.md or daily log), `scratchpad`. Distilled capture: (a) exit summary on `session_shutdown` (skipped for `/reload`/`/new`/`/resume`/`/fork` unless `PI_MEMORY_SUMMARIZE_TRANSITIONS=1`; self-imposed timeout race since pi awaits shutdown handlers unbounded; empty summaries filtered to avoid log pollution — index.ts:1516-1548); (b) compaction handoff on `session_before_compact` appends `<!-- HANDOFF ts [sessionid] -->` + open scratchpad items + last 15 daily-log lines to today's log (index.ts:1638-1681). Post-write: debounced (500ms) background `qmd update` + `qmd embed` (`PI_MEMORY_QMD_UPDATE=background|manual|off`). Dedup/idempotency: none beyond write-once recovery records; capture IS tied to session (short session id embedded in every marker and handoff).

## 3. RETRIEVAL
Default injection is static, not query-driven: `before_agent_start` injects a 16K-char capped block with priority order scratchpad(2K) > today(3K tail) > search results(2.5K, per-turn mode only) > MEMORY.md(4K middle-trunc) > yesterday(3K tail) — index.ts:1576-1620, buildMemoryContext ~805-870. KV-cache-stable snapshot mode (default `PI_MEMORY_SNAPSHOT=stable`): block rendered once at session_start, byte-identical every turn; deletions append a correction message instead of re-rendering; `per-turn` mode restores per-prompt qmd search (top-3 keyword, 3s timeout, `searchRelevantMemories`). Model-invoked retrieval: `memory_search` tool (keyword/semantic/deep modes), `memory_read`, plus `memory_restore`/`memory_status`. Ranking = qmd BM25 default, vector via qmd embeddings (model downloaded on first embed). Max context growth = 16K injection + unbounded explicit tool reads.

## 4. STATE + LIFECYCLE
All state durable on disk as markdown (git-friendly); nothing meaningful in-process except the snapshot cache. Day rollover handled by daily log paths; session boundaries via exit summaries + handoff on compact. Forgetting = `memory_forget` (writes RecoveryRecord JSON to `recovery/` BEFORE mutating, returns visible ID; `memory_restore` replays it — a durable undo pattern). No decay, no compaction of MEMORY.md (middle-truncation silently drops middle entries — flagged as open question in design.md). Schema versioning only on RecoveryRecord (`version: 1`).

## 5. SEAM SURFACE
Registers: 7 tools (`memory_write/forget/restore/read/search/status`, `scratchpad`), lifecycle hooks (`session_start` qmd auto-setup + snapshot, `session_shutdown` exit summary, `before_agent_start` injection, `session_before_compact` handoff, `input` /quit detection), and `ctx.ui.notify` messages (qmd install hints, index.ts:408, 1483). No panel/statusline widget. Human-readable surface is the files themselves (`cat`/`git diff` — deliberate design point) plus `memory_status` tool output. Doc-family fit: the RecoveryRecord (id, createdAt, target, removedContent, restoredAt) is exactly an interaction-style durable per-record document; handoff/exit-summary entries would also translate to per-record durable docs. Tagged memory lines would NOT — they're intentionally schema-free content.

## 6. EXTERNAL DEPENDENCIES
Optional qmd binary (npm `@tobilu/qmd`; Windows .cmd shim workaround invokes its JS entry via node). Semantic/deep search needs qmd's embedding model (auto-download on first embed). Exit summary makes an LLM call using session model or `PI_MEMORY_EXIT_SUMMARY_MODEL` (+ API key from pi context). Core write/read/scratchpad tools fully offline without qmd; search degrades gracefully.

## 7. VERDICT
(a) **~55%**. The markdown-file store and snapshot/compaction machinery are private extension concerns a generic doc-family can't absorb, and memory lines deliberately carry no schema — but the RecoveryRecord, exit summaries, and handoff entries are natural durable per-record documents, and a panel could render `memory_status`/scratchpad/log state well. Selective injection and session-id-marked entries have no seam counterpart today.
(b) **Compaction-boundary capture event** — a host hook that lets a memory extension persist a handoff/summary at `session_before_compact`/session-end (with a bounded-time LLM distillation) is the primitive approvals/interactions/ambient don't provide; secondarily, a "durable correction append" pattern for post-snapshot mutation.
