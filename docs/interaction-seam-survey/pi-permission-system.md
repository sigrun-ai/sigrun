# pi-permission-system — interaction-shape inspection

**Brief note**: `/tmp/pi-ext-inspect/brief-pi-perm.txt` did not exist on disk (supervisor ping timed out). The sibling briefs in that directory share one 5-section template (KINDS / MAPPING / GAPS / PERSISTENT STATE / VERDICT) over candidate primitives `text / options / fields / diff`. The only "perm"-matching candidate in the directory is `pi-permission-system` (there is also `pi-permission-model-judge`, an Authorizer-chain judge extension with no native UI of its own). I applied the template to `/tmp/pi-ext-inspect/gotgenes-pi-packages/packages/pi-permission-system`. Reconnaissance only; no code executed. All claims cite file paths.

## 1. KINDS

| # | Kind | Trigger | What human sees / does | Blocking? | Durability |
|---|------|---------|------------------------|-----------|------------|
| 1 | **Inline keybind permission dialog** (`ctx.ui.custom` component, `src/authority/permission-prompt-component.ts` + pure reducer `src/authority/permission-prompt-decision.ts`) | A gate resolves `ask` (tool, bash, MCP, path, external_directory, skill) | One fact per line, `label : value`, under a row budget; `PromptPayload` facts block (`src/presentation/prompt-payload.ts:12-20`). Human presses remappable hotkeys: `y` approve, `s` approve-for-session (+ `b` both-directions when proven, `docs/session-approvals.md:27-63`), `n` deny, `r` deny-with-reason (free-text reason step); optional `scope` step picks subagent-only vs whole-session grant. `doublePressToConfirm` arms-then-confirms; `Ctrl+O` expands the full request; `promptNotifications: ["bell"]` rings the terminal on open | Blocking | Decision recorded in review log + `permissions:decision` broadcast; grant rules persist for the session only (memory, cleared `session_shutdown`) |
| 2 | **`select` prompt fallback (non-TUI/RPC)** | Same `ask` in a non-TUI context (`docs/configuration.md:269-270`) | Same one fact per line under the same budget via `renderPromptDialog` (`src/presentation/dialog-renderer.ts:20-42`, `DialogView {lines, elided}`); human picks options from a select list | Blocking | Same |
| 3 | **Follow-up dialogs**: denial-reason free-text input (`reason` step) and grant-scope choice (`scope` step) (`src/authority/permission-prompt-decision.ts:15, 88-101`) | Chosen from the decision step | Multi-step wizard state machine (`PromptStep = "decision" \| "reason" \| "scope"`); human types reason (required, empty rejected via `reasonError`) or toggles scope | Blocking | Same |
| 4 | **Queued asks** | Second ask raised while one is open — `AskDialogQueue` serializes presentations, emitted `permissions:ui_prompt` fires only when the queued ask's turn comes (`src/authority/ask-dialog-queue.ts:11-27`, `docs/cross-extension-api.md:389-391`) | Nothing extra; the ask waits invisibly | Blocking for the caller, transparent to the human | Review log brackets the wait; queue release reasons logged |
| 5 | **Forwarded subagent ask** | Non-UI subagent forwards; parent shows it with the child's own surface/value and `forwarding` context (`docs/cross-extension-api.md:387-389, 432-447`) | Same dialog shape, plus a possible second `scope` step choosing grant width | Blocking | Same as 1 |
| 6 | **Timeout denial (non-interaction)** | `promptTimeoutMs` expires — denied, never approved, `decidedBy: {kind:"unanswered", timeoutMs}`, broadcast `prompt_unanswered` (`docs/configuration.md:236-255`) | Clock hint row while running; any keypress stops the clock | Blocking-with-deadline | Review log + broadcast |
| 7 | **Tool-triggered warnings** | `ctx.ui.notify(message, "warning")` — untrusted-project skip (`src/handlers/lifecycle.ts:126-138`), config-apply/reset/usage errors (`src/config/config-modal.ts:222-245`) | Transient toast | Non-blocking | Review log `project_trust.skipped` + debug log |
| 8 | **Status value** | `ctx.ui.setStatus` shows only `"yolo"` when yolo mode active, cleared at shutdown (`src/config/status.ts:22-34`, `src/handlers/lifecycle.ts:141-145`) | Status string `"yolo"` in the status line | Non-blocking | Transient UI-only, session-scoped |
| 9 | **`/permission-system` settings modal** | User command with no args (default `SettingsList` TUI modal) or args `show|path|reset|help` (notify text) (`src/config/config-modal.ts`) — USER-initiated, not agent-fired | Settings list editor | Blocking (modal) while editing; `on/off` toggles persist to config file | Persists config changes to `config.json` |
| 10 | **Observation channels (no visible dialog)**: `permissions:ready` / `permissions:ui_prompt` / `permissions:decision` broadcasts on `pi.events` (`docs/cross-extension-api.md:373-375`); JSONL review log (`<agentDir>`/`pi-permission-system-permission-review.jsonl`) and debug log, owner-only 0600 (`src/config/config-paths.ts:5-6`, `src/logging/session-logger.ts:73-74`) | Every gate resolution / prompt | Machine consumers | Non-blocking | Persistent record (broadcast + JSONL) |

The `pi-permission-model-judge` sibling registers an `Authorizer` link; its only interaction surface is a `deny`-with-corrective-reason returned through the chain — no dialog of its own. All UI volume above belongs to `pi-permission-system`.

## 2. MAPPING (primitives: text / options / fields / diff)

**Main payload — `PromptPayload`** (`src/presentation/prompt-payload.ts:12-63`):

```ts
interface PromptPayload {
  readonly kind: PromptPayloadKind; // "bash"|"mcp"|"tool"|"path"|"external_directory"|"bash_external_directory"|"skill"|"skill_read"|"forwarded"
  readonly request: PromptRequestFacts;
  readonly evidence: readonly PromptEvidence[];
  readonly annotations: readonly PromptAnnotation[];
}
interface PromptRequestFacts {
  requester: PromptRequester; surface: string; toolName: string | null;
  invokedToolName: string | null; value: string; matchedPattern: string | null;
  matchedSpelling: string | null; commandContext: BashCommandContext | null; executedUnit: string | null;
}
interface PromptEvidence { label: string; text: string; detail: string | null; }
```

**Decision model** (`src/authority/permission-prompt-decision.ts:24-101`): `PromptAction = "approve" | "approveSession" | "approveSessionBoth" | "deny" | "denyWithReason"`; `PromptStep = "decision"|"reason"|"scope"`; `PromptViewState` carries `highlightedAction`, `armedAction`, `hint`, `reasonError`, `scopeServing`, `grantWidth`.

| Kind | text | options | fields | diff |
|---|---|---|---|---|
| 1-3, 5 Dir body + evidence | **FULLY** (facts/evidence → `text {label,text}`; `detail` is a second text, or elided detail) | **PARTIAL / FULLY** — the fixed 4-6 roster maps to `options [{id,label,tone}]` cleanly (approve→positive, deny→negative tones; session grants = extra buttons) **except** `approveSessionBoth` is conditionally offered (widthLabel) and the session-patter text (`Yes, allow "/tmp/*"` — dynamic label, fine for primitive) | **PARTIAL** — `reason` = one required `string` full text; `scope` = boolean off/on; both expressible as `fields`, but neither is a form — a single field | NOT AT ALL — no before/after anywhere |
| 4 Queue | FULLY (same shape once presented) | PARTIAL | PARTIAL | not applicable |
| 6 Timeout | FULLY | not applicable | n/a | n/a |
| 7 Warnings | FULLY (message text) | n/a | n/a | n/a |
| 8 Status | FULLY (short string; "yolo" could be an option-free notice) | n/a | n/a | n/a |
| 9 Settings modal | PARTIAL (toggle list: `{name, boolean value}` is field-shaped) | FULLY | FULLY (each row = boolean field; args = text) | n/a |
| 10 Broadcasts | FULLY (`surface`/`value` display projection is text) | **NOT AT ALL** on the wire — `PermissionsResultEvent`/decision payloads are data, not interaction options | n/a | n/a |

## 3. GAPS (fall to opaque `details` JSON)

- **`PromptPayloadKind` discriminant** (`prompt-payload.ts:36-47`) — which ask is it; nine variants drive renderer dispatch.
- **Evidence array + per-entry elision pairing** — `evidence: PromptEvidence[]` with `label/text/detail` and the elision, budget, `elided` flag (`dialog-renderer.ts:26-42`) is richer than flat text (JSON fallback survives, losing budget/elide semantics).
- **`commandContext` / `executedUnit` / `matchedSpelling` / `floorExemption` / `askingUnits`** (`prompt-payload.ts:64-70`; `types.ts` `FloorExemption = "core-reader" | "execution-modifier"`, `AskingBashUnit`) — structured provenance facts a human sees rendered; `text` covers them only as rendered lines.
- **Decision/queue semantics** — `PromptStep` wizard state, `grantWidth` (`"proven"|"family"`), queue release reasons (`ask-dialog-queue.ts`), `promptTimeoutMs` unanswered decision.
- **Broadcast envelopes** — `requestId`, `source`, `forwarding: {requesterAgentName, requesterSessionId}`, `resolution` (`"user_approved" | "user_denied" | "policy_allow" | ... | "prompt_unanswered" | "authorizer_allowed" ...`), `origin` (`docs/cross-extension-api.md:377-500`) — pure data events with no primitive (rightly, they're not interactions).
- **Review log records** — JSONL events (`project_trust.skipped`, `authorizer_chain_resolved/delegated/unregistered_link/vacant`, `toolInputPreview` with sensitive-name masking, `sessionGrantWidth`, `decidedBy:{kind,timeoutMs}`) — persistent audit, not an interaction.

## 4. PERSISTENT STATE

- **Session rule store** — session-scoped wildcard grants, in-memory, never persisted, cleared `session_shutdown` (`docs/session-approvals.md:15`). Update: on each `approveSession`/`approveSessionBoth`. Rendered only in subsequent prompts (matched rule shown).
- **Review log** `${agentDir}/pi-permission-system-permission-review.jsonl` + `-debug.jsonl`, JSONL append, owner-only 0600/0700, redaction + `reviewLogFieldMaxWidth` 1000 cap (`src/config/config-paths.ts:5-6`, `docs/configuration.md:1505-1574`). Rendered by nothing on-screen (`review-log-renderer.ts` summarizes the chain); consumed by operators/other extensions.
- **Config store** — global+project `config.json` + agent frontmatter, deep-shallow merge, fail-closed clamp on invalid non-global scopes (project trust gating, `docs/configuration.md:6-70`); edited via `/permission-system` modal (kind 9); drives prompt text (deny reasons) — the modal is the human surface.
- **Status key** — `"yolo"` string only when yolo (`src/config/status.ts:18-34`); cleared at shutdown.
- **Forced-forwarding files** — request/response files for out-of-process subagent forwarding, owner-only; written per forwarded ask.

## 5. VERDICT

Interactive volume (kinds 1-6, ~90% of human-touching events) is ~**95% covered** by `{text, options, fields}`: body/evidence→text, the fixed decision roster→options, reason/scope→single fields. The lost pieces are structural (evidence array elision, `PromptPayloadKind`, wizard step semantics) that would land in `details` — they change *how* a renderer would present, not *what the human chooses*. `diff` is unused (0%); nothing here is before/after. Total incl. warning toasts and status line: ~92%.

Most valuable MISSING primitive: an **"elidable-evidence list"** primitive — `evidence[]: {label, text, detail?}` + `elided` flag (quote `PromptEvidence` and `DialogHostException`-style `DialogView {lines, elided}` above). motivating payloads: path asks carrying both referenced and symlink-resolved alias (bounded `/tmp/x` row budget, `Ctrl+O` expand shows the difference), bash chain asks carrying `askingUnits[].command` per line, and forwarded asks carrying the child's own evidence the parent re-renders. A ledger second: an **event/broadcast** primitive (`permissions:decision` envelopes) matters for persistence, not for the human-prompt record.

## Residual risks / open questions

- Brief file absent; section 5's `details` fallback and the template interpretation were inferred from sibling briefs in `/tmp/pi-ext-inspect/brief-pi-goal.txt`.
- `pi-permission-model-judge` (the other perm candidate) had no README read; asserted from `docs/configuration.md:389` that it only registers an Authorizer link. If the intended target differs, re-run.
