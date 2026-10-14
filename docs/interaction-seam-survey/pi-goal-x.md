# pi-goal-x interaction-shape inspection

(All paths relative to /tmp/pi-ext-inspect/pi-goal-x. Recon only — no code run.)

## 1. KINDS

- **Questionnaire / proposal dialog** — Trigger: `/goal`, `/sisyphus` guided drafting; proposal confirmation; extension tools `goal_questionnaire`/`goal_question`. Human sees a rich custom TUI dialog: question tabs, options list with "(Recommended)" markers, embedded free-text Editor for custom answers, auditor toggle line; headless/limited hosts degrade to sequential `ctx.ui.select`/`ctx.ui.input` dialogs (extensions/goal-questionnaire.ts:313-355 basic path; rich `ctx.ui.custom` component at :390). Blocking. Answers are transient UI; the result is rendered back into conversation text via `formatQuestionnaireAnswers` (:281).
- **Task-list confirmation dialog** (extensions/goal-task-confirmation.ts:37-48) — binary confirm ("Confirm task list" / "Keep current tasks") with rich custom variant; blocking; transient (only the decision survives).
- **Escape-during-audit dialog** (extensions/widgets/goal-escape-dialog.ts:21-52) — 2 options with descriptions, Escape/Enter; blocking; transient.
- **Selector / settings dialogs** (extensions/goal-commands.ts:104,139,495-611) — `ctx.ui.select` lists (focus a goal, auditor model, settings rows), `ctx.ui.input` (numeric thresholds, model filter), `ctx.ui.confirm` (stale-lock repair). Blocking; transient.
- **Dashboard widget** (extensions/widgets/goal-widget.ts + goal-dashboard-model.ts / goal-dashboard-renderer.ts; registered in extensions/goal-state.ts:672/703 via `ctx.ui.setWidget(GOAL_WIDGET_KEY, factory, {placement:"aboveEditor"})`) — persistent above-editor component, compact + expanded modes; Ctrl+Shift+T toggle, scroll keys, Ctrl+Shift+A unfocus; non-blocking; read-only surface over persisted goal state.
- **Statusbar hints / unfocused banner** (extensions/goal-state.ts:664,672 — `ctx.ui.setStatus("goal", ...)`) — transient one-line status text.
- **Task-list overlay** (extensions/widgets/task-list-overlay.ts:34) — modal overlay listing tasks across goals; interactive cursor + Enter toggles a task, Escape dismisses; transient.
- **Auditor progress surface** — `AuditorWidgetProgress` (phase, percentage, label, recentOutput) rendered inside the dashboard while the completion auditor runs; non-blocking.
- **Message-rendered records** — `pi-goal-event` checkpoint entries and `pi-goal-audit-event` (extensions/goal-format.ts:27-28,149-168) are persisted custom messages rendered by `registerMessageRenderer` (extensions/goal.ts:30-31).

## 2. MAPPING

```ts
// extensions/goal-questionnaire.ts:8-15
GoalQuestionnaireQuestion { id, question, context?, options: string[], recommended?: number, allowCustom?: boolean }
// extensions/goal-record.ts:11-23
GoalTask { id, title, status: "pending"|"complete"|"skipped", completedAt?, skippedAt?,
  evidence?, skipReason?, verificationContract?, lightweightSubtasks?, subtasks?: GoalTask[] }
// extensions/goal-record.ts:35
GoalRecord { id, objective, status: GoalStatus, autoContinue, usage: {tokensUsed, activeSeconds},
  sisyphus, createdAt, updatedAt, pauseReason?, pauseSuggestedAction?, tokenBudget?,
  currentTaskId?, taskList?: GoalTaskList, scheduler?, verificationContract?, ... }
// extensions/widgets/goal-dashboard-model.ts:25-67
GoalDashboardModel { scheduling, goalId, title,
  status: {code, label, footerLabel, reason?, suggestedAction?}, focused, auditorEnabled,
  usage: {activeSeconds, tokens, footerBits}, budget?: {used,total,percentage,remaining},
  taskProgress?: {completed,total,percentage}, taskTree: DashboardTaskNode[],
  currentTask?: {id,title,depth,completedSubtasks,totalSubtasks,subtaskPercentage,
                 verificationContract?,evidence?,inferred?}, recentActivity }
// extensions/widgets/goal-widget.ts:70-80
AuditorWidgetProgress { currentTool?, recentOutput: string[],
  phase: "running"|"tool_executing"|"producing_report"|"thinking"|"done",
  elapsedMs, label?, percentage?, auditorLabel? }
// extensions/goal-scheduler-state.ts:4-16
GoalWait { id, token, reason, deadline: number, intervalMs?, remainingChecks?, nextCheckAt?, signalled? }
```

| Kind | text | options | fields | diff |
|---|---|---|---|---|
| Questionnaire | FULLY (question + context prose) | FULLY (options; `recommended` ≈ tone; `allowCustom` = free text) | PARTIAL (no per-question scalar `type`, options-only so mostly unneeded) | NOT |
| Task confirmation | FULLY (proposal text incl. rendered tree) | FULLY (2 choices) | NOT | NOT |
| Escape dialog | FULLY | FULLY (2 options + description) | NOT | NOT |
| Selector/settings | FULLY (titles) | FULLY (choice lists) | FULLY (inputs = string/number fields) | NOT |
| Dashboard widget | PARTIAL (renderable as prose, but it is a live structured surface) | NOT | PARTIAL (progress counters) | PARTIAL (task status changes are state transitions) |
| Statusbar/banner | FULLY | NOT | NOT | NOT |
| Checkpoint/audit messages | FULLY | NOT | NOT | PARTIAL |

## 3. GAPS (fall to JSON `details` fallback)

- **Progress/percentage + live phase**: `percentage`, `phase`, `elapsedMs`, `recentOutput[]` on AuditorWidgetProgress; `TaskProgress{completed,total,percentage}` and `subtaskPercentage` — no primitive expresses a live progress meter.
- **Subtask hierarchy**: recursive `GoalTask.subtasks` with depth/isCurrent/direct-child counts (DashboardTaskNode) — no tree/nesting primitive.
- **Deadlines / scheduled waits**: `GoalWait{deadline, intervalMs, remainingChecks}` — no timer/schedule primitive.
- **Per-item verification contracts & evidence**: `verificationContract` + `evidence` on GoalTask and GoalRecord, checked by auditor `AuditCheckState "pending"|"running"|"passed"|"failed"` (extensions/widgets/auditor-dashboard-model.ts:13).
- **Budget counters**: `GoalRecord.tokenBudget`, dashboard `budget{used,total,percentage,remaining}` — partially numeric-fields, but rendered as a gauge.

## 4. PERSISTENT STATE

- **Goal storage**: `.pi/goals/` (`GOALS_DIR`, extensions/storage/goal-files.ts), archived under `.pi/goals/archived/`; one JSON record per goal (`GoalRecord`, with `revision` monotonic counter and per-goal lock); append-only ledger `.pi/goals/goal_events.jsonl` (`GOAL_LEDGER_FILE`, extensions/goal-ledger.ts:10) with ~28 typed `GoalLedgerEvent` variants (created/paused/task_complete/audit_result/budget_limited/oracle_* …). Rendered by the dashboard widget; updated per turn and on every extension write (caches invalidated).
- **Focus state**: `GoalFocusEntry {version, storageRoot?, focusedGoalId, reason}` — drives the unfocused banner and "(+N open)" counts.
- **Settings**: goal-settings (keybindings, task/subtask depth, `hideUnfocusedBanner`) loaded per cwd.
- **Transcript records**: `pi-goal-event` / `pi-goal-audit-event` custom messages persisted in the session transcript with typed `details` (v2/v3 checkpoint shapes, extensions/goal-record.ts).
- Dialogs and overlays are NOT persisted; only their decisions enter the ledger.

## 5. VERDICT

Blocking-dialog volume (questionnaire, confirmations, escape, selectors, settings inputs) — the majority of *human-input* interactions — is ~80-90% covered by {text, options, fields}: these reduce to prose + choice lists + free-text/numeric input. However the extension's flagship surface is the always-visible dashboard, whose content (progress meters, phase, token/second counters, recursive task tree, deadlines, audit check states) maps to NONE of the four primitives and would degrade to opaque JSON.

Most valuable missing primitive: a **progress/status** primitive — e.g. `{label, phase?, percent?, counters?: {tokens?, seconds?}, items?: {done,total}, recentOutput?: string[]}` — motivated directly by `AuditorWidgetProgress` and `GoalDashboardModel.taskProgress/budget`. Second: a **tree** primitive for the recursive GoalTask hierarchy with status + current-task pointer. With progress alone, coverage rises to ~95%.
