# Sigrun UI refresh — web UI, TUI, and conversation metadata

> Status: design, pending approval. Written 2026-10-17 from a review of
> the running v0 web UI and TUI (screenshots of the starting state were
> taken at 1440/820/390px, dark + light, and from a tmux-attached TUI).
> Reference mockups, committed next to this file:
> `assets/2026-10-17-ui-refresh/web-main-view.html` (layout, transcript,
> composer) and `assets/2026-10-17-ui-refresh/palettes.html` (the four
> palettes × seven accents, dark + light). Open them in a browser; both
> are self-contained static HTML.

## 1. Intent

Both clients work but look basic: every element is boxed, labelled,
and always visible, so the transcript reads like a debug log. The goal
is **refined simple, not basic simple** — fewer borders, fewer labels,
progressive disclosure, and a calm reading surface.

The visual direction is **openly adapted from
[hermes-webui](https://github.com/nesquena/hermes-webui)**, the user's
daily driver. The imitation is deliberate and credited (§9). Its
`DESIGN.md` is the style reference: conversation first, one accent at a
time, metadata quieter than prose, shadows only on floating UI. Where
hermes is busy (too many options visible at once, a floating outline
icon), sigrun is quieter.

The TUI's reference points are opencode (friendly by default) and pi
(fullscreen, keyboard-driven). The TUI must be fully usable without a
mouse; the user is a vim user.

The project has three parts, built in this order:

1. **Server: conversation metadata** — names (including automatic
   naming), last-activity time, fork lineage on the conversation list.
   Both clients' sidebars depend on it.
2. **Web UI refresh.**
3. **TUI refresh.** Reuses the palette and accent definitions settled
   in part 2.

## 2. Goals, non-goals, anti-goals

**Goals**
- The web UI matches the reference mockup in layout, rhythm, and type.
- Palette and accent are both user-selectable in both clients.
- Copy and fork-from-here on every message, in both clients.
- Model and thinking pickers in the composer (web) and status bar (TUI).
- The TUI is fullscreen with mouse support, and every action is
  keyboard-reachable.
- Three TUI keymaps: standard (default), vim, emacs.
- The conversation list shows names, ages, and fork nesting.

**Non-goals (catalogued for later, not built here)**
- Workspace write operations (write/delete/rename/mkdir/download),
  drag-and-drop into the workspace, and a "files the agent changed"
  view. Uploads and read-only list/read already exist and stay as-is.
- A built-in terminal pane (needs a PTY/WebSocket endpoint).
- Board, tools, skills, and memory panes. The section rail ships with
  only the sections that work today (§4.2); the rest wait on an
  extension panel-registration seam, the same deferred design as
  extension-provided settings sections.
- Search across conversation *contents* (the sidebar filter is by name
  only).
- Cost display (usage reports $0 for gateway models until pricing is
  wired through).
- Native vim editing inside the prompt field (`w`, `ciw`, `dd`, ...).
  Vim mode hands the prompt to real vim instead (§5.4).

**Anti-goals (a failure even if it technically works)**
- Every tool call rendered as a first-class transcript card.
- Diagnostics (extension count, backup status) in the most prominent
  spot on screen.
- Any TUI action that only the mouse can reach.
- A TUI global keybinding that collides with tmux/herdr's `Ctrl+B` or
  with the composer's existing emacs-style editing keys.
- Vim mode opening anything other than a vim-family editor.
- Multiple decorative accent colours in one viewport.

## 3. Server: conversation metadata

### 3.1 What the list must carry

`GET /v1/conversations` summaries gain three fields (additive,
read-only on this endpoint):

| Field | Meaning |
|---|---|
| `name` | Display name: user-set name if present, else auto-generated name, else absent. |
| `lastActivityAt` | Wall-clock time (ISO 8601) of the most recent settled run or submission. Absent for never-used conversations. |
| `parent` | `{ id, at }` — the conversation and entry it was forked from. Absent for non-forks. |
| `archived`, `pinned` | Copied from session meta so clients can filter without per-row fetches. |

The list becomes the **single source** for sidebar rows. Today both
clients fetch `/meta` once per conversation after listing (web
`SessionList.tsx`, TUI `sidebar.ts`); that N+1 pattern is removed.
Per-conversation `/meta` stays for the draft and the detail view.

Clients format ages ("2m", "1d", "Oct 9") and the Today / Yesterday /
Earlier grouping themselves. The server returns a flat list; clients
assemble the tree. Forks nest under their parent in both sidebars. A
tree sorts and groups by the newest `lastActivityAt` anywhere in it, so
a parent moves up when one of its forks is used and its forks always
sit directly under it. A fork whose parent is archived or missing shows
at top level.

`parent` comes straight from pi-durable's `ConversationRecord.parent`
— no new storage.

**Constraint:** pi-durable entry records carry no wall-clock time, so
sigrun records `lastActivityAt` itself, in the conversation's session
meta. The runSettled seam event (or the same settle observation it is
built on) is the natural hook. Whether a submission's admission also
bumps the time is left to the builder; the visible requirement is that
a conversation the user just used sorts to the top.

### 3.2 Automatic naming

- After the **first settled run** of a conversation that has no name,
  sigrun generates a short title (target ≤ 6 words, no trailing
  punctuation) from the first user prompt and the answer, and stores it
  as the auto name.
- **A user-set name always wins** (`/name`, rename in the UI). An auto
  name never overwrites a user name. Clearing the user name falls back
  to the auto name.
- Store user and auto names separately so a rename is reversible and
  the auto name is never mistaken for user intent.
- Naming runs off the request path and must never block or fail a run.
  A failed naming call leaves the conversation unnamed and is logged;
  it retries at the next settled run, up to a small bound.
- The naming call is a **one-shot pi-ai completion** (`complete`), not
  a pi-durable conversation. A hidden scratch conversation would show
  up in conversation enumeration, so it is not allowed. It reuses the
  same provider and credential resolution the harness uses for the
  chosen model; the builder exposes that resolution from
  `src/harness/providers/` rather than duplicating it.
- The naming model is a new settings key (`namingModel`, settings file
  and `PATCH /v1/settings`). It defaults to the server's default model.
  Thinking is off for the naming call.
- Auto naming can be switched off with the same key (`namingModel:
  false`); the conversation then stays unnamed until the user names it.
- Forks get the parent's name with a fork marker at creation (the
  builder picks the exact form; the mockup shows "…Hugo deep dive" for
  a renamed fork). Auto naming does not re-run on a fork.
- Both clients pick up name changes live (the existing stream or a list
  refresh — builder's choice). A newly named conversation's title
  appears without a page reload.

### 3.3 Rename and archive from the UI

The existing meta PATCH endpoint already accepts `name` and `archived`;
the web "⋯" menus and the TUI call it. No new endpoint.

## 4. Web UI

### 4.1 Visual system

- **Typography.** Assistant prose: serif stack (Georgia substitute).
  User bubbles and all UI: sans. Monospace only for code, commands,
  paths, and tool names. Tight scale: 11px metadata, 12–13px labels,
  14px UI body, ~15.5px assistant prose.
- **Surfaces.** Near-zero shadows in the transcript; shadows only on
  popovers, menus, and dialogs. Cards use a subtle border *or* a subtle
  tint, not both. Radii: rows 4–8px, cards/panels 8–12px, pills 999px
  for true chips only.
- **Palettes.** Four, all shipped, each with dark and light variants:
  Fjord, Iron & Ember, Polar Night, Birch & Moss. Exact values are in
  `palettes.html`.
- **Accents.** Seven, shared by every palette: Baltic Amber, Ember,
  Lingonberry, Glacier, Aurora, Lichen, Heather. Each has a dark-mode
  value and a darker light-mode value for contrast (both in
  `palettes.html`).
- **Defaults.** Polar Night + Baltic Amber; mode follows the system.
- **Settings.** Palette, accent, and mode (dark / light / system) live
  in Settings → Interface and replace the current header accent picker
  and theme toggle. Choices persist per browser, as today.
- **Migration.** Existing stored accent values (`indigo`, `emerald`,
  `amber`) map to the nearest new accent (`amber` → Baltic Amber; the
  others → the default). No user-visible error.

### 4.2 Layout

Left to right, per the mockup:

1. **Section rail** (~52px). Brand mark at the top, then section icons
   with an accent indicator on the active one. Ships with **Chats**
   only, plus **Files** if the builder finds a full-screen workspace
   view cheap; no placeholder icons for sections that don't exist. At
   the bottom: a single **health dot** (green ok / amber degraded / red
   down, from `/v1/meta`; tooltip lists extensions and backup status)
   and **Settings**. The rail is the extension point for future panes.
2. **Conversation sidebar** (~264px). Search field (filters by name,
   `⌘K`/`Ctrl+K` focuses it) and a small "+" new button. Rows: name
   (or "New conversation" when unnamed) plus age; grouped Today /
   Yesterday / Earlier; forks indented under their parent. Archive,
   rename, and fork actions sit in a per-row "⋯" that appears on hover.
   Archived conversations are reachable from a filter or a section at
   the bottom (builder's choice), not listed inline.
3. **Main column.** Header (48px): conversation name (click to rename),
   then right-aligned icon buttons for **Outline**, **Workspace**, and
   **⋯** (export, compact, rename, archive). The transcript is a
   centred reading column, max ~720px.
4. **Right panel** (~220–300px, optional). One panel, two modes:
   Outline or Workspace. The header buttons switch modes; clicking the
   active mode closes the panel. Closed by default. Open/closed and mode
   persist per browser.

At narrow widths (≤ ~900px) the rail and sidebar collapse into a
drawer and the right panel becomes an overlay. The top bar must not
wrap to two lines at 390px.

### 4.3 Transcript

- **User turn.** Right-aligned compact bubble. Content renders as
  **Markdown** (GFM), same renderer as assistant prose.
- **Assistant turn.** Unboxed prose, left-aligned in the column.
- **Activity line.** All thinking and tool calls of one assistant turn
  collapse into a single quiet disclosure: `Thought for 4s · 3 tools`
  (the builder picks the exact wording rules; it stays terse and never
  lists tool names). Collapsed by default, during live runs too.
  Expanded: thinking text (italic, faint) and one row per tool —
  status glyph (✓ / ✗ / spinner), tool name, a short target preview
  (the command, path, or URL), and duration. Each tool row expands
  again to its arguments and output (output truncated, "show more" for
  the full log). The existing diff view for edit results stays, inside
  the tool row.
- **Errors and pending approvals** are the exception: they show
  prominently and are never folded away.
- **Compaction** renders as a centred, non-interactive divider with
  horizontal rules, not a card.
- **Message actions.** On hover (and on keyboard focus), a small action
  row under each message:
  - user message: **Copy**, **Edit**, **Fork from here**;
  - assistant message: **Copy**, **Fork from here**, and a right-aligned
    faint `model · tokens` label when known;
  - tool row: **Copy command** and **Copy output**;
  - code block: **Copy** in the block header (with the language label).
  Copy puts Markdown on the clipboard.
- **Fork from here** forks at that entry and navigates to the fork.
- **Edit** (user messages only) forks at the entry *before* the message
  and opens the fork with the composer pre-filled with the original
  text. The original conversation is untouched.
- **Tables.** GFM tables render in a bordered block. Tables with more
  than 6 data rows (builder may tune) get a filter bar ("Filter rows",
  row count); smaller tables render without it.
- **Scroll fade.** Text scrolling up behind the composer blurs and
  fades out rather than ending in a hard edge (the mockup's gradient +
  mask + light backdrop blur).
- **Fork lineage in the transcript.** A forked conversation shows a
  quiet "Forked from *Parent name*" link at the top of its transcript.

### 4.4 Outline panel

Lists the conversation's user prompts in order (truncated to two
lines). Clicking one scrolls to it. The prompt currently in view is
marked with the accent bar. Docked in the right panel; no floating
button.

### 4.5 Composer

One rounded box. Text area on top; toolbar underneath:
`[+ attach] [model ▾] [thinking ▾] … [context ring %] [send]`.

- **Model picker:** the `/v1/models` catalog; selection applies via the
  existing `configure` endpoint.
- **Thinking picker:** the levels `/thinking` accepts. Always shown —
  the catalog's `reasoning` flag is unreliable (it reports `false` for
  models that do think) and must not hide the control.
- **Context ring:** the existing usage fraction; tooltip shows
  used / window.
- A faint hint line beneath that reflects the existing `enterToSend`
  preference: `Ctrl+Enter to send · / commands` by default, or `Enter
  to send · Shift+Enter newline · / commands` when the pref is on. The
  pref and its current default (off) are unchanged.
- Send is the accent colour; disabled state is clearly distinct from
  enabled (today's enabled button looks disabled).

### 4.6 Settings dialog

Restyled to the same visual system: styled controls (no native-looking
selects in dark mode), sentence-case labels, sans-serif labels. The
existing sections stay; Interface gains palette / accent / mode.

Existing client prefs keep working. `showThinking` (default on) now
controls whether thinking text appears inside an expanded activity
line; when off, the activity line still shows and lists tools, but no
thinking text. No existing pref is removed.

## 5. TUI

### 5.1 Screen and mouse

- Runs **fullscreen** on pi-tui's `TuiAltScreen`, with mouse reporting
  on. This **replaces** the current `TuiMainScreen` launcher; there is
  no main-screen fallback mode. The conversation pane moves from a
  per-frame static projection to viewport/scroll-view content. Plan
  part 3 as a rework of the pane and launcher, not a restyle.
- Adopt `TuiAltScreen`'s built-in features where they fit (wheel
  scrolling, viewport search, prompt jumps, application-owned text
  selection) and rebind them through pi-tui's `KeybindingsManager` so
  each keymap's own keys drive them. Built-in default keys that
  conflict with the active keymap are rebound or disabled, never left
  as a second, competing binding.
- Mouse: click a conversation to open it; click an activity line to
  fold/unfold; wheel scrolls the transcript and the list; click the
  model or thinking item in the status bar to open its picker.
- **Every mouse action has a keyboard equivalent.** No exceptions.
- Copying a whole message uses an explicit action (`y` / `M-w` /
  menu) that writes Markdown to the system clipboard via OSC 52.
  Mouse drag-selection uses alt-screen's application-owned selection
  (copy on select) as a convenience, not as the only way to copy.

### 5.2 Layout and look

- Conversation list on the left (names, ages, fork nesting — same data
  as the web sidebar), transcript in the middle, composer at the
  bottom, then a **one-line status bar**.
- Status bar, left to right: mode indicator (in vim mode `-- INSERT --`
  / `-- NORMAL --`), conversation name, model, thinking level, context
  %, and 2–3 key hints that change with the current mode and focus.
- **User messages** get an accent-coloured bar down the left edge.
  Assistant prose is plain. The activity line is one dim row,
  `▸ Thought 4s · ✓ 3 tools`, expanding to `✓ bash  ls /  0.8s` rows.
  `[tool]` / `[thinking]` text tags go away.
- The focused list row and focused message are highlighted (no `→ *`
  markers).
- The composer shows a prompt glyph and placeholder text.
- **Narrow terminals.** Below ~80 columns the conversation list
  collapses away. The picker (`Ctrl+P` / `:b` / `C-x b`) is the switcher,
  and the status bar drops hints before it drops the model and
  context.
- **Model and thinking pickers.** Choosing from either applies
  immediately via the existing `configure` endpoint, as on the web. The
  TUI gains working `/model` and `/thinking` commands (they are
  rejected as unsupported today), which also back vim's `:model` and
  `:set thinking=`.
- Colour: the same four palettes and seven accents as the web UI, with
  the same names, mapped to 24-bit colour, falling back to the nearest
  256-colour when truecolour is unavailable. Definitions are shared
  data, not duplicated by hand (builder picks the mechanism — a shared
  module, or a generated file).

### 5.3 Configuration (`tui.json`)

New keys: `palette`, `accent`, `mode` (dark / light; the TUI does not
detect the system), `keymap` (`standard` | `vim` | `emacs`), and
`editor` (optional vim-family editor path, §5.4). Defaults: Polar
Night, Baltic Amber, dark, standard.

### 5.4 Keymaps

All three keymaps trigger the **same actions**: switch conversation,
new, fork from focused message, edit-and-resend, copy, picker, model,
thinking, search, fold/unfold, outline jump (prev/next user prompt),
answer pending interaction, cancel run, redraw, quit.

**Keys no keymap may bind globally:** `Ctrl+B` (tmux/herdr prefix) and
the composer's existing emacs-style editing chords (`Ctrl+A/E/B/F/K/U/
W/Y/D/J`, see pi-tui `keybindings.js`). The current `Ctrl+B` sidebar
toggle and `Ctrl+F` fork bindings are removed (the latter already
conflicts with cursor-right).

**Standard (default).** Two focus states: composer and navigation.
- `Tab` moves focus composer → list → transcript → composer.
- Arrows / PgUp / PgDn / Home / End navigate the focused pane;
  `Enter` opens or folds.
- Global: `Ctrl+P` conversation picker (searchable), `Ctrl+N` new
  conversation, `Ctrl+T` cycle thinking level, `Ctrl+O` answer pending
  interaction (existing), `Ctrl+L` redraw. Model selection via the
  picker or `/model`.
- `Esc` cancels a running reply (pi muscle memory); otherwise it
  returns focus to the composer.
- In navigation focus: `y` copy, `f` fork from here, `e` edit and
  resend.

**Vim.** Real modes.
- **Insert:** all keys go to the prompt; nothing else reacts. Enter
  sends (as today).
- **Normal** (`Esc` from insert): `j`/`k` next/previous message or
  conversation, `h`/`l` move between list and transcript,
  `Ctrl+D`/`Ctrl+U` half page, `gg`/`G` top/bottom, `{`/`}` previous /
  next user prompt, `/` search the transcript with `n`/`N`,
  `Enter`/`za` fold, `y` copy, `f` fork from here, `e` edit and resend,
  `v` edit the prompt in vim. `i`/`a`/`o` return to insert.
- **Command** (`:` from normal): a command line in the status bar.
  `:new`, `:fork`, `:model <name>`, `:set thinking=<level>`,
  `:b <name|id>` switch conversation (prefix/fuzzy match), `:ls` open the
  picker, `:q` quit. Any existing slash command is also reachable as
  `:<command>`. Tab completes command names.
- `Ctrl+C` cancels a running reply (Esc means "leave insert").
- **`v` and the editor.** The prompt opens in a temp file in a
  vim-family editor; on exit the file contents replace the composer
  draft. Editor resolution: `tui.json` `editor` → `$VISUAL` → `$EDITOR`
  — each used **only if its basename is `vim`, `nvim`, or `vi`** (with
  or without a path) — then `nvim`, `vim`, `vi` on `PATH`. If none is
  found, show "no vim found" in the status bar and do nothing. **Never
  fall back to nano or any other editor.** The TUI suspends cleanly
  while vim runs and redraws on return.

**Emacs.** Modeless chords, consistent with the composer's existing
editing keys: `C-x b` switch conversation (picker), `M-x` run any command by name (completing prompt), `C-s` / `C-r`
search the transcript forward / backward, `C-g` cancel a running reply
or close a prompt, `M-p` / `M-n` previous / next user prompt, `C-x o`
cycle focus between panes. Message actions on the focused message via
`M-w` (copy) and `M-x fork` / `M-x edit`. The builder fills the
remaining actions with conventional emacs chords that don't collide
with the excluded set.

### 5.5 Discoverability

The status bar always shows the most relevant keys for the current
mode and focus. `?` (standard / vim normal) or `C-h` (emacs) opens a
key reference overlay for the active keymap.

## 6. Constraints

- Web UI stays React + react-markdown + remark-gfm; no new heavy UI
  frameworks. Icons are inline SVG or a small icon set — builder's
  call, with no icon font.
- TUI stays on pi-tui; use its alternate-screen mode, `MouseRegion`,
  and keybinding system rather than a parallel input layer.
- Wire types are imported from `src/server/views.ts` (the single wire
  contract); the new list fields are added there.
- The existing stable class/data hooks used by tests are kept or
  replaced deliberately with the tests updated; new components get
  stable hooks (hermes' "stable hooks for visual regression" rule).
- Repo verification rules apply: `npm test`, `npm run typecheck`,
  `typecheck:webui`, `build:webui`, the TUI workspace suite + typecheck,
  and `test:e2e`.
- Tests own their literals (synthetic names/hosts).

## 7. Left to the builder

- Exact spacing, sizes, and colour tokens beyond what the mockups fix.
- Icon set.
- Naming prompt wording, retry bound, and how the fork marker reads.
- Whether `lastActivityAt` also bumps on admission.
- Where archived conversations are reachable from.
- The table-filter row threshold (starting point: > 6 rows).
- How palette definitions are shared between webui and tui.
- Remaining emacs chords, within the excluded-key rule.
- Whether Files gets a rail entry in this project.

## 8. Decisions ledger (user rulings)

1. Direction: hermes-webui's design, openly imitated and credited; less
   busy than hermes.
2. Light mode stays.
3. Palette **and** accent are user-selectable; four palettes × seven
   accents as shown in `palettes.html`. Default Polar Night + Baltic
   Amber.
4. Outline and Workspace share one right panel, switched by header
   buttons; no floating outline icon.
5. Table filter only on larger tables.
6. Scroll fade above the composer.
7. Conversation search/filter in the sidebar.
8. TUI goes fullscreen with mouse support.
9. Navigation never requires the mouse.
10. No `Ctrl+B`.
11. Keymap is configurable: standard / vim / emacs. Vim mode has real
    insert / normal / command modes.
12. Vim mode's `v` opens the prompt in real vim; never nano, never a
    non-vim editor.
13. Server work is in scope up front: last-activity time, fork lineage,
    and automatic conversation naming.

Calls made by the designer, not the user: list absorbs archived/pinned
and the N+1 meta fetch goes away; fork trees sort by newest activity
anywhere in the tree; naming is a one-shot pi-ai call with a
`namingModel` setting (can be `false`); existing `enterToSend` and
`showThinking` prefs keep their defaults; TUI moves wholesale to
`TuiAltScreen` and reuses its built-ins under each keymap's keys; TUI
pickers apply immediately and `/model` + `/thinking` become real
commands; narrow-terminal list collapse; standard keymap as default;
system-following mode default on web, dark default on TUI; Esc cancels
in standard but Ctrl+C cancels in vim; rail ships without placeholder
sections; user/auto names stored separately; naming model defaults to
the server default model with thinking off; OSC 52 clipboard in the
TUI; accent migration mapping.

Deviations recorded during execution (rulings by the executor):

- Activity lines show counts ("Thinking · 2 tools"), not durations —
  the wire carries no per-block timing.
- The web table filter threshold is `> 6` data rows.
- A fork of an unnamed conversation stays eligible for auto naming
  (only named sources hand down `"<name> (fork)"`); the fork commit
  also resets `autoNameAttempts` so a fresh naming budget applies.
- The TUI disables alt-screen's built-in search and prompt-jump
  bindings in favour of turn-aware actions.
- Vim keeps `?` = search-backward (plan C4's binding, correct vim
  behaviour); the vim help key is `g?` and vim normal hints advertise
  "g? keys" — §5.5's "? opens key reference" holds for standard and
  emacs only.
- C-g in emacs cancels a run only when no overlay is open; with the
  picker/search open it closes the overlay first (modal owns keys),
  so cancelling a busy run with an overlay open takes two presses.

## 9. Credit

Add `THIRD_PARTY_NOTICES.md` with hermes-webui's MIT copyright notice
(required where CSS or code is copied; included regardless as
attribution), and a README line: "The web UI's visual design is adapted
from hermes-webui by nesquena and contributors."
