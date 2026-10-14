# pi-warden — Ambient Surfaces Inspection

## 1. SURFACES

**(S1) Status stack widget** — `ctx.ui.setWidget(WIDGET, renderer, { placement })` in `extension.ts:821-868`. Placement configurable: `aboveEditor` | `belowEditor` (`WIDGET_PLACEMENTS`, `widget.ts:5`). Size: variable stack of one-line verdicts; bodies wrap to pane width (`widget-render.ts` `widgetLines`, RAIL_MAX=10 chip column). Update: `record()` (`extension.ts:906-913`) fires per guard verdict — event-driven, no cadence. Persistence: **in-memory only** (`widget: Map<GuardName,string>`, `extension.ts`; cleared/re-set on every `paint`); survives /reload only via re-record — nothing persists across restart except messages. Two modes via `widget.barMode`: `stack` (one line per guard, latest-per-guard, quiet verdicts folded one-line-per-status) and `live` (single most recent entry re-rendered through sentence templates, `extension.ts:826-854`).

**(S2) Trace sidebar overlay** — `openTracePanel` (`panel.ts:157-173`), `ui.custom` floating component, `overlayOptions { anchor: "right-center", width: 40% (panelWidth), minWidth: 44, maxHeight: "100%", nonCapturing: true }`. Opens via: click on widget (MouseRegion, `extension.ts:830-861`), `ctrl+shift+w` shortcut (`extension.ts:2937-2939`), `/warden trace`. Live-updating: subscribes to `Trace` events (push/amend/clear), newest-first, detail lines under each entry. Backend store: in-memory `Trace` (limit 100, `trace.ts:27-66`); optional **file medium**: `PI_WARDEN_TRACE_DIR` → `<dir>/<session>.jsonl` append-only with full history (`trace-file.ts:6-34`; v1 session/judgments/entry/amend kinds). Trace file survives restart; in-memory trace does not.

**(S3) Config panel overlay** — `ConfigPanel` (`panel.ts:244+`), same `ui.custom` right-center overlay mechanics, opened by second widget-click (`toggleConfigPanel`, `extension.ts:814-818` — click toggles trace→config? no: click toggles trace, config toggle pairs with it) and `/warden config`. **Human edits state here**: cursor navigation, toggle booleans on enter, cycle selects (←→), text drafts, `s` persists to **user config file** (`writeUserConfig`, `panel.ts:464-477`) — the only surface through which a human writes state directly.

**(S4) Statusline-ish text slots** — (a) `/warden status` command prints arming summary incl. `arming.statusLine()` (`extension.ts:3056`, `arming.ts:172`) — a keyed one-line slot per arming rule set, transient chat text, no persistence. (b) Session custom messages `${PACKAGE_NAME}-status` sent when `ctx.hasUI` is false (headless hosts) (`extension.ts:675-700,1212`) — persisted as session messages via the host's session store. (c) Trial record via `pi.appendEntry(TRIAL_ENTRY_TYPE, record)` (`extension.ts:479`) — persisted in session custom entries.

**(S5) One-serving notices (banner-class)** — `ctx.ui.notify(text, level)` for guard warnings/blocks/runaways (`extension.ts:~1774,2082,2573,2909…`), fire-once, transient toast, no persistence.

## 2. DATA MODEL

- Widget entry: `WidgetEntry { guard: string; line: string }` (`widget-render.ts:6`). Underlying token map: `type Tokens = Record<string, string | undefined>` (`widget.ts:194`), filled by `{tool, level, status,…}` tokenizers per guard (`actionTokens`, `stuckTokens`, `doneTokens`, … in `widget.ts`) rendered through `" · "`-separated `{token}` templates (`DEFAULT_TEMPLATES` / `SENTENCE_TEMPLATES`, `widget.ts:56-66,116-…`).
- Trace: `TraceEntry { at: number; guard: GuardName; line: string; details: string[]; tokens?: Tokens }` (`trace.ts:9-15`); `GuardName` union of 12 guards. Trace-file JSONL shapes documented at `trace-file.ts:8-18`.
- Level color map: `LEVEL_COLOR: Record<status, theme-color>` with ~18 status chips (allow/ok/warn/unverified/nudged/confirm/deny/stuck/false claim/stopped/stopped, recovering/violation/skipped/wake/silent/appended silently/possible credentials/error) (`widget.ts:9-11`).
- Config panel row: `ConfigRow { path, label, level, value, editable }` + type variants boolean|number|string|select (`panel.ts:177-191`).
- Arming statusline: plain string from templates (`arming.ts:172`).

## 3. INTERACTIVITY

- Widget: read-only text; ONE interaction — left click opens the trace panel via MouseRegion (`extension.ts:840-845, 862-867`); degrades silently to pure text when host lacks MouseRegion (omp 18.2.5 note, `extension.ts:856-860`).
- Trace sidebar: read-only; focused key handling ↑↓/j/k/PgUp/PgDn/Home/End scroll, `d` detailed⇄compact, `c` **clears trace** (one mutating action — in-memory only), `q`/ctrl+c close, Esc unfocus, wheel scroll, click focus (`panel.ts:113-136`). Non-capturing: editor keeps working while visible.
- Config panel: fully interactive — edit/toggle/cycle/save config to disk (`panel.ts:343-477`).
- Statusline/notify surfaces: no input.

## 4. MAPPING to candidate primitives

- **(A) statusline `{key,text}`** — PARTIAL for S1: each widget line is exactly a keyed status slot (`guard` key → rendered line). FULLY covered for S4(a/b) and folded fold-rows. NOT covered: chip coloring per level, fold grouping by level, severity ordering — those need structured status, not a bare text (falls to a text-only fallback).
- **(B) widget rows {id,label,statusGlyph/enum,detail?,metrics?,progress?}** — PARTIAL-to-full for S1 stack mode: guard label + status enum (the LEVEL_COLOR keys) + body segments ≈ detail; lossy because the body is free-form token segments (e.g. `slop: stub 0.12, comments 0.04`) not metrics{tokens,cost,*}, and continuations/hanging-indent wrap semantics are custom. Progress: absent entirely (no done/total anywhere).
- **(C) gauge {label,percent,phase,elapsed,recentOutput}** — NOT covered; nothing in pi-warden is a gauge. Closest trivia: elapsedMs/model tokens appear in trace detail lines only.
- **(D) tree/list** — PARTIAL for S2 sidebar as a flat list (id=id, label=line, detail=details[], newest-first), but NOT covered: timestamp+guard rail dual-column head, per-entry amend appends (amend mutates an existing entry's detail — state replacement would lose the appended outcome), scroll/viewport/clear semantics, compact vs detailed mode, and the config panel selector rows (`‹ value ›` cycle affordance, editable boolean ○● glyphs) which are strictly list-shaped beyond B/D scope → opaque fallback.

## 5. VERDICT

Coverage ≈ **85–90%** of ambient-surface ink by primitive set {A: ~20%, B: ~55%, C: 0%, D: ~15%}. pi-warden is verdict-text-only: no gauges, no progress, no nested trees. The single most valuable missing primitive: a **verb/status-chip enumeration + fold rule on the row primitive** — i.e. the payload `LEVEL_COLOR` carries (status enum → color/severity + quiet-fold grouping + severity sort + "carriesFlag keeps its own line" exception, `widget.ts:9-23`, `widget-render.ts:26-40`). Without a first-class `{status: enum, severity: 0..2, quiet: bool}` on primitive B, generic rendering cannot reproduce the folding/severity-ordering/coloring that is pi-warden's entire above-editor design, and every such surface degrades to opaque text.
Does the human act ON the surface? Mostly no — the widget and sidebar are read-only observation (only `c` clear). The exception proves the shell: the **config panel (S3) is a browsable-editable list surface where the human writes persisted config state** (toggle/select/text→`writeUserConfig`). If acting needs a channel-neutral spec, an "editable row (bool/select/text)" affordance on D/B is the second gap.
