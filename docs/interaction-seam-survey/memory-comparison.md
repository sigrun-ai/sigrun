# Memory-seam comparison report (2026-10-15)

Parallel subagent inspections of 21 pi memory extensions, sizing a
channel-neutral memory seam for sigrun. Method: shallow source clones to
/tmp/pi-mem-inspect, quote-backed reports keyed by file:line (one per
extension, `memory-*.md` in this directory), control cases included
(pi-optchat — a memory architecture under a chat-optimization name;
openlore — code-index memory, not conversation memory; pi-mnemosyne —
a 277-line CLI wrapper). Summarized here.

---

## Architecture families

The 21 extensions sort into five families. Family membership predicts
seam-fit far better than quality or popularity does.

**F1 — Markdown distillery** (human-readable files are the source of
truth; index/LLM is derived): pi-memory (qmd-indexed), pi-hermes-memory
(MEMORY.md/USER.md + FTS5), @pify/memory (tiered MEMORY.md + daily
logs), @pi-unipi/memory (frontmatter .md + MemPalace vectors), pi-weave
(note vault + verbatim `## Raw` tails + wiki-link graph),
common-memory-core (canonical section-patched .md + SQLite queue).

**F2 — Session/turn ledger with LLM distillation** (records live in or
alongside the session store; workers distill): pi-observational-memory
(ledger = pi custom entries, fold/projection), pi-blackhole (same OM
pattern + deterministic VCC + 3 worker loops), pi-memory-evolution
(SQLite claim store + dormancy/decay scheduler), pi-optchat (append log
+ binary summary tree *replacing* compaction, git checkpointed).

**F3 — Raw transcript index** (verbatim turns, rebuildable): 
pi-session-memory (node:sqlite over JSONL, deliberately regressed from
summaries to raw turns), openlore (code-anchored JSON, repo-scoped),
heimdall (path-keyed journal + Graft graph daemon — filesystem memory,
zero conversation binding).

**F4 — External-service client** (memory lives server-side; extension
is a thin stateful client): pi-honcho (Honcho cloud + local FTS5),
@amaster.ai/pi-memory-mem0 (mem0 cloud/embedded/self-hosted),
@luxusai/pi-hindsight (Hindsight server + local outbox),
@josephyoung/pi-openviking (OpenViking service + consent-gated delivery
state machine), @remnic/plugin-pi (local daemon over HTTP),
@kvidzibo/pi-mem — *not* F4 despite appearances (local SQLite, see
below), mnemosyne (external Python CLI).

**F5 — Curated records, no engine** (@kvidzibo/pi-mem: immutable
lessons, supersede chains, human-audited promotion pipeline — SQLite
but record-shaped to its core).

## The comparison table

| Extension | Model | Store (durable) | Capture trigger | Retrieval | Injection style | Scoping | Heavy deps | Seam fit (a) | Missing primitive it motivates |
|---|---|---|---|---|---|---|---|---|---|
| pi-memory | distiller+index | markdown files + qmd index | model tools + shutdown exit-summary + compact handoff | qmd BM25/vector/hybrid + tools | 16K static snapshot (KV-stable) + tool search | global+day | qmd binary (optional) | 55% | compaction-boundary capture event |
| pi-hermes-memory | distiller+FTS | md files + SQLite trigram FTS | 4 triggers (turn-count review, compact/shutdown flush, correction regex, tools) | FTS5 trigram + tools | policy prompt / legacy full blocks | project (cwd) | better-sqlite3 | 45% | searchable derived index over host docs |
| pi-honcho | remote summarizer | Honcho cloud + rebuildable FTS | settled exchanges (text-only), durable delivery ledger | server-side derivation + 3 tools + FTS | once-per-session cached block, adaptive 800→200→0 tokens | repo hash session | Honcho SDK + API key | 55% | durable delivery/outbox ledger (pending/ack, exactly-once) |
| omms | vector+distiller | SQLite+DiskANN shards (local ONNX embeddings) | agent_settled work-units, LLM worth-it gate | hybrid vector+keyword, 2K token budget | `<omms-retrieval>` section per prompt | project tag / user shard | onnxruntime (+LLM) | 55% | session-bound provenance on records (host+session+entryIds) |
| @pi-unipi/memory | vector (external tool) | frontmatter .md + MemPalace palace | model-invoked only, re-prompt nudges | MemPalace vectors + tool | ≤20 titles priming, never content | project / global | Python uv + MemPalace | **85%** | recall-source contract (queryable records injected as prompt section + tool) |
| @remnic/plugin-pi | daemon fact-store | daemon markdown + pluggable index | message_end/turn_end hash-deduped, shutdown sweep | daemon QMD hybrid | ONE recall per session, KV-stable system-prompt append, 12K chars | sessionKey+namespace+cwd | daemon | 55% | compaction-coordination hook (flush + versioned summary contribution) |
| pi-observational-memory | OM ledger (in-session) | pi session custom entries ONLY | token-clock workers (observer/reflector/dropper) | recall-by-id (explicitly not search) + compaction projection | compaction summary REPLACEMENT | session branch | none (LLM only) | 35% | compaction hook contract + provenance-backed recall |
| openlore | code-index (control) | repo .openlore JSON | model tools only | lexical + freshness verdicts (fresh/drifted/orphaned) | first-turn orient, ≤6 lines | repo | tree-sitter, optional daemon | 35% | freshness-attested records (bitemporal, machine-verifiable validity) |
| pi-weave | curated vault+graph | markdown vault + JSONL history | model tools + opt-in scans | graph-augmented lexical + tool | none (tool-only) | vault-global | none | **85%** | derived-artifact cache (content-hash-anchored, rebuildable, disposable) |
| @amaster.ai/pi-memory-mem0 | mem0 client | mem0 stores (cloud/sqlite/REST) | turn_end pairing, background prefetch | mem0 vectors + tool | user-channel custom msg, 8KiB cap, UNTRUSTED-wrapped | user+project hash | mem0ai (+LLM) | 15% | capture-boundary pairing rule (input↔answer binding, replay-safe once-per-session markers) |
| @josephyoung/pi-openviking | remote service | remote + owner state.json (delivery lifecycle) | explicit verbatim-span saves + consented collection | remote find, token-budgeted JSON | ephemeral custom msg, never persisted | owner/scoped URIs | remote svc + fs-ext | 35% | consent-scoped durable source provenance (epoch + verbatim verification + erasure) |
| @kvidzibo/pi-mem | curated lessons | SQLite (immutable, schema v9) | agent tool adds → provisional candidates → evaluated+approved | NO search — auto context overlay only | snapshot + ID-delta overlays, 30 lessons/8KiB budgets | git-worktree scope + global | none | **80%** | recall snapshot + delta overlay primitive (cache-preserving incremental context) |
| common-memory-core | LLM-maintained shared md | canonical .md + SQLite queue | delivered-turn batching via OS-supervised Core service | NONE (full-doc disclosure) | frozen system-prompt snapshot per session | multi-agent scoped auth | separate LLM provider | 55% | multi-writer scoped authorization over shared durable store |
| @pify/memory | md tiers + opt-in observer | markdown tiers + recovery JSON | tools + opt-in agent_end observer + compact salvage | FTS5/in-process + tool | hidden memory-context msg, RE-INJECTED after compaction (deduped) | global+project+daily | none | **80%** | compaction-surviving injection channel (host-owned re-attach + presence dedupe) |
| pi-optchat | summary tree (control+) | flat files + git checkpoints | message_end + async compactor LLM | zoom/date/search tools | REPLACES context each turn (128KB sawtooth view) | profile-global | compactor LLM | 35% | versioned context-replacement hook with atomic generation cutover |
| pi-session-memory | raw turn index | node:sqlite over JSONL | agent_settled per turn + startup sync | literal SQL substrings (+opt Jev filter) | NEVER injected (tools only) | per-session rows | optional Ollama | 25% | capture-boundary hook (finalized turn tuple) + rebuildable-index state class |
| @luxusai/pi-hindsight | external server | Hindsight server + local outbox | agent_end retains + tools | server hybrid (sem+graph+temporal) | ephemeral context block, topK 12, TTL-cached | bank tags (project/global) | server (self-host ok) | 35% | async delivery outbox (enqueue/flush/dead-letter/receipts) |
| pi-memory-evolution | claim store+scheduler | SQLite (schema v7, jobs/leases) | compact + agent_end, LLM claim distiller | two-gated lexical, ≤3 claims/2KB | system-prompt digest per turn | scope=provenance only, recall global | none | 40% | async background-work ledger (leases, backoff, cross-session jobs) |
| @arihantdeva/heimdall | path-keyed graph (control) | journal.db + Graft daemon | tool_result path hints → reconciler | graph+vector+trust verdicts | first-input transform ≤6 lines | filesystem paths | vendored Graft | 35% | (derived-index projection concept; first-input transform hook) |
| @mnemosyne-oss/pi-mnemosyne | CLI proxy (control) | external Python SQLite | model-invoked only | external vectors + tool | none | none | Python pkg | **90%** (records trivially doc-shaped; engine external) | capture-policy tiers (graded model-proposed records) |
| pi-blackhole | OM ledger + VCC | session JSONL + pending files | token-clock 3-worker agent loops | BM25+regex recall tool + compaction projection | compaction preamble projection | session lineage | LLM only | 45% | coverage/provenance contract (sourceEntryIds + reflection support gating destructive drops) |

## Cross-cutting findings (sized by evidence)

**1. The doc-family fit is bimodal, not gradient.** Extensions whose
durable state is *already records* (pi-weave, unipi, pi-mem, pify,
mnemosyne — 80-90%) map onto {durable doc-family + panel} almost
natively. Extensions whose essence is an *engine* (vector shards, worker
pipelines, summarizer trees, external services — 15-45%) never map,
because the value is private machinery, not records. Median ≈ 45%. A
sigrun memory seam should own RECORDS and leave engines private — the
same conclusion as the interaction survey (records not dashboards).

**2. Every serious implementation rebuilt the same four pieces of
plumbing.** Appearing in ≥6 extensions each, always privately:
(a) a **compaction-boundary hook** (salvage/flush/handoff before history
folds — pi-memory, pify, remnic, observational, hermes, evolution);
(b) a **durable delivery/outbox ledger** (enqueue→ack→reconcile with
replay safety — honcho, hindsight, openviking, common-memory, remnic);
(c) a **capture-boundary pairing rule** (bind user input to the answer
turn, idempotently — sigrun's own submit-binding hack, mem0, session-memory,
omms); (d) a **compaction-surviving injection channel** with presence
dedupe (pify — measured 3/3 vs 0/3; pi-mem delta overlays; honcho
cached block). These are the seam primitives the evidence actually
motivates; none exists in approvals/interactions/ambient.

**3. Provenance is the second consensus requirement.** Ten extensions
tie memory records to their origin (sourceEntryIds, session+entry ids,
verbatim-span verification, content hashes). pi-blackhole's
coverage tiers (reflections citing observations gating destructive
drops) and openviking's consent-epoch provenance are the two ends of the
spectrum. A sigrun memory record should carry host-assigned provenance
(conversation, entry ids, capture path) — never model-asserted.

**4. Injection discipline is a real design space with a visible failure
mode.** KV-cache stability recurs deliberately (byte-identical snapshots:
pi-memory, remnic, pi-mem overlays, common-memory frozen snapshots);
untrusted-data framing is near-universal (`<...>` wraps, "not
instructions" preambles, user-channel delivery); hard budget caps range
2KB (evolution) to 128KB (optchat). The failure mode — injected memories
re-captured as fresh input — is explicitly patched in omms
(stripRetrievalSections) and hindsight (isInjectedHindsightMemory
exclusion). A seam injection channel needs all three: stability
guarantee, untrusted framing, and re-capture exclusion.

**5. Where honcho actually sits.** pi-honcho's memory payload is
100% server-side derivation (summary + user representation + chat); the
extension's local value is the delivery ledger, FTS transcript search,
and the adaptive injection budget (800→200→0 tokens as context
fills — the most sophisticated budget curve in the survey). Its honcho
API surface is small and stable (workspace/session/peer/message +
context/search/chat/conclusions + clone) — see the control note in
memory-pi-honcho.md. vs pi-blackhole: blackhole's distillation is
local-LLM worker loops with deterministic contracts (coverage tiers,
hash ids, fail-closed cursors) and zero service dependency; honcho's is
outsourced to a server. They agree on the record model (observations +
provenance + reflections) and disagree on who runs the distiller —
which is exactly spec B's hosted-honcho-vs-local decision.

**6. Control-case verdicts.** pi-optchat IS a memory architecture (a
compaction replacement — the only extension with turn-scoped context
authority). openlore is code memory, useful only for its
freshness-verdict and bitemporal patterns. pi-mnemosyne is a thin CLI
wrapper whose high seam-fit score reflects that it has almost nothing
to cover. pi-session-memory's deliberate regression (dropping its
summary tables for raw turns) is the strongest single data point that
transcript-derived summaries age badly while raw indexes stay honest.

## Sigrun seam implications (ordered by evidence weight)

1. **Own records, not engines.** The seam = durable per-record memory
documents (doc-family) + generic panel + private-engine freedom. The
four plumbing primitives (finding 2) are the host's to provide; the
memory model (vectors, distillers, graphs) is the extension's.
2. **The compaction-boundary hook is the single most-demanded
primitive** — 6+ extensions would have been impossible to build
correctly without privately reimplementing it.
3. **Records carry host-assigned provenance + lifecycle status**
(provisional→confirmed, fresh/drifted, dormant) — the graded-triage
shape mnemosyne motivates, the coverage evidence blackhole motivates,
the bitemporal validity openlore motivates.
4. **Injection channel = seam-owned** with stability + untrusted
framing + re-capture exclusion as contract requirements, not extension
hygiene.
5. **The observe stream should be a core-owned doc family** (per the
earlier session analysis) — this survey strengthens that: the OM family
(observational, blackhole) proves ledger-style durable records in the
session store work, and the outbox pattern (honcho/hindsight) proves
delivery state belongs in durable records too.
