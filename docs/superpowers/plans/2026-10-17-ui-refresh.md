# Sigrun UI refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sigrun's conversation list names, activity times and fork lineage (with automatic naming), then rebuild the web UI in hermes-webui's visual language and the TUI as a fullscreen, mouse-capable, keyboard-first client with standard / vim / emacs keymaps.

**Architecture:** Three parts in order. Part A (server) extends `GET /v1/conversations` and the session-meta doc, and adds an auto-namer wired to the event bus. Part B (web) adds a shared palette module, a new shell (rail / sidebar / main / right panel), and a turn-grouped transcript. Part C (TUI) moves the launcher to `TuiAltScreen`, reuses the shared palette and turn-grouping modules, and routes all input through one action layer that three keymaps drive.

**Tech Stack:** TypeScript (NodeNext server, bundler webui), Fastify, pi-durable 1.2.0, pi-ai, React 19 + react-markdown + remark-gfm, pi-tui 1.3.0, vitest, playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-ui-refresh-design.md` (mockups in `docs/superpowers/specs/assets/2026-10-17-ui-refresh/`). Executors read both.

## Global Constraints

- Default palette `polar-night`, default accent `baltic-amber`; web mode default `system`, TUI mode default `dark`, TUI keymap default `standard`.
- Palette names: `fjord`, `iron-ember`, `polar-night`, `birch-moss` (labels "Fjord", "Iron & Ember", "Polar Night", "Birch & Moss").
- Accent names: `baltic-amber`, `ember`, `lingonberry`, `glacier`, `aurora`, `lichen`, `heather` (labels "Baltic Amber", "Ember", "Lingonberry", "Glacier", "Aurora", "Lichen", "Heather").
- Colour values are copied verbatim from `assets/2026-10-17-ui-refresh/palettes.html` (`PALETTES` and `ACCENTS` objects).
- No TUI keymap binds `Ctrl+B`, nor any composer editing chord: `Ctrl+A/E/B/F/K/U/W/Y/D/J`.
- The TUI's vim editor launch only ever runs a binary whose basename is `vim`, `nvim` or `vi`. Never nano, never another editor.
- Every TUI action is keyboard-reachable; mouse is additive.
- Wire types live in `src/server/views.ts` (pure: `import type` only, no `node:`); shared client logic lives in pure modules under `src/shared/` (no imports at all).
- Webui deps stay React + react-markdown + remark-gfm; no icon font (inline SVG).
- Tests own their literals (synthetic names, `faux/m` models, `example.invalid` hosts).
- Verification gate per task: the suites the task touched. Final gate: `npm test`, `npm run typecheck`, `npm run typecheck:webui`, `npm run build:webui`, `npm --workspace @sigrun/webui test`, `npm --workspace @sigrun/tui run test`, `npm --workspace @sigrun/tui run typecheck`, `npm run test:e2e`.
- Commits are signed; one commit per task minimum, conventional prefixes (`feat(server)`, `feat(webui)`, `feat(tui)`, `docs`).

## Review Focus

1. **Naming must never hurt a run.** Provider down, model returns empty or junk text, or the call hangs → the conversation stays unnamed, the run's outcome is untouched, attempts stop at 3, and task-owned (subagent) conversations are never named. Tests in Task A2.
2. **Long or odd names.** 200-character names, emoji, names with newlines → one truncated line with ellipsis in the web sidebar, header, outline and TUI list; no layout break, no wrapped TUI row. Tests in Tasks B3 and C2.
3. **Tool-only or interrupted assistant turns.** A turn with tool calls but no text, or a tool call whose result never arrived (aborted run) → the activity line renders (`2 tools`), the missing result shows as not-done, no empty prose block. Tests in Task B4 (web) and C2 (TUI) via the shared `groupTurns` tests in B4.
4. **Edit or fork at the very first message.** Editing the first user message has no "entry before" → create a fresh conversation with the draft prefilled instead of erroring; forking at the first assistant turn works normally. Tests in Task B4 and C3.
5. **Vim editor round-trip failure.** Editor exits non-zero, the temp file is deleted, or no vim exists → the composer draft is unchanged, the status bar says why, and the TUI is redrawn. Tests in Task C4.

---

## File Structure

**Server (Part A)**
- `src/server/session-meta.ts` — gains server-owned `autoName`, `autoNameAttempts`, `lastActivityAt`.
- `src/server/views.ts` — `ConversationSummary` gains `name`, `lastActivityAt`, `parent`, `archived`, `pinned`.
- `src/server/index.ts` — list route fills the new fields; submissions route bumps activity; fork route sets fork naming.
- `src/harness/activity.ts` (new) — `touchActivity` + bus wiring for settle-time bumps.
- `src/harness/naming.ts` (new) — `cleanTitle`, `createAutoNamer`.
- `src/harness/settings.ts` — `namingModel` key.
- `src/harness/boot.ts` — wires activity + namer.

**Shared (Parts B and C)**
- `src/shared/themes.ts` (new) — palette and accent data.
- `src/shared/turns.ts` (new) — `groupTurns`, `toolPreview`, `activityLabel`.
- `src/shared/conversations.ts` (new) — `buildConversationTree`, `formatAge`, `ageGroup`.

**Web (Part B)**
- `webui/src/theme/useTheme.ts`, `ThemeControls.tsx` (deleted) — mode / palette / accent.
- `webui/src/layout/` — `Rail.tsx`, `ChatHeader.tsx`, `RightPanel.tsx`, `icons.tsx` (new); `TopBar.tsx` deleted.
- `webui/src/sessions/` — `SessionList.tsx` rewritten, `useConversationList.ts` (new).
- `webui/src/entries/` — `TurnList.tsx`, `AssistantTurn.tsx`, `ActivityLine.tsx`, `MessageActions.tsx`, `Markdown.tsx` (new); `EntryList.tsx` replaced by `TurnList.tsx`.
- `webui/src/outline/OutlinePanel.tsx` (new).
- `webui/src/composer/Composer.tsx`, `ModelPicker.tsx`, `ThinkingPicker.tsx` (new).
- `webui/src/settings/SettingsPanel.tsx` — Interface section.
- `webui/src/app.css` — rewritten on tokens.
- `THIRD_PARTY_NOTICES.md`, `README.md`.

**TUI (Part C)**
- `tui/src/theme.ts` (new) — ANSI styling from shared tokens.
- `tui/src/ui/status-bar.ts`, `tui/src/ui/picker.ts`, `tui/src/ui/help.ts` (new).
- `tui/src/actions.ts` (new) — the action union + dispatcher.
- `tui/src/keymaps/standard.ts`, `vim.ts`, `emacs.ts`, `types.ts` (new).
- `tui/src/editor-launch.ts` (new) — vim-only resolution + round-trip.
- `tui/src/clipboard.ts` (new) — OSC 52.
- `tui/src/launch.ts`, `tui/src/ui/app.ts`, `conversation-pane.ts`, `sidebar.ts` — reworked.
- `src/cli.ts` — `TuiFile` gains `palette`, `accent`, `mode`, `keymap`, `editor`.
- `tui/tsconfig.json` — include `../src/shared/*.ts`.

---
## Part A — Server: conversation metadata

### Task A1: Activity time, fork lineage, and a one-request conversation list

**Files:**
- Modify: `src/server/session-meta.ts`, `src/server/views.ts`, `src/server/index.ts` (list route ~611-655, submissions route ~780, meta PATCH ~1556)
- Create: `src/harness/activity.ts`
- Modify: `src/harness/boot.ts` (after `EventBus.open`, ~511)
- Test: `test/conversation-list-meta.test.ts` (new; hermetic faux-provider pattern from `test/session-management.test.ts`), `test/session-meta.test.ts`

**Interfaces:**
- Produces (`session-meta.ts`): `SessionMeta` gains server-owned optional fields `autoName?: string`, `autoNameAttempts?: number`, `lastActivityAt?: string` (ISO 8601). `SessionMetaPatch` does NOT gain them — the strict validator keeps rejecting them as `invalid_field`. The PATCH route's response projection copies all three when present.
- Produces (`views.ts`):
  ```ts
  export interface ConversationSummary {
    readonly id: number; readonly root: boolean; readonly entryCount: number; readonly owner?: string;
    readonly name?: string;            // meta.name ?? meta.autoName
    readonly lastActivityAt?: string;
    readonly parent?: { readonly id: number; readonly at: number };
    readonly archived: boolean;
    readonly pinned: boolean;
  }
  ```
- Produces (`activity.ts`): `touchActivity(harness: Harness, conversationId: ConversationId, now: () => Date, context: Context): Promise<void>` — one `conversation.commit` setting `lastActivityAt = now().toISOString()` on `SessionMetaDoc`; a missing conversation is a no-op. `wireActivity(bus: EventBus, harness: Harness, now?: () => Date): () => void` — registers `bus.onSettled` calling `touchActivity` for `group.conversationId`; returns the unsubscribe.
- Produces (`OpenedHarness` in `boot.ts`): `readonly now: () => Date` (defaults to `() => new Date()`, overridable via `openHarness` options `now`) so tests pin time.

- [ ] **Step 1: Write the failing tests** in `test/conversation-list-meta.test.ts`:
  - `list carries archived/pinned/name without a per-row meta fetch`: create two conversations, PATCH one `{name:"Alpha", pinned:true, archived:true}`; `GET /v1/conversations` → that row has `name:"Alpha", pinned:true, archived:true`; the other has `pinned:false, archived:false` and no `name`.
  - `user name wins over auto name in the list`: write `autoName:"Auto"` directly via `conversation.commit(tx => tx.doc(SessionMetaDoc,…).autoName = "Auto")`; list shows `name:"Auto"`; PATCH `{name:"Mine"}` → `"Mine"`; PATCH `{name:null}` → `"Auto"` again.
  - `fork carries parent {id, at}`: script one faux answer, submit, wait settled, fork at the answer entry id → the fork's row has `parent: { id: <source>, at: <entry> }`; the source row has no `parent`.
  - `settled run stamps lastActivityAt` with `now` pinned to `2026-01-02T03:04:05.000Z` → row `lastActivityAt === "2026-01-02T03:04:05.000Z"`; a never-used conversation has no `lastActivityAt`.
  - `submission admission stamps lastActivityAt before the run settles`: faux provider holds the answer (unresolved script); after `POST …/submissions` returns, the row already has `lastActivityAt`.
  - In `test/session-meta.test.ts`: `PATCH rejects server-owned keys` — each of `autoName`, `autoNameAttempts`, `lastActivityAt` → 400 `{error:"invalid_field", field:<key>}`.
- [ ] **Step 2: Run** `npx vitest run test/conversation-list-meta.test.ts test/session-meta.test.ts` — expect FAIL (fields absent).
- [ ] **Step 3: Implement.** Extend the types; in the list route the existing per-conversation `SessionMetaDoc` snapshot already loads — read the new fields from it, and `parent` from `record.parent` of the scan page item (`conversationId` → `id`). In the submissions route, after a successful admission call `touchActivity`. In boot, call `wireActivity(eventBus, harness, now)` right after `EventBus.open`.
- [ ] **Step 4: Update both clients' list consumers to stop the N+1:** web `SessionList.tsx` and TUI `sidebar.ts` read `archived` / `pinned` / `name` from the summary and drop their per-row `getConversationMeta` / `getMeta` calls (keep existing behaviour otherwise — the rewrite comes in B3/C2). Update their existing tests' stubs to return the new summary fields.
- [ ] **Step 5: Run** `npm test && npm run typecheck && npm run typecheck:webui && npm --workspace @sigrun/webui test && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck` — all PASS. If `test/webui-schema-pin.test.ts` fails, re-pin `webui/src/schema-version.ts` to the printed hash.
- [ ] **Step 6: Commit** `feat(server): conversation list carries name, activity time, fork parent, archive/pin flags`

### Task A2: Automatic conversation naming

**Files:**
- Create: `src/harness/naming.ts`
- Modify: `src/harness/settings.ts` (`SettingsFile`, `SETTING_KEYS`, validation beside `defaultModel` ~430), `src/harness/boot.ts`, `src/server/index.ts` (fork route ~1360)
- Test: `test/naming.test.ts` (new), `test/settings.test.ts`, `test/session-management.test.ts`

**Interfaces:**
- Consumes: `RunSettledEvent` and `EventBus.registerExtension` from `src/harness/event-bus.ts`; `SessionMetaDoc` (A1 fields); `OpenedHarness.models` (pi-ai `Models`), `.settings`, `.defaultModel`.
- Produces (`settings.ts`): `SettingsFile.namingModel?: string | false` — a `provider/model-id` string validated exactly like `defaultModel` (error field `"namingModel"`), or `false` to disable. Added to `SETTING_KEYS` so `GET/PATCH /v1/settings` serve and accept it.
- Produces (`naming.ts`):
  - `cleanTitle(raw: string): string | undefined` — trim; drop surrounding quotes/backticks and a leading `Title:`; collapse whitespace and newlines to single spaces; strip trailing `.,;:!?`; keep the first 6 words; cap 60 characters on a word boundary; `undefined` when empty.
  - `NAMING_MAX_ATTEMPTS = 3`.
  - `createAutoNamer(deps: { harness: Harness; models: Models; readSettings: () => SettingsFile; defaultModel: ModelRef; isTaskOwned(id: ConversationId): Promise<boolean>; timeoutMs?: number; log?: (message: string) => void }): { runSettled: ExtensionRunSettledHandler; idle(): Promise<void> }` — boot's `isTaskOwned` reads the storage `ConversationRecord.owner`; `timeoutMs` defaults to 20 000. — `runSettled` returns immediately and starts naming in the background; `idle()` resolves when no naming call is in flight (tests await it).
  - Naming algorithm: skip unless `outcome.status === "answered"`; skip when `readSettings().namingModel === false`; skip task-owned conversations (`ConversationRecord.owner` set); read the meta doc and skip when `name` or `autoName` is set or `autoNameAttempts >= 3`; resolve the model (`namingModel` string parsed with the same rules as `defaultModel` — reuse `config.ts`'s model-spec parser — or `defaultModel`) with `requireServedModel`; call `models.completeSimple(model, { systemPrompt: NAMING_SYSTEM_PROMPT, messages: [user message containing "User: <first inputText, max 2000 chars>\n\nAssistant: <answer text, max 2000 chars>"] })` with no `reasoning` option and an abort signal fired after `timeoutMs`; `cleanTitle` the text; on a title, commit `autoName` only if `name` and `autoName` are still absent; on any failure (throw, timeout, `undefined` title) commit `autoNameAttempts = (n ?? 0) + 1` and `log` one line. Never rethrows.
  - `NAMING_SYSTEM_PROMPT` (exact): `"Write a short title (at most 6 words) for this conversation. Reply with the title only: no quotes, no trailing punctuation."`
- Produces (fork route): after the fork, in one commit on the fork's meta doc: delete the copied `name` and `autoName`; set `autoName` to `"<source display name> (fork)"` when the source had a display name, else leave unset; set `lastActivityAt` to now.
- Boot: `eventBus.registerExtension("sigrun:auto-name", { runSettled: namer.runSettled })` after the extension registrations; expose `namer` on `OpenedHarness` as `autoNamer` for tests.

- [ ] **Step 1: Write failing tests** in `test/naming.test.ts`:
  - `cleanTitle`: `'"Paris weather lookup."'` → `"Paris weather lookup"`; `"Title: Static site generators with i18n support today"` → `"Static site generators with i18n support"`; `"  \n "` → `undefined`; a 30-word string → 6 words; a single 80-char word → ≤ 60 chars.
  - `names the conversation after the first answered run`: faux scripted with the chat answer then `"Root filesystem layout."` for the naming call; submit, await settle + `autoNamer.idle()`; list row `name === "Root filesystem layout"`.
  - `user name is never overwritten`: PATCH `{name:"Mine"}` before the first submit → after settle + idle, still `"Mine"` and no naming call consumed (faux script has one response; assert it is still pending or count calls).
  - `failure leaves it unnamed and stops after 3 attempts`: naming calls throw (faux error response) → after 4 settled runs, `autoNameAttempts === 3`, no `name`, every run's outcome `answered`.
  - `namingModel false disables naming`: PATCH settings `{namingModel:false}` → no naming call, row unnamed.
  - `unanswered runs do not name`: faux returns an error for the chat call → no naming call.
  - `task-owned conversations are never named` (unit, stub deps with `isTaskOwned: async () => true`) → `completeSimple` never called.
  - `a hanging naming call is abandoned` (unit, stub `completeSimple` that never resolves, `timeoutMs: 50`) → `idle()` resolves, `autoNameAttempts === 1`.
- [ ] **Step 2:** In `test/settings.test.ts`: `namingModel accepts provider/model, false, rejects ""` (400 `field:"namingModel"`). In `test/session-management.test.ts`: `fork gets "<name> (fork)" and drops the copied user name` — source named `"Alpha"`; fork row `name === "Alpha (fork)"`; fork meta has no `name`.
- [ ] **Step 3: Run** `npx vitest run test/naming.test.ts test/settings.test.ts test/session-management.test.ts` — FAIL.
- [ ] **Step 4: Implement** per the Interfaces block.
- [ ] **Step 5: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 6: Commit** `feat(server): automatic conversation naming + fork naming`

---
## Part B — Web UI

### Task B1: Shared pure modules (themes, turns, conversation tree)

**Files:**
- Create: `src/shared/themes.ts`, `src/shared/turns.ts`, `src/shared/conversations.ts`
- Modify: `tui/tsconfig.json` (`include` += `"../src/shared/*.ts"`), `test/views-purity.test.ts` (also scan `src/shared/*.ts`: no `import` statements at all)
- Test: `test/shared-themes.test.ts`, `test/shared-turns.test.ts`, `test/shared-conversations.test.ts` (root vitest)

**Interfaces (all three files have zero imports):**
- `themes.ts`:
  ```ts
  export type PaletteName = "fjord" | "iron-ember" | "polar-night" | "birch-moss";
  export type AccentName = "baltic-amber" | "ember" | "lingonberry" | "glacier" | "aurora" | "lichen" | "heather";
  export type ModeName = "dark" | "light";
  export interface PaletteTokens { bg: string; surface: string; surface2: string; border: string; text: string; muted: string; faint: string; ok: string; code: string }
  export interface Palette { label: string; defaultAccent: AccentName; dark: PaletteTokens; light: PaletteTokens }
  export interface Accent { label: string; dark: string; light: string }
  export const PALETTES: Readonly<Record<PaletteName, Palette>>;
  export const ACCENTS: Readonly<Record<AccentName, Accent>>;
  export const PALETTE_NAMES: readonly PaletteName[]; export const ACCENT_NAMES: readonly AccentName[];
  export const DEFAULT_PALETTE: PaletteName; // "polar-night"
  export const DEFAULT_ACCENT: AccentName;   // "baltic-amber"
  export function isPaletteName(value: unknown): value is PaletteName;
  export function isAccentName(value: unknown): value is AccentName;
  ```
  Values from `palettes.html` (`surface-2` → `surface2`). Palette ids map: `fjord`→`fjord`, `iron`→`iron-ember`, `aurora`→`polar-night`, `birch`→`birch-moss`; accent ids map `amber`→`baltic-amber`, others same name.
- `turns.ts` (structural types so both clients' wire types fit):
  ```ts
  export interface TurnBlock { readonly type: string; readonly text?: string; readonly thinking?: string; readonly id?: string; readonly name?: string; readonly arguments?: unknown }
  export interface TurnMessage { readonly role: string; readonly content: string | readonly TurnBlock[]; readonly toolCallId?: string; readonly toolName?: string; readonly isError?: boolean }
  export interface TurnEntry { readonly id: number; readonly kind: string; readonly model?: readonly TurnMessage[] }
  export interface ToolCall { readonly callId: string; readonly name: string; readonly preview: string; readonly resultEntryId?: number; readonly isError: boolean }
  export type Turn<E extends TurnEntry> =
    | { readonly kind: "user"; readonly entry: E }
    | { readonly kind: "assistant"; readonly entries: readonly E[]; readonly thinking: readonly string[]; readonly tools: readonly ToolCall[]; readonly text: string; readonly lastEntryId: number }
    | { readonly kind: "other"; readonly entry: E };
  export function groupTurns<E extends TurnEntry>(entries: readonly E[]): Turn<E>[];
  export function toolPreview(name: string, args: unknown): string;
  export function activityLabel(turn: { thinking: readonly string[]; tools: readonly ToolCall[] }): string;
  ```
  Rules: consecutive `pi.assistant` and `pi.tool-result` entries form one assistant turn; `pi.user` ends it; every other kind is `other` and also ends it. `text` joins the turn's assistant text blocks with `"\n\n"`. Tool calls come from assistant `toolCall` blocks in order; a `pi.tool-result` whose `toolCallId` matches sets `resultEntryId` and `isError`. `toolPreview`: `bash` → `args.command`; `read`/`write`/`edit`/`ls`/`find` → `args.path`; `grep` → `args.pattern`; otherwise the first string-valued argument; first line only, truncated to 80 chars with `…`; `""` when nothing fits. `activityLabel`: `"Thinking"` when thinking exists, `"<n> tool"`/`"<n> tools"`, joined with `" · "`; `""` when neither. (No durations: the wire carries no per-block timing — see spec deviation note in the final task.)
- `conversations.ts`:
  ```ts
  export interface ListRow { readonly id: number; readonly name?: string; readonly lastActivityAt?: string; readonly parent?: { readonly id: number }; readonly archived: boolean; readonly pinned: boolean }
  export interface TreeNode<R extends ListRow> { readonly row: R; readonly children: readonly TreeNode<R>[]; readonly newestActivity: number }
  export type AgeGroup = "Pinned" | "Today" | "Yesterday" | "Earlier";
  export function buildConversationTree<R extends ListRow>(rows: readonly R[], options: { includeArchived: boolean }): TreeNode<R>[];
  export function ageGroup(node: TreeNode<ListRow>, now: Date): AgeGroup;
  export function formatAge(iso: string | undefined, now: Date): string;
  export function displayName(row: ListRow): string;
  ```
  Rules: children attach to their parent when the parent is in the (filtered) set, otherwise the node is top-level; `newestActivity` = max epoch ms over the subtree (`0` when none); siblings and roots sort by `newestActivity` desc, ties by id desc; pinned roots form group `"Pinned"` first. `ageGroup` uses local calendar days. `formatAge`: `<1m` → `"now"`, minutes `"5m"`, hours `"3h"`, days < 7 `"2d"`, older `"Oct 9"` (`en-US` short month + day), `undefined` → `""`. `displayName`: `name` trimmed, newlines → spaces, or `"New conversation"`.

- [ ] **Step 1: Write failing tests.** `shared-themes`: four palettes and seven accents exist with every token a non-empty string; defaults are `polar-night` / `baltic-amber`; `isAccentName("amber") === false`. `shared-turns`: the root-filesystem fixture (user, assistant thinking+toolCall `bash {command:"ls /"}`, tool-result, assistant text) → turns `[user, assistant]`, assistant `tools[0].preview === "ls /"`, `resultEntryId` set, `activityLabel === "Thinking · 1 tool"`; **tool-only aborted turn** (toolCall with no result) → one tool, `resultEntryId === undefined`, `text === ""`, label `"1 tool"`; compaction between turns → `other` separates them. `shared-conversations`: fork used today under a parent used last week → one root whose group is `"Today"` with the fork as child; archived parent excluded → fork becomes a root; 200-char name with newlines → `displayName` single-line; `formatAge` table above with `now` fixed.
- [ ] **Step 2: Run** `npx vitest run test/shared-*.test.ts test/views-purity.test.ts` — FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** the same command plus `npm --workspace @sigrun/tui run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(shared): palette, turn-grouping and conversation-tree modules`

### Task B2: Theme system and app shell (rail, header, right panel)

**Files:**
- Modify: `webui/src/theme/useTheme.ts`, `webui/src/App.tsx`, `webui/src/app.css` (rewrite on tokens), `webui/index.html` (if it hardcodes a theme attribute)
- Create: `webui/src/layout/Rail.tsx`, `ChatHeader.tsx`, `RightPanel.tsx`, `icons.tsx`
- Delete: `webui/src/layout/TopBar.tsx` (+ test), `webui/src/theme/ThemeControls.tsx`
- Test: `webui/src/theme/useTheme.test.tsx`, `webui/src/layout/Rail.test.tsx`, `ChatHeader.test.tsx`, `RightPanel.test.tsx`, `webui/src/App.test.tsx`

**Interfaces:**
- Consumes: `src/shared/themes.ts`.
- Produces `useTheme(): { mode: "dark" | "light" | "system"; resolved: ModeName; palette: PaletteName; accent: AccentName; setMode; setPalette; setAccent }`. Storage keys: `sigrun.theme` (mode; legacy `dark`/`light` stay valid), `sigrun.palette`, `sigrun.accent`. Migration: stored accent `amber` → `baltic-amber`; any other unknown value (`indigo`, `emerald`, junk) → `DEFAULT_ACCENT`, rewritten on load. `system` follows `matchMedia("(prefers-color-scheme: dark)")` live. Applies tokens as CSS custom properties on `document.documentElement` (`--bg --surface --surface-2 --border --text --muted --faint --ok --code --accent --accent-bg`, `--accent-bg` = accent at 14% dark / 16% light alpha) plus `data-mode`, `data-palette`, `data-accent` attributes.
- Produces `Rail(props: { meta: MetaResponse; onOpenSettings(): void })` — brand mark, one **Chats** entry (active), spacer, health dot, Settings button. Health dot: `data-health="ok"` when every extension is `ok`, `health.memory`/`health.providers` are `ok` and `health.backup !== "degraded"`; otherwise `"degraded"`. Its `title` lists extensions (`"extensions: none"` or names + status) and `backup: <status>`.
- Produces `ChatHeader(props: { title: string; panel: PanelMode | null; onPanel(mode: PanelMode): void; onRename(name: string): Promise<void>; onExport(): void; onCompact(): void; onArchive(): void })`, `type PanelMode = "outline" | "workspace"`. Title click → inline input (Enter saves, Esc cancels). Panel buttons carry `aria-pressed`. `⋯` opens a menu: Export, Compact, Rename, Archive.
- Produces `RightPanel(props: { mode: PanelMode | null; outline: ReactNode; workspace: ReactNode })` — renders nothing when `mode === null`.
- App state: `panel: PanelMode | null`, persisted in `localStorage["sigrun.panel"]`, default `null`; clicking the active mode sets `null`. Settings opens from the rail (the dialog itself is restyled in B7).
- CSS: rewrite `app.css` around the tokens with the mockup's metrics (rail 52px, sidebar 264px, header 48px, column max 720px, right panel 280px). Fonts: `--serif: Georgia, "Iowan Old Style", serif`, `--sans: Inter, -apple-system, "Segoe UI", system-ui, sans-serif`, `--mono: "JetBrains Mono", ui-monospace, Menlo, monospace`. Links in light mode use `--text` with an accent underline (light-mode Baltic Amber is 4.05:1 on white — under 4.5 for text). At ≤ 900px the rail + sidebar become a drawer opened from a header menu button, and the right panel becomes an overlay; nothing in the header wraps at 390px.

- [ ] **Step 1: Write failing tests:** `ChatHeader` with a 200-character title renders it in an element carrying the single-line ellipsis class. `useTheme` — defaults (`system`, `polar-night`, `baltic-amber`); `localStorage["sigrun.accent"]="amber"` → `baltic-amber`; `"indigo"` → `baltic-amber`; `setPalette("fjord")` sets `--bg` on `documentElement` to Fjord's dark `bg` under a dark `matchMedia` stub. `Rail` — degraded dot when an extension is `quarantined`; title contains `backup: unconfigured`. `ChatHeader` — clicking Outline calls `onPanel("outline")`; rename via Enter calls `onRename("New")`. `App` — Outline then Outline again closes the panel; Workspace replaces Outline; the old top-bar accent `<select>` is gone.
- [ ] **Step 2: Run** `npm --workspace @sigrun/webui test` — FAIL.
- [ ] **Step 3: Implement**; move the current workspace toggle and settings entry into ChatHeader / Rail.
- [ ] **Step 4: Run** `npm --workspace @sigrun/webui test && npm run typecheck:webui && npm run build:webui` — PASS. Screenshot at 1440 / 820 / 390 against the running dev build and compare to `web-main-view.html`.
- [ ] **Step 5: Commit** `feat(webui): palette/accent/mode theme system + rail/header/right-panel shell`

### Task B3: Conversation sidebar

**Files:**
- Rewrite: `webui/src/sessions/SessionList.tsx` (+ test)
- Create: `webui/src/sessions/useConversationList.ts` (+ test)
- Modify: `webui/src/App.tsx` (lift the list into App so header/transcript can read names and parents)

**Interfaces:**
- Consumes: `buildConversationTree`, `ageGroup`, `formatAge`, `displayName` (B1); summary fields (A1).
- Produces `useConversationList(client: SigrunClient, options: { busy: boolean }): { rows: readonly ConversationSummary[]; reload(): Promise<void>; error: string | null }` — loads on mount; polls every 10 000 ms while `document.visibilityState === "visible"`; reloads immediately when `busy` goes `true → false`, then again after 5 000 ms (so a just-generated auto name appears without a reload).
- Produces `SessionList(props: { rows; activeId; onSelect(id): void; onNew(): void; onRename(id, name): Promise<void>; onArchive(id, archived: boolean): Promise<void>; onFork(id): void })`. Search input filters by `displayName` (case-insensitive substring) and keeps a match's ancestors visible; `Ctrl+K` / `⌘K` focuses it. Groups render under small headings in order Pinned / Today / Yesterday / Earlier. Children indent one level with a `↳` marker. Row: name (single-line ellipsis) + `formatAge`; on hover/focus the age swaps for a `⋯` menu (Rename, Fork, Archive / Unarchive). An "Archived" toggle at the bottom of the list switches `includeArchived`.

- [ ] **Step 1: Write failing tests:** grouping order with `now` stubbed; fork row renders under its parent with `↳`; search `"hugo"` keeps the parent of a matching fork; a 200-char name renders inside one element with the ellipsis class and the row height unchanged (class assertion); archived rows hidden until the Archived toggle; `useConversationList` reloads on busy→idle and again after 5 s (fake timers).
- [ ] **Step 2: Run** `npm --workspace @sigrun/webui test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** webui test + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(webui): named, grouped, searchable conversation sidebar with fork nesting`

---
### Task B4: Turn-grouped transcript, activity line, message actions

**Files:**
- Create: `webui/src/entries/TurnList.tsx`, `AssistantTurn.tsx`, `ActivityLine.tsx`, `MessageActions.tsx` (+ tests)
- Modify: `webui/src/entries/UserEntry.tsx`, `ToolResultEntry.tsx` (becomes the expanded tool row; diff view kept), `CompactionEntry.tsx`, `webui/src/App.tsx`
- Delete: `webui/src/entries/EntryList.tsx` (+ test) after TurnList covers its cases; `ThinkingBlock.tsx` if unused

**Interfaces:**
- Consumes: `groupTurns`, `activityLabel` (B1); `liveToolSlots`, `liveGenerationPartial`, `slotForEntry` (existing `liveDoc.ts`); `client.fork`, `client.createConversation`, `client.patchConversationMeta`.
- Produces `TurnList(props: { view: ConversationViewWire; showThinking: boolean; parent?: { id: number; name: string }; onNavigate(id: number): void; client: SigrunClient })`. Each turn root carries `data-turn-kind` and `data-entry-id` (user turns) for the outline (B5).
- `ActivityLine`: collapsed by default, also during live runs; open state persisted in `sessionStorage` keyed `sigrun.activity.<conversationId>.<lastEntryId>`. Expanded: thinking text (italic, faint; omitted when `showThinking` is false) then one row per tool — glyph `✓` (result, not error) / `✗` (error) / spinner (live slot running) / `·` (no result, not running), tool name, `preview` in mono, expandable to arguments (JSON) and output (first 20 lines, "Show more" for the rest). Errors from a tool render the row with the error colour even when collapsed — the line shows `· 1 failed`.
- `MessageActions(props: { kind: "user" | "assistant"; text: string; onFork(): void; onEdit?(): void; meta?: string })` — visible on hover and `:focus-within`. Copy uses `navigator.clipboard.writeText(text)` and flips its label to "Copied" for 1.5 s. Tool rows get "Copy command" (the preview's full argument) and "Copy output".
- Fork from here: `client.fork(conversationId, turn.lastEntryId)` → `onNavigate(fork.id)`. For a user turn, fork at that entry.
- Edit (user only): find the entry immediately before the user entry in `view.entries`; if present `client.fork(id, previous.id)`, else `client.createConversation()`; then `patchConversationMeta(newId, { draft: { text: <user text> } })` and `onNavigate(newId)` (the composer's draft restore fills it).
- Assistant meta label: `<model> · <n> tokens` from the last assistant message's `model` and `usage.totalTokens` when present.
- Fork lineage: when `parent` is set, a quiet first row "Forked from <name>" that navigates to the parent.
- Compaction: centred text between two rules, `"Context compacted"`, no button.

- [ ] **Step 1: Write failing tests** (react-test-renderer, existing `test-utils.ts` builders): root-filesystem fixture renders one user bubble + one assistant turn with collapsed `Thinking · 1 tool`; expanding shows `ls /`; tool-only aborted turn renders `1 tool` with the `·` glyph and no empty prose node; `showThinking=false` hides thinking text but keeps the tool row; Fork from here calls `client.fork(1, <lastEntryId>)` then `onNavigate`; **Edit on the first user message** (no previous entry) calls `createConversation` then `patchConversationMeta(newId, {draft:{text}})`; Edit on a later message forks at the previous entry id; Copy writes the assistant markdown source (stub `navigator.clipboard`); compaction renders the divider text.
- [ ] **Step 2: Run** webui tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** webui test + typecheck + build — PASS.
- [ ] **Step 5: Commit** `feat(webui): turn-grouped transcript with activity line, copy, fork and edit`

### Task B5: Markdown everywhere, table filter, code copy, outline, scroll fade

**Files:**
- Create: `webui/src/entries/Markdown.tsx` (+ test), `webui/src/outline/OutlinePanel.tsx` (+ test)
- Modify: `UserEntry.tsx`, `AssistantTurn.tsx`, `App.tsx`, `app.css`

**Interfaces:**
- Produces `Markdown(props: { source: string; variant: "prose" | "bubble" })` — react-markdown + remark-gfm. `prose` uses the serif stack; `bubble` the sans stack. Custom renderers: `table` → `FilterableTable` (filter bar only when data rows `> TABLE_FILTER_MIN_ROWS = 6`; filter is case-insensitive substring over row text; shows `"<visible> of <total> rows"`); `pre > code` → block with a header showing the language (or `text`) and a Copy button; links open in a new tab with `rel="noreferrer"`.
- Produces `OutlinePanel(props: { scrollRoot: HTMLElement | null; turns: readonly { entryId: number; text: string }[] })` — one item per user turn (2-line clamp); click scrolls `[data-entry-id="<id>"]` into view (`block: "start"`, smooth); an `IntersectionObserver` on the user turns marks the topmost visible one `aria-current="true"`.
- Scroll fade: the composer dock sits over the bottom of the scroll area; a pointer-events-none overlay above it uses the mockup's gradient + mask + `backdrop-filter: blur(1.5px)`; the transcript gets bottom padding equal to the dock height so the last message is reachable.

- [ ] **Step 1: Write failing tests:** a 7-row GFM table renders the filter bar and filtering `"zola"` leaves 1 row and `"1 of 7 rows"`; a 6-row table has no filter bar; a fenced `ts` block shows `ts` and Copy writes the code text; a user message `**bold**` renders `<strong>`; OutlinePanel lists two user turns and clicking the second calls `scrollIntoView` on `[data-entry-id="5"]` (stubbed).
- [ ] **Step 2: Run** webui tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** webui test + typecheck + build — PASS; screenshot a scrolled transcript to confirm the fade.
- [ ] **Step 5: Commit** `feat(webui): markdown in prompts, filterable tables, code copy, outline panel, scroll fade`

### Task B6: Composer toolbar with model and thinking pickers

**Files:**
- Modify: `webui/src/composer/Composer.tsx` (+ test), `app.css`
- Create: `webui/src/composer/ModelPicker.tsx`, `ThinkingPicker.tsx` (+ tests)

**Interfaces:**
- Consumes: `client.listModels()`, `client.configure(id, { model?, thinking? })`; the view's `docs["pi.agent"].model` (`{provider, modelId}`) for the current model.
- Layout: one rounded box; textarea on top; toolbar `[attach] [ModelPicker] [ThinkingPicker] spacer [context ring + %] [send]`; hint line below. The ring's `title` is `"<used> / <window> tokens"`.
- `ModelPicker(props: { models: readonly ModelEntry[]; current: string | null; disabled: boolean; onPick(id: string): Promise<void> })` — popover list (shadowed), current marked; picking calls `configure(conversationId, { model: id })`; failure shows the composer error line and keeps the previous selection. Replaces the display-only selection.
- `ThinkingPicker(props: { current: string | null; onPick(level: string): Promise<void> })` — the existing `THINKING_LEVELS`; always rendered regardless of `ModelEntry.reasoning`. Current level: `perModelThinking` is not on the view, so show the last level picked in this session or `"default"`.
- Hint text (exact): with `enterToSend` off `"Ctrl+Enter to send · / for commands"`; on `"Enter to send · Shift+Enter for newline · / for commands"`. The `enterToSend` pref and its default (off) are unchanged.
- Send: accent background when enabled; disabled state uses `--surface-2` background and `--faint` icon. Attach becomes an icon button with the same upload behaviour.

- [ ] **Step 1: Write failing tests:** picking a model calls `configure(1, {model:"faux/m2"})`; a rejected configure leaves the previous model shown and renders the error; the thinking picker renders even when every model has `reasoning:false`; hint text matches both pref states; disabled send carries `aria-disabled` and the disabled class.
- [ ] **Step 2: Run** webui tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** webui test + typecheck + build — PASS.
- [ ] **Step 5: Commit** `feat(webui): composer toolbar with live model and thinking pickers`

### Task B7: Settings restyle, Interface section, credit, e2e

**Files:**
- Modify: `webui/src/settings/SettingsPanel.tsx` (+ test), `app.css`, `README.md`, `webui/e2e/smoke.spec.ts` + affected e2e specs
- Create: `THIRD_PARTY_NOTICES.md`; `package.json` `files` += `"THIRD_PARTY_NOTICES.md"`

**Interfaces:**
- Interface section gains: Mode (System / Dark / Light), Palette (four swatch buttons, each showing its bg + text + default accent), Accent (seven round swatches with labels in `title`). Changes apply immediately via `useTheme` (no Save needed for these three; existing server-backed fields keep their Save).
- `showThinking` description updates to "Show thinking text inside activity details".
- All selects become styled custom controls or `appearance: none` selects with token colours; labels sentence case in the sans stack; dialog title "Settings".
- `THIRD_PARTY_NOTICES.md`: a "hermes-webui" heading, URL `https://github.com/nesquena/hermes-webui`, a line that sigrun's web UI visual design is adapted from it, then its MIT licence text verbatim from `~/repos/hermes-webui/LICENSE` (copyright line "Copyright (c) 2025 Hermes Web UI Contributors").
- README gains under the web UI section: "The web UI's visual design is adapted from [hermes-webui](https://github.com/nesquena/hermes-webui) by nesquena and contributors — see THIRD_PARTY_NOTICES.md."

- [ ] **Step 1: Write failing tests:** picking Fjord in the Interface section sets `data-palette="fjord"` on `documentElement`; picking Lichen sets `data-accent="lichen"`; Mode Light sets `data-mode="light"`.
- [ ] **Step 2: Run** webui tests — FAIL; implement; re-run — PASS.
- [ ] **Step 3: Update e2e specs** to the new selectors (stable `data-*` hooks added in B2–B6) and run `npm run test:e2e` — PASS.
- [ ] **Step 4: Commit** `feat(webui): restyled settings with palette/accent/mode + hermes-webui credit`

---
## Part C — TUI

### Task C1: Fullscreen launcher, theme, layout, status bar

**Files:**
- Modify: `tui/src/launch.ts`, `tui/src/ui/app.ts`, `src/cli.ts` (`TuiFile`, `loadTuiFile`, `LaunchTuiOptions`, default `launchTui`), `test/cli.test.ts`
- Create: `tui/src/theme.ts`, `tui/src/ui/status-bar.ts` (+ tests in `tui/test/`)
- Test: `tui/test/launch.test.ts`, `tui/test/app.test.ts`, `tui/test/theme.test.ts`, `tui/test/status-bar.test.ts`

**Interfaces:**
- `TuiFile` gains `palette?: PaletteName; accent?: AccentName; mode?: ModeName; keymap?: "standard" | "vim" | "emacs"; editor?: string`; `loadTuiFile` validates each (fail-loud message naming the key, e.g. `tui.json: palette must be one of fjord, iron-ember, polar-night, birch-moss`). `LaunchTuiOptions` gains the same five as optional fields; `launchTuiShell` receives them.
- `tui/src/theme.ts`: `interface TuiTheme { fg(token: keyof PaletteTokens | "accent"): (s: string) => string; bg(token): (s: string) => string; bold(s): string; dim(s): string; italic(s): string }`; `createTuiTheme(opts: { palette: PaletteName; accent: AccentName; mode: ModeName; colorMode: TerminalColorMode }): TuiTheme` built on pi-tui `parseColor` / `foregroundAnsi` / `backgroundAnsi` (pi-tui degrades truecolour to 256 when `colorMode` says so — use `getTerminalColorMode()` at launch). `plainTuiTheme()` returns identity functions (tests).
- `StatusBar implements Component`: `set(state: { mode?: string; conversation: string; model?: string; thinking?: string; contextPct?: number; hints: readonly string[]; message?: string })`; renders exactly one line: left `mode` (accent bg) + `conversation`, right `model · thinking · ctx N%` then hints; when too narrow, drops hints first, then `thinking`, keeping `model` and `ctx`; `message` (transient, 4 s) replaces the hints.
- `launchTuiShell`: `new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: true })`; layout via `tui.setLayoutRoot(new VStack([...]))`: body `HStack` [sidebar (basis 28, `visible: (w) => w >= 80`), `ScrollView(pane, { follow: "end", primary: true, overscroll: "chain" })` grow 1] grow 1; interactions + ambient `basis: "auto"`; composer `basis: "auto"`; status bar basis 1. `TuiApp` stops being the mounted root render path (it still owns the components and exposes them).
- Built-in alt-screen bindings: install `setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": [], "tui.altScreen.searchNext": [], "tui.altScreen.searchPrevious": [], "tui.altScreen.previousPrompt": [], "tui.altScreen.nextPrompt": [] }))` before constructing the screen. The action layer owns search and prompt jumps (they must target turns and move focus; the built-ins search raw lines and jump OSC 133 marks sigrun never emits). Built-in `pageUp`/`pageDown`/`ctrl+home`/`ctrl+end` scrolling and wheel scrolling stay.
- Remove the `Ctrl+B` sidebar toggle and `Ctrl+F` fork from `TuiApp.handleKeybinding` (C3 reintroduces navigation through the action layer). Keep `Ctrl+O` and `Esc`-cancel for now; `Ctrl+C` still quits.

- [ ] **Step 1: Write failing tests:** `loadTuiFile` accepts `{palette:"fjord", accent:"lichen", mode:"light", keymap:"vim", editor:"/usr/bin/nvim"}` and rejects `palette:"nord"` with the key named (`test/cli.test.ts`); `createTuiTheme(...).fg("accent")("x")` contains the Baltic Amber RGB SGR sequence `38;2;214;162;74` under truecolor; StatusBar at width 40 keeps `model` and `ctx` and drops hints; `app.handleKeybinding("\x02")` (Ctrl+B) returns `false`; `launch.test` asserts the shell is constructed with `TuiAltScreen` and `mouse: true` (inject the constructor via a test seam on `launchTuiShell` options if none exists).
- [ ] **Step 2: Run** `npm --workspace @sigrun/tui run test && npm test -- test/cli.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tui test + typecheck + root `test/cli.test.ts` — PASS. Manual check in tmux: `npx tsx src/cli.ts attach --server http://localhost:3000`, then `tmux capture-pane -e` shows colour and the status bar.
- [ ] **Step 5: Commit** `feat(tui): fullscreen alt-screen shell, themed colours, status bar`

### Task C2: Transcript and conversation list restyle (focusable, foldable, clickable)

**Files:**
- Modify: `tui/src/ui/conversation-pane.ts`, `tui/src/ui/sidebar.ts` (+ tests)

**Interfaces:**
- Consumes: `groupTurns`, `activityLabel`, `toolPreview` (B1); `buildConversationTree`, `formatAge`, `displayName` (B1); `TuiTheme` (C1).
- `ConversationPane` gains: `turns(): readonly Turn<EntryShape>[]`; `focusIndex: number | undefined` (focused turn; `undefined` = none, follow end); `setFocus(index: number | undefined): void`; `toggleFold(index: number): void`; `lineRangeOf(index: number): { start: number; end: number } | undefined` (line offsets from the last render, for `ScrollView.scrollTo`); `textOf(index: number): string` (markdown source of a user/assistant turn — copy payload); `entryIdOf(index): number` (user entry id or assistant `lastEntryId`).
- Rendering: user turn = accent `▎` bar on every line + text; assistant prose = Markdown; activity = one dim line `▸ Thinking · 2 tools` (`▾` when open); open shows thinking (dim italic, unless empty) and `✓ bash  ls /` rows (`✗` for an error result; `·` for no result; `◌` for a running slot); focused turn gets a `surface2` background on its first line and a `›` gutter marker; `pi.compaction` → centred `── context compacted ──`. `[tool]` / `[thinking]` tags are gone.
- Mouse: wrap each activity line in a `MouseRegion` — left click toggles fold; a click on a turn's body sets focus.
- `Sidebar` rewrite: rows from the tree (fork children indented two spaces + `↳ `), right-aligned `formatAge`, single-line truncated names (`truncateToWidth`), active row highlighted with `accent-bg`-equivalent (accent fg + bold); `+ New conversation` stays as the last row; a click selects a row (MouseRegion per row or `handleMouse` on the list). Public: `rows`, `refresh()`, `setActive(id)`, `onSelect`, plus `cursor: number`, `moveCursor(delta)`, `confirm()` for the action layer. `refresh()` uses list summary fields only (no per-row meta fetch) and polls every 10 s from the app (`setInterval`, unref'd, cleared on dispose).

- [ ] **Step 1: Write failing tests:** render (plain theme) the root-filesystem fixture → contains `▸ Thinking · 1 tool`, not `[tool]`; `toggleFold(1)` → contains `✓ bash  ls /`; tool-only aborted turn → `▸ 1 tool` and `·`; `setFocus(0)` → first user line starts with `›`; `lineRangeOf(1)` is after `lineRangeOf(0)`; `textOf(1)` returns the assistant markdown; sidebar: fork renders `↳ ` under its parent, a 200-char name renders on one line of width ≤ sidebar width, `moveCursor(1)` + `confirm()` calls `onSelect` with the next id.
- [ ] **Step 2: Run** tui tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tui test + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(tui): turn-grouped, foldable, focusable transcript and named conversation tree`

### Task C3: Action layer, standard keymap, pickers, copy, fork/edit

**Files:**
- Create: `tui/src/actions.ts`, `tui/src/keymaps/types.ts`, `tui/src/keymaps/standard.ts`, `tui/src/ui/picker.ts`, `tui/src/clipboard.ts` (+ tests)
- Modify: `tui/src/ui/app.ts`, `tui/src/launch.ts`, `tui/src/api.ts` (add `listModels`, `configure`)

**Interfaces:**
- `actions.ts`:
  ```ts
  export type Focus = "composer" | "list" | "transcript";
  export type Action =
    | { type: "focus"; target: Focus } | { type: "focus-cycle"; direction: 1 | -1 }
    | { type: "move"; delta: number } | { type: "page"; direction: 1 | -1; half: boolean } | { type: "edge"; to: "top" | "bottom" }
    | { type: "prompt-jump"; delta: 1 | -1 } | { type: "toggle-fold" } | { type: "open" }
    | { type: "copy" } | { type: "fork-here" } | { type: "edit-here" } | { type: "edit-in-vim" }
    | { type: "picker"; kind: "conversation" | "model" | "command" } | { type: "new-conversation" } | { type: "cycle-thinking" }
    | { type: "search"; direction: "forward" | "backward" } | { type: "search-next"; reverse: boolean }
    | { type: "answer-interaction" } | { type: "cancel-run" } | { type: "redraw" } | { type: "quit" } | { type: "help" }
    | { type: "command-line" } | { type: "run-command"; line: string };
  export interface ActionHost { dispatch(action: Action): Promise<void> }
  ```
  `TuiApp implements ActionHost` and owns `focus: Focus`. Semantics: `move` moves the sidebar cursor (list) or `pane.focusIndex` (transcript, scrolling `lineRangeOf` into view); `prompt-jump` moves focus to the previous/next user turn; `open` on list = select, on transcript = toggle fold; `copy` copies `pane.textOf(focus)`; `fork-here` = `forkConversation(id, pane.entryIdOf(i))` then select it; `edit-here` follows B4's Edit rule (previous entry fork, else create; prefill via `patchMeta(newId, { draft: { text } })`; set the composer text locally too); `cycle-thinking` cycles `off → minimal → low → medium → high → xhigh → off` via `configure`; `search` opens a one-line query in the status bar, matching turn text case-insensitively and focusing the next match; `run-command` parses `/name args` through the existing slash path; `cancel-run` = existing abort.
- `keymaps/types.ts`:
  ```ts
  export interface KeyContext { readonly focus: Focus; readonly busy: boolean; readonly autocompleteOpen: boolean; readonly overlayOpen: boolean }
  export type KeyResult = Action | "pass" | "consume";
  export interface Keymap { readonly name: "standard" | "vim" | "emacs"; modeLabel(): string | undefined; handle(data: string, ctx: KeyContext): KeyResult; hints(ctx: KeyContext): readonly string[]; describe(): readonly { keys: string; action: string }[] }
  export const RESERVED_KEYS: readonly string[]; // ["ctrl+b","ctrl+a","ctrl+e","ctrl+f","ctrl+k","ctrl+u","ctrl+w","ctrl+y","ctrl+d","ctrl+j"]
  ```
  `"pass"` = let the focused component (composer) have the key. The launcher's single input listener asks the keymap, then dispatches / consumes / passes. While `ctx.overlayOpen` the keymap passes everything except its cancel key.
- `standard.ts` (`createStandardKeymap(): Keymap`): global `Ctrl+P` picker conversation, `Ctrl+N` new, `Ctrl+T` cycle-thinking, `Ctrl+O` answer-interaction, `Ctrl+L` redraw, `Ctrl+C` quit, `Tab` / `Shift+Tab` focus-cycle, `Esc` = cancel-run when busy else focus composer (pass when `autocompleteOpen`), `?` help (outside composer). Outside the composer: arrows move, `PgUp/PgDn` page, `Home/End` edge, `Enter` open, `y` copy, `f` fork-here, `e` edit-here, `/` search, `n`/`N` search-next. In the composer everything else passes. **Ctrl+D/U are composer chords here and are not bound.**
- `picker.ts`: `openPicker<T>(tui, items: readonly { label: string; detail?: string; value: T }[], options: { title: string; onPick(value: T): void })` — centred overlay, `SelectList` with fuzzy filter as you type, `Enter` pick, `Esc` close; mouse click picks. Conversation picker items from the tree (indented forks); model picker from `listModels()`; command picker from the slash catalog.
- `clipboard.ts`: `osc52(text: string): string` → `"\x1b]52;c;" + base64(utf8) + "\x07"`, wrapped for tmux (`"\x1bPtmux;\x1b" + seq.replaceAll("\x1b", "\x1b\x1b") + "\x1b\\"`) when `env.TMUX` is set; `copyToTerminal(terminal, text, env)` writes it and the app flashes `"Copied"` in the status bar.
- TUI-local commands `/archive` and `/unarchive` call `patchMeta(id, { archived })` and refresh the list; `/name <text>` (existing slash) renames.
- `/model <id>` and `/thinking <level>` in the TUI composer stop being rejected: they call `configure` and show the result in the status bar. Clicking the status bar's model / thinking segment opens the model picker / cycles thinking.

- [ ] **Step 1: Write failing tests:** standard keymap — `"\x10"` (Ctrl+P) in composer focus → `{type:"picker",kind:"conversation"}`; `"y"` in composer → `"pass"`, in transcript → `{type:"copy"}`; `"\x1b"` busy → cancel-run, not busy → focus composer, autocomplete open → pass; every key in `RESERVED_KEYS` returns `"pass"` in every focus (loop with `Key.ctrl(...)` encodings). App — `dispatch({type:"fork-here"})` with focus on turn 1 calls `forkConversation(id, lastEntryId)` and selects the fork; `edit-here` on the first user turn calls `createConversation` + `patchMeta(new, {draft:{text}})`; `cycle-thinking` calls `configure(id,{thinking:"minimal"})` from `off`; `/model faux/m2` calls `configure`. Clipboard — `osc52("hi")` equals `"\x1b]52;c;aGk=\x07"`; with `TMUX` set it is DCS-wrapped.
- [ ] **Step 2: Run** tui tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tui test + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(tui): action layer, standard keymap, pickers, OSC 52 copy, fork/edit from a message`

---
### Task C4: Vim keymap and the vim-only editor round-trip

**Files:**
- Create: `tui/src/keymaps/vim.ts`, `tui/src/editor-launch.ts` (+ tests)
- Modify: `tui/src/launch.ts` (keymap selection from `tui.json`), `tui/src/ui/app.ts` (command line in the status bar, `edit-in-vim`)

**Interfaces:**
- `createVimKeymap(): Keymap & { readonly mode: "insert" | "normal" | "command" }`. Starts in **insert** with focus composer. `modeLabel()` → `"-- INSERT --"` / `"-- NORMAL --"` / `undefined` in command (the status bar shows the `:` line instead).
  - Insert: every key passes except `Esc` (→ normal, focus transcript; pass when autocomplete open), `Ctrl+C` (cancel-run when busy; otherwise consumed — quitting is `ZZ` or `:q` from normal), `Ctrl+O` answer-interaction.
  - Normal: `j`/`k` move, `h` focus list, `l` focus transcript, `Ctrl+D`/`Ctrl+U` half page, `Ctrl+F`/`Ctrl+B` are **not** bound, `gg` (two-key, 500 ms window) / `G` edge, `{` / `}` prompt-jump, `Enter` or `za` toggle-fold, `o` open, `y` copy (`yy` also), `f` fork-here, `e` edit-here, `v` edit-in-vim, `/` and `?` search forward/backward, `n`/`N` search-next, `i`/`a` → insert + focus composer, `:` → command, `Ctrl+P` picker, `Ctrl+L` redraw, `Ctrl+C` cancel-run when busy, `ZZ` quit. Unbound printable keys are consumed (never typed into the composer).
  - Command: characters accumulate into the line (Backspace edits, Esc cancels → normal, Tab completes the command name from the table below plus the slash catalog), Enter dispatches `{type:"run-command", line}` → normal.
- Command table (in `app.ts` `runCommand`): `new` → new-conversation; `fork` → fork-here; `model <id>` → configure; `set thinking=<level>` → configure; `b <name|id>` → select the first conversation whose id equals the arg or whose `displayName` contains it case-insensitively (status message `no match` otherwise); `ls` → conversation picker; `q` / `quit` → quit; anything else → the slash path as `/<line>`.
- `editor-launch.ts`:
  ```ts
  export const VIM_NAMES: readonly string[]; // ["vim", "nvim", "vi"]
  export function isVimFamily(command: string): boolean; // basename of the first whitespace-separated token ∈ VIM_NAMES
  export function resolveVimEditor(opts: { configured?: string; env: NodeJS.ProcessEnv; which(name: string): string | undefined }): string | undefined;
  export function editInVim(opts: { text: string; editor: string; tui: { stop(): void; start(): void; requestRender(force?: boolean): void }; spawnSync?: typeof import("node:child_process").spawnSync; tmpDir?: string }): { ok: true; text: string } | { ok: false; reason: string };
  ```
  Resolution order: `configured` → `env.VISUAL` → `env.EDITOR` — each used only when `isVimFamily`; then `which("nvim")`, `which("vim")`, `which("vi")`; else `undefined`. `editInVim`: write text to `<tmpDir>/sigrun-prompt-<random>.md`, `tui.stop()`, `spawnSync(editor-command-split, [file], { stdio: "inherit" })`, `tui.start()`, `requestRender(true)`; non-zero exit or unreadable file → `{ok:false, reason}` and the draft is untouched; always unlink the temp file. The app shows `no vim found` when resolution fails and never spawns anything.
- `launch.ts` picks the keymap from `options.keymap` (`standard` default).

- [ ] **Step 1: Write failing tests:** vim — starts insert, `"j"` passes; `Esc` → normal, `"j"` → move +1, `"x"` consumed (not passed); `g`,`g` within window → edge top, `g` then 600 ms then `g` → no edge (fake timers); `:` then `b`,` `,`h`,`u`,`g`,`o`, Enter → `{type:"run-command", line:"b hugo"}`; every `RESERVED_KEYS` key in insert passes. Editor — `isVimFamily("/opt/bin/nvim -u NONE")` true, `"nano"` false, `"/usr/bin/vimdiff"` false; `resolveVimEditor({env:{EDITOR:"nano"}, which: n => n==="vim" ? "/usr/bin/vim" : undefined})` → `"/usr/bin/vim"`; with `which` returning nothing and `EDITOR=nano` → `undefined`; `editInVim` with a stub `spawnSync` that rewrites the file → returns the new text and calls stop/start/requestRender in order; stub exiting 1 → `{ok:false}` and stop/start still balanced; stub that deletes the file → `{ok:false}`. App — `edit-in-vim` with resolution `undefined` sets the status message `"no vim found"` and leaves the composer text unchanged.
- [ ] **Step 2: Run** tui tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tui test + typecheck — PASS. Manual: `tui.json` `{ "keymap": "vim" }`, check `Esc`, `:b`, `v` opens vim and the edit lands in the composer.
- [ ] **Step 5: Commit** `feat(tui): vim keymap with insert/normal/command modes and vim-only prompt editing`

### Task C5: Emacs keymap, key reference overlay, TUI e2e

**Files:**
- Create: `tui/src/keymaps/emacs.ts`, `tui/src/ui/help.ts` (+ tests)
- Modify: `tui/test/e2e.test.ts`, `tui/src/launch.ts`

**Interfaces:**
- `createEmacsKeymap(): Keymap` — modeless. Prefix `C-x` (`"\x18"`) arms a 1 000 ms chord: `C-x b` picker conversation, `C-x o` focus-cycle +1, `C-x C-c` quit, `C-x k` (no-op, consumed). `M-x` (`"\x1bx"`) opens the command picker. `C-s` / `C-r` search forward / backward (and next / previous while a search is open). `C-g` cancel-run when busy, else closes search/picker, else focus composer. `M-p` / `M-n` prompt-jump −1/+1. `M-w` copy, `M-f` fork-here, `M-e` edit-here (outside the composer; inside the composer `M-f` passes as the editor's word-forward). `C-n` / `C-p` move outside the composer. `C-o` answer-interaction, `C-l` redraw, `C-h` help. All reserved composer chords pass.
- `showHelp(tui, keymap: Keymap): void` — overlay listing `keymap.describe()` in two columns, closed by `Esc`, `q`, or the keymap's help key.
- Status-bar hints per keymap (from `keymap.hints(ctx)`): standard composer focus `["Tab focus", "^P chats", "? keys"]`; vim normal `["i insert", ": command", "? keys"]`, vim insert `["Esc normal"]`; emacs `["C-x b chats", "M-x commands", "C-h keys"]`.

- [ ] **Step 1: Write failing tests:** emacs — `C-x` then `b` → picker conversation; `C-x` then 1 100 ms then `b` → `"pass"` (fake timers); `C-g` busy → cancel-run; reserved chords pass in composer focus; `M-f` in composer passes, in transcript → fork-here. Help overlay renders every `describe()` row. e2e (`tui/test/e2e.test.ts`, existing headless pattern): for each keymap, create two conversations, switch via that keymap's picker key, send a prompt, fold/unfold the activity line, copy (assert the OSC 52 write on the fake terminal), and fork from the answer — the new conversation becomes active with the fork's name.
- [ ] **Step 2: Run** tui tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tui test + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(tui): emacs keymap, key reference overlay, per-keymap e2e`

---

## Task D: Whole-branch verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-ui-refresh-design.md` (Decisions ledger: deviations), `AGENTS.md` (mention `src/shared/` as the pure client-shared leaf), `CHANGELOG.md` (Unreleased entry)

- [ ] **Step 1:** Record in the spec's ledger the deliberate deviations: (a) activity lines show counts (`Thinking · 2 tools`), not durations — the wire carries no per-block timing; (b) the web table filter threshold is `> 6` data rows; (c) a fork of an unnamed conversation stays eligible for auto naming (only named sources hand down `"<name> (fork)"`); (d) the TUI disables alt-screen's built-in search and prompt-jump bindings in favour of turn-aware actions.
- [ ] **Step 2:** Run the full gate: `npm test && npm run typecheck && npm run typecheck:webui && npm run build:webui && npm --workspace @sigrun/webui test && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck && npm run test:e2e` — all PASS.
- [ ] **Step 3:** Rebuild the docker image, run it on a free port, and capture web screenshots at 1440 / 820 / 390 in dark and light, plus a tmux capture of the TUI in each keymap; compare to the mockups.
- [ ] **Step 4: Commit** `docs: UI refresh — ledger deviations, shared leaf, changelog`
