# pi-goal-x — Ambient Surfaces Inspection (recon only)

## 1. SURFACES

| Surface | Trigger | Placement / budget | Update trigger + cadence | Persistence | Survival |
|---|---|---|---|---|---|
| **Goal dashboard widget** (`GOAL_WIDGET_KEY="goal"`, reg once via `ctx.ui.setWidget(...,{placement:"aboveEditor"})` goal-state.ts:672,703) | Active OR unfocused goals exist | aboveEditor; compact = width-bucketed task rows (§5.5: ≥100w→5 rows, 70–99→4, 50–69→3, else 2; `compactTaskViewportRows`); expanded replaces compact (~24 lines); hard cap `terminalRows − WIDGET_HEIGHT_RESERVE(6)` with a **sticky per-regime height latch** (applyStableHeightBound: head-slice growth / blank-pad shrink, resets on regime change/resize) | State change → coalesced microtask flush (`updateUI` P1-9); deliberate **no periodic render** except when live accounting or the audit spinner is on (80ms `auditAnimationTimer` for elapsed/spinner) | None for the surface itself; all facts derived from `.pi/goals/*.md` + session custom entries (`pi-goal-focus`, `pi-goal-state`, `pi-goal-event`, `pi-goal-audit-event`) | On reload/restart `loadState` rebuilds via `readActiveGoalPoolAsync` + session-entry scan; expanded toggle (`dashboardExpanded`, core-owned) survives re-instantiation but is not persisted |
| **Statusline slot** `ctx.ui.setStatus("goal", …)` | goal-state.ts:573,670,700 — only the **unfocused hint** (`goal: unfocused [N open] - /goal-focus`); cleared whenever a goal is focused (widget is the single home for status) | statusbar keyed slot, 1 line | Same coalesced render flush | none | none |
| **Unfocused banner panel** (`renderUnfocusedDashboard` renderer:584) | Open goals but none focused, unless `hideUnfocusedBanner` setting (goal-state.ts:660) | aboveEditor widget branch, 3–4 lines | Any state change | none | none |
| **Task-list overlay** (`showTaskListOverlay`, task-list-overlay.ts; still live as the debug task overlay chord) | Ctrl+Shift+T (debug/debug-overlay path, goal-widget.ts:473) | modal overlay: center, width 80% (min 60), maxHeight 80% | User keys | none (reads pool) | none |
| **Auditor dashboard** (replaces normal widget content, §15.3; `renderAuditorWidgetLines`:297) | `auditProgress != null` during completion audit | same aboveEditor widget; 5 check rows + progress bar + elapsed + optional diagnostics | `onProgress` callbacks from auditor session events + 80ms animation timer | in-memory only (`core.auditProgress`); audit verdicts durable via `pi-goal-audit-event` ledger | none (null on finish/cancel) |
| **Audit result card** (§15.4, `setAuditResult` goal-state.ts:234) | audit finishes | aboveEditor widget, card | once + auto-clear after **6000ms** timer | none (short-lived foreground display) | none |

## 2. DATA MODEL

- **Widget records (in-memory, read via getters in `makeGoalWidgetFactory`, goal-widget.ts:79)**: `GoalWidgetRecord` (GoalRecord display clone + `taskList`, `currentTaskId`, `tokenBudget`); `AuditorWidgetProgress` {phase: "running"\|"tool_executing"\|"producing_report"\|"thinking"\|"done", elapsedMs, label?, percentage?, currentTool?, currentToolArgs?, currentToolStartedAt?, recentOutput: string[], auditorLabel?} (goal-widget.ts:93–105).
- **Canonical ambient model (pure, no TUI imports)**: `GoalDashboardModel` (goal-dashboard-model.ts:25–64): {scheduling: string[], goalId, title, status{code∈running\|idle\|paused\|blocked\|budget_limited\|complete, label, footerLabel, reason?, suggestedAction?}, focused, auditorEnabled, filePath?, usage{activeSeconds, tokens, footerBits}, budget?{used,total,percentage,remaining}, taskProgress?{completed,total,percentage}, taskTree: DashboardTaskNode[], currentTask?{id,title,depth,completedSubtasks,totalSubtasks,subtaskPercentage,verificationContract?,evidence?,inferred?}, goalVerificationContract?, otherOpenGoals, recentActivity: GoalActivityItem[]}. `DashboardTaskNode` {id,title,status∈pending\|complete\|skipped,depth,isCurrent,verificationContract?,evidence?,completedAt?,totalSubtasks,completedSubtasks}. Viewport struct `TaskListViewport` {totalRows,rows,offset,maxOffset,hiddenAbove,hiddenBelow}.
- **Auditor model**: `AuditorDashboardModel` (auditor-dashboard-model.ts:30–41): {auditorLabel, elapsedMs, percentage?, checks: AuditCheck[{id,label,state∈pending\|running\|passed\|failed,detail?}], currentTool?, currentToolArgs?, recentOutput: string[], verdict?, active}, plus `AuditResultCard`.
- **Overlay lines**: discriminated `LineEntry` (task-list-overlay.ts:16–22): separator | goal-header{icon,title,status} | task-summary | task{goalId,taskId,status,prefix,title} | empty-message.
- **Durable backing**: `GoalRecord`/`GoalTask` in `.pi/goals` files; ledger events as session custom entries.

## 3. INTERACTIVITY

- Dashboard widget: key-capture when focused — Ctrl+Shift+T toggle compact/expanded (expanded is modal: ↑↓/PgUp/PgDn/Home/End/Esc, `handleNavigationKey`:667); Ctrl+Shift+↑↓, ↑↓, PgUp/PgDn, Home/End scroll the compact task viewport (`handle...`:~645) with bottom-anchored default viewport (`anchoredScrollOffset` anchors on latest `completedAt`). Ctrl+Shift+A toggles the auditor (mutates goal settings!); Ctrl+Shift+X toggles debug. All chords configurable via `/goal-settings keybindings.dashboard`. **No mouse.**
- Task-list overlay: ↑↓/jk, PgUp/PgDn, Home/End scroll; 'a' toggles current vs all goals; **Enter toggles a task's status** (`toggleTaskViaService` mutation through goalService — human EDITS state); Esc/Enter dismiss. Cursor + warning message on failed toggle.
- Statusline / unfocused banner / auditor dashboard / result card: read only (auditor dashboard has no keys; result card auto-clears).

## 4. MAPPING to candidate primitives

- **Dashboard widget (compact + expanded) — PARTIALLY covered**: task tree = **D fully** (id/title/status enum/depth/isCurrent; completedSubtasks counts ≈ metrics, completedAt = per-row detail; scroll/collapse is envelope concern); budget row + task-progress bar + header bar = **B gauge**; current-task block with subtask ratio/percentage = **B gauge + B row**; status line = **A**.
- Falls to opaque fallback: `scheduling: string[]` (free-text lines); `recentActivity: GoalActivityItem[]` (typed ledger feed — icon/verb/kind, not plain rows); Blocker/Reason + Suggested-Action paired rows; File path; verificationContract/evidence text blocks; footer auditor-dot toggle state.
- **Auditor dashboard: PARTIALLY covered** — elapsed/percentage/phase/recentOutput/currentTool = **C gauge** explicitly (label, percent, phase, elapsed, recentOutput ✓); `checks[]` = **D tree/list** (status enum, no depth/deps). Falls opaque: result card (`AuditResultCard` verdict + freeform report lines) and currentToolArgs diagnostics.
- Statusline hints & unfocused banner: **A fully** (+ B row for the 3-line banner version, but A suffices as a keyed slot).
- Task-list overlay tree + summary: **D PARTIAL** (header/summary/empty-message entry kinds outside D).

## 5. VERDICT

**~70–75%** of ambient-surface content is covered by {A statusline, B row/gauge, C gauge, D tree/list}, with D+B doing most of the work; opaque fallback needs: scheduling summary lines, recent-activity feed (GoalActivityItem with kind/icon/verb), blocker+suggestedAction pairs, audit result card, auditor check-row detail strings.

**Most valuable missing primitive**: a **keyed detail-pair / block-row primitive** — `{label, text, tone?}` row (or grouped "fields" block) — motivating payload: Blocker/Suggested-Action pairs, File path line, verification contract/evidence quotes, and the audit result card all reduce cleanly to it; C-without-it forces these into opaque fallback that loses per-line tone (error vs dim) and truncation semantics.

**Human acts on the surface**: yes — Enter in the task overlay toggles task status through the service mutation boundary; Ctrl+Shift+A toggles the auditor from the widget. All other ambient surfaces are read-only.
