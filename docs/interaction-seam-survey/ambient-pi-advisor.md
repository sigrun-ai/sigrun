# pi-advisor — Ambient-Surfaces Inspection

## 1. SURFACES

| Surface | Trigger | Placement | Size/budget | Update trigger + cadence | Persistence | Survival |
|---|---|---|---|---|---|---|
| Status slot `advisor-usage` | Advisor consultation records usage (`src/tools/gate-policy.ts:22-30`, `src/commands/runtime.ts:147-155`) | statusbar keyed slot | one line | after each consultation / command; set-on-change; `undefined` clears at session_start / gate skip (`src/tools/register-lifecycle.ts:79,221`, `src/commands/lifecycle.ts:97`) | in-memory (pi ctx.ui.setStatus); totals live in `AdvisorSessionState` (`src/session-state.ts:357-372`) | In-memory per pi lifecycle; undefined on `session_start` (fresh session). Not persisted to session entries/files. |
| Status slot `advisor-scout` | Scout tool call/chunks (`src/tools/scout-status.ts:78-178`) | statusbar keyed slot | one line, fixed text "Scout curating…" | per lifecycle event + refcounted `ScoutStatusManager` release (`/#active` Set) | in-memory only | cleared on release / session reset; not persisted |
| Status slot `advisor-manual` | `/advisor-manual` command (`src/commands/runtime.ts:39`) | statusbar keyed slot | one line, undefined after dialog closes | set during manual dialog, cleared on completion | in-memory | same class |
| Herdr metadata "seeking advice" | consultation in flight (`src/herdr.ts:20-33`, `herdr-block.ts:59,88`) | external pane status (socket `pane.report_metadata`, agent="pi") | one state label | refcounted leases `HerdrAdvisorActivity` (start/finish/clear, `src/herdr.ts:36-150`); emission on start + when count hits 0 | none (socket fire-and-forget, failure swallowed) | no survival; opt-in via `herdrIntegration` setting |
| Custom entries / rendered messages | tool/command completion | transcript (aboveEditor flow content, not overlay) | full body boxes | one-shot per result, static thereafter | session custom entries via `pi.appendEntry("advisor-scout-result"|"advisor-manual-call"|"advisor-loop-call/result"|"advisor-turn-gate-call/result")` (`src/tools/scout-status.ts:78`, `manual-command.ts:130`, `loop-gate.ts:41,73,101`, `jev-turn-gate.ts:174,203`); steer messages `advisor-manual-result`, `advisor-stats-result` (`manual-consultation.ts:148,180`, `outcome-stats.ts:99`) | persisted as session log entries, re-rendered by `registerEntryRenderer`/`registerMessageRenderer` (`src/tools/register-renderers.ts:204-211`, `src/commands/renderers.ts:141-151`) | survives reload/compaction persistence (re-render from session log) |
| `/advisor-stats` panel | command invocation | steer message with custom renderer | summary table | one-shot on demand | derived from an on-disk outcome log (`src/outcome-stats.ts` readOutcomeLog) | file-backed source; display is one-shot |

No banners, no overlay-modal dashboards, no interactive widgets outside the transcript renderers.

## 2. DATA MODEL
- Status slots: plain `string | undefined` keyed by literal ("advisor-usage", `"advisor-scout"`, "advisor-manual"). `formatAdvisorUsageStatus(totals)` (`src/usage.ts:252-266`) → `"Advisor: N calls · <usage totals>"`; `AdvisorUsageTotals` = cumulative {calls, input/out/totalTokens/cost...}. Scout: fixed string.
- `ScoutToolDetails` (`src/tools/types.ts:24-37`): availableCount?, fallbackReason?, latencyMs?, model, omittedBeforeScout?, selectedCount?, selectedLabels?: string[], status enum "calling|streaming|curated|fallback|cancelled", synthesis?, text?, thinking?, usage?
- `AdvisorGateResult`/`AdvisorConsultationResult`/`AdvisorGateFailure` (`types.ts:39-98`): markdown, model, usage?, decision, bytes tallies, trigger, adviceId...
- Herdr: `{ method: "pane.report_metadata", params: {agent:"pi", pane_id, state_labels: {working:"seeking advice"} | clear_state_labels, seq} }`.

## 3. INTERACTIVITY
All status slots and the Herdr pane label are read-only. Interactivity exists only in the transcript renderers: static expanded/collapsed view supplied by pi (renderers accept an `expanded: boolean` and show Selected labels / synthesis / omission counts when expanded — `src/tools/scout-status.ts:184-262`); toggle/expand affordance is pi-provided, not custom key handlers. No click, no navigation, no state editing through any ambient surface. Dialogs (excluded from scope) are where the human acts.

## 4. MAPPING
- `advisor-usage` / `advisor-manual`: primitive **C (statusline text {key,text})** — FULLY (usage footer even carries metrics {tokens,cost,total} inside the text).
- `advisor-scout`: **C** FULLY as shipped (static text); its per-scout concurrency could use **D** PARTIALLY, but current payload never needs it.
- Herdr "seeking advice" label: **C** FULLY (keyed state label/enum).
- Transcript Scout result card: **B (widget rows)** PARTIALLY — status enum, metrics {tokens,cost,latency}, detail lines map well; selectedLabels list + synthesis text exceed B's `detail?` (needs markdown/AI-output body) → anything beyond rows falls to an opaque custom renderer, correctly.
- Turn-gate/loop/manual result cards, `/advisor-stats`: **B** PARTIAL for header-line fields; body markdown/tables = opaque-fallback territory (correct — arguably these are transcript content, not ambient surfaces).
- No surface needs **A (gauge)** or a full **D** tree; spinner phase is done via glyph frames inside renderers (`SPINNER_FRAMES`, `src/tools/render-common.ts`).

## 5. VERDICT
≈ 95-100% of true ambient-surface content (3 status slots + Herdr pane label; all metric counters in footers) is covered by {C statusline, B rows}. The gauge (A) is entirely unused ( Advisor Scout shows elapsed seconds in text, never a percentage). Tree/list (D) is unneeded at current concurrency (single Scout at a time; manager refcounts but renders one fixed string). Most valuable missing primitive: none material — if forced, **D scoped to "active operations" rows** would let the Scout manager expose multiple concurrent curations instead of one global "Scout curating…", a marginal gain. The human never acts ON any ambient surface — they only read; all editing/actions live in excluded dialogs and commands.
