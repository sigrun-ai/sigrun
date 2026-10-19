# U1 — Webui Block Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The webui renders every v1 block, display and field natively, with container-width classes, the channel fallbacks of spec §12.3, the confirmed-plus-overlay data model, pointer and keyboard moves, and a dev-only Blocks gallery.

**Architecture:**
- `webui/src/blocks/` holds one React component per block, dispatched by `BlockView` on `block.type`. Every component reads bindings through a `SurfaceData` context and reports actions through a `SurfaceActions` context, so the renderer has no idea which placement or transport it serves.
- `useSurface(transport)` owns a surface's state: tree, confirmed data at a `rev`, and an optimistic overlay keyed by `actionId` (§6.3). `SurfaceTransport` comes from `@sigrun/shared/blocks` (U0); U3 (extension surfaces) and U5 (chat surfaces) implement it, and this plan tests against an in-memory fake.
- Width classes come from a `ContainerWidth` provider measuring its element with `ResizeObserver` (`compact` < 40 rem, `regular` 40–75 rem, `wide` > 75 rem); CSS uses `@container` queries for purely visual changes.
- Charts are hand-written SVG (no chart library); moves use pointer events (works for mouse and touch), not HTML5 drag and drop.

**Tech Stack:** React 19, Vite, vitest + react-test-renderer, Playwright, `@sigrun/shared/blocks` (U0).

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §5, §6.1–§6.3, §10, §12, §14.4, §15 (links), §16 (Moves, Width, Visual, Keyboard).

**Depends on:** U0.

## Global Constraints

- Width classes measure the **container**, never the viewport: `compact` < 40 rem, `regular` 40–75 rem, `wide` > 75 rem.
- Width tokens: `s`/`m`/`l` = 16/24/32 rem.
- Tones map to theme tokens from `@sigrun/shared/themes` (4 palettes × 7 accents × light/dark); `accent` is the user's accent. No block sets a colour, font or pixel size.
- Icons: the 49 `ICON_NAMES` from U0, drawn from Lucide SVG paths (MIT) copied into `webui/src/blocks/icons.tsx`; add Lucide to `THIRD_PARTY_NOTICES.md`.
- Links: an explicit URL transform allows `https:`, `http:`, `mailto:` only, in block markdown **and** in the existing chat `Markdown` (`webui/src/entries/Markdown.tsx`); other schemes render as text.
- Unknown block types render `fallback` plus "Not supported in this client".
- Table paging: 50 rows. Chart: at most 2,000 points per series, downsampled with largest-triangle-three-buckets for line and area.
- Move timeout: 10 s → treated as reject.
- Keyboard (standard keymap in the webui): `m` pick up, arrows place (left/right across groups, up/down within), `Enter` drop, `Esc` cancel; `Space` select; `.` action menu; `x` check; `[`/`]` previous/next range and `t` today in calendars.

## Review Focus

1. **A data update arriving mid-drag** — the item under the pointer stays under the pointer; when the drop lands, the overlay applies to the *new* confirmed data. Owner: Task 4.
2. **Rapid double drop** (two moves before the first reply) — both overlay entries apply in order; rejecting the first snaps back only that move. Owner: Task 4.
3. **Container resize across a class boundary while a lane switcher is open** — the selected lane is preserved when returning to side-by-side lanes. Owner: Task 4.
4. **Very long unbroken strings** (a URL as a card title) — wrap or ellipsize; never widen the container past its class. Owner: Task 3.
5. **Right-to-left text in markdown and cards** — `dir="auto"` on text slots so mixed-direction content reads correctly. Owner: Task 1.

---

### Task 1: Renderer core, layout and simple content blocks

**Files:**
- Create: `webui/src/blocks/BlockView.tsx`, `webui/src/blocks/context.ts`, `webui/src/blocks/width.tsx`, `webui/src/blocks/tones.ts`, `webui/src/blocks/icons.tsx`, `webui/src/blocks/layout.tsx` (`stack`, `columns`, `grid`, `section`), `webui/src/blocks/content.tsx` (`markdown`, `fields`, `stat`, `callout`, `image`, `diff`, `details`), `webui/src/blocks/blocks.css`
- Modify: `webui/src/entries/Markdown.tsx` (export the shared `safeUrlTransform`; use it), `THIRD_PARTY_NOTICES.md`
- Test: `webui/src/blocks/BlockView.test.tsx`, `webui/src/blocks/width.test.tsx`, `webui/src/entries/Markdown.test.tsx`

**Interfaces:**
- Consumes: `Tree`, `Block`, `resolvePointer`, `formatValue`, `ICON_NAMES` from `@sigrun/shared/blocks`.
- Produces:
  ```ts
  export type WidthClass = "compact" | "regular" | "wide";
  export function ContainerWidth(props: { children: ReactNode }): JSX.Element;      // provides useWidthClass()
  export function useWidthClass(): WidthClass;
  export interface SurfaceDataCtx { data: JsonObject; item?: JsonValue; locale: string }
  export interface SurfaceActionsCtx { dispatch(action: Action, payload: JsonValue): void; access: "read" | "write"; viewState: ViewState }
  export function BlockView(props: { block: Block }): JSX.Element;                   // renders any block
  export function Icon(props: { name: IconName; size?: number }): JSX.Element;
  export function safeUrlTransform(url: string): string;                             // "" for disallowed schemes
  ```

- [ ] **Step 1: Write failing tests:** each fixture in `test/fixtures/blocks/` for these blocks renders without error; `stat` with `format: "bytes"` shows "1.5 KB"; `visibleAt: "atLeast:regular"` hides the block when `ContainerWidth` reports compact (mock `ResizeObserver` to 30 rem) and shows it at 50 rem; `columns` stacks when the sum of `minWidth`s exceeds the container; an unknown block type renders its `fallback` and "Not supported in this client"; a markdown link `tel:123` and `javascript:x` render as text in both `BlockView` and chat `Markdown`; `access: "read"` hides `callout` action buttons; an action with `confirm` opens a dialog with its title, body and `confirmLabel`, and cancelling dispatches nothing; `copy` writes to the clipboard with no dispatch; `open` opens a new tab only for allowed schemes.
- [ ] **Step 2: Run** `npm --workspace @sigrun/webui run test -- blocks` — FAIL.
- [ ] **Step 3: Implement.** `tones.ts` maps each tone to CSS variables already defined by the theme (`--accent`, status colours); text slots get `dir="auto"`.
- [ ] **Step 4: Run** tests + `npm run typecheck:webui` — PASS.
- [ ] **Step 5: Commit** `git commit -m "webui: block renderer core, layout and content blocks, container width classes, safe link transform"`.

### Task 2: `chart`, `meter`, `log`, `tree`

**Files:**
- Create: `webui/src/blocks/chart.tsx`, `webui/src/blocks/meter.tsx`, `webui/src/blocks/log.tsx`, `webui/src/blocks/treeview.tsx`
- Test: `webui/src/blocks/chart.test.tsx`, `webui/src/blocks/log.test.tsx`, `webui/src/blocks/treeview.test.tsx`

**Interfaces:**
- Consumes: `lttb` from `@sigrun/shared/blocks`.

- [ ] **Step 1: Write failing tests:** a chart given 10,000 points per series renders at most 2,000 (downsampled with `lttb`); a mixed line+bar chart renders one `<path>` and N `<rect>`s; `stacked: true` stacks bar heights; thresholds render as horizontal rules with their tone class; below 16 rem container width the chart renders the sparkline-plus-latest fallback (one `<path>` and a text value per series); `meter` with thresholds picks the tone of the highest threshold ≤ value; `log` with `follow` scrolls to bottom on append and stops following when the user scrolls up; default level tones map `error`→bad, `warn`→warn; `tree` calls `dispatch` with the `onExpand` action and `{id}` when a node with `hasChildren` and no `children` is expanded.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Axis ticks: at most `floor(width / 80px)` x-ticks, 5 y-ticks; time axes use `formatValue(…, x.format ?? "datetime")`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "webui: chart (svg, lttb), meter, log, tree blocks"`.

### Task 3: `collection` — list, table, grid, and card slots

**Files:**
- Create: `webui/src/blocks/collection/Collection.tsx`, `webui/src/blocks/collection/Card.tsx`, `webui/src/blocks/collection/ListDisplay.tsx`, `webui/src/blocks/collection/TableDisplay.tsx`, `webui/src/blocks/collection/GridDisplay.tsx`, `webui/src/blocks/collection/selection.ts`
- Test: `webui/src/blocks/collection/*.test.tsx`

- [ ] **Step 1: Write failing tests:** card renders every slot from §5.5.1 (eyebrow, title, subtitle, body clamped to 4 lines, image, icon, badges, meta incl. `{person: {user, name}}` shown as `name`, metrics, tone stripe, up to 3 actions then an overflow menu, `status` with spinner, `deps` as "after: …"); `quiet` items fold behind "N more"; `groupBy` + `groups` render headings in `groups` order; nested `children` indent; `numbered` lists number; `checkable` toggles dispatch the `onCheck` edit action with `{itemId, value}`; multi-select shows `bulkActions`, and a bulk action with a `form` opens it and dispatches `{ids, values}`; table sorts by a clicked `sortable` column (numeric for numeric formats), pages at 50, renders `cell: "meter"` as a bar and `cell: "badge"` with the item tone; in compact width a table renders rows as cards with `priority: "low"` columns in an expandable part; grid `overflow: "scroll"` stays one row; view-only state (sort, selection, expanded) survives a data update.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** View-only state lives in the surface's `/view/` branch held by `useSurface` (Task 4), never sent to the server.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "webui: collection list/table/grid displays and fixed card slots"`.

### Task 4: `useSurface`, optimistic overlay, lanes, calendar and moves

**Files:**
- Create: `webui/src/blocks/useSurface.ts`, `webui/src/blocks/collection/LanesDisplay.tsx`, `webui/src/blocks/collection/CalendarDisplay.tsx`, `webui/src/blocks/collection/drag.ts`
- Test: `webui/src/blocks/useSurface.test.ts`, `webui/src/blocks/collection/LanesDisplay.test.tsx`, `webui/src/blocks/collection/CalendarDisplay.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // SurfaceTransport: from @sigrun/shared/blocks (U0)
  export function useSurface(t: SurfaceTransport): {
    status: "loading" | "ready" | "notFound" | "error";
    tree?: Tree; view: JsonObject; access: "read" | "write";
    dispatch(action: Action, payload: JsonValue): void; retry(): void;
  };
  ```
- Overlay rules (§6.3): confirmed data only changes from server data or ops; the overlay is a list of `{actionId, op, untilRev?}`; `{ok: true, rev, ops}` → apply ops to confirmed, drop entry; `{ok: true, rev}` (no ops) → keep entry with `untilRev = rev` until a fetch at ≥ that rev arrives, then drop; `{ok: false}` or 10 s timeout → drop entry and toast; `rev` gap or `DataOpError` → full refetch.

- [ ] **Step 1: Write failing tests** (fake transport with controllable promises): every Review Focus 1–3 case; accept-with-ops; accept-without-ops keeps the item placed until the refetch at `rev` arrives, with no intermediate render showing it in the old spot; reject snaps back and toasts; timeout at 10 s (fake timers) snaps back; `access: "none"` → `status: "notFound"`; `treeRev` change triggers `load()`; lanes render side by side in regular width with pointer-drag across lanes dispatching `move` with `{itemId, from: {group, index}, to: {group, index}}`; in compact width one lane shows with a lane switcher, and the item action menu offers "Move to…" listing other groups; keyboard `m`, `→`, `↓`, `Enter` produces the same move payload as the pointer; `Esc` cancels with no dispatch; calendar month view places items by `time.start`; dragging an item to another day dispatches `move` with `to: {start, end}` preserving duration; `onResize` drag dispatches `{itemId, end}`; `onCreate` drag on an empty slot dispatches `{start, end}`; compact width shows the agenda; `[`/`]`/`t` change the visible range (view-only).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** `drag.ts` uses pointer capture; drop targets come from `data-drop-group`/`data-drop-index` attributes so lanes and lists share it.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "webui: useSurface with confirmed data + optimistic overlay; lanes, calendar, pointer and keyboard moves"`.

### Task 5: `form` and every field

**Files:**
- Create: `webui/src/blocks/form/Form.tsx`, `webui/src/blocks/form/fields.tsx`, `webui/src/blocks/form/ChoiceField.tsx`, `webui/src/blocks/form/ListField.tsx`, `webui/src/blocks/form/FileField.tsx`
- Test: `webui/src/blocks/form/*.test.tsx`

- [ ] **Step 1: Write failing tests:** `mode: "submit"` dispatches `onSubmit` with `{values}` only when client validation (`required`, `min`/`max`, `minLength`/`maxLength`, `pattern`) passes, and shows server `{error: {field}}` messages under that field; `mode: "live"` bound under `/view/` changes view state after 300 ms with no dispatch; `mode: "live"` bound elsewhere dispatches an edit after 300 ms; `mode: "inline"` renders one row and clears on success; `choice` single/multi values match §5.6 (id; ids; `{other: text}`; ids plus `{other}` last), `preview` markdown appears beside options when the container is regular or wider and below when compact, `allowOther` adds a "Type something" row; `secret` never renders a value, shows `set (stored)`/`set (env)`/`not set` from its bound status, and sends only what the user typed; `file` checks `accept`/`maxBytes` before dispatching `onUpload`; `list` adds/removes/reorders entries within `min`/`max`; `daterange` presets fill both dates; a form with several sections each holding a `choice` in an `interaction` placement offers a one-question-at-a-time stepper with a review step, and submits once; `access: "read"` disables every field.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "webui: form and fields (choice preview/allowOther, secret, file, list, daterange), interaction stepper"`.

### Task 6: `page` shell and the Blocks gallery

**Files:**
- Create: `webui/src/blocks/Page.tsx`, `webui/src/blocks/SurfaceView.tsx` (renders a `useSurface` result: loading, not-found, error-with-retry, ready), `webui/src/gallery/GalleryView.tsx`, `webui/src/gallery/samples.ts` (imports `test/fixtures/blocks/*` through a Vite alias)
- Modify: `webui/src/layout/Rail.tsx` (a "Blocks" entry when `/v1/meta` reports `dev: true`, which U0 Task 4 added), `webui/src/App.tsx` (route to the gallery)
- Create: `webui/e2e/blocks-gallery.spec.ts`
- Test: `webui/src/blocks/Page.test.tsx`

- [ ] **Step 1: Write failing tests:** page renders header title/subtitle/switcher/actions, sidebar, main, detail; `empty` shows when main's first collection binds to missing, `null` or `[]`; compact width turns the sidebar into a drawer and the detail pane into a pushed page with a back button; the gallery entry is absent unless `dev: true`; Playwright: every gallery page screenshot at container widths 30 rem, 60 rem and 90 rem (`toHaveScreenshot`), and one drag across lanes in the browser.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** The gallery uses an in-memory `SurfaceTransport` that accepts every action.
- [ ] **Step 4: Run** `npm --workspace @sigrun/webui run test && npm run typecheck:webui && npm run build:webui && npm run test:e2e` — PASS.
- [ ] **Step 5: Commit** `git commit -m "webui: page shell, SurfaceView, dev Blocks gallery with visual snapshots"`.
