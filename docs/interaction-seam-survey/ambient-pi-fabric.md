# pi-fabric — Ambient-Surfaces Inspection (bf87045b task-3)

## 1. SURFACES

**W1. Above-editor status widget** (`src/ui/widget.ts`, `FabricWidget`; registered via `ui.setWidget(WIDGET_ID, …, { placement: "aboveEditor" })` in `src/ui/controller.ts:868-896`; id WIDGET_ID).
- Trigger: `shouldShowFabricWidget` (widget.ts) — active agents/actors/shells, or a run finished after `widgetDismissedAt`; mode `auto|always|hidden` (`src/config.ts:53,1286`).
- Budget: `maxRows` (default 6, clamped 1-20, `config.ts:570,1287`) bounded by `WIDGET_TERMINAL_ROW_SHARE` = 0.5 of terminal rows (`widgetRowLimit`); expanded pane bumps to full half-share (`widgetExpandedRowLimit`); activity pane `WIDGET_ACTIVITY_ROWS`=12 (`widget-activity.ts:11`).
- Cadence: snapshot poll `refreshMs` default 500ms (`config.ts:571`); render is diff-cached (`hasChanged`, `#lastLines`).
- Persistence: in-memory snapshot only (`#snapshot`, poll loop in controller.ts); **no session entries, no file** — dies on restart; contents re-derived from live runtime state (agents/actors/mesh/activity store). Survival across /reload/restart: not durable per se.
- Header line carries a dismiss/complete-gate via `snapshot.widgetDismissedAt`.

**W2. Statusline slots** — `ctx.ui.setStatus(key, text)` with key `"fabric-prewalk"` (`src/prewalk/{return.ts,handoff.ts,arm.ts}`, cleared in `fabric-state.ts:201`, `fabric-runtime-state.ts:396,1143`). One keyed one-line slot, transient text, no persistence.

**W3. Dashboard overlay** (`src/ui/dashboard.ts`, opened via `ui.custom(..., { overlay: true, overlayOptions: { width: "94%", maxHeight: "90%", anchor: "center", margin: 1 } })` controller.ts:688-694; also 94%/90% for tasks view at controller.ts:267). Full TUI: panes (phases/entities, `dashboard-model.ts:65-172`), filters, detail views (summary/transcript), graph panel, modals, openers for actor model/instructions editors. Read from same snapshot; actions write back through controller callbacks (steer/follow-up/stop/setModel/instructions — controller.ts:510-686).

**W4. Shell-tasks overlay** (`src/ui/shell-tasks.ts`): `Fabric · shell tasks` overlay for background jobs; height-clamped (`slice(0, height)`), keys ↑↓/pg/G tail, "x×2 stop". In-memory job list.

**W5. Conversation overlay** (controller.ts:306, overlay 100%/100% anchor top-left, controller.ts:454-455) — full-screen chat with one agent (native-reader replay layer). Out of scope for primitives but an ambient overlay surface.

Overlay compositing is patched at runtime by `retainImageSafeOverlays` (`src/ui/image-overlays.ts`) — leases host compositor prototypes while overlays are open (kitty-image z-order workaround). No banner/banner surface; the package.json `pi.image` is install-time metadata only.

## 2. DATA MODEL (canonical source: `src/activity/types.ts` and `src/ui/types.ts`)

```ts
// ui/types.ts
FabricUiAgent { id, name, status: string, currentTool?, toolCalls?, usage?: AgentUsage,
  startedAt?, finishedAt?, error?, text?, nestingDepth?, runId?, ... }
FabricUiActor extends FabricActorInfo { instructions, recentMessages, worker?: FabricUiAgent }
FabricUiStateEntry { key, label, status, owner?, detail?, value, version, updatedAt }
FabricDashboardSnapshot { now, widgetDismissedAt?, runs, main, peers, agents, actors,
  componentGraph, globalActors, state, events, shells? }
// activity/types.ts
FabricActivityCall { id, ref, label, kind, status, phaseId?, metrics?: {tokens?,toolCalls?,cost?}, progress?, ... }
FabricActivityItem { id, label, status, kind, phaseId?, detail?, current?, total?, completed? }
FabricActivityPhase { id, name, status, total? } ; FabricRunStatus = running|completed|failed|cancelled
FabricActivityStatus = pending|running|completed|failed|blocked|stopped
```
Widget rows: `FabricWidgetRow { id, kind: "agent"|"actor", name }` (widget.ts:57).

## 3. INTERACTIVITY

- **Widget** (`Focusable` + mouse): full nav — ↑↓/j/k select, Enter/Space toggle expand, Esc collapse/focus-release (`FabricWidgetInteraction.release(forward)` returns key to editor), PgUp/PgDn/End/G + wheel scroll the expanded activity pane; click focuses/toggles a row; unfocused rows not selectable (`#selectableRows`). READ-ONLY state — it never mutates runtime; only dismiss/visual state (`widgetDismissedAt` gate is external). Toast hint promotes `/fabric tasks` / ctrl+alt+t conversation shortcuts.
- **Dashboard/tasks overlays**: genuinely EDIT state — steer ("s")/follow-up message editor, agent stop, actor model pin, instructions editor, stop-confirm with expiry (`pendingStop`). Keys via `matchesKey` + keybinding `app.tools.expand`; graph has pan/zoom camera effects.
- **setStatus**: no interaction; read-only transient text.

## 4. MAPPING to candidates A statusline / B widget-rows / C gauge / D tree-list

- **Statusline slots (W2)**: covered FULLY by **A**: exactly `{key,text}`.
- **Widget (W1)**: header line ≈ a keyed status row (A PARTIALLY — but it includes computed aggregates: counts, tokens/cost totals, elapsed, phase progress `n/m`). Participant rows ≈ **B (FULL)**: `{id, kind, label, statusGlyph, detail (currentTool/error), metrics {toolCalls, tokens, cost, duration}}`; agent `nestingDepth` indentation ≈ D depth. Header phase progress `n/m` ≈ B `progress:{done,total}` / C percent. Expanded activity pane (live transcript log with scroll) is NOT covered — falls to **opaque fallback** (rich scrollable diff-rendered text pane, live file-log tail `log-tail.ts` + `transcript.ts`).
- **Dashboard (W3)**: rows/lists ≈ B/D PARTIALLY; detail summary, topology graph, transcript paging, modals, editors = opaque fallback.
- **Shell-tasks overlay (W4)** ≈ B rows (label/status/elapsed/description) PARTIAL; tail/text clipping opaque.

## 5. VERDICT

Coverage of ambient-surface content by {A, B, C-gauge, D}: roughly **70%** (status slots and widget rows/gauges dominate the always-visible real estate; the widget's expanded live-activity pane, dashboard detail/graph/transcript views, and message editors are opaque). Humans DO act on surfaces: steer/follow-up/stop/input-model/instructions through the dashboard and tasks overlays — but the always-on widget itself is strictly read-only. **Most valuable missing primitive**: a **scrollable live-log/expanded-pane element** (`{id, lines|stream-ref, follow, viewportRows, parity: 'live'|'↑N-scroll'}` — motivating payload: the widget's inline activity pane with `live` vs `↑N` position marker, 600 log lines, thinking-hiding, per-row expansion) — nothing else in the closed set expresses a stateful follow/tail text viewport. Secondary gap: an **interactive-select modal/prompt component for row-level actions** (steer/stop editors) if interactivity is ever spec'd, but per the brief's read-first promise an opaque fallback is an acceptable bucket for it.
