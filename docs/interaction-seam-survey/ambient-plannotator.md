# Plannotator — Ambient-Surfaces Inspection

Scope: `apps/pi-extension` (browser review/annotation UI and inbox excluded per brief). Evidence is `apps/pi-extension/index.ts`, `config.ts`, and `packages/shared/checklist.ts`. **The extension has exactly two ambient surfaces**, both imperatively managed helpers:

## 1. SURFACES

**(1) Statusline slot** — key `plannotator`, set via `ctx.ui.setStatus("plannotator", ...)` (index.ts:549-564, `updateStatus`).
- Trigger/placement: pi statusline keyed slot. Shows phase `statusLabel` (from config, e.g. "⏸ plan") or, during executing, a computed `📋 completed/total` counter.
- Update cadence: event-driven, no timers. Called from `markStepDone` (648-649), `applyPhaseConfig` (762-763), phase-exit/idle (`returnToIdle`→838-839), `turn_end` checklist scan (2284-2285), and post-resync (2516-2517). In-flight step transitions fire per tool result; phase changes fire on phase entry/exit.
- Persistence: none for the slot itself. Cleared with `setStatus("plannotator", undefined)` whenever phase is idle or no items. Underlying phase/checklist state is restored from session entries + plan file, so the slot re-derives on reload/resume.
- Survival: survives reload/compaction/restart only indirectly via state restore (phase + `ChecklistItem[]` rebuilt in `resyncPhaseFromSession`, index.ts:2356-2450, from `customType:"plannotator"` entries and the on-disk plan checklist).

**(2) Widget (above-editor progress checklist)** — key `plannotator-progress`, set via `ctx.ui.setWidget(key, lines)` (index.ts:566-580, `updateWidget`).
- Trigger/placement: above-editor persistent widget; only rendered while `phase === "executing"` and `checklistItems.length > 0`; `setWidget(key, undefined)` clears otherwise.
- Content: one line per step — `☑` + accent + strikethrough for completed, `☐` + text for pending (571-576). All styling is pre-flattened terminal-theme strings.
- Cadence: same callers as the statusline; per-step on mark, per-turn on `[DONE:n]` scan.
- Persistence: none for the widget; same re-derivation path as above. Additionally mirrored to a todo provider (`syncTodoProvider`, 583-622) for pi-todos' *interactive* `/todos` view — but that mirror explicitly "must never break plan execution" and there is no live widget surface there.

No other ambient surfaces: `ctx.ui.notify` (toasts) and browser-review UI are the only remaining user-facing output, and both are excluded from this classification (notify is transient toast; browser is a separate app-channel surface, excluded per brief).

## 2. DATA MODEL

Statusline: pi's keyed slot — `{ key: "plannotator", text: (pre-themed string | undefined) }` at the call site. Labels come from `PhaseProfile.statusLabel?: string | null` (config.ts:23-29).

Widget: `string[]` of pre-rendered lines; no structured payload at the surface. The backing state is:

```ts
// packages/shared/checklist.ts
export interface ChecklistItem {
  /** 1-based step number */
  step: number;
  text: string;
  completed: boolean;
}
let checklistItems: ChecklistItem[] = [];  // index.ts:456
```

Phase state persisted as `pi.appendEntry("plannotator", { phase, lastSubmittedPath, savedState, phaseAddedTools, framingDelivered, idleNoticePending })` (index.ts:663-671) and `plannotator-execute` `{ lastSubmittedPath, approvedPlan }` (2074). Checklist itself is re-parsed from the plan file (`parseChecklist`, markdown checkbox regex) and merged with session-message `[DONE:n]` / `plan_mark_done` tool results.

## 3. INTERACTIVITY

Both surfaces are strictly **read-only** for the human. No key handlers, click, collapse, expand, or navigation are registered on either. There is no observable for `updateStatus`/`updateWidget`. The human edits state only through other channels: config (statusLabel), the browser review UI (approve step), or the todo provider's own `/todos` view (outside this extension). The agent mutates widget state by calling the `plan_mark_done` tool or emitting `[DONE:n]` (index.ts:646, 2331-2336).

## 4. MAPPING

- **Statusline slot → candidate A (statusline text `{key, text}`)**: FULLY. It is exactly a keyed one-line slot; theme-styling happens in the extension before handoff, which A's contract permits (body from primitives, styling left to channel/renderer decision).
- **Progress widget → candidate B (widget rows `{id, label, statusGlyph/enum, metrics: {completed, total}, progress: {done, total}}`)**: PARTIALLY-FULLY. Each line maps to a row: `id` = step ordinal, `label` = item text, `statusGlyph` = ☑/☐, completion count derivable as `metrics.completed/total` from the row set. Two gaps fall to opaque fallback: (a) **strikethrough styling on completed rows** — B's rows carry enum+detail, not text-decoration; a generic row renderer would need a `strikethrough` affordance on the completed enum or the extension loses that visual. (b) The widget is a plain `string[]` today, so any rich line (it is currently uniformly one of two forms) would not map. Everything else maps.
- **Candidate C (gauge/progress)**: NOT USED anywhere. The `📋 N/M` status and widget do not convey percent/phase/elapsed/recentOutput; no spinner/animate surface exists.
- **Candidate D (tree/list)**: NOT USED. Flat unordered checklist rows; no depth, deps, or spinnerLabel.

Opaque fallback needed: nothing. Total surface content is two primitives.

## 5. VERDICT

**Coverage: ~100%** of ambient-surface content is expressible as {A rows, B rows, C gauge} — read: A (statusline) + B (widget rows) cover **100%** of it; C and D are required at 0%. The only C-value nuance is the `📋 completed/total` statusline, which is better expressed as B's metrics on a row or by A carrying plain text — a dedicated gauge primitive adds nothing here. Single most valuable missing primitive: **a combined statusline+row "progress counter" sugar** is unnecessary; the genuine gap is **B rows lacking a completed/struck-through styling affordance (e.g. `status: "done"|"pending"|"failed"` enum with channel-defined glyph+decoration)** — the extension hand-encodes `☑`/strikethrough today and a generic renderer cannot recover that intent from a bare string.

**Human never acts ON the surface**: fully read-only. The only adjacent interactive channel (todo-provider mirror → pi-todos `/todos`) is an explicit non-ambient escape hatch documented at index.ts:583-622 ("pi-todos renders its list on demand... has no live surface").
