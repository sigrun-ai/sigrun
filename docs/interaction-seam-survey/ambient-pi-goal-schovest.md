# pi-goal — Ambient-Surfaces Inspection

## 1. SURFACES
This extension has exactly **one ambient surface: a single keyed statusline slot.** No widgets, overlays, banners, or dashboards exist. (`/goal`, budget chooser, recovery preview in `src/menu.ts` are interactive dialogs/prompts — out of scope.)

- **Statusline `goal`** (`STATUS_KEY = "goal"`, `src/runtime.ts:105`):
  - **Trigger:** every goal-state mutation. Set via `ctx.ui.setStatus(STATUS_KEY, formatStatus(...))` at `updateStatus` (`src/runtime.ts:507-510`), cleared to `undefined` on clear/remove (`runtime.ts:1090`; `src/lifecycle.ts:76,107,131`), set to literal `"complete"` then cleared by a **one-shot 8s timer** (`showCompletionStatus`, `runtime.ts:1149-1159`).
  - **Placement:** statusbar key slot (pi `ui.setStatus` API, one line per key; rendered by external statusline extensions, e.g. `@narumitw/pi-statusline` adds the 🎯 icon — README "Statusline states").
  - **Size/budget:** one bounded text string; waiting reason sanitized + capped (`safeGoalMenuText`, 160-char notification truncation applies to notifies, status text bounded by `MAX_GOAL_WAIT_REASON_LENGTH=1000` before sanitize/truncate).
  - **Update cadence:** event-driven only, near-immediate after each lifecycle event — `message_end`/tool events (`lifecycle.ts:317-321`), `turn_end`/`agent_end` (`lifecycle.ts:401-414`), `session_start`, `session_before_compact`, `session_compact`, wait-deadline fires, budget/safety pauses. No polling/animation.
  - **Persistence medium of the backing state:** pi session **custom entries** — `pi.appendEntry("goal-state", {goal})` (`persistGoal`, `runtime.ts:1059-1064`; entry type `GOAL_STATE_ENTRY_TYPE="goal-state"`, `runtime.ts:106`). Legacy global file `~/.pi/agent/pi-goal-state.json` is no longer read; only legacy entries are deleted by `/goal clear` (`src/persistence.ts`, `clearLegacyPersistedGoal`).
  - **Survival:** full — restores across `/reload`, session reopen, and compaction (`session.restore` listener re-hydrates then re-calls `updateStatus`, `lifecycle.ts:103`; auto-turn counts, repeat fingerprints, safety-pause causes persist, README "Compaction & shutdown"). RPC event publish (`GoalStateSnapshot`, `runtime.ts:112`) is in-memory `pi.events.emit` to subscriber extensions only — not a visible surface.

## 2. DATA MODEL
```ts
// src/persistence.ts:18-35
export interface ActiveGoal {
  id: string; text: string; status: GoalStatus;      // GoalStatus: active|queued|paused|blocked|usage_limited|budget_limited|complete
  startedAt: number; updatedAt: number; iteration: number;
  tokenBudget?: number; tokensUsed: number; timeUsedSeconds: number;
  baselineTokens: number; activeStartedAt?: number;
  automaticModelTurns: number; toolFreeRepeatCount: number;
  lastToolFreeOutputFingerprint?: string;
  safetyPauseCause?: "continuation_limit" | "no_progress";
  safetyResetPending?: boolean;
  waiting?: { reason: string; resumeAt?: number };   // GoalWait, src/wait.ts:1-5
}
// session entry: { type: "custom", customType: "goal-state", data: { goal: ActiveGoal | null } }
```
Displayed value is a pre-generated **plain string**: `formatStatus(goal, automaticTurnLimit)` (`runtime.ts:1278-1307`) → `"active 18k/100k · automatic 12/25"`, `"waiting <reason> · automatic 12/25"`, `"paused · automatic limit 25/25"`, `"budget 100k/100k · automatic 12/25"`, `"complete"` etc.

## 3. INTERACTIVITY
**None.** The statusline slot is read-only text; no keybinds, click, collapse, or navigation are attached. All state editing happens through `/goal` commands and dialog-based flows (`ctx.ui.confirm/editor` in `src/menu.ts`, `src/commands.ts:59`). Human only *reads* the surface; status edits are self-croted by the extension or via dialogs.

## 4. MAPPING
- Statusline `goal` slot → **A (statusline text {key, text}) FULLY.** Format is exactly a keyed one-line text slot.
- B (widget rows): **NOT** — no row list surface; would over-generate nothing.
- C (gauge/progress): **PARTIAL** — no gauge is rendered, but the payload *contains* gauge data flattened into text: `{tokensUsed}/{tokenBudget}` (progress `{done,total}` equivalent), elapsed `3m`, iteration counts. Backing `ActiveGoal` supplies percent-capable numbers; the surface shows only text.
- D (tree/list): **NOT** — single item, no deps/depth (legacy queue support was dropped).
- Opaque fallback: none needed — the string is already formatStatus output; if richer rendering existed it would need GoalStateSnapshot events, which omit tokens/iteration (only `{goalId, status, summary?, reason?}`).

## 5. VERDICT
**~100% of ambient-surface content is covered by {A} alone** (the sole surface is a keyed status string). Adding B/C/D would cover nothing; they are latent capacities hidden inside `ActiveGoal` (tokensUsed/tokenBudget ≈ C's progress, iteration/automaticModelTurns ≈ metrics). Most valuable missing primitive: none required by the surface itself — but if pi-goal ever wanted richer display, **C gauge with {label, progress {done,total}, elapsed}** would let the statusline render `18k/100k` as a meter instead of reparsing text; the motivating payload is already in ActiveGoal. The human never acts ON the surface — purely read-only; all action routes to `/goal` dialogs.
