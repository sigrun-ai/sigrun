# @mnemosyne-oss/pi-mnemosyne — Memory-Architecture Inspection
Source: https://github.com/mnemosyne-oss/pi-mnemosyne

**What it actually implements (special-attention answer): almost nothing.** The repo is a 277-line total project (src/index.ts 159 lines, 1 test file, 1 skill). `src/index.ts` registers 5 tools that each `spawn("mnemosyne", [...])` and return stdout. Every architectural claim (SQLite, semantic search, banks, consolidation) lives in an external Python package, `mnemosyne-memory` (`pip install`), whose source is NOT in this repo and was not inspected — claims below about store internals come from README/skill prose only. There are no hooks, no capture, no persistence, no session wiring in the TS at all (tests/index.test.ts:26-36 asserts only 5 registerTool calls).

## 1. ARCHITECTURE
- **Model**: external-service client (CLI proxy). The extension is a typed-arg wrapper over `spawn("mnemosyne", cmd)` — `src/index.ts:15-44` (`runMnemosyne`), tools at :52, :81, :110, :128, :141.
- **Backing store**: per README:3 — "local-first, SQLite-backed AI memory" — a SQLite DB managed by the external CLI; location on disk unspecified in this repo (no path, no env var, no config file anywhere in `src/`).
- **Record shape**: no TS type exists in-repo. Tool schema is `{content: string, source?: string (default "pi"), importance?: number 0.0–1.0}` — `src/index.ts:56-73`. CLI invocation is positional: `mnemosyne store <content> [source] [importance]` (:74-79). ID is whatever the CLI prints back (consumed only by `forget`, :117-124).

## 2. CAPTURE
- **Trigger**: model-invoked only. There is **no GenerationHooks.afterResponse, no submit hook, no automatic capture anywhere** — the extension registers zero events. Capture happens when the LLM decides to call `mnemosyne_remember` (SKILL.md:6-12 nudges it: user preferences, project facts, gotchas) or the user asks. This is the opposite pole from sigrun's observe-at-boundary design.
- **Dedup/idempotency**: none in the extension; fire-and-forget CLI calls, no retry, no crash-replay, no conversation/session id passed at all — the CLI receives only content/source/importance, so capture is **not session-bound**.
- **Consolidation**: `mnemosyne_sleep` (:141-155) proxies `mnemosyne sleep` — "compress working memories into long-term summaries" (SKILL.md:67-69), invoked manually "at the end of a long session".

## 3. RETRIEVAL
- **Tool**: `mnemosyne_recall {query: string, top_k?: 1–50, default 5}` — `src/index.ts:81-105`, proxied to `mnemosyne recall <query> [top_k]`. Model-invoked; **no automatic injection, no prompt section, no boot-time recall**. SKILL.md:59-61 says recall "before starting work on a task" — pure discipline, unenforced.
- **Ranking**: "semantic similarity" (README, SKILL.md:5) — implemented in the Python package; embedding model unknown from this repo (`mnemosyne_stats` mentions "model status", :134).
- **Context reach**: only tool-result text the model chose to fetch. No section/prompt injection, so unbounded-by-design but never passive.

## 4. STATE + LIFECYCLE
- **Persists**: everything lives in the external CLI's SQLite DB, fully session-independent (global, not per-conversation). **In-process state: none.** No compaction triggers, no decay, no forgetting schedule — `forget` is explicit-by-id, `sleep` is manual.
- **Session boundaries**: invisible to this extension (no `getSession`, no session events in src/index.ts).
- **Schema versioning**: none visible; migrations live in the unshipped Python package.

## 5. SEAM SURFACE
- Registers: **5 tools** (`mnemosyne_remember/recall/forget/stats/sleep`) + a skill dir (`pi.skills` in package.json). **No commands, no hooks, no sections, no UI widgets, no statusline/panel** — nothing host-facing for a human; stats is a tool the model runs.
- Doc-family mapping: a memory here is an opaque row in a foreign SQLite file; there is **no durable per-record document**, no host-visible record surface. `forget`/`stats` are the only management verbs, both model-facing.

## 6. EXTERNAL DEPENDENCIES
- **Hard dep**: `mnemosyne-memory` Python CLI on PATH (`pip install mnemosyne-memory`, src/index.ts:11-13; spawn error message reminds the user, :34-38). Failure mode = tool error at call time, not at load time.
- **No API keys** (README: "No cloud. No API keys", SKILL.md:5). Embedding model: unknown, presumably local (claimed offline-capable) — but that lives in the unshipped Python package, so offline-capability of THIS repo is only as good as that install.

## 7. VERDICT
- **(a) Durable doc-family + generic panel coverage: ~90%.** The extension's entire state is discrete human-readable facts (content/source/importance/id) with explicit create/forget/stats verbs — a near-perfect fit for per-record durable documents and a list/stats panel; the only uncovered piece is the semantic-search index and consolidation, which are backend concerns a host seam needn't own (the extension would keep its own index alongside doc records).
- **(b) Most valuable new seam primitive: capture-policy tiers — "suggested by the model" vs "recorded at boundary"** — i.e., a way for the host to let an extension tag records with provenance/confidence (here `importance` 0–1 + source tag) and have the host panel render/triage them; approvals/interactions/ambient have no notion of graded, model-proposed durable records awaiting implicit confirmation. (Secondary: a `forget`-by-id verb in the shared record contract.)
