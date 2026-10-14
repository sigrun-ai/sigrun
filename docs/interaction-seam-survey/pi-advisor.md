# pi-advisor — user-interaction shape inventory

## 1. KINDS

| Kind | Trigger | Human sees | Human does | Blocking | Durability |
|---|---|---|---|---|---|
| **Manual advisor dialog** (`/advisor-manual [focus]`, `manual-command.ts:58` → `ctx.ui.custom<ManualAdvisorRequest>`) | user command | centered overlay: multiline message editor (prefilled), radio list of Git-context levels (None/Summary/Full), [Submit]/[Cancel] buttons (`manual-dialog.ts`, `manual-dialog-render.ts`) | free text + single-select + buttons (Tab cycles focus) | blocks the command | transient UI-only; result becomes a consultation recorded in session state/usage |
| **Model pickers** (`/advisor`, `/advisor-models`, `model-picker.ts`) | command or first-use/model unavailable | searchable model list per role + effort `ctx.ui.select` (`searchable-model-list.ts`, `model-picker.ts:66-129`) | single-select from list; effort select | blocks command | transient; saved choice persists to `advisor.json` |
| **Settings panel** (`/advisor-settings`, `settings-commands.ts:67`) | command | category list of ~40 toggles/values + nested text submenus (input), dropdown selects, masked-key input (`text-setting-submenu.ts`, `masked-input.ts:55`, `jev-provider-submenu.ts`) | toggle/select/type (incl. password-masked API keys) | blocks | transient UI; changes persisted immediately to `<dir>/advisor.json` (`config/storage.ts:22-24,187`) |
| **Tool-result renderers** (`ask_advisor`, `advisor_scout`, `record_advisor_outcome`; `register-renderers.ts`, `render-advisor-result.ts`, `scout-status.ts`) | tool call | streaming Markdown advice with usage footer / scout status card | none (read-only) | no (except auto loop gates) | transcript-persistent |
| **Loop gate block** (`loop-gate.ts:146-183`, `gate-protocol.ts:9`) — the human never interacts; Advisor Markdown must contain a literal `Decision: proceed|revise|blocked` line repeated identically; policy can block the tool call | no human interaction; the "choice" is parsed from model text | no |
| **Notices / status** | `ctx.ui.notify` (errors/warnings/info: `gate-policy.ts:37,106,143`, `outage-notifier.ts:27`) and `ctx.ui.setStatus("advisor-usage", …)` footer (`session-state.ts:362`, `gate-policy.ts:24`) | short message line / status-bar line | none | transient |
| **Herdr external surface** (`herdr-block.ts:22-38`, `docs/herdr.md`) | Advisor activity/block | pane blocked label ≤200 chars via socket `herdr:blocked` | none | external pane state |

## 2. MAPPING to {text, options, fields, diff}

- **Consultation payload (ask_advisor params, `register-ask-advisor.ts:434-480`)**: `question?: string`, `draft?: string`, `followUpTo?: string`, `force?: boolean`, `gitContext?: "none"|"summary"|"full"`, `includeTrackedFiles?: string[]`, `includeUntracked?: boolean`. This is the agent→advisor side, not user-facing, but drives renders. text covers question/draft FULLY; gitContext/files = none of the primitives (it's disclosure config, not interaction).
- **Manual dialog**: text (message) FULLY; options FULLY for git levels + Submit/Cancel; combined form = PARTIALLY (needs fields+options composed).
- **Model picker**: option-id single-select — options FULLY (labels only; the searchable-list filtering is UI behavior).
- **Settings panel**: fields PARTIALLY (string/number/boolean covers most of `AdvisorSettings` in `ui/types.ts:70-117` — booleans like `completionGate`, numbers like `contextMaxChars`, strings like `advisorModel`); NOT covered: enum selects with descriptions (git levels, effort levels, tool policies `Record<string,"full"|"summary"|"exclude">`), masked secret input, nested submenu navigation, custom Jev provider verification flow (`jev-setup-support.ts`).
- **Advice Markdown ('Advisor returns an opinion with risks, alternatives, and verification steps', README §How it works)**: text FULLY. Gate `Decision:` triple = options PARTIALLY (a 3-button choice), but it is machine-generated, not human input.
- **Notices/status/Herdr labels**: text PARTIALLY (single string; no severity/level field in primitives).
- **No diff primitive is used anywhere** despite gitContext patches — patches flow to the *Advisor model*, never rendered as a user-facing diff object.

## 3. GAPS (→ JSON fallback)

- Preset/dropdown with label+description pairs: `{label, description, value: number}` — `ContextPreset` (`ui/types.ts:73-77`); stubs map to options but "description" has no slot; primitives' `{id,label,tone}` lacks the second descriptive line used throughout (git levels in `manual-dialog-render.ts:6-11` also show `description`).
- Setting-category navigation + two-column layout of the settings panel — no primitive covers structured settings UIs beyond flat lists/fields.
- `AdvisorSettings.toolPolicies: Record<string, "full" | "summary" | "exclude">` (`ui/types.ts:111`) — a per-key select, not a flat field.
- Masked secret entry (`masked-input.ts`) — fields have no `secret` type.
- Usage/status metadata: `usage?: {inputTokens, outputTokens, cost?...}` rendered as footer (`usage.ts`, `session-state.ts:362-368`) — numbers+labels beyond a text blob.
- Multi-value selection: `SearchableModelMultiSelectorOptions.onSelect(values: string[])` (`ui/types.ts:22-27`) — primitives' options are single-choice only.
- Tool details `AdvisorToolDetails`/`ScoutToolDetails` (`tools/types.ts:20-43`) — 15+ fields per card, JSON-fallback territory.

## 4. PERSISTENT STATE

- `advisor.json` (settings, global + optional project-scoped, `config/storage.ts:22-24,187`) — the config surface above.
- `~/.pi/agent/advisor-outcomes.jsonl` + `advisor-outcomes-salt`: `OutcomeRecord {adviceHash, adoption: followed|not-followed|unknown, validationStatus, trigger, timestamp, v:1}` capped at 1 MiB, rewritten on overflow (`outcomes.ts:20-47,60-62`); rendered by `/advisor-stats` as a Markdown stats summary (`commands/outcome-stats.ts`), not a widget.
- Usage status line ("advisor-usage" status slot) — updated after each consultation (`gate-policy.ts:24-29`, `register-lifecycle.ts:79,221`).
- Jev session ledger counters (`filter.skipped/screened/overrides…`, `jev/ledger.ts:8-37`) — session-local, surfaced in settings submenus, not durable.
- Herdr pane blocked state — external, refcounted on/off edges (`herdr-block.ts:22-38`).

## 5. VERDICT

Roughly **75–80%** of interaction volume is covered: consultations/pickes/notices/confirm-style flows map to text+options; most settings to fields. The most valuable missing primitive is **descriptive select** — options entries carrying `{id, label, description}` plus multi-select, motivated by `ContextPreset` (`ui/types.ts:73-77`), the git-level radio rows, and `SearchableModelMultiSelectorOptions`. Secondary: a `secret` field type for the masked key inputs. Everything genuinely structural (settings panel layout, scout/stat detail cards) legitimately degrades to the `details` fallback.

**Special attention result:** no multi-advisor opinion matrices, rankings, or debate transcripts exist — a single Advisor model is consulted per call (same-model calls are skipped, README Features); gate "decisions" are one-of-three parsed Markdown lines, not matrices.
