# rpiv-todo interaction shapes (inspection, no code executed)

Repo: /tmp/pi-ext-inspect/rpiv-mono/packages/rpiv-todo

## 1. KINDS

Four user-facing surfaces, none blocking:

- **`todo` tool output (agent-facing, also surfaced in transcripts)** — trigger: model calls `todo` (actions create/update/list/get/delete/clear). Human sees: `content[0].text` summary lines, e.g. `Created #3: Write the parser (pending)`, or multi-line `get` detail (`#${id} [status] subject / description: / activeForm: / blockedBy: / blocks: / owner:`) — `tool/response-envelope.ts`. Human does: nothing (machine-mediated; the agent is the author). Non-blocking. Durable: full post-mutation snapshot.
- **Todo overlay widget** — trigger: any visible (non-deleted) task exists after a `tool_execution_end` for `todo` (`index.ts`); auto-unregisters when list empties. Human sees: persistent panel above the editor — `● Todos (2/5)` heading, glyphs `○/◐/✓/✗`, dim struck completed rows, `(activeForm)` spinner label, `⛓ #1,#2` dependency markers, `+N more (X completed, Y pending)` overflow line; `ctrl+shift+t` collapses to heading + hint. Human does: keyboard toggle only (no selection/buttons). Non-blocking. UI-only (real state lives on the session branch).
- **`/todos` slash command** — trigger: user runs `/todos`. Human sees: grouped text print — header `2/7 completed · 1 in progress · 4 pending`, sections `── Pending ──` / `── In Progress ──` / `── Completed ──`, rows `◐ #3 subject (creating the repository)`; `No todos yet. Ask the agent to add some!` or `/todos requires interactive mode` (`docs/overlay.md`, `todo.ts` ERR strings in `tool/types.ts`). Human does: nothing. Non-blocking. Transient print.
- **Collapse/expand shortcut** — `pi.registerShortcut` handler (`index.ts:110-120`); transient UI toggling, non-blocking.

All interaction is display + agent-written state. There are zero dialogs, prompts, forms, or choices; the human never supplies data.

## 2. MAPPING

- Tool envelope text → **text** FULLY (plain prose/lines).
- `/todos` grouped output → **text** FULLY (grouped plain lines).
- Overlay widget → **text** PARTIALLY: line content is expressible as structured text, but placement (persistent above-editor widget, row budget, collapse state, auto-hide, `requestRender` lifecycle) is a widget-render contract, not a message payload — none of the 4 primitives express widget placement or update cadence.
- Shortcut → NOT AT ALL (host keybinding, not a payload).

Core persisted payload `Task` (`tool/types.ts`):
```ts
type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
interface Task { id: number; subject: string; description?: string; activeForm?: string;
  status: TaskStatus; blockedBy?: number[]; owner?: string; metadata?: Record<string, unknown>; }
```
Replay snapshot `TaskDetails` (`tool/types.ts`): `{ action, params: Record<string, unknown>, tasks: Task[], nextId: number, error? }`. Neither is a human-interaction payload as defined by the 4 primitives (no options, no fields, no diff) — they map closest to `details` JSON fallback.

## 3. GAPS

Elements beyond {text, options, fields, diff}:
- `blockedBy?: number[]` — graph edges between tasks; also derived reverse `blocks` edges (`tool/response-envelope.ts` `formatGetLines`, `state/task-graph.ts`). No primitive expresses dependencies.
- `metadata?: Record<string, unknown>` — open map, explicitly arbitrary (`tool-schema.md`).
- `activeForm?: string` — present-continuous spinner label, a live-update field rather than static prose.
- Status enum `pending|in_progress|completed|deleted` — a state machine with transition legality (`docs/tool-schema.md`).
- `nextId`, `params` passthrough, `error?` in `TaskDetails`.
- Overlay internals: row budget (`maxWidgetLines`), `collapsed` boolean, overflow `+N more (X completed, Y pending)` — widget-layout state, not payload.

## 4. PERSISTENT STATE

- **Session-branch custom entries** (`STATE_ENTRY_TYPE = "rpiv-todo-state"`, `tool/types.ts`): every state-changing todo call writes the full `TaskDetails` snapshot; replay takes the LAST snapshot (last-write-wins) on `session_start`/`session_compact`/`session_tree`; per-session keyed (`state/store.ts`, `index.ts:130-200`). Survives /reload + compaction; **no disk writes**.
- **In-memory slots**: per-session state store (`state/store.ts`) + foreground selection (`getActiveRenderSession()`); overlay module memoized loader (`index.ts` `makeTodoOverlayLoader`).
- **Overlay widget** keyed `rpiv-todos`, `placement: "aboveEditor"` (`todo-overlay.ts`); re-rendered on every todo tool execution; completed rows hidden at next `agent_start` (`index.ts`); user config `~/.config/rpiv-todo/config.json` (maxWidgetLines 12, collapseKey, guidance) — read-only.

## 5. VERDICT

Coverage by {text, options, fields, diff}: roughly **30–40%** of interaction volume. The `/todos` command output and tool summary strings (the human-visible text) are fully covered by `text`, but ~60–70% of the extension's value is (a) the persistent above-editor overlay widget (placement/budget/collapse semantics no primitive captures) and (b) the structured task graph (`blockedBy` dependency edges, status machine, open `metadata`) that a generic `details` fallback would render as opaque JSON, degrading its legibility.

**Most valuable missing primitive**: a **task-list/structured-list primitive** with `{items: [{id, subject/label, status: enum, blockedBy?: ids[], spinnerLabel?}]}` plus a **statusbar/widget placement** attribute (aboveEditor, row budget, collapse key). Motivating payload: `Task { id: number; subject: string; status: "pending"|"in_progress"|"completed"|"deleted"; blockedBy?: number[]; activeForm?: string }` (`tool/types.ts`) — the extension's entire human value is showing exactly this graph live above the editor.
