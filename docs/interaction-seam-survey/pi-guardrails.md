# pi-guardrails — user-interaction shapes

## 1. KINDS

**K1. Dangerous-command dialog** (`extensions/permission-gate/prompt.ts`, used in `extensions/permission-gate/index.ts:117`). Trigger: bash tool call matching dangerous pattern. Human sees bordered "Dangerous Command Detected" panel with scrollable numbered command viewport + reason. Human: keyboard choices — allow / allow-session / deny / "decline & stop" (keys y/enter, a, n/esc, s). Blocking. Transient UI-only; non-interactive fallback = `ctx.ui.select(...)` with same 4 options or hard block (`index.ts:121-136`).

**K2. Outside-workspace path prompt** (`extensions/path-access/prompt.ts`, `path-access/index.ts:113-160`). Trigger: tool targets path outside cwd in ask mode. Human sees "Outside Workspace Access" box: toolName, collapsible command, Cwd/Path/Dir lines, tabbed option grid (6 file / 4 dir options: allow once/session/always file+directory, deny; Tab/arrows, `x` expands command). Result payload `PromptResult` union (`prompt.ts:8-17`). Blocking ("remember-allow" flow: session grants to memory, always→persisted config). Fallback: block with reason (`index.ts:101-111`).

**K3. Warning notice** — `ctx.ui.notify(..., "warning")` (`permission-gate/index.ts:101`, `path-access/index.ts:134` for too-broad grant). Non-blocking, transient toast.

**K4. Settings UI** — `/guardrails:settings`, `/guardrails:examples`, `/guardrails:onboarding` (`extensions/guardrails/commands/`, `components/pattern-editor.ts`, `onboarding-choice-step.ts`, `add-rule-wizard.ts`, `path-list-editor.ts`). Human: selection lists, free-text inputs (policy name), enum pickers, boolean toggles, pattern list add/edit/delete forms (pattern + description + regex toggle), multi-step wizards, example-preset checkboxes. Blocking command UIs; results persist to `~/.pi/agent/extensions/guardrails.json` / `.pi/extensions/guardrails.json` (README "Configuration").

**K5. Non-blocking event surfaces** — paired `guardrails:prompt:opened`/`closed` events + `guardrails:action:blocked` + `guardrails:risk:detected` (`src/shared/events.ts`); herdr adapter emits `herdr:blocked {active, label}` (`extensions/herdr/index.ts:21,26`). Persistent record: no — transient event bus, correlation via `prompt.id`.

## 2. MAPPING

- **K1** — options: FULLY (4 fixed choices). text: FULLY (reason + command). diff: N/A. fields: PARTIALLY (no fields; command is prose, but a free-text `details` is unnecessary).
- **K2** — options: FULLY (6 `{label → enum result}` — needs tone for deny). text: FULLY.
- **K3** — text: FULLY (message + tone=="warning" → options tone).
- **K4** — options: FULLY for pickers/toggles (enum picker = options; boolean = 2 options). fields: FULLY for policy-name input & pattern description (typed text fields — settings detail editors already use `{id, type: text|enum|boolean, label, description}` shapes, `settings/index.ts:32-83`). Regex toggle = boolean field. **List editors (PatternEditor, PathListEditor, examples multi-select) = JSON fallback.**
- **K5** — JSON fallback (arbitrary metadata objects).

Main payload shapes:
```ts
// path-access/prompt.ts:8-17
type PromptResult = "allow-file-once" | "allow-dir-once" | "allow-file-session"
  | "allow-dir-session" | "allow-file-always" | "allow-dir-always" | "deny";
// permission-gate/prompt.ts done(): "allow" | "allow-session" | "deny" | "stop"
// events.ts
interface GuardrailsPrompt<TMeta> { kind: "confirmation" | "permission"; metadata?: TMeta }
type GuardrailsBlockSource = "policy" | "permission" | "user" | "user-stop" | "nonInteractive";
// herdr: { active: boolean; label: string }
// pattern-editor.ts:12-16
interface EditorPatternItem { pattern: string; description: string; regex?: boolean }
// core/paths: AllowedPath = { kind: "file" | "directory"; path: string }
```

## 3. GAPS (→ JSON fallback)

- Scrolling command viewport with line numbers & expand/collapse state (K1/K2) — presentation only, degrades to text.
- Matched-pattern metadata: `prompt.metadata` carries feature-specific matcher details (dashboardName etc.); arbitrary `TMeta` (events.ts `metadata?: TMeta`). Needs structured details.
- Multi-select checkbox state in `/guardrails:examples` (`ExamplesState { policyIndexes: Set<number>; commandIndexes: Set<number> }`, `commands/examples/index.ts:18-22`).
- List CRUD editors (`EditorPatternItem[]`, `AllowedPath[]`) — add/edit/delete with cursor index; no primitive covers ordered item lists.
- Persistent grants: `pathAccess.allowedPaths: AllowedPath[]` in settings file — config, not interaction.
- Block/prompt event payloads (`context.input?: Record<string, unknown>`).

## 4. PERSISTENT STATE

Settings files only: `~/.pi/agent/extensions/guardrails.json` (global) and `.pi/extensions/guardrails.json` (project), with `$schema` (README; `config/loader.ts`, `schema.json`). Holds `{enabled, features, policies.rules[], permissionGate{patterns, autoDenyPatterns}, pathAccess{mode, allowedPaths[]}, onboarding{completed}}`, migrated via numbered migrations (`config/migration/001…012`). Rendered by the settings UI; session grants (`grants.ts`) are in-memory files/strings per session; herdr state is a live `Set<promptId>`. No statusbars/banners.

## 5. VERDICT

~**80%** covered by {text, options, fields}: both gate dialogs, path prompts, notices, onboarding/settings pickers and simple forms, plus remember-allow flows. The ~20% falling back: **list-editor (ordered item list with CRUD)** — the single most valuable missing primitive; its concrete payload is `EditorPatternItem[]` (`{pattern, description, regex?}`) and `AllowedPath[]` (`{kind, path}`) with per-item selected/cursor index and add/edit/delete affordances (pattern-editor.ts, path-list-editor.ts). Second, smaller gap: typed metadata/details payload on prompts (arbitrary `TMeta`).
