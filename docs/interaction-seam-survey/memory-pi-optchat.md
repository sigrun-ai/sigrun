# pi-optchat — Memory-Architecture Inspection
Source: https://github.com/jonaslsaa/pi-optchat

## 1. ARCHITECTURE

**This is a genuine memory architecture, not chat-optimization.** Despite the name, pi-optchat implements Victor Taelin's OptChat recipe: an append-only message log plus a binary tree of LLM-compressed summaries, replacing context compaction entirely ("Pi compaction is disabled", src/index.ts:475-478). The memory model is a **summarizer/distiller with transcript-index retrieval** — no vectors, no embeddings, no external service.

Backing store: flat files under `~/.optchat/profiles/<name>/` (`OPTCHAT_HOME` override; docs/storage.md), accessed through a single `Store` seam (src/store.ts:33-42): `load() / append(entry) / appendNode(summary) / saveView(view) / putImage()`. `FileStore` is the only implementation; the docstring explicitly anticipates a Postgres store. The profile dir is a local Git repo committed after each turn and on clean shutdown (docs/storage.md, src/checkpoint.ts).

A **record** (src/memory.ts:14):
```ts
export interface Entry { i: number; kind: Kind; text: string; size: number; date: string; receipt?: string; origin?: Origin }
export const KINDS = ['user', 'talk', 'tool', 'echo', 'note', 'work'] as const;
```
Summary nodes are `(level, index)` tree positions with text+size: `interface Summary extends Part { text: string; size: number }` (`Part = { l: number; i: number }`, src/memory.ts:16-17).

## 2. CAPTURE

- **Trigger:** `pi.on('message_end', ...)` (src/index.ts:393) — every message (user, assistant, tool results) is logged per run; a turn-boundary flush (`flush()` in `agent_settled`, src/index.ts:484-489). Summaries are generated asynchronously by a dedicated "compactor" LLM (default Anthropic Sonnet 5.5, medium) via a `Compressor = (input: Compression, signal) => Promise<string>` callback (src/memory.ts:19), scheduled oldest-first over unbuilt leaves and mergeable sibling pairs (`mostDue`, src/memory.ts:55-69).
- **Idempotency:** substantial. Subagent report receipts deduplicate re-delivered steers (`reportReceipt`, duplicate suppression src/index.ts:410-419); an inbox journal claims typed inputs before the model sees them; `Memory` tracks per-node busy/retry maps with retry scheduling and a write-failure latch (`failed`/`writing`, src/memory.ts:118-124). Log entries carry `receipt?: string`.
- **Session binding:** capture is bound to a *profile*, not a session id — memory persists across Pi sessions and directories per profile (README). Runs get a `RUN_BOUNDARY` custom entry start/end (src/index.ts:375, 490). Images are saved to the store at `message_end` (src/index.ts:396-402).

## 3. RETRIEVAL

- **Automatic injection:** each turn starts from a fresh context whose system prompt embeds the *view* — a sawtooth list of one-line summaries (≤512–640 bytes each) tiling the log, capped at 128 KB (`VIEW`, src/memory.ts:6); over budget it merges most-due pairs in one batch down to 64 KB. Injected via `before_agent_start` → `event.systemPromptOptions.customPrompt` (src/index.ts:388) inside `<chat>` tags (src/prompts.ts:11). Optional full previous exchange replay (`Previous exchange` setting, 16 KB cap). `context_with_system` (src/index.ts:430) swaps each turn's context to fresh-view + new message.
- **Model-invoked:** tools `zoom` (open a summary line into its two children, or a full message, paged at 25 KB, with images; also fetches subagent transcripts by run id), `date` (timestamp of id), and opt-in `search` (plain-text case-insensitive over originals, newest-first, ~5 KB pages with `before` cursor) — src/tools.ts:43-65. No embeddings; ranking is recency + pagination.
- **Size bound:** view is hard-capped at 128,000 bytes; zoom pages capped at 25 KB/output cap 30 KB (`CAP`, src/memory.ts:7).

## 4. STATE + LIFECYCLE

- **Durable:** message log, summary tree, saved view, images (the `Store` seam — declared "what would travel between machines"), plus local-only files: runs, recovery journals, usage, settings, per-profile `AGENTS.md` instructions, import records (docs/storage.md).
- **In-process:** the Sawtooth view state, busy/retry maps; view reloaded from the saved snapshot at open.
- **Generation/versioning:** imports build a new `memories/<id>/` generation and atomically flip `active-memory.json` only when the whole tree is ready; older generations retained. `Saved` records validate every entry/summary on load (src/memory.ts:120-130).
- **Compaction/decay:** no decay; the tree *is* the compaction — progressive merges (512-byte lines, most-due-first). Pi's own compaction is explicitly cancelled (src/index.ts:475-478). Crash recovery via journal + git checkpoints after each turn.

## 5. SEAM SURFACE

Registered on `ExtensionAPI`: hooks (`session_start`, `before_agent_start`, `message_end`, `context_with_system`, `before_provider_request` prompt-cache pinning, `session_before_compact` cancel, `turn_end`/`agent_settled`, session-switch blocking); tools `zoom`, `date`, `search`, `spawn`, `tell`; one root command `/optchat` with subcommands (profile, settings, model, agents, usage, activity, instructions, browse, import) plus `/complete`, `/tell-main`; flags `--optchat-profile/--optchat-connect/--optchat-agent`; custom renderers for reports and connected windows (src/index.ts:497-650).

**Host-facing human surfaces:** footer status (profile name), `/optchat activity` memory gauge (view size, summaries catching up, running agents), `/optchat usage` token/cost table, `/optchat browse` memory browser (the exact shape the model sees, zoomable to originals, with fold locations — src/inspector.ts).

**Doc-family fit:** the per-profile `AGENTS.md` instructions, usage ledger, and run histories are record-shaped and human-readable — natural durable-doc candidates. The log/tree/view are private internal state; the `Store` seam already isolates exactly what is transportable, which is the same boundary question sigrun's doc-family seam asks.

## 6. EXTERNAL DEPENDENCIES

- **LLM calls:** compactor model (summaries, imports, handoffs) and subagent model (default Opus 5.5 high) — authenticated via Pi's existing provider login, no separate keys. README: "Compression and subagents make extra model requests with your provider credentials." Not offline-capable for capture (every summary is a model call); core chat works with whatever Pi model is selected.
- **No embeddings, no vector DB, no external services.** Node 22.19+, Git for checkpoints. Storage is pure local files; the optional `Lease` interface (src/store.ts:19-31) supports cross-machine sharing.

## 7. VERDICT

(a) **Durable-doc-family + generic-panel seam coverage: ~35%.** OptChat's memory is one large internal artifact (log + tree + view) with no per-record durable documents; its model-facing context is wholesale-replaced rather than sectioned, and its store is a bespoke seam it already abstracts. Only the peripheral records (instructions, usage, run metadata, import records) would map to doc-families; the panel surface (activity gauge, memory browser) is richer than a generic panel would render.

(b) **Most valuable seam primitive it motivates: a versioned *context-replacement* hook with generation atomicity** — the ability for an extension to own the model's working context per turn (replacing compaction) while building a new state generation offline and flipping an active pointer only when complete (`active-memory.json` pattern). Approvals/interactions/ambient all *append* records; none gives an extension turn-scoped authority over context assembly with a crash-safe cutover. A secondary takeaway: `Store`/`Lease` as an explicit transportable-vs-machine-local split is a clean contract worth mirroring in the seam design.
