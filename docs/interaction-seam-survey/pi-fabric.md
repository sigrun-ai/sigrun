# pi-fabric user-interaction shapes

## 1. KINDS

1. **Permission (risk) dialogs** — trigger: `ApprovalController.approve()` when a fabric_exec action's risk class isn't granted (`src/core/approval-controller.ts:120-165, 218-293`). Human sees: notify "Fabric permission requested: <ref> needs <risk> access" + a bordered 🛡 panel (TUI `ui.custom` with DynamicBorder/SelectList) or plain `ui.select`; options: "Allow once" / "Allow <risk> access for this session" / "Deny", each with description text; cancel=deny (approval-controller.ts:235-289). Blocking; transient (session-only grant in `FabricSessionApprovals.approvedRisks`).
2. **Durable decisions** — trigger: program calls `fabric.decisions.raise` (`src/providers/decisions-provider.ts:38-70`), stored as `DecisionRecord` in mesh under `decisions/<id>` (`src/decisions/store.ts:11-60`) — kind approval/question/escalation, options `{id,label}`, input text|confirm|select|editor, holder user/root/supervisor, deadline, onExpire cancel/default/escalate, escalation chain, history. Human answers via `/fabric decisions` dialog (`src/decisions/command.ts`) or `pi-fabric decisions` CLI. Persistent (mesh CAS); NOT blocking the extending Pi unless the workload awaits `decisions.await`.
3. **Routed child dialogs** — child Pi's `extension_ui_request` (select/confirm/input/editor) relayed to parent AgentManager (`src/worker/questions.ts:14-31`: `ChildQuestionEvent {requestId, method, title, message?, options?, placeholder?, prefill?, timeout}`; caps: 16 pending, 1k title, 64 options, 24h timeout). Parent renders via dialogs; answered→`ui_response` steer. Blocking for the child; transient (child cancelled on timeout/parent death); headless answers come from durable decisions (`src/agents/types.ts:376-402`).
4. **Live status widget** — `context.ui.setWidget("pi-fabric", …, placement "aboveEditor")` (`src/ui/controller.ts:864-905`): rows of agents/actors with status glyphs (✓ ✗ ! ○ ·, `src/ui/widget.ts:30-40`), phase progress, tokens/cost; expandable via ctrl+shift+e into a transcript activity pane (`src/ui/widget-activity.ts`). Non-blocking, non-persistent (transient UI; hidden per `widgetDismissedAt`).
5. **Dashboard** — full-screen TUI (`/fabric dashboard`, `src/ui/dashboard.ts`, `dashboard-modal-controller.ts`) snapshot of `FabricDashboardSnapshot {runs, main, peers, agents, actors, componentGraph, state, events}` (`src/ui/types.ts:78-93`). Non-blocking; transient.
6. **Status line** — `ctx.ui.setStatus("fabric-prewalk", …)` handoff/prewalk/return messages (`src/extension.ts:733`, `src/prewalk/return.ts`, `src/fabric-exec-tool.ts:904-920`). Transient footer text.
7. **Notifications** — 187 `ui.notify(level info/success/warning/error)` call sites (progress, denials, "Allowed once", errors). Transient toasts.
8. **Conversation-message surfaces** — batched agent completions (`pi-fabric-agent-complete`, `src/agents/completion-inbox.ts:6-17`, custom messages with `details:{ids}`), shell-task awareness messages (`src/core/shell-inbox.ts:1-10`), thinking entries, peer presence, handoff-completion renderer, word-diff tool renders. Mostly agent-directed (not human-facing), persistent in the session transcript, non-blocking.
9. **Settings UI** — `/fabric settings` trees of `ui.select`/`ui.input` RPC paths (`src/ui/settings-rpc.ts:70-241`). Blocking, select/labels; free text.

## 2. MAPPING

- **Decision options** (`DecisionOption {id,label}`, decisions-provider schema `{id,label}` maxItems) → **options FULLY** (minus no tone field; tone absent).
- **Approval dialog** → options **PARTIAL**: 3 fixed options map, but option *descriptions* ("Run only this requested action"…) and the notification preamble (ref, risk, description, escalation reason) fall outside; no fields needed.
- **Child questions** → select = options PARTFULLY (plain string options, no ids); input/editor/confirm = **text** (placeholder/prefill/title fall to fallback); confirm = options PARTIAL (2-button).
- **Durable decisions with `input: text|confirm|select|editor`** → text = PARTIAL (no label/required/placeholder); fields NOT exercised — the extension never uses fielded forms.
- **Tool diff renders / word-diff** → **diff FULLY** (before/after in core-tool-render).
- **Notifications/status line** → text PARTIAL (level + source lost).
- **Widget, dashboard, activity, custom messages, settings tree navigation** → **NOT AT ALL** (live state, not prompt payloads). Tool render diffs: diff.

## 3. GAPS (fall to JSON fallback)

- `DecisionRecord.deadline?: number, onExpire: "cancel"|"default"|"escalate", defaultOptionId?, holder, escalation: {chain, hop, hopTimeoutMs, onFinal}, history: DecisionHistoryEntry[]` (store.ts:47-60) — expiry/escalation semantics.
- `ChildQuestionEvent {placeholder, prefill, timeout}` (questions.ts:14-31) — metered form hints.
- Per-option *descriptions* on approval SelectItems and notification `level ("info"|"success"|"warning"|"error")` (activity/types.ts:32-36; notify sites).
- `FabricWidgetRow`/activity data: `status, usage {input/output/cost}, phaseProgress {completed,total}, current/total/completed/progress` (activity/types.ts:40-79, widget.ts:47-56, ui/types.ts:78-93) — entirely outside the 4 primitives.
- Completion messages `details: {ids: string[]}` (completion-inbox.ts:11-13).

## 4. PERSISTENT STATE

- **Mesh store**: project `.pi/fabric/mesh/` (env `PI_FABRIC_MESH_ROOT` / `mesh.root` override, `src/fabric-state.ts:243-248`): `events.jsonl`, `state.json`, `sequence`, `generation`, `schedules.json`, plus `decisions/<id>` records. Rendered into dashboard/widget/status; updated on every event (CAS + append log).
- **Activity store** in-memory snapshot per run (runs/phases/calls/items with startedAt/updatedAt/finishedAt), NOT file-persisted; polled into the widget each render (controller.ts:846-870).
- **No todo/counter widgets or statusbars beyond the fabric-prewalk setStatus + the pi-fabric widget.**

## 5. VERDICT

Human-facing *blocking* volume (approvals, routed child dialogs, `/fabric decisions`, settings) is well covered: ~**70% of dialogs** map onto {text, options, diff} (options is the workhorse; diff only in tool renders). But by raw interaction-surface count pi-fabric is dominated by **live status surfaces** (widget, dashboard, status line, awareness messages) with no prompt-payload at all — call it **~30% of total interaction volume** covered by the 4 primitives; the widget/dashboard/activity stack is a control case.

**Most valuable missing primitive**: a **live status-row surface** (widget rows / activity entries): `{id, label, status: glyph/enum, detail, metrics {tokens?, cost?, current?, total?, completed?, phaseId?}, progress}` — exactly `FabricActivityItem` + `FabricWidgetRow` (src/activity/types.ts, widget.ts:47). A second-tier primitive: **option descriptions + notify level** (`{id,label,description}` + severity), motivated by approval-controller.ts:268-275 and notify levels.
