# @arihantdeva/heimdall — Memory-Architecture Inspection
Source: https://github.com/ArihantDeva/heimdall

**Special attention answered first: memory is not merely one feature among many — it IS the product.** Heimdall is a machine-wide persistent knowledge base ("did I already solve this in another project?") with four pi extensions, a daemon, a CLI, and a vendored backend all serving memory. The guard/orient components are behavioral scaffolding *for* retrieval. (README.md; components map row "Pi extension" entries.)

## 1. ARCHITECTURE

Hybrid: **transcript/file-tree indexer + code knowledge-graph + local vector store + pluggable backend**, all offline. There is no conversation-transcript memory at all — the unit of memory is *verified file-level knowledge*.

- **Journal (authoritative store)**: `~/.heimdall/journal.db`, node built-in `node:sqlite` WAL, `synchronous=FULL` (`bin/lib/journal.mjs:13-21,109-115`). Tables: `paths` (path/hash/size/mtime/depth/generation/state), `owned_nodes` (node_id/path/kind/symbol/line/label/sink_id), `owned_edges`, `pending_edges` (order-independent cross-file edges), `queue` (deduped reconcile work), `fact_history` (append-only supersession trail for FACT-kind nodes, capped 50/path, `journal.mjs:79-103`). Schema versioning via `SCHEMA_VERSION = 3` + additive `CREATE IF NOT EXISTS`/guarded-ALTER migrations and `PRAGMA user_version` (`journal.mjs:93-139`).
- **Sink (rebuildable projection)**: pluggable interface in `bin/lib/sink.mjs` — `GraftSink` (vendored Graft daemon, `~/.graft/`, sqlite + bge-m3 local embeddings + graph edges) and `MemorySink` (tests/dry-run). "Journal is authoritative; a sink is a rebuildable view."
- **Single-writer reconciler daemon** (`bin/heimdall-reconciler.mjs` + `bin/lib/reconcile.mjs`): level-triggered convergence; hints/watchers only say "look at this path"; desired state = pure function of (bytes, depth); content-hash oracle + ABA generation guard; O_EXCL lock (`bin/lib/lock.mjs`).
- **Record shape** (TS/JSON): a hint is `{ path, reason, at: number }` (`extensions/kb-autosync.ts:41-47`; `bin/lib/hints.mjs:19`). A graph node is the `owned_nodes` row `{node_id, path, kind, symbol, line, label, sink_id}`; a manual `kb_insert` card is `{title, body, keywords}` (`sink.mjs:19-25`, `extensions/kb-tools.ts:71-76`). Depth ladder L0 path → L3 call-graph (`README.md` depth table).

## 2. CAPTURE

- **Trigger**: no per-turn capture. Two channels feed the reconciler: (a) the **kb-autosync** pi extension appends path hints on `tool_result` events for edit tools (`edit`/`write`/`hashline_edit`, path from input) and regex-extracts absolute path tokens from `bash` commands and `user_bash` events — deliberately over-inclusive, "never believed about WHAT changed" (`kb-autosync.ts:56-79`); (b) fs.watch in the daemon + a 15-min audit timer re-queue drift. Hints go to append-only `~/.heimdall/hints.jsonl` (O_APPEND atomic, torn lines dropped, audit recovers — `hints.mjs:19-44`).
- **Dedup/idempotency**: hint queue is `path TEXT PRIMARY KEY` — N agents hammering one file collapse to one queue row; reconcile is idempotent (byte-identical re-run); "journal before sink, sink before commit" crash-ordering; generation guard rejects stale commits.
- **Explicit capture**: `kb_insert` tool / `heimdall insert --title --body --keywords` for curated cards; experimental `bin/lib/facts.mjs` regex-extracts English facts (preference/assertion/declaration/negation, first-match precedence) from prompt logs with trigram Jaccard 0.97 dedup + hard secret filtering — explicitly marked experimental.
- **Conversation binding: NONE.** No session/conversation id anywhere in capture or journal (grep: only per-process guard session state). Memory is keyed by filesystem path, not dialogue.

## 3. RETRIEVAL

- **Tool**: `kb_search(query, n?, scope?)` (`extensions/kb-tools.ts:33-53`) → `heimdall search` → `bin/kb-search.sh`: per-repo `graft ask --json` (code graph) + global `embed-index.py` semantic query (bge-m3), merged/deduped/ranked, then an **in-process trust-verdict pass**: STRONG requires index-card identity (size+mtime vs `global.db`, exact stat, no file opens) + query-token coverage in the hit's text; WEAK/REBUILT/STALE/REMOVED otherwise. Graph walk (`graft explore`) supplements.
- **Automatic injection**: **kb-orient** (`kb-orient.ts:24-77`) fires on the harness `input` event for the FIRST user prompt only (per-process flag), runs two searches under a 2.5s total race deadline, and appends ≤6 deduped `title [score]` lines as `[Context: machine knowledge — related prior work, consult if relevant]` to the user's text via `action: "transform"`. Silent degrade on any failure. No other section/prompt injection.
- **Behavior enforcement**: **kb-search-guard** (`kb-search-guard.ts` + `lib/kb-guard-core.mjs`) counts consecutive grep-style discovery tools per session; ladder warn → escalate → block on 3rd; resets on kb_search/kb_sync; `kb_guard_pause(turns 1-20)` self-service suspension via `turn_start` clock. Prompt-side: `promptSnippet`/`promptGuidelines` push "search before building" discipline.
- **Size ceiling**: orient block ≤6 one-line hits; kb_search default n=6, maxBuffer 2MB, 300s timeout. Bounded.

## 4. STATE + LIFECYCLE

- **Durable across sessions**: everything — journal DB, graft sqlite profile, embeddings, hints archive, `~/.heimdall/config.json`, fact_history. All in `~/.heimdall/` + `~/.graft/`.
- **In-memory only**: guard chain/firings/suspension, orient's one-shot flag (per-process/session).
- **Decay/forgetting**: no LLM compaction. STALE paths are pruned so they "never rank again" (retraction is exact — a deletion removes exactly that path's nodes); fact_history is a bounded supersession trail (FACT_HISTORY_CAP=50, newest-win per path) for "what did we believe"; REBUILT re-homes moved files. Session boundaries are irrelevant by design (path-keyed).
- **Schema versioning**: explicit (`SCHEMA_VERSION`/`user_version`, additive-only).

## 5. SEAM SURFACE

Registers with pi: 4 tools (`kb_search`, `kb_insert`, `kb_sync`, `kb_guard_pause` — `kb-tools.ts:30-88`, `kb-search-guard.ts:17-40`), 3 hooks (`tool_result` + `user_bash` hints; `input` transform orient; `tool_call`/`tool_result` guard patches + `turn_start`), no UI panels/statusline. Host-facing for humans: `heimdall doctor`/`verify`/`telemetry.sh view` (nodes/day, kb_* calls, hit rate, est. time saved), `kb-health.sh`. Beyond pi: `heimdall init` wires 7 harnesses (rules block + MCP server `mcp-server.mjs`) — a deliberately channel-neutral layer already.

Durable per-record doc-family fit: the **fact cards** (`{node_id, path, kind, text, invalidated_at, superseded_by}` + secret filtering) and **manual insert cards** (`{title, body, keywords}`) are exactly the approvals/interactions-shaped durable records. The graph/journal internals (paths/nodes/edges) are private extension storage — projections of disk, never human decisions; they should NOT become doc-family records.

## 6. EXTERNAL DEPENDENCIES

Zero runtime npm deps. Needs: Node ≥22.5 (node:sqlite), bash, python3 + tree-sitter grammars for L2/L3 depth, vendored **Graft** daemon built from source (cmake/sqlite/libyaml; clones llama.cpp for bge-m3 local embeddings — Metal/CUDA/CPU accel) — fully **offline-capable**, nothing leaves the machine. Optional: mnemosyne-oss backend via `HEIMDALL_BACKEND`; launchd for the macOS daemon. No API keys.

## 7. VERDICT

- **(a) Coverage by {durable doc-family + generic panel} seam: ~35%.** The curated cards/facts (doc-family-shaped) and telemetry would port, but the core value — a single-writer reconciler, journal-of-paths, stat-verified retrieval against the live filesystem, and path-keyed capture — is process/storage machinery a doc-family seam doesn't model at all; forcing it into per-record documents would be the wrong shape.
- **(b) Most valuable new seam primitive: none for the record/panel seam itself — but it motivates a "derived-index projection" concept** (a durable authoritative store + pluggable rebuildable projections + audit-as-CI `verify --deep`), which no existing seam (approvals/interactions/ambient) has. Closest missing host primitive it does exercise: a **first-input transform hook** (orient's once-per-session context enrichment) — sigrun's afterResponse/submit capture seam doesn't cover pre-prompt injection.
