# rpiv-todo — Ambient Surfaces Inspection (recon-only, no code executed)

## 1. SURFACES

The extension has exactly **one ambient surface** plus display echoes; no statuslines, banners, dashboards, or modal overlays exist anywhere in the package (grep for `statusline`/`setStatus`/`banner` returns nothing).

**Todo overlay widget** (`todo-overlay.ts`, widget key `rpiv-todos`)
- **Trigger/placement**: registered via `pi.setWidget(key, renderFn, { placement: "aboveEditor" })` — persistent above-editor panel. Mounted lazily on first foreground `session_start` with a UI; registered only while ≥1 visible task exists (**auto register/unregister**: self-unregisters via `setWidget(key, undefined)` when the list empties, re-registers on reappearance — `update()`, todo-overlay.ts:44-76). Disposed on foreground `session_shutdown` (`dispose()`, index.ts:229-249).
- **Size/budget**: content-row budget `maxWidgetLines` default 12 (floor 3, no ceiling, read fresh per render, config.ts:41-50) + always-appended trailing spacer row = up to 13 terminal lines. Pi's global tool-output-expansion mode (`ctrl+o`) temporarily lifts the budget to show all tasks (`this.uiCtx?.getToolsExpanded?.()`, todo-overlay.ts:154).
- **Update trigger + cadence**: event-driven, no timers. `tool_execution_end` for tool `todo` (index.ts:252-266), `session_start`/`session_compact`/`session_tree` (branch replay via `replayFromBranch`), `agent_start` (hides previous turn's completed rows — `hideCompletedTasksFromPreviousTurn`, todo-overlay.ts:81-94). Renders on `tui.requestRender()` (forced full-redraw `requestRender(true)` only on collapsed↔expand height step, todo-overlay.ts:97-101).
- **Persistence medium**: **session custom entries** — every state-changing `todo` call appends `pi.appendEntry("rpiv-todo-state", details)` (task snapshot) to the session branch (todo.ts:89-90), however the tool was reached (incl. codemode `ctx.executeTool`). State is replayed from the branch into per-sid in-memory store slots (`state/store.ts`). **No disk writes, no files.**
- **Survival**: survives `/reload` and **compaction** (branch is replayed on `session_start`/`session_compact`; completed-display tracking resets). Not meaningful across restarts beyond the transcript itself. Parallel sessions: sibling/child sids never repaint the foreground overlay (sid-gated, index.ts:199-214).

Secondary rendered output (not ambient surfaces): `/todos` slash command prints a grouped text listing (`todo.ts`, sections Pending/In Progress/Completed); `renderCall`/`renderResult` echo status glyphs in tool output — these are ordinary tool-call rendering, not widgets.

## 2. DATA MODEL

```ts
// tool/types.ts
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;          // present-continuous spinner label while in_progress
  status: TaskStatus;
  blockedBy?: number[];         // dependencies, cycle-validated (state/task-graph.ts)
  owner?: string;
  metadata?: Record<string, unknown>;
}
export interface TaskDetails {   // replay snapshot (persisted entry)
  action: TaskAction;            // create|update|list|get|delete|clear
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
}
// state/state.ts
export interface TaskState { tasks: Task[]; nextId: number; }
```

Render-side state is minimal: `collapsed: boolean` + `hiddenCompletedTaskIds` display tracking (todo-overlay.ts private fields). Widget callback shape: `{ render(width) => string[], invalidate() }` with `placement: "aboveEditor"`.

## 3. INTERACTIVITY

- **One key handler**: a single collapse/expand shortcut (`collapseKey`, default `ctrl+shift+t`, `"off"` disables; resolved once at load, `/reload` rebinds; `pi.registerShortcut(collapseKey, ...)` in index.ts:145-160). Collapsed view = heading + dim `└─ "{key} to expand"` hint (2 rows).
- **No click/mouse, no navigation, no row selection.** Pi's global tool-output expansion shortcut affects the budget indirectly.
- **Read-only for the human**: the surface is a view; all state changes flow through the agent's `todo` tool calls. The human toggles visibility (collapse) and reads — never edits tasks through the widget.

## 4. MAPPING to candidate primitives

| Surface | A statusline | B rows | C gauge | D tree |
|---|---|---|---|---|
| Overlay heading `● Todos (2/5)` | partial (keyed slot could carry it, but here fused into panel) | — | partial (label + counts; no percent/phase) | — |
| Task rows (glyph + subject + activeForm + `⛓ deps` + `#id`) | not | **FULLY** — {id, label, statusEnum (4-state), spinnerLabel≈activeForm, deps ids} | — | **near-full** |
| Overflow line `+3 more (2 completed, 1 pending)` | not | partial (envelope collapse semantics should own it; here counts computed from layout) | — | — |
| deps `⛓ #1,#2` markers + `#id` visibility gating | — | partial | — | **FULLY** — deps: ids[] + depth-agnostic flat list |

`deleted` is a tombstone status that overlays never render (filter). No percent/progress anywhere; `activeForm` ≈ `spinnerLabel`; `blockedBy` ≈ `deps?: ids[]`. Nothing needs an opaque fallback — the widget is B+D expressible with a per-row glyph/status enum and deps markers, plus one envelope rule (overflow summary computed by the extension today; primitives only guarantee "collapse semantics", placement/budget riding the envelope).

## 5. VERDICT

**~95%** of the ambient-surface content is covered by the {A,B,C,D} set — practically 100% of the *rows* body via B+D; the C gauge is unused (no percent/elapsed/phase concepts at all), and A is unused (no statusline slot). The two extension-owned rendering details the primitives must accommodate: (1) semantic row-budget overflow policy — drop completed first, newest first, then truncate unfinished tail, then `+N more (X completed, Y pending)` — stronger than plain "collapse"; (2) auto hide-on-empty + completed-rows-fade-after-turn display policy (transient, not state). **Most valuable missing primitive**: none in shape terms — the gap is *envelope* semantics: a per-widget row-budget + overflow-summary slot (e.g. `overflow: {max, hiddenByBucket}`) so extensions don't hand-roll layout math; motivating payload: cheapest-model ordering + completed/pending split summarization, currently 60+ lines of custom `selectOverlayLayout` logic. The human never acts ON the surface except toggling its visibility (collapse key); there is no human edit path.
