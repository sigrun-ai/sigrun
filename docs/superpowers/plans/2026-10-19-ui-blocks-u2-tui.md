# U2 — TUI Block Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The TUI renders every v1 block, display and field as pi-tui components, full-featured (ruling 2): keyboard moves, forms, Braille charts, inline images, the compact fallbacks, and the same confirmed-plus-overlay data model as the webui.

**Architecture:**
- `tui/src/blocks/` holds one pi-tui `Component` per block, built by `renderBlock(block, ctx)`. Components render to lines at a given width; the width class comes from the pane's width in cells (`compact` < 80, `regular` 80–139, `wide` ≥ 140).
- `tui/src/blocks/surface.ts` is the TUI twin of the webui's `useSurface`: the same `SurfaceTransport` interface from `@sigrun/shared/blocks` (U0) and the same overlay rules.
- Focus and keys go through the existing keymap layer (`tui/src/keymaps/`): a block that takes focus registers its key handlers as actions, so standard, vim and emacs bindings and the help overlay pick them up.

**Tech Stack:** `@earendil-works/pi-tui` (Image, Markdown, ScrollView, Input, Editor, SelectList, HStack/Stack), vitest, `@sigrun/shared/blocks`.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §5, §6.1–§6.3, §10, §11.3, §12, §16 (Width, Visual, Keyboard, Images).

**Depends on:** U0. Parallel with U1.

## Global Constraints

- Width classes from pane cells: `compact` < 80, `regular` 80–139, `wide` ≥ 140. Width tokens `s`/`m`/`l` = 30/45/60 cells.
- Tones map through the existing `TuiTheme` (`tui/src/theme.ts`); no raw ANSI colours in block code.
- Icons: each of the 49 `ICON_NAMES` maps to a Unicode glyph plus an ASCII fallback (`tui/src/blocks/icons.ts`); ASCII is used when the theme reports no Unicode support.
- Images: pi-tui `Image` when `getCapabilities().images` is `"kitty"` or `"iterm2"`; fetch non-PNG with `as=png` (U7); otherwise `[image: <alt>]`. Width = block width in cells, max 20 rows. Under `TMUX` pi-tui reports no images unless `PI_IMAGE_PROTOCOL` is set; add no detection of your own.
- `open`: OSC 8 when `getCapabilities().hyperlinks`, else print the URL. Schemes `https:`, `http:`, `mailto:` only.
- Keys per keymap (§12.4): pick up `m` (standard, vim) / `M-m` (emacs); arrows place; `Enter` drop; `Esc` cancel; `Space` select; `.` action menu; `x` check; `[`/`]`/`t` calendar range. Every binding appears in the help overlay.
- Snapshot widths: 72, 100, 160 columns.

## Review Focus

1. **Terminal resize while a card is picked up** — the pick-up survives the reflow and the drop target is recomputed in the new layout. Owner: Task 4.
2. **A pane narrower than the narrowest block minimum** (40 cells) — blocks truncate with `…`, never wrap mid-escape-sequence or overflow the pane. Owner: Task 1.
3. **Wide characters (CJK, emoji) in card titles and table cells** — columns align by display width, not string length. Owner: Task 3.
4. **A focused form field when a data update arrives** — the cursor position and unsaved text are kept. Owner: Task 5.
5. **No colour support (`NO_COLOR`)** — tones still distinguishable by a text marker (`!`, `✓`, `•`). Owner: Task 1.

---

### Task 1: Renderer core, layout and simple content

**Files:**
- Create: `tui/src/blocks/render.ts`, `tui/src/blocks/context.ts`, `tui/src/blocks/width.ts`, `tui/src/blocks/icons.ts`, `tui/src/blocks/tones.ts`, `tui/src/blocks/layout.ts`, `tui/src/blocks/content.ts`
- Test: `tui/test/blocks-render.test.ts`, `tui/test/__snapshots__/blocks-render.test.ts.snap`

**Interfaces:**
- Produces:
  ```ts
  export type WidthClass = "compact" | "regular" | "wide";
  export function widthClassOf(cells: number): WidthClass;
  export interface BlockCtx { data: JsonObject; item?: JsonValue; theme: TuiTheme; locale: string;
    access: "read" | "write"; dispatch(action: Action, payload: JsonValue): void; view: ViewState }
  export function renderBlock(block: Block, ctx: BlockCtx): Component;
  ```

- [ ] **Step 1: Write failing tests:** snapshot every layout/content fixture from `test/fixtures/blocks/` at 72, 100, 160 columns; `widthClassOf(79) === "compact"`, `(80) === "regular"`, `(140) === "wide"`; `visibleAt: "atLeast:regular"` hides at 72; `columns` stacks at 72 when minimums don't fit; unknown block type renders `fallback` + "Not supported in this client"; with `NO_COLOR=1` a `bad` callout starts with `!`; a 40-cell pane truncates a long title with `…` and every rendered line's display width ≤ 40; an action with `confirm` asks `y/N` with its title and body, and `N` dispatches nothing; `copy` uses the existing OSC 52 clipboard (`tui/src/clipboard.ts`).
- [ ] **Step 2: Run** `npm --workspace @sigrun/tui run test -- blocks` — FAIL.
- [ ] **Step 3: Implement.** Markdown uses pi-tui `Markdown`; `fields` aligns labels; `diff` reuses the existing interaction diff renderer from `tui/src/ui/interactions.ts` (extract it to `tui/src/blocks/diff.ts`).
- [ ] **Step 4: Run** tests + `npm --workspace @sigrun/tui run typecheck` — PASS.
- [ ] **Step 5: Commit** `git commit -m "tui: block renderer core, layout and content blocks, width classes"`.

### Task 2: `chart` (Braille), `meter`, `log`, `tree`, `image`

**Files:**
- Create: `tui/src/blocks/chart.ts`, `tui/src/blocks/braille.ts`, `tui/src/blocks/meter.ts`, `tui/src/blocks/log.ts`, `tui/src/blocks/treeview.ts`, `tui/src/blocks/image.ts`
- Test: `tui/test/blocks-chart.test.ts`, `tui/test/blocks-image.test.ts`, `tui/test/blocks-log.test.ts`

- [ ] **Step 1: Write failing tests:** `braille` plots a diagonal line as the expected dot characters (2×4 dots per cell); a line chart at 100 columns renders axes, one legend line, and the series in Braille; bars use `▁▂▃▄▅▆▇█`; stacked bars sum; thresholds render as a dashed rule in their tone; below 30 cells the chart is a sparkline plus latest value per series; `meter` renders a bar of `width - label` cells; `log` follows the tail and stops when the user scrolls up; tree expand dispatches `onExpand` with `{id}`; `image` with faked `getCapabilities() → {images: "kitty"}` builds a pi-tui `Image` from the PNG bytes the transport returns; with `images: null` (and with `TMUX` set and no `PI_IMAGE_PROTOCOL`) renders `[image: <alt>]`; a non-PNG source is requested with `as=png`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (downsample with `lttb` from `@sigrun/shared/blocks`). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "tui: braille charts, meter, log, tree, inline images"`.

### Task 3: `collection` — list, table, grid, card slots

**Files:**
- Create: `tui/src/blocks/collection/collection.ts`, `card.ts`, `list.ts`, `table.ts`, `grid.ts`
- Test: `tui/test/blocks-collection.test.ts`

- [ ] **Step 1: Write failing tests:** card shows every §5.5.1 slot in a fixed line layout (eyebrow line, title with icon and tone marker, subtitle, body clamped to 4 lines, badges and meta on one line, metrics, `status` with a spinner frame, `deps` as "after: …"); `quiet` items fold behind "N more"; groups render in `groups` order; nesting indents 2 cells per level; `numbered`; `x` toggles a checkable item and dispatches `onCheck`; `Space` selects, `.` opens the bulk action menu (with its form when present); table sorts on `s` + column choice, aligns by display width (a CJK title test), pages at 50 rows with `PgUp`/`PgDn`; compact width renders table rows as cards with low-priority columns under `Enter`-expand; grid lays out `floor(width / token)` columns.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "tui: collection list/table/grid displays and card slots"`.

### Task 4: Surface state, overlay, lanes, calendar and keyboard moves

**Files:**
- Create: `tui/src/blocks/surface.ts`, `tui/src/blocks/collection/lanes.ts`, `tui/src/blocks/collection/calendar.ts`, `tui/src/blocks/move.ts`
- Modify: `tui/src/keymaps/standard.ts`, `vim.ts`, `emacs.ts`, `types.ts` (block actions: `blocks.pickUp`, `blocks.drop`, `blocks.cancelMove`, `blocks.select`, `blocks.actionMenu`, `blocks.check`, `blocks.rangePrev`, `blocks.rangeNext`, `blocks.today`), `tui/src/ui/help.ts`
- Test: `tui/test/blocks-surface.test.ts`, `tui/test/blocks-lanes.test.ts`, `tui/test/blocks-calendar.test.ts`, `tui/test/keymap-*.test.ts` (extend)

**Interfaces:**
- Produces: `export class SurfaceState { constructor(t: SurfaceTransport); load(): Promise<void>; dispatch(a: Action, p: JsonValue): void; readonly view: ViewState; onChange(cb: () => void): () => void }` with exactly the U1 overlay rules (§6.3).

- [ ] **Step 1: Write failing tests:** the same overlay cases as U1 Task 4 against `SurfaceState` (accept with ops, accept without ops held until the refetch, reject, 10 s timeout, rev gap refetch, `treeRev` reload, `none` → not found); lanes side by side at 160 columns, one lane plus a switcher (`Tab`/`S-Tab`) at 72; `m` → `→` → `↓` → `Enter` dispatches `move {itemId, from, to}` across lanes, and the same payload as a pointer drop would in U1; `Esc` cancels; at 72 columns "Move to…" in the `.` menu lists other groups; Review Focus 1 (resize while picked up); calendar month grid at 160, agenda at 72; `m` on an event then arrows by day and `Enter` dispatches `{start, end}` keeping duration; `[`/`]`/`t` change the range; every new binding appears in the help overlay in all three keymaps (emacs uses `M-m`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "tui: surface state with optimistic overlay; lanes, calendar, keyboard moves in all keymaps"`.

### Task 5: `form`, fields and `page`

**Files:**
- Create: `tui/src/blocks/form/form.ts`, `fields.ts`, `choice.ts`, `list.ts`, `file.ts`, `tui/src/blocks/page.ts`, `tui/src/blocks/surface-view.ts`
- Test: `tui/test/blocks-form.test.ts`, `tui/test/blocks-page.test.ts`

- [ ] **Step 1: Write failing tests:** the U1 Task 5 field behaviours in TUI terms (submit validation and server field errors; live under `/view/` local; live elsewhere dispatches after 300 ms; inline; `choice` values per §5.6 with `preview` shown below the options and `allowOther` as a final "Type something" row; `secret` masked and write-only with its status; `file` prompts for a path, checks `accept`/`maxBytes`, reads the file and dispatches `onUpload`; `list` add/remove/reorder; `longtext` opens the existing `$EDITOR` flow from `tui/src/editor-launch.ts` for `syntax: code`); multi-question interaction forms step one section at a time with a review step; Review Focus 4 (focused field survives a data update); `page`: header line with title, switcher (`ctrl+s` opens it), actions in the `.` menu, sidebar as a focusable pane at ≥ 100 columns and a toggled overlay below, detail as a pushed view with `Esc` back; `SurfaceView` shows loading, "Not found", and an error line with `r` to retry.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** `npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck` — PASS.
- [ ] **Step 5: Commit** `git commit -m "tui: forms and fields, interaction stepper, page shell, SurfaceView"`.
