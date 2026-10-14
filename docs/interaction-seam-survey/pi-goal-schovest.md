# pi-goal (@schovest/pi-goal) — interaction-shape inspection

Repo: `/tmp/pi-ext-inspect/schovest-mono/packages/pi-goal`. Port of `@narumitw/pi-goal` v0.52.2; feature-identical to upstream (README "Differences from upstream").

## 1. KINDS

**K1 — Goal manager menu** (TUI only; trigger `/goal` bare). Multi-screen wizard built with `@narumitw/pi-tui-kit` `defineMenu/runMenu` (`src/menu.ts:142`, screens: main / start-budget / start-custom-budget / increase-budget / safety / status / help; `GoalMenuScreen` menu.ts:36-43). Human sees titled action lists + guidance lines + status preview ("Automatic work: 12 of 25 responses"); navigates arrow keys/Enter/Escape, selects from items (`items: {id, label, description, action|to}` menu.ts:176-210), or types into `kind:"input"` screens (custom budget, menu.ts:219-224). Blocking while open; transient UI only. Non-TUI modes fall through to `commands.showGoal` notification (menu.ts:130-133).

**K2 — Confirmation dialogs** — `ctx.ui.confirm(title, body)` for replace-goal (commands.ts:59), clear (menu.ts:349), Unlimited-mode (settings-ui.ts:368), budget increase (menu.ts:351), lower-active-limit (settings-ui.ts:432), edit-replace (menu.ts:575,587). Human picks yes/no. Blocking; transient.

**K3 — Free-text editors/inputs** — `ctx.ui.editor(title, initial)` for objective entry/edit (menu.ts:469,484,571; settings-ui.ts:380), `ctx.ui.input` for numeric limits (settings-ui.ts:384). Blocking; transient.

**K4 — Status surface** — `ctx.ui.setStatus("goal", formatStatus(...))` (runtime.ts:509; STATUS_KEY="goal" runtime.ts:105). Compact string e.g. `active 18k/100k · automatic 12/25`, `blocked · automatic 12/25` (`formatStatus` runtime.ts:1278-1311). Non-blocking; transient statusline, continuously updated on every state transition; cleared on completion/clear (runtime.ts:1090,1151-1155).

**K5 — Notifications** — `ui.notify(message, level: info|warning|error)` via `notifyTerminal` (errors.ts:57-62), truncated to 160 chars (`truncateNotification` errors.ts:71-74). Non-blocking; transient.

**K6 — RPC state events** — managed-run protocol `pi-goal:event:${runId}` payloads `{type:"state",runId,goalId,status,summary?,reason?}` / `{type:"error",...,error:{code,message}}` (run-protocol.ts:27-41). Programmatic, not human-facing directly; non-blocking; ephemeral event bus.

Agent-facing tools (`goal_complete{goal_id,summary}`, `goal_blocked{goal_id,reason,evidence,repeated_turns}`, `goal_wait{goal_id,reason,resume_after_ms?}` — tools.ts:33-50) are model inputs, not human interactions, but they *cause* the blocked/paused status surfaces (K4).

## 2. MAPPING

| Kind | text | options | fields | diff |
|---|---|---|---|---|
| K1 menu | PARTIAL (title/guidance lines = prose) | FULL for action screens (`items[]` ≈ options {id,label}; extra `description` + `to` navigation) | PARTIAL for `kind:"input"` screens (single string field) | NOT AT ALL |
| K2 confirm | FULL (title+body prose) | FULL (2 options + tone≈warning) | — | — |
| K3 editor/input | FULL (prose body) | — | FULL-ish (one field: name/title, type string/number, required) | — |
| K4 status | PARTIAL (it *is* a formatted string, but semantically a {status, tokensUsed, tokenBudget, automaticModelTurns, limit, waiting?} record flattened to text) | — | — | NOT AT ALL |
| K5 notify | FULL | — | — | — |
| K6 events | PARTIAL | — | — | NOT AT ALL (structured JSON) |

## 3. GAPS (→ JSON fallback)

- Menu **navigation structure**: `to: "start-custom-budget"`, `close: true`, `description` per item, screen `kind: "actions"|"input"|"detail"` (menu.ts:176-230) — multi-screen flow, not flat options.
- Status **structured fields**: `formatStatus` flattens `goal.status | waiting.reason | formatBudget | automaticModelTurns/limit` (runtime.ts:1278-1311); machine-readable shape exists only in the `ActiveGoal` type.
- RPC payloads: `error.code` enum + `summary`/`reason` fields (run-protocol.ts:27-41).
- Goal state itself (see §4): numeric counters, ISO timestamps, `safetyPauseCause`, `waiting.resumeAt` — none fit text/options/fields/diff.

## 4. PERSISTENT STATE

- **Session-persisted goal record**: `ActiveGoal {id, text, status, startedAt, updatedAt, iteration, tokenBudget?, tokensUsed, timeUsedSeconds, baselineTokens, activeStartedAt?, automaticModelTurns, toolFreeRepeatCount, lastToolFreeOutputFingerprint?, safetyPauseCause?, waiting?: GoalWait}` (`src/persistence.ts:13-27`). Stored as a Pi session custom entry `customType:"goal-state"` via `this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(goal))` (runtime.ts:1059-1068; persistence.ts:9,55-66). Survives reload/compaction; rendered by pi-goal itself in menu/status; updated on every transition.
- **Legacy global file**: `~/.pi/agent/pi-goal-state.json` keyed by cwd — write-only legacy; no longer read; `/goal clear` removes the entry (persistence.ts:10; README "Session and reload behavior").
- **Settings file**: `~/.pi/agent/pi-goal.json` — `{toolVisibility, rpc:{enabled}, continuationLimits:{automaticTurns,noProgressTurns}}` (README Configuration; src/settings.ts). User-editable + Settings UI; read at startup/reload.
- **Statusline**: transient `ctx.ui.setStatus` string (K4), re-emitted per transition, consumed by statusline extensions like `@narumitw/pi-statusline`.

## 5. VERDICT

Estimated coverage of *human-interaction volume* by {text, options, fields, diff}: **~80-85%**. The extension is dialog-heavy and deliberately text-centric: confirms, notifies, editors, and flat action menus map cleanly onto text+options(+one-field forms). No diffs anywhere.

**Most valuable missing primitive**: a **status/metric widget** — a persistent, keyed, machine-readable status line `{key:"goal", status, counters:{used,limit}, budget?:{used,total}, waiting?}`. Today it exists only as a pre-formatted string (`formatStatus`) flattened into `ctx.ui.setStatus`, and the underlying `ActiveGoal` record is the real payload; a generic pending-interaction record that can carry a live, updatable structured status would cover K4 exactly and remove the biggest fallback class. Second (smaller): menu *navigation* (`to`/screen graph) if wizards must round-trip, though they degrade acceptably to flat options + text.
