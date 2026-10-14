# pi-warden — user-interaction shape inspection

## 1. KINDS

**Confirm dialog (hold)** — trigger: tool call judged irreversible or pattern-matched in `confirm` mode (src/extension.ts:2198,2218,3452). Human sees title `warden: allow this <tool> call?` plus `confirmMessage(verdict)` prose: command/path/input, `Why: reasons`, Jev scores (src/extension.ts:306-316). Human picks Yes/No. **Blocking**. Outcome persists (holds jsonl + sqlite).

**Steer message** — trigger: guard violation not held (rules/slop/done/stuck/cause). Agent gets `pi.sendMessage({customType:"pi-warden-steer"...})` (src/extension.ts:1031); transcript-visible if `steerVisible`. Human does nothing (agent self-corrects). Non-blocking. Transcript record.

**Toast/notice** — trigger: slop, rules, security, sensitive path, stuck, blocked, runaway, config warnings. `ctx.ui.notify(text, level)` (src/extension.ts:2082,2109,1774). Human sees transient popup. Non-blocking, UI-only.

**Trace sidebar** — trigger: `/warden trace`, shortcut, or widget click. `TracePanel` overlay, newest-first verdict lines with status chips (src/panel.ts:14-100). Keyboard scroll/clear/close. Non-blocking. Session-transient; jsonl only if `PI_WARDEN_TRACE_DIR` set (src/trace-file.ts:23-32).

**Status widget** — always-on guard verdict stack above/below editor, one line per guard with colored chip (src/widget-render.ts:27); click opens trace panel. Non-blocking.

**Config panel** — `/warden set`: editable rows of boolean/number/string/select values (src/panel.ts:196-206). Semi-blocking overlay. Writes pi-warden.json (persistent).

**Consent dialogs** — `/warden enable|init|audit|test|index` confirmations (src/extension.ts:3302,3358,3398,3438,3482). Yes/No, blocking during command.

**Desktop notification + herdr pane state** — fire-and-forget side effects of holds/dialogs/runaway (src/extension.ts:1141-1155). Non-blocking, transient.

**Open-loops message** — agent promises via `warden_loops` tool; injected text on resume (src/extension.ts:640-660, loops.ts:27-33 `Loop {id,text,when?,status}`). Agent closes with tool. Persistent session JSON.

## 2. MAPPING

- **Confirm dialog** — PARTIAL: body is flattened prose (confirmMessage); approve/deny is implicit `options[]`; verdict internals (scores, reasons[]) lost.
- **Steers, toasts, desktop, herdr, consent dialogs** — FULL via `text`.
- **Trace sidebar + widget** — NOT COVERED: entries `{line, guard, details[]}` parsed into chip + key·value segments (`parseVerdictLine`, `LEVEL_COLOR`, template tokens, src/widget.ts). Structured, not prose.
- **Stuck diff note** — FULL via `diff`: `stuckDiff(previous, current, {diffLimit, tailLimit, fullPath})` unified line diff (src/stuck.ts:341-429); `AttemptChange {path, added, removed, diff}` (src/stuck.ts:38-43).
- **Open loops** — PARTIAL: text-listable but status enum (`open|done|dropped`) needs more.
- **Config panel** — PARTIAL via `fields[]`; select options are schema-linked enums.

## 3. GAPS (JSON fallback)

- Trace entry: `{status, body: Segment[]}` where each segment is `label·value` token pairs (e.g. `irreversible 0.92`) — src/widget.ts. Powers chips/colors; not prose.
- Hold ledger: `CallRecord {held, outcome: approved|declined|replanned|abandoned|regretted|accepted|pending, outcomeVia, mode, regret?}` + `HoldSnapshot` counters + `precision` (src/holds.ts:67-82,241-276). Stateful outcome record.
- ConfigRow: `{path, label, level, value, editable, type, options}` — enumerated select values exceed `{id,label,tone}` (src/panel.ts:196-206).
- Loop: `{id, text, when?, status}` (src/loops.ts:27-33).
- Rule findings: `findings[].{name, violation}` float scores (src/extension.ts:2109,2864).

## 4. PERSISTENT STATE

- **Widget**: repainted per verdict via `setWidget` (src/extension.ts:821-866); no storage.
- **Trace sidebar**: in-memory emitter; optional `<PI_WARDEN_TRACE_DIR>/<session>.jsonl` (src/trace-file.ts:23-32).
- **Loops**: `<agent dir>/pi-warden/loops/<sha12(cwd)>/<session>.json`, updated per warden_loops call, re-announced on resume (src/loops.ts:53-55; extension.ts:640-660).
- **Hold log**: `<agent dir>/pi-warden/holds/<date>-<session>.jsonl`; outcome relabelled after user reply / next prompt (src/holds.ts:341-345,160-204).
- **Learning DB**: SQLite under Pi agent dir; redacted hold context, 365d hold / 90d allowed retention; read by `/warden recommend` (docs/data-handling.md:14).

## 5. VERDICT

~75-80% of interaction volume covered by {text, options, fields, diff}. Remaining 20-25% (trace/widget token-line, hold-outcome ledger, loop status, config select enums, finding scores) needs JSON fallback because it is structured, stateful, color-chipped, or enumerated.

**Most valuable missing primitive**: a **`tokens[]` segmented colored line** (label·value pairs + semantic level), motivated by `parseVerdictLine`'s `{status, segments}` and `WidgetEntry {guard, line}` + `LEVEL_COLOR` (src/widget.ts, src/widget-render.ts:8) — it powers the highest-density persistent surface (always-visible widget + trace sidebar). Secondary: stateful enum record (loop status, hold outcome).
