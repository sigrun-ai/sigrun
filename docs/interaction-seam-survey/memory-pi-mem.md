# @kvidzibo/pi-mem — Memory-Architecture Inspection
Source: https://github.com/kvidzibo/pi-mem
Repo inspected: /tmp/pi-mem-inspect/pi-mem (v0.17.0, schema 9)

## 1. ARCHITECTURE
Curated-lesson store (NOT transcript-index, NOT vector, NOT summarizer): human/model-approved "lessons" with explicit lifecycle. Backing store = SQLite (`node:sqlite` DatabaseSync) at `<pi-agent-dir>/memory-v9.sqlite3` (schema-versioned filename selection, `src/database.ts:7-11`; `PRAGMA user_version` = 9, application_id 0x504D454D, `src/store.ts:50-51`). A record (`Lesson`, `src/store.ts:26-40`):

```ts
interface Lesson { id: number; scope: string; text: string; evidence: string;
  basis: "validated_learning"|"validated_fix"|"user_request"|"import";
  source_harness: string; source_session: string|null; created_at: number;
  updated_at: number; revision: number; archived: boolean; archived_at: number|null;
  supersedes_id: number|null; }
```
Immutability enforced by SQL trigger (`lessons_immutable`, `src/store.ts:53-58`) — supersede creates a linked replacement; nothing is deleted. Candidate pipeline tables add observations/exposures/evaluations/groupings (`src/candidates.ts:59-96`). Dedup = sha256 normalized-text key (`textKey`, `src/store.ts:71-74`). No embeddings, no background model calls (README: "No transcript harvesting, embeddings, or background model calls").

## 2. CAPTURE
No automatic capture hooks. Capture is agent-invoked via the `memory` tool `add` action (params: text, evidence, basis, optional reason — `src/index.ts:408-460`), plus human `/pi-mem add` commands/menu. Capture timing is explicitly delegated to the agent's rules (README "Setup"). Agent adds are ALWAYS provisional session-scoped candidates (`src/index.ts:454`), recalled only by the originating session. Idempotency: exact repeated submissions from one session retain first observation (candidate_observations dedup, disclosure records prevent evaluator-lineage vote recycling). Session binding: scope = canonical git worktree root or cwd (`src/project.ts`); origin {harness, session, actor, provider, model} recorded on every write. Ephemeral (`--no-session`) writes require `basis: "user_request"` (`src/index.ts:444-446`).

## 3. RETRIEVAL
Fully automatic, tool-free (no recall tool; "No agent read/search/history actions"). A `context` hook rewrites the message list each model request (`src/index.ts:399-406`), injecting hidden `custom` user-role messages: initial snapshot + ID-based delta "MEMORY UPDATE" overlays appended at fixed boundaries, preserving prompt-cache prefix (`src/recall.ts:22-68`, RecallContext.apply). Sections: `GLOBAL LESSONS`, `PROJECT LESSONS`, `SESSION CANDIDATES`; plain bullets `- text #43`. Ranking: newest-created then ID asc; budgets maxRecallLessons=30 / maxRecallBytes=8192 UTF-8 per scope (config defaults, README §Configuration); omissions get a `[N lessons omitted.]` notice. Literal-substring SQLite search exists only in the human UI/commands. System prompt gains save-guidance + word limits (`src/index.ts:380-382`). Model context can accumulate delta history until compaction — budget bounds selection, not accumulated updates.

## 4. STATE + LIFECYCLE
Durable: lessons, candidates, evaluations, append-only activity log, backups — all SQLite, cross-session, cross-project. In-process only: RecallContext prefix-hash state and pending audit/evaluation proposals (invalidated by compaction/tree/session change — `src/index.ts:396-397, 500-504`). Lifecycle: candidate → (LLM-partitioned evaluation + human approval, thresholds projectMinOccurrences=2 / global=4+3 projects) → active lesson; supersede chains (supersedes_id); archive hides from recall, retains record, irreversible. Decay: none automatic (no TTL/expiry) — forgetting is human/model audit (`/pi-mem audit` proposes archives/moves, one transaction). Schema versioning is filename-level (`-v9` sibling, no migration, no import — `src/database.ts:7-11`, README §Database selection). Backups via SQLite online backup API at process startup, scheduled Off/Daily/Weekly/Monthly (`src/backups.ts`).

## 5. SEAM SURFACE
Registered with harness: 3 tools (`memory` add/supersede/archive, `memory_evaluate`, `memory_audit` — `src/index.ts:408,462,538`); events: session_start, session_shutdown, session_compact, session_tree, context (`src/index.ts:321-406`); system-prompt append; ~40 `/pi-mem` subcommands (`src/index.ts:615+`); statusline segment `ctx.ui.setStatus("pi-mem", …)` (`src/index.ts:163`); UI widget `pi-mem-backup` (`src/index.ts:332,353`); TUI/RPC menu (`src/menu.ts`, `src/menu-ui.ts`). Host-facing human surface: statusline counts, backup report widget, full menu browser with history/provenance. Chat cards appended to the session for saves/archives (`src/index.ts:247`). Durable-doc mapping: each Lesson is already a stable-ID, immutable, append-only-history record — an exact fit for a per-record durable document family (scope/origin/activity = interaction-record shape). Candidates/evaluations are workflow state that would also map to records; RecallContext overlays are purely in-process.

## 6. EXTERNAL DEPENDENCIES
None beyond Node 22.19+ stdlib (`node:sqlite`, `node:crypto`, git CLI for scope resolution). No API keys, no embedding models, no binaries. Evaluation/audit use the CURRENT chat model (no separate service). Fully offline-capable; requires local filesystem with SQLite WAL support (README §Privacy).

## 7. VERDICT
(a) **~80%.** Lessons are stable-ID immutable records with append-only provenance history — a natural doc-family fit — but the extension's core value is (i) session-candidate scoping and (ii) prompt-cache-preserving incremental recall overlays, which a generic doc-family + panel does not cover and would need host recall/section primitives.
(b) **"Recall snapshot + delta overlay" primitive** — the host owning "durable selection rendered into context as snapshot + ID-based delta updates at fixed boundaries with byte/lesson budgets" is the valuable seam neither approvals/interactions/ambient have.
