# Sigrun UI blocks: one block set for views, settings, chat, interactions and ambient surfaces

Status: draft for review. Date: 2026-10-19.

Inputs:

- the evidence-sizing pass,
  `docs/superpowers/specs/2026-10-19-ui-blocks-sizing.md` (the block set
  below is its result; the sketches there are the worked examples);
- the user rulings from the 2026-10-19 design conversation (§2);
- the existing seams this replaces: interaction records and ambient
  surfaces (`docs/approval-ux-seams.md`, `shared/src/interactions.ts`,
  `shared/src/ambient.ts`);
- the core-hardening spec
  (`2026-10-19-sigrun-core-hardening-design.md`), whose W1 (principal,
  `accessOf`), W3 (`/v1/events`, extension settings) and W5 (extension
  routes, contract type) this builds on.

## 1. Goal

An extension can give sigrun a whole window (a rail view, a right-panel
tab, a settings section) and the agent can put rich content in chat,
without any channel knowing that extension or that content exists.

The server describes UI with a **closed set of blocks**. Each channel
(webui, TUI) renders every block natively, once, in core. Extensions and
the agent only ever produce block trees and data. A new channel gets
every extension for free by implementing the block set.

**In:**

- the block set, its wire format, versioning and fallback;
- placements: where trees appear and which blocks each allows;
- separate layout and data, with data-only updates;
- the action model, including which actions start agent turns;
- extension views, panels and settings sections;
- agent-authored blocks in chat, with saved edits and change notes;
- interaction records and ambient surfaces re-expressed as block trees;
- width classes and host-owned narrow fallbacks;
- styling by meaning (tones, sizes, named icons) through the existing
  themes;
- images: extension assets, data URLs, a same-origin image proxy, and
  inline images in the TUI;
- live versus restart settings, a settings change event, and an admin
  Restart button;
- developer experience: typed builders, validation, a text renderer for
  tests, and a dev gallery.

**Out** (§17): the kanban extension itself (its own repo), `embed`,
the cut blocks, per-width alternative layouts, user-arranged
dashboards, extension-to-extension actions, i18n of extension strings.

## 2. Rulings

1. **Option A.** The server describes UI from a closed block set;
   channels render it natively. No per-extension channel code.
2. **The TUI is full-featured.** Every block has a TUI rendering that
   supports its interactions, including drag-equivalent moves.
3. **No view-level iframes.** `embed` is reserved as a block (web-only,
   mandatory fallback). It is not built by this spec.
4. **Layout and data travel separately.** A surface's tree is sent once;
   blocks bind to paths in its data model; updates carry data only.
5. **One block set** for chat, views, settings, interactions and ambient
   surfaces. Each placement allows a subset.
6. **Evidence-sized.** The v1 set is exactly what the sizing pass kept.
   Blocks are added when a real extension outgrows the set, never
   speculatively.
7. **No domain vocabulary.** No block or prop is named after kanban,
   calendars, recipes or any other single domain.
8. **Drag and drop within and across groups** is a general `collection`
   capability.
9. **Container width, not viewport.** Blocks adapt to the width of the
   space they're in. Channels own the narrow fallbacks. Extensions get
   three width classes as the only escape hatch.
10. **Fixed card slots.** Collection items render through a card with
    fixed slots; `body` (markdown) is the only free-form slot.
11. **Optimistic moves.** The channel applies a move at once, reverts it if
    the handler rejects it, and the handler's data update is
    authoritative for everyone.
12. **External images are proxied.** Extension assets and data URLs pass
    through.
13. **Inline images in the TUI** where the terminal supports them.
14. **Actions start a turn only when they answer something.** View-only
    actions never reach the server. Edits are saved and summarised to
    the agent at its next turn. `submit` defaults to a turn; any action
    can set `turn: true`.
15. **Settings say how they apply.** Every field declares `apply: "live"
    | "restart"`. Restart-only changes show as pending, and admins get a
    Restart button.
16. **No legacy interaction or ambient shapes.** `sigrun-ext-approvals`
    is deleted rather than migrated; its replacements (ports of
    `rpiv-ask-user-question` and `pi-warden`) are written against block
    trees from the start.
17. **The image proxy converts to PNG for the TUI.** `sharp` is a server
    dependency (§11.3).
18. **This spec supersedes core-hardening §5.7's "every `server.*` key is
    restart-required".** It lands after core-hardening; §13.1 is the rule
    from then on. The core-hardening docs are not edited.
19. **Forks copy everything as of the fork point, then diverge.** A fork
    gets the chat block state, its revisions and its pending change
    records exactly as they were at the forked entry; after that, edits in
    either conversation never reach the other (§8.2).
20. **Interaction answers are form values.** `{values: {<field>: value}}`
    replaces `{ids, values, text}` (§9.1).

## 3. Concepts

Terms: **server** is the sigrun process; **channel** is a client (the
webui, the TUI); **core** is sigrun's own code as opposed to an
extension's.

- **Block.** A typed node: `{type, id?, ...props, children?}`.
- **Tree.** A root block plus the block-set version it was written
  against.
- **Data model.** One JSON object per surface. Blocks read from it
  through bindings.
- **Surface.** A tree plus its data model, shown in one placement for
  one principal. A surface has an address (§7.1) and a revision.
- **Placement.** Where a surface appears. Each placement allows a subset
  of blocks (§5.7) and routes actions to one handler (§6.4).

| placement | what it is | provided by |
|---|---|---|
| `view` | a rail entry; the whole main area, with the page shell | extension |
| `panel` | a tab in the webui right panel / a TUI side pane | extension |
| `settings` | a section in Settings | core, extension |
| `chat` | a transcript entry | agent (core tool) |
| `interaction` | a pending human decision | extension (existing seam) |
| `ambient` | a status line, footer segment or above-composer panel | extension (existing seam) |

## 4. Wire format

### 4.1 Trees

```ts
type Tree = { v: 1; root: Block };            // v = block-set version
type Block = { type: string; id?: string; visibleAt?: WidthCondition;
               fallback?: string; [prop: string]: unknown };
```

- **Where the code lives.** `@sigrun/shared` is a zero-dependency leaf
  whose purity test forbids runtime imports (`test/views-purity.test.ts`).
  So:
  - `shared/src/blocks/` holds the TypeScript types, `applyOps` (§4.3)
    and `toText` (§14.3): pure code with no imports outside `shared/`;
  - `src/blocks/` holds the typebox schemas and `validateTree` (§14.2),
    and is re-exported by `sigrun/blocks` (§14.1);
  - the purity test scans `shared/src/` recursively, so the new
    subdirectory is covered.
- `id` is required on blocks that carry actions or inputs, and must be
  unique within the tree. Channels use it to route actions and keep
  focus and scroll across re-renders.
- `fallback` is plain text a channel shows when it can't render the
  block (§4.4). Every block may carry it; when absent, the server fills
  it with the block's `toText` projection, truncated to 200 characters.

### 4.2 Bindings and the data model

Any prop whose value can change at runtime may be a binding instead of a
literal:

```ts
type Binding = { $: string };   // a JSON Pointer into the data model, e.g. "/jobs"
```

- Collections bind their items: `items: {$: "/cards"}`. Inside an item
  template, a pointer starting `./` resolves against the current item
  object (`{$: "./title"}` is the item's `title`); this is the one
  extension to JSON Pointer.
- **Structural props are literals,** never bindings: `type`, `id`,
  `display`, `groupBy`, `reorder`, `select`, `mode`, field `name`s, and
  every handler name (§6.1). A view that switches structure (a board/list
  toggle) does it with `navigate(params)`, and `render` returns the other
  tree. Content props (text, values, items, options, series) may bind.
- Inputs bind their value: a form field's `name` is the path its value
  is read from and written to (relative to the form's `bind`).
- A binding to a missing path renders as empty, never as an error. A
  binding of the wrong JSON type renders the block's fallback and logs a
  warning once per surface revision.

### 4.3 Data updates

```ts
type DataOp =
  | { op: "set"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "insert"; path: string; value: JsonValue }   // path ends in an array index or "-"
  | { op: "move"; from: string; path: string };        // array reorder / cross-array move
type DataUpdate = { rev: number; ops: DataOp[] };
```

- A surface's data has a monotonic `rev`, **assigned by the server**.
  Extensions and tools submit ops without a rev; the server applies them
  in arrival order, increments `rev` once per update, and that is the
  `rev` channels see. A channel that sees a gap fetches the full data
  again.
- `move` exists so collection reorders don't re-send the moved item.
- The tree changes rarely. When it does, the surface's `treeRev`
  changes and channels fetch the tree again.

### 4.4 Versioning and unknown blocks

- `v` is the block-set version. This spec defines `v: 1`. Adding a block
  or an optional prop bumps it. Removing or changing the meaning of
  either is not allowed.
- The server validates every tree against the version it declares,
  before it leaves the server (§14.2). Invalid trees never reach a
  channel.
- A channel that meets a block type or required prop newer than it
  supports renders the block's `fallback` text plus "Not supported in
  this client". It never drops content silently. This is the existing
  seams' opaque-fallback rule.

### 4.5 Limits

| placement | max blocks per tree | max tree size | max data size |
|---|---|---|---|
| `chat` | 200 | 256 KiB | 256 KiB |
| `interaction`, `ambient` | 100 | 64 KiB | 64 KiB |
| `view`, `panel`, `settings` | 2,000 | 1 MiB | 4 MiB |

- Sizes are the UTF-8 length of the serialized JSON.
- A collection counts as one block however many items it binds.
- A `data:` image URL (§11.1) counts toward whichever of the tree or the
  data holds it.
- Over a limit, the server rejects the tree or update with `413
  surface_too_large` naming the limit.

## 5. The v1 block set

### 5.1 Shell

**`page`** (placements: `view`, `panel` without `sidebar`)

| prop | meaning |
|---|---|
| `title`, `subtitle?` | header text (bindable) |
| `switcher?` | a `choice` field in the header; selecting navigates |
| `actions?` | header buttons: `{id, label, icon?, action: Action}` (§6.1) |
| `sidebar?` | blocks for the list column |
| `main` | blocks for the body |
| `detail?` | blocks for a side pane, shown when non-empty |
| `empty?` | `{icon, title, hint}`, shown instead of `main` when `main`'s first collection binds to a missing path, `null` or `[]` |

The channel draws the header, the columns, the empty state and their narrow
fallbacks. The extension never positions them.

### 5.2 Layout

| block | props | notes |
|---|---|---|
| `stack` | `children`, `gap?: s/m/l` | every slot is implicitly a stack; explicit only where a slot takes one block |
| `columns` | `children: {weight?, minWidth?: s/m/l, block}[]` | stacks when the minimums don't fit |
| `grid` | `minItemWidth: s/m/l`, `children` with `span?: 1/2/"full"` | as many columns as fit; `span` is capped at the columns available |
| `section` | `title?`, `subtitle?`, `tone?`, `collapsible?`, `collapsed?`, `children` | also groups fields inside a `form` |

Width tokens `s`/`m`/`l` are channel-defined (the webui maps them to
16/24/32 rem, the TUI to 30/45/60 cells).

### 5.3 Content

| block | props |
|---|---|
| `markdown` | `text`. The same renderer as chat (tables, code, links). Raw HTML is escaped. |
| `fields` | `rows: {label, value, tone?, icon?}[]` (label/value pairs) |
| `stat` | `label`, `value`, `unit?`, `format?`, `tone?`, `icon?`, `size?: s/m/l`, `caption?`, `sparkline?: number[]` |
| `callout` | `tone`, `title`, `body?` (markdown), `actions?` |
| `image` | `src` (§11), `alt` (required). Shown at its own aspect ratio, scaled to the block's width. |
| `chart` | §5.4 |
| `meter` | `value`, `min?` (0), `max?` (1), `label?`, `format?`, `thresholds?: {at, tone}[]` |
| `log` | `lines` (binding to `{at?, level?, text}[]`), `follow?`, `wrap?`, `tones?: {[level]: Tone}` (default: `error`→`bad`, `warn`→`warn`, `info`→`neutral`, `debug`→subtle) |
| `tree` | `nodes` (binding to `{id, label, icon?, hasChildren?, children?}[]`), `onExpand?` (handler for lazy children; it returns a `DataUpdate` inserting them), `onActivate?` |
| `diff` | `before`, `after`, `path?`, `lang?` (the existing interaction primitive) |
| `details` | `value` (opaque JSON; shown collapsed and pretty-printed) |

**Formats** (`format` on `stat`, `meter`, table columns, chart axes):
`number`, `compact` (2.5k), `percent`, `currency:<ISO 4217>`, `bytes`,
`duration` (ms in, "3h 12m" out), `datetime`, `date`, `time`,
`relative` ("5 min ago"). Channels format with the user's locale.

### 5.4 `chart`

| prop | meaning |
|---|---|
| `title?` | |
| `x` | `{kind: "time" \| "category" \| "number", format?, label?}` |
| `y?` | `{format?, unit?, label?, min?, max?}` |
| `series` | `{name, kind: "line" \| "area" \| "bar", data: binding \| [x, y][]}[]` (colours come from the theme's series palette, in order) |
| `stacked?` | stack `area` and `bar` series |
| `thresholds?` | `{at, tone, label?}[]` drawn as horizontal rules |

- Series kinds can be mixed in one chart (line over bars). One y-axis.
- Data points per series: at most 2,000. The channel downsamples for
  display (largest-triangle-three-buckets for line and area).
- TUI: Braille-dot lines and areas, block-character bars, a legend line.
- Narrow fallback: fewer ticks and the legend below; below 30 cells or
  16 rem, a sparkline plus the latest value per series.

### 5.5 `collection`

One block for every set of items.

| prop | meaning |
|---|---|
| `items` | binding to an array; each item has a unique `id` |
| `item` | the card template (§5.5.1) |
| `display` | `list` \| `table` \| `lanes` \| `grid` \| `calendar` |
| `groupBy?` | item field to group on |
| `groups?` | ordered `{id, title, tone?, collapsed?}[]`; with `lanes` these are the lanes |
| `sort?` | initial order, `{field, dir: "asc" \| "desc"}`; users can change it (view-only). Filtering is a `form(mode: live)` bound under `/view/` (§6.2), not a collection prop. |
| `select?` | `single` \| `multi` |
| `bulkActions?` | `{id, label, icon?, onSubmit, form?: Tree}[]`, offered when multi-select has a selection. With `form`, choosing the action opens that small form (e.g. a status `choice`) and its values ride the payload with the selected ids. |
| `checkable?` | item field holding a boolean; toggling it calls `onCheck` (an edit, §6.2) |
| `reorder?` | `{within?: boolean, across?: boolean}` (and time moves for `calendar`); requires `onMove` |
| `children?` | item field holding nested items (indented in `list`) |
| `numbered?` | `list` only |
| `onMove?`, `onCheck?` | handler names (§6.1) for moves and checkbox toggles |
| `onActivate?` | an `Action` run when an item is activated (click, Enter): usually `navigate({item: id})` |
| `columns?` | `table` only: `{field, label, format?, cell?: "text" \| "meter" \| "badge", sortable?, priority?: "high" \| "low", width?: s/m/l}[]`. `meter` draws the value (0–1) as a bar, `badge` as a badge with the item's tone. |
| `time?` | `calendar` only: `{start, end?, allDay?}` item fields, `range: month \| week \| day \| agenda`, `onResize?` (handler; enables dragging an item's end), `onCreate?` (handler; enables drag-to-create, payload `{start, end}`) |
| `overflow?` | `grid` only: `wrap` (default) \| `scroll` (one horizontal row) |

Display behaviour:

- `list`: rows. Supports groups, nesting, checkboxes, numbering.
- `table`: sortable, filterable columns, paged at 50 rows. Narrow: rows
  become cards; `priority: low` columns move into an expandable part.
- `lanes`: one column per group, side by side, horizontally scrollable.
  Narrow: one lane at a time with a lane switcher.
- `grid`: cards in as many columns as fit (`minItemWidth` from the item
  template's `image` presence: `m` with images, `s` without).
- `calendar`: month, week, day or agenda over `time`. Narrow: agenda.

#### 5.5.1 Card slots (ruling 10)

| slot | content |
|---|---|
| `eyebrow` | small text above the title (an id, a time) |
| `title` | required |
| `subtitle` | one line |
| `body` | markdown, clamped to 4 lines in lists and lanes, full in `detail` |
| `image` | top image (grid) or thumbnail (list) |
| `icon` | named icon (§10.2) |
| `badges` | `{text, tone?}[]` |
| `meta` | inline facts: `{icon?, text}` or `{person: {user, name}}` (the extension supplies the display name; there is no non-admin user directory) or `{time, format}` |
| `metrics` | `{label, value, format?}[]` |
| `tone` | accent stripe / TUI marker |
| `actions` | up to 3 buttons, then an overflow menu |
| `status` | `{label, tone?, spinner?: boolean}`: a status badge; with `spinner`, an activity indicator beside the label (ambient progress rows) |
| `quiet` | boolean: the item is folded away by default behind an "N more" toggle (pi-warden's quiet verdicts) |
| `deps` | ids of items this one depends on, shown as "after: …" markers (task lists with blockers). Distinct from `children`, which nests. |

Every slot except `title` is optional; each takes a binding relative to
the item.

### 5.6 `form` and fields

**`form`**

| prop | meaning |
|---|---|
| `bind` | path of the object the fields read and write |
| `mode` | `submit` (a Save/Send button), `live` (every change is applied after 300 ms; for filters), `inline` (one row, field plus button; for quick-add) |
| `onSubmit?`, `submitLabel?` | the handler name (§6.1) and the button label; `turn?` (chat only, §6.2) |
| `children` | fields and `section`s grouping them |

**`choice` options for interactions:** `preview` is markdown shown
beside the options while one is focused (the webui shows it side by side
when there's room, the TUI below the list); `allowOther` adds a free-text
answer row. A `choice` field's value is the selected id (single) or ids
(`multi`); with `allowOther` and text entered, it is `{other: text}`
(single) or the ids plus `{other: text}` as the last element (`multi`).

**Field props, shared by all field types:** `name`, `label`, `help?`,
`placeholder?`, `required?`, `disabled?`, `apply?` (§13; settings only),
validation (`min`, `max`, `minLength`, `maxLength`, `pattern`), and a
server error the channel shows under the field.

| field | extra props |
|---|---|
| `text` | `kind?: plain \| search \| email \| url`, `suggest?` (binding to strings) |
| `longtext` | `syntax?: plain \| markdown \| code`, `lang?`, `rows?` |
| `number` | `step?`, `format?` |
| `toggle` | |
| `choice` | `options` (literal or binding): `{id, label, description?, tone?, recommended?, preview?}[]`, `multi?`, `allowOther?: {label?}`. The channel picks radio buttons, a select or a list by option count and width. |
| `date`, `datetime` | `min?`, `max?` |
| `daterange` | `presets?: {id, label, duration}[]` |
| `secret` | write-only; the channel shows `set (stored)` / `set (env)` / `not set` from a bound status |
| `file` | `accept?` (MIME patterns), `maxBytes?`, `multi?`, `onUpload` (handler); uploads through the surface's upload route (§7.2) |
| `list` | `item`: fields for one entry; `reorder?`, `min?`, `max?` (a repeatable group) |

### 5.7 Allowed blocks per placement

| block | view | panel | settings | chat | interaction | ambient |
|---|---|---|---|---|---|---|
| `page` | root, required | root, no `sidebar` | — | — | — | — |
| layout blocks | ✓ | ✓ | `section` only | ✓ | `stack`, `section` | `stack`, `columns` |
| `markdown`, `fields`, `callout`, `diff`, `details` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `stat`, `meter`, `log` | ✓ | ✓ | — | ✓ | — | ✓ |
| `chart`, `image`, `tree` | ✓ | ✓ | — | ✓ | — | — |
| `collection` | ✓ | ✓ | `list`, `table` | ✓ | `list` | `list` |
| `form` | ✓ | ✓ | root, required | ✓ | root, required | — |
| fields allowed in `form` | all | all | all but `file` | all but `secret` | `text`, `longtext`, `number`, `toggle`, `choice`, `secret` | — |

Validation rejects a tree that uses a block or field its placement
doesn't allow, and a `turn` flag outside `chat` (§6.2).

## 6. Actions

### 6.1 The closed set

```ts
type Action =
  | { type: "submit"; name: string; turn?: boolean; confirm?: Confirm }
  | { type: "navigate"; params?: JsonObject; target?: CoreTarget }
  | { type: "move"; name: string; turn?: boolean }
  | { type: "edit"; name: string; turn?: boolean }       // checkbox toggles, inline field edits
  | { type: "open"; url: string }                        // http(s) only, new tab / OSC 8 link
  | { type: "copy"; text: string | Binding }
  | { type: "restart"; confirm?: Confirm };              // core, admin, settings only
type Confirm = { title: string; body?: string; tone?: "bad" | "warn"; confirmLabel?: string };
type CoreTarget =
  | { conversation: number } | { job: string } | { settings: string }
  | { view: { extension: string; id: string; params?: JsonObject } };
```

- `Action` objects appear where a block offers buttons: `page.actions`,
  card `actions`, `callout.actions`, and `onActivate`.
- Blocks with built-in gestures name their handler with a prop instead:
  `onMove`, `onCheck`, `onExpand`, `onResize`, `onCreate` (collection and
  tree), `onSubmit` (form, bulk action), `onUpload` (file field).
  `validateTree` resolves each to the matching `Action` (`move`, `edit`
  for check/expand/resize, `submit` for create/submit/upload).
- `name` is a key of the surface's `actions` map (§7.1). A name with no
  handler fails validation. The channel sends `{action: name, payload,
  actionId}`.
- `actionId` is a channel-generated UUID. The **server** invokes a
  handler at most once per `actionId` (a 10-minute dedup window per
  surface instance), so retries are safe.
- `open` allows `https:`, `http:` and `mailto:` URLs only.

### 6.2 Three kinds (ruling 14)

| kind | examples | where it goes | starts a turn |
|---|---|---|---|
| **view-only** | sort, filter, page, expand/collapse, select, copy, lane switch, `form(mode: live)` over view-only state, `navigate(params)` | nowhere: the channel applies it to the surface's view state | never |
| **edit** | `move`, `edit` (checkbox, inline field), `submit` with `turn: false` | the placement's handler (§6.4); the change is saved | only with `turn: true` |
| **answer** | `submit` (default `turn: true`), any action with `turn: true` | the placement's handler, then a turn | yes |

- A `form(mode: live)` is view-only when its `bind` path is under
  `/view/` (the surface's view-state branch, which the channel owns and
  never sends to the server). A live form bound elsewhere is an edit.
  This is how a filter over agent-generated data stays local.
- **`turn` is valid only in the `chat` placement.** Elsewhere a turn is
  the handler's decision (§6.4), and validation rejects the flag rather
  than silently ignoring it.
- `navigate` with `params` re-renders the surface with new params; with
  `target` it leaves the surface.

### 6.3 Optimistic moves (ruling 11)

The channel keeps two layers: **confirmed data** (exactly what the
server has sent, at its `rev`) and an **optimistic overlay** (pending
actions, keyed by `actionId`). It renders confirmed data with the overlay
applied on top.

1. The channel adds the move to the overlay and renders it at once.
2. It sends `{action, payload: {itemId, from: {group?, index}, to: {group?,
   index?, start?, end?}}, actionId}`.
3. The handler accepts or rejects:
   - **accept with an update** → the server applies the ops, assigns the
     next `rev`, returns it, and announces it to other viewers (§7.3).
     The channel applies the ops to confirmed data and drops that
     action's overlay entry.
   - **accept without an update** (`{ok: true}`) → the handler took the
     move as sent. The server applies the move itself as a `DataOp.move`,
     so the next `rev` and every other viewer see it. Without this, the
     next refetch would silently undo the drag.
   - **reject** → `{error: {message}}`. The channel drops the overlay
     entry (the item snaps back) and shows the message as a toast.
4. A handler that hasn't answered in 10 s counts as a reject.
5. Server ops always apply to confirmed data, never to the overlay, so an
   update that arrives while a move is pending can't duplicate or lose an
   item.

Concurrent moves need no locking: the server applies them in arrival
order, and the resulting updates converge every viewer.

### 6.4 Routing per placement

| placement | handler | how a turn starts |
|---|---|---|
| `view`, `panel` | the extension's action handler (§7.1) | the handler calls `host.conversations.submit(...)` (W5) if it wants one |
| `settings` | core: validate, store, publish `settings.changed` (§13) | never |
| `chat` | core: §8 | the core submits for the user (§8.4) |
| `interaction` | core answer route; the extension receives `{values}` (§9.1) | the existing interaction semantics |
| `ambient` | the extension's ambient action handler | as for `view` |

### 6.5 Access

- Every surface render and every action carries the principal (W1).
- Extension surfaces: the extension's `render` and handlers receive the
  principal and do their own `accessOf` checks (core-hardening §5.9).
- `render` returns `access: "none" | "read" | "write"` for the principal:
  - `none` → `404 surface_not_found` on the surface, data, action and
    upload routes (indistinguishable from a surface that doesn't exist),
    no events, and no rail entry;
  - `read` → the channel hides every edit and answer action and disables
    `reorder`, `checkable`, inputs and bulk actions. The extension doesn't
    build a second tree for read-only users;
  - `write` → everything.
- **The server enforces it per principal.** It caches the result of each
  render keyed by `(slug, id, key, principal.user)` for 60 seconds.
  - An action from a principal whose cached access is `read` gets `403`;
    `none` gets `404`.
  - A cache miss (expired, or never rendered) is not an allow: the server
    calls `render` for that principal first and uses its answer.
  - One principal's render never changes another's access.
- Handlers still check `accessOf` themselves; the server check is defence
  in depth, not the extension's only guard.
- Chat surfaces: access follows the conversation (`read` sees the
  blocks; `write` can edit and answer).

## 7. Extension surfaces

### 7.1 Declaring them

The extension contract (W5's `src/extension.ts`) gains a `surfaces`
field on the factory result:

```ts
surfaces?: {
  views?: SurfaceDef<"view">[];
  panels?: SurfaceDef<"panel">[];
  settings?: SettingsSectionDef[];          // §13.3
};

interface SurfaceDef<P> {
  id: string;                                // unique within the extension
  title: string;
  icon: IconName;
  placement: P;
  sharedData?: boolean;                      // data is identical for every principal with access (§7.3)
  refreshMs?: number;                        // channels refetch data on this interval while visible (min 5000)
  instanceKey?(params: JsonObject): string;  // §7.3; default: canonical JSON of params
  render(ctx: SurfaceContext): Promise<{ tree: Tree; data: JsonObject; access: "none" | "read" | "write" }>;
  data?(ctx: SurfaceContext): Promise<{ data: JsonObject; access: "none" | "read" | "write" }>;
  actions?: Record<string, (ctx: SurfaceContext, payload: JsonValue) => Promise<ActionResult>>;
}

interface SurfaceContext {
  principal: Principal;
  params: JsonObject;                        // from navigate(params); validated as JSON, size-capped at 4 KiB
  key: string;                               // instanceKey(params)
  signal: AbortSignal;
}

interface UploadedFile {                     // the payload of an onUpload handler
  field: string;                             // the file field's name
  name: string;                              // client-supplied filename, sanitised to a basename
  mime: string;                              // sniffed, not trusted from the client
  bytes: Uint8Array;                         // capped by the field's maxBytes and server.maxUploadBytes
}

type ActionResult =
  | { ok: true; update?: DataUpdate; navigate?: Action & { type: "navigate" }; toast?: string }
  | { ok: false; error: { message: string; field?: string } };
```

- Surfaces are validated at load. A malformed `surfaces` field
  quarantines the extension (the loader's existing fail-loud rule).
- `data()` is required when `refreshMs` is set or when the extension
  calls `changed` for the surface; without it, a data refetch would re-run
  `render`.
- Uploaded bytes go to the `onUpload` handler and nowhere else. Core keeps
  no copy; the extension stores what it wants in its own stores.
- The rail shows views in the user's saved order (a client preference,
  like hermes' tab order), after the core entries.

### 7.2 Routes

All under W5's extension prefix, with W1's auth pipeline:

| route | returns |
|---|---|
| `GET /v1/ext/<slug>/surfaces/<id>?params=<json>` | `{tree, data, rev, treeRev, access}` |
| `GET /v1/ext/<slug>/surfaces/<id>/data?params=<json>&since=<rev>` | `{rev, treeRev, data}`, or `{rev, treeRev, ops}` when the server holds the ops since `since` |
| `POST /v1/ext/<slug>/surfaces/<id>/actions` | body `{action, payload, actionId, params}` → `ActionResult` |
| `POST /v1/ext/<slug>/surfaces/<id>/uploads?field=<name>&params=<json>` | raw `application/octet-stream` body with an `X-Filename` header (the same shape as core uploads, core-hardening W2), capped by the field's `maxBytes` and `server.maxUploadBytes` → `ActionResult` |
| `GET /v1/ext/<slug>/assets/<path>` | static files from the package's declared `assets` dir (§11) |

- **Reserved prefixes.** `surfaces/` and `assets/` under
  `/v1/ext/<slug>/` belong to core. An extension that declares an HTTP
  route (core-hardening W5 §9.2) starting with either is quarantined at
  load, naming the route.

A surface that throws in `render` or a handler returns `500
surface_failed`; the channel shows an error state with a retry button.
The extension stays loaded.

### 7.3 Live updates

- Extensions publish changes with `host.surfaces.changed(id, key, update?)`.
  `key` identifies the instance (a board id, a calendar id): the same
  string `instanceKey(params)` returns for that instance.
- **Watchers.** The server keeps a registry of who is looking at what:
  - an entry is `(stream, slug, id, key)`, where `stream` is a
    `/v1/events` connection. Its id is sent in the stream's first frame,
    and channels send it as `X-Sigrun-Stream` on surface and data fetches;
  - a fetch creates or refreshes the entry. It is dropped when its stream
    closes, or 10 minutes after the last fetch. Channels make a `since`
    fetch every 5 minutes while a surface is visible, which keeps the entry
    alive and costs nothing when nothing changed;
  - only principals with a registry entry get the event, and only after
    their cached access (§6.5) for that instance is not `none`.
- The event is `surface.changed {slug, id, k, rev, treeRev}`, where `k` is
  `sha256(slug + "\0" + id + "\0" + key)` in hex. Params never appear in
  events. **The event carries no data.**
- Event types are an open set: channels ignore types they don't know.
  This spec adds `surface.changed` and `settings.changed` (§13.2) to W3's
  §7.4 list.
- Each channel then fetches `…/data?since=<rev>` as its own principal.
  This is why events don't carry data: `render` and `data` are
  principal-specific, so pushing one principal's data to another would
  leak it.
- When `update` is passed to `changed`, the server keeps the ops (last
  100 per instance) so `since` fetches return only ops. Otherwise the
  fetch returns full data.
- Ops are only kept for surfaces declared `sharedData: true`: every
  principal with access sees the same data (a shared board, a household
  shopping list). For principal-specific surfaces, `update` is ignored
  and each channel refetches full data, because one principal's ops
  could describe rows another can't see.
- When `treeRev` changed, the channel fetches the whole surface.
- `refreshMs` surfaces (dashboards) refetch data on that interval while
  visible, as their own principal, without any event.

## 8. Agent-authored blocks in chat

### 8.1 Tools

Two core tools, available to every agent:

- **`show_blocks {title, tree, data}`** appends a block surface to the
  conversation and returns its `entryId`.
  - The tree is validated against the `chat` subset (§5.7) and the
    limits (§4.5). Validation errors go back to the model as the tool
    error, each naming its JSON path, so the model can fix the tree and
    retry.
  - The tool result the model sees is the text projection (§14.3) of the
    tree and its initial data, plus the `entryId`.
  - The transcript shows the surface in place of the tool call: channels
    render a `show_blocks` tool call whose result names an `entryId` as
    that surface, not as a separate tool row.
- **`update_blocks {entryId, ops}`** applies `DataOp`s to one of the
  conversation's own block surfaces. It records no change record (the
  agent made the change), and is how an agent keeps a progress table or
  a live chart current.
  - Its result is the surface's text projection after the ops, so the
    model always sees the current state. This matters after user edits:
    an op written against stale indexes shows up as a visibly wrong
    result instead of silently misplacing an item.

The tool descriptions teach the action kinds in two sentences:
"Interactive elements save the user's edits silently; you'll receive a
summary of edits at your next turn. A `submit` sends you the result
immediately; set `turn: true` on a `move` or `edit` only if each one
needs an immediate reply."

### 8.2 Storage

- The surface is a typed pi-durable entry, kind `sigrun.blocks`:
  `{title, tree, data}` as created. It never changes.
- Its live state is a conversation-scoped document family,
  `sigrun.blocks.state`, keyed by entry id:
  `{rev, data, changes: ChangeRecord[], notedThrough: number}`.
  - `ChangeRecord = {seq, at, by: user, action, summary}`; `seq` is
    monotonic per surface.
  - `notedThrough` is the highest `seq` already sent to the agent in a
    change note (§8.3). Records at or below it are trimmed when more than
    50 have accumulated.
- **Forks (ruling 19).** The family is declared `history: "rewindable",
  fork: "asOf"`. pi-durable copies `asOf` documents as they were at the
  forked entry's commit (`session/forks.js`), so a fork gets the state,
  `rev`, change records and `notedThrough` exactly as they were at the
  fork point. After that, the parent's and the child's copies are
  separate documents and diverge. Forking at the latest entry gives the
  current state.
  - The cost is retained history for as-of reads. The family's
    `checkpointWhen` takes a full snapshot every 100 ops, so one edit is
    one small op, not a copy of the data.
- **Chat surfaces use the surface machinery of §7.** Their address is
  `(conversationId, entryId)` instead of `(slug, id, key)`:
  - `GET /v1/conversations/:id/blocks/:entryId` returns `{tree, data,
    rev, treeRev: 0, access}`, `…/data?since=` and `…/actions` mirror
    §7.2;
  - access is the conversation's (`read` sees, `write` edits and
    answers; hidden is 404, core-hardening §5.9);
  - changes announce `surface.changed {conversation, entry, rev}` to
    watchers (§7.3). Chat data is the same for everyone who can see the
    conversation, so ops are kept and returned like `sharedData`
    surfaces.
  - The conversation view stream does not carry block state. Its
    documents are keyed by kind and have no slot for per-entry family
    members (`harness/view.d.ts`).

### 8.3 Edits and change notes

- Edits on a chat surface are handled by core, generically:
  - `move` applies a `DataOp.move` to the collection's bound array (and
    sets the group field on cross-group moves);
  - `edit` applies a `set` at the bound path;
  - `submit` with `turn: false` writes the form's values at its `bind`.
- Each edit appends a `ChangeRecord`. Core writes its `summary` from the
  tree, using labels the user saw: "moved 'Clair de Lune' from 4th to
  1st in 'Ranking'", "checked 'milk' in 'Shopping'", "set 'Notes' to
  '…'".
- **Before the agent's next turn,** core writes one change note covering
  every surface with records above `notedThrough`:
  - **Where:** in core's submit path (the one every turn starter goes
    through: the composer route, block answers, jobs and W5's
    `host.conversations.submit`), immediately before the input that
    starts the turn is submitted;
  - **How:** a `type: "write"` submission whose entry
    (`kind: "sigrun.blocks.note"`) carries the note as a `model` user
    message. pi-durable appends it at once when the conversation is idle,
    and queues it in `pi.inbox` ahead of the input when it's busy, so the
    note always precedes the input it belongs to (a steer included);
  - **Exactly once:** the write's `requestId` is
    `blocks-note:<conversationId>:<sha of the noted (entryId, seq) set>`.
    `notedThrough` advances after the write is admitted. A crash between
    the two re-sends the same note under the same `requestId`, which
    pi-durable deduplicates (`submissionByRequest`);
  - **Mid-run inputs:** a note queued while busy is placed at the next
    boundary along with its input, so the agent sees it mid-run, exactly
    when it sees the steer. That is the intended behaviour.

  The note reads:

  > Changes made to your UI since your last turn:
  > • Ranking (alice): moved 'Clair de Lune' 4th → 1st; moved 'Gymnopédie' 5th → 2nd.
  > Current state of Ranking: 1. Clair de Lune 2. Gymnopédie 3. …

  - Each line names who made the change; conversations can be shared with
    `write` access (core-hardening §5.9).
  - Each changed collection's **current state** follows its changes, so
    the agent never has to replay moves.
  - Over 50 change lines per surface, the oldest are summarised as
    "…and N earlier changes"; the current state is always complete (up to
    the §4.5 data cap).
  - The note is appended after earlier entries. Old tool results are
    never rewritten, so the prompt prefix stays byte-identical and cached.

### 8.4 Answers (turns)

- A turn action (`submit`, or any action with `turn: true`) makes core
  submit a user message for the acting user, through the normal
  submission path (W3 async submit; it steers when the agent is busy,
  exactly as the composer does).
- The submission is:

  ```ts
  { type: "input",
    content: textProjection,              // "Submitted 'Ranking': 1. Clair de Lune 2. …"
    entry: { kind: "sigrun.blocks.answer",
             data: { entryId, action, payload, state } },
    requestId: "blocks:" + actionId }
  ```

  - `content` is what the model sees. The `entry` (pi-durable's
    `InputEntry`) is what channels show, and what agents and extensions
    reading structure use.
  - The surface's unnoted change records are folded into `content` and
    `notedThrough` advances, so they aren't sent again in a change note.
  - `requestId` makes a double click one turn.

### 8.5 Worked example: ranking songs

1. User: "help me pick the playlist order."
2. The agent calls `show_blocks` with a `collection(display: list,
   numbered: true, reorder: {within: true}, onMove: "reorder")` bound to
   `/songs`, and a `form(onSubmit: "useOrder", submitLabel: "Use this
   order")`. In chat, handler names are labels core reports back; core
   handles the edits itself (§8.3).
3. The user drags songs around for a while. Each drag is a saved edit
   with a `ChangeRecord`. No turns.
4. The user asks, mid-way, "does this flow well?" The next turn carries
   the change note with the current order, so the agent answers about
   the order on screen.
5. The user presses "Use this order". That is one turn carrying the final
   order. The agent builds the playlist.

## 9. Interactions and ambient surfaces on the block set

### 9.1 Interaction records

- Records carry `body: Tree` (placement `interaction`): a root `form`
  whose `submit` is the answer. The old body fields are removed.
- Mapping from today's body (all channels render only trees after this
  spec):

  | today | tree |
  |---|---|
  | `text` | `markdown` |
  | `options[]` | a `choice` field (`multi`, `recommended`, `tone`, `description` carry over) |
  | `fields[]` | `text` / `number` / `toggle` / `secret` fields |
  | `diff` | `diff` |
  | `details` | `details` |
  | `answer {ids, values, text}` | `{values: {<field name>: value}}`: every field's value under its name (ruling 20). A `choice` value is its id or ids (§5.6). |

- `tone` values use the block tones: today's `danger` becomes `bad`, `ok`
  becomes `good`; `warn` and `neutral` are unchanged.
- **The envelope is unchanged:** `kind`, `callId`, `status`, timestamps
  (`createdAt`, `expiresAt?`, `answeredAt?`), `answeredBy?`, `answer`,
  and first-answer-wins. The extension still declares its kinds through
  the factory result's `interactionKinds`.
- **The answer route keeps its path; its body becomes `{values}`.**
  Nothing depends on the old shape once approvals is deleted.
- **No compatibility layer** (ruling 16). The only extension that writes
  interaction records today is `sigrun-ext-approvals`, which is being
  deleted (core-hardening §1). No other `sigrun-ext-*` repo writes
  interaction or ambient records (checked 2026-10-19). Legacy-shaped
  records fail validation, and core's seam fixtures (`fixture-seam`,
  `fixture-seam-visual`, `fixture-seam-bad-kinds`, and the decide fixture
  W2 renames from `fixture-approvals`) are rewritten as trees.
- **The planned ports are the evidence check.** The replacement
  extensions are ports of `@juicesharp/rpiv-ask-user-question` and
  `pi-warden`. The interaction subset covers both:
  - ask-user-question: 1–4 questions, each a `section` (its short header
    as the title) holding one `choice` with 2–4 options, `multi`,
    per-option `description` and `preview`, and a free-text answer
    (`allowOther`). `preview` and `allowOther` are the two `choice`
    props added for it (§5.6). Its answer is `{values: {q1: …, q2: …}}`,
    one entry per question;
  - pi-warden: an allow/deny `choice` with tones, a `longtext` reason,
    `markdown` for the matched rule and command, and its verdict stack
    as an ambient `collection` with severity tones, `quiet` items folded
    away (§5.5.1).
- When an interaction form has more than one `section` holding a
  `choice`, channels may present the sections one at a time (a step
  through, with a review before submit). That's a channel presentation of
  the same tree, not a new block.

### 9.2 Ambient surfaces

- Records carry `body: Tree` (placement `ambient`) in place of today's
  `body`. **The envelope is unchanged:** `key`, `owner`, `place: "status"
  | "footer" | "panel"`, `maxRows?`, `overflow?: "drop" | "wrap" |
  "summarize"`, `refreshMs?`, `expires: "never" | "idle"`, `updatedAt`,
  and `details?` (`shared/src/ambient.ts`).

  | today | tree |
  |---|---|
  | `line {text}` / `segments[]` | one-line `markdown`; segments are a `columns` of one-line `markdown`s |
  | derived metrics with `format` | `stat` with `format` |
  | `rows[]` (status, severity, quiet, depth, deps, spinnerLabel, metrics) | `collection(display: list)`: `status` (with `spinner`), `tone`, `quiet`, `children` (depth), `deps`, `metrics` |
  | `gauge` | `meter`, plus `log` for `recentOutput` and a nested `collection` for `checks` |
  | `ledger[]` | `log` |
  | `details` | `details` |

- `place: status` and `place: footer` allow one line: a single
  `markdown` or one `columns` of one-line blocks (the footer's left /
  middle / right zones are three columns). Validation enforces it.
- No compatibility layer, as for interactions: records carry trees only.

## 10. Styling and icons

### 10.1 By meaning only

- Extensions never set colours, fonts, pixel sizes or spacing values.
  They set:
  - `tone`: `neutral`, `accent`, `good`, `warn`, `bad`, `info`;
  - `size`: `s`, `m`, `l` where a block offers it (`stat`).
- Each tone maps to the active theme's tokens (`shared/src/themes.ts`:
  4 palettes × 7 accents × light/dark). `accent` is the user's accent.
- The TUI maps tones through the same tokens via its existing
  `TuiTheme`.

### 10.2 Named icons

- Icons are names from a closed set. The webui draws them from a bundled
  subset of Lucide (MIT, already the style of `webui/src/layout/icons.tsx`).
  The TUI maps each name to a Unicode glyph with an ASCII fallback.
- v1 set (60 names) covers navigation and actions (add, edit, delete,
  refresh, search, filter, share, copy, link, external, more, check,
  close, drag), objects (file, folder, calendar, clock, user, users, tag,
  list, board, chart, image, book, cart, home, bell, lock, key), status
  (info, warn, error, success, pending, running), and weather (sun,
  moon, cloud, cloud-sun, cloud-rain, cloud-snow, cloud-lightning, fog,
  wind, droplets, thermometer, umbrella). The plan pins the exact list.
- An unknown icon name fails validation.

## 11. Images

### 11.1 Sources

| `src` | rule |
|---|---|
| `asset:<path>` | a file from the extension package's `assets` directory (declared in its package manifest as `sigrun.assets`), served at `/v1/ext/<slug>/assets/<path>` |
| `data:image/png\|jpeg\|gif\|webp;base64,…` | at most 192 KiB of base64 text; counts toward the tree or data limit that holds it (§4.5) |
| `https://…` | rewritten by the server to the proxy (§11.2) before the tree or data leaves the server |

- SVG and AVIF are never accepted. SVG can carry script; AVIF has no
  decoder in pi-tui. `http:` URLs are rejected.
- **Assets are public to every signed-in user,** like any static file of
  an installed package. Extensions don't put private data in `assets`.
- **Asset paths are resolved with `realpath`** and must stay inside the
  package's assets directory, so `..` segments and symlinks out of it are
  both rejected with 404. The same check applies to `asset:` sources
  when a tree is validated.

### 11.2 The proxy (ruling 12)

- `GET /v1/image?u=<url>&e=<expiry>&s=<sig>[&as=png]`, authenticated like
  every route.
- **Signing.**
  - `s` is HMAC-SHA256 over the exact bytes `u + "\n" + e`, where `u` is
    the URL string as it appeared in the tree. The server never
    re-parses or re-encodes `u` between verifying and fetching.
  - `e` is an expiry 24 hours after signing. The server signs URLs only
    when serving a tree or data that contains them, so the proxy can't be
    used to fetch arbitrary URLs.
  - The key is 32 random bytes in `<stateDir>/image-proxy.key`, created
    at first boot. Deleting the file rotates it: old signatures fail and
    channels re-fetch the surface, which re-signs.
  - Signatures are not bound to a user. A signed URL copied to another
    signed-in user works for them until it expires. That reveals nothing
    the URL didn't already.
- **Fetching** (no DNS rebinding):
  - https only;
  - the server resolves the host once, checks every returned address,
    and connects only to a checked address. It passes a custom `lookup`
    to the HTTP agent that returns the vetted address, so the connection
    can't re-resolve. TLS SNI and `Host` keep the original name;
  - refused ranges: loopback, `0.0.0.0/8`, RFC 1918 private, link-local,
    CGNAT `100.64.0.0/10`, unique-local `fc00::/7`, multicast, and
    IPv4-mapped IPv6 forms of all of them (`::ffff:127.0.0.1`);
  - redirects: at most 3 in total, each target re-resolved and re-checked
    the same way, and https only;
  - 10 s total timeout, 10 MiB cap;
  - the body must sniff as PNG, JPEG, GIF or WebP.
- **Cache:** `<cacheDir>/images/` (pod-local and outside backups, like the
  other cache roots), keyed by URL hash, 256 MiB LRU, `max-age` clamped to
  between 1 hour and 7 days.
- **PNG conversion (ruling 17):** with `as=png`, the server converts the
  image to PNG with `sharp` (a server dependency) and caches the result
  beside the original. The TUI asks for it; the webui doesn't.
- Responses carry `X-Content-Type-Options: nosniff`. The webui's own CSP
  (`img-src 'self' data:`) is what stops images loading from elsewhere.
- Failures render the block's `alt` text.

### 11.3 In the TUI (ruling 13)

- The TUI fetches images with the user's credentials (proxied URLs with
  `as=png`; assets and data URLs converted the same way through
  `GET /v1/image?as=png&src=asset:…` for non-PNG files) and renders them
  with pi-tui's `Image` component when `getCapabilities().images` is
  `"kitty"` or `"iterm2"`. pi-tui draws only PNG on Kitty without a
  registered transcoder; converting server-side avoids needing one.
- Otherwise it shows `[image: <alt>]`.
- Images are sized to the block's width in cells and capped at 20 rows.
- **tmux:** pi-tui turns images off whenever `TMUX` is set
  (`terminal-image.js`); setting `PI_IMAGE_PROTOCOL=kitty|iterm2`
  overrides it. herdr reports Kitty graphics and gets images. The TUI
  adds no detection of its own.
- `open` actions use OSC 8 hyperlinks when `getCapabilities().hyperlinks`
  is true, and print the URL otherwise.

## 12. Width (ruling 9)

### 12.1 Width classes

Classes describe the **container** a block is in: the chat column, a
view's main area, a detail pane, a TUI pane.

| class | webui (container width) | TUI (container cells) |
|---|---|---|
| `compact` | < 40 rem | < 80 |
| `regular` | 40–75 rem | 80–139 |
| `wide` | ≥ 75 rem | ≥ 140 |

- The webui measures containers with CSS container queries and a
  `ResizeObserver` for blocks that switch structure.
- The TUI computes the class from each pane's width on every layout.

### 12.2 `visibleAt`

Any block may set `visibleAt: "atLeast:regular"`: the block is hidden in
a compact container. It is the only width-dependent thing an extension
can say, and the only value with a case behind it (the sizing pass: the
weather hourly strip, secondary dashboard charts). Other values are added
when a case needs them. There are no per-width alternative layouts.

### 12.3 Channel fallbacks

Every channel implements these. Extensions get them without asking.

| block / display | regular and wide | compact |
|---|---|---|
| `page` | rail, sidebar, main, detail side by side | sidebar → drawer; detail → pushed page with back |
| `columns` | side by side by weight | stacked when the minimums don't fit |
| `grid` | as many columns as fit | one column |
| `collection` `lanes` | lanes side by side; drag across | one lane plus a lane switcher; "Move to…" for cross-lane moves; drag within |
| `collection` `table` | full table | rows as cards; `priority: low` columns in the expandable part |
| `collection` `calendar` | month / week / day grid | agenda; time moves through the item's form |
| `collection` `grid` | multi-column cards | one column (`overflow: scroll` stays one row) |
| `chart` | axes and legend | fewer ticks, legend below; very narrow → sparkline plus latest value |
| `form` | labels beside fields | labels above fields |

### 12.4 Keyboard and the TUI

- Every pointer interaction has a keyboard path, in both channels:
  - **move:** focus an item, `m` (vim/standard) or `M-m` (emacs) to pick
    it up, arrows to place it (left/right across groups, up/down within),
    `Enter` to drop, `Esc` to cancel;
  - **select:** `Space`; bulk actions from the action menu (`.`);
  - **checkable:** `x`;
  - **calendar:** `[`/`]` previous/next range, `t` today.
- The bindings join the TUI's keymap layer (standard, vim, emacs) and
  appear in its help overlay.

## 13. Settings: sections, live changes and restart (ruling 15)

### 13.1 How a setting applies

- Every settings field declares `apply: "live" | "restart"`.
  - **live:** the value is read where it's used, at the time it's used.
    Saving it takes effect without a restart.
  - **restart:** the value is read at boot. Saving stores it and marks
    it pending.
- Fields declared by extensions default to `live`. An extension marks a
  field `restart` when its factory reads the value at load.
- **This replaces core-hardening §5.7's rule** that every `server.*` key
  is restart-required (ruling 18). From U4 on, each core key is marked
  individually, and the plan audits `server.*`:
  - `live`: `namingModel` (already read per use, `src/harness/naming.ts`),
    `providers.refreshIntervalMinutes` (the scheduler re-arms),
    `jobHistory.*` (already live);
  - stay `restart`: listen host and port, the data and config dirs,
    `auth.*`, `trustedProxies`, the webui bundle selection, the
    extension list.

### 13.2 Change events and pending restarts

- Every settings write publishes `settings.changed {scope: "server" |
  {extension: slug}, keys}` on the event bus and on `/v1/events`.
- Extensions receive it through a new factory-result hook,
  `onSettingsChanged(keys)`, called after the write commits. Errors are
  caught and logged; the write still succeeds.
- The server keeps a boot snapshot of every `restart` key.
  `GET /v1/settings` (and each extension's settings GET) returns
  `pendingRestart: string[]`: the restart keys whose stored value
  differs from the snapshot.
- The settings surface shows a `callout(tone: warn)` listing them, with
  a Restart button for admins.

### 13.3 Restart

- `POST /v1/admin/restart` (admin; confirms in the UI) runs the normal
  graceful shutdown, then exits with code 0.
- It's offered only when the server knows something will start it
  again: `server.supervised: true` (env `SIGRUN_SUPERVISED=1`), set by
  the Helm chart and the compose file, which both restart the container.
  The Dockerfile does not set it: a bare `docker run` without a restart
  policy would stay down after a Restart.
  `sigrun run` (the local TUI launcher) is not supervised; there the
  callout says "Restart sigrun to apply" with no button.
- The webui and TUI show "Restarting…" and reconnect when `/readyz`
  answers.

### 13.4 Settings sections

```ts
interface SettingsSectionDef {
  id: string; title: string; icon?: IconName;
  form: Tree;                       // placement "settings": a root form
  secrets?: { key: string; label: string; help?: string }[];
  admin?: boolean;                  // only admins see and edit it; default true (settings writes are admin-only, core-hardening §7.7)
}
```

- The form binds to the extension's settings object
  (`settings/<slug>.json`, core-hardening §7.7). Saving validates every
  field, writes the object, then fires §13.2.
- `secrets` render as `secret` fields backed by the core-hardening §7.7 secrets routes
  (write-only, showing their source).
- Core's own sections (General, Interface, Providers, Users and invites,
  Jobs, Backup, Extensions) are rebuilt as `SettingsSectionDef`s, so core
  and extensions use one renderer. Client-only preferences (theme,
  keymap) stay client-side but render through the same blocks.
- Extensions with no declared section keep core-hardening §7.7's raw JSON editor under
  Settings → Extensions → <name> → Advanced.
- Settings search indexes every section's field labels and help text.
  Section trees are static per extension version, so the index builds
  once at boot.

## 14. Developer experience

### 14.1 Builders

`sigrun/blocks` (a new subpath in the package's `exports` map, next to
W5's contract surface; the root `package.json` gains the map) exports
typed builder functions for every block and field, plus the types:

```ts
import { page, collection, card, form, choice, chart, bind } from "sigrun/blocks";

render: async ({ principal, params }) => ({
  access: "write",
  data: { cards: await board.cards(params.board), lanes: LANES },
  tree: page({
    title: "Board",
    main: collection({
      id: "cards", items: bind("/cards"), display: "lanes",
      groupBy: "status", groups: bind("/lanes"),
      reorder: { within: true, across: true }, onMove: "move",
      item: card({ title: bind("./title"), meta: [{ person: bind("./assignee") }] }),
    }),
  }),
}),
```

- Builders return plain JSON; there is no runtime besides them.
- Event props (`onMove`, `onSubmit`, `onCheck`, `onActivate`) name
  handlers in the surface's `actions` map. A name with no handler fails
  validation at load where it can be checked statically, and at render
  otherwise.

### 14.2 Validation

- `validateTree(tree, placement)` returns every error with its JSON path
  and a plain message ("main[2].collection: `reorder.across` needs
  `groupBy`").
- The server runs it on every render and every `show_blocks` call. An
  extension's invalid tree is a `500 surface_failed` with the errors in
  the server log and, in development (`server.dev: true`, env
  `SIGRUN_DEV=1`), in the response.

### 14.3 Text projection

- `toText(tree, data, {width})` renders a surface as plain text:
  headings, aligned tables, lists with checkboxes and numbers, lanes as
  sections, charts as one summary line per series (min, max, latest).
- It is used for:
  - what the model sees of its own `show_blocks` call (§8.1);
  - the default `fallback` text;
  - extension unit tests (snapshot the text at 80 and 160 columns);
  - logs and notifications.
- It is deterministic: the same input gives the same bytes, which keeps
  model context cacheable.

### 14.4 The gallery

- With `server.dev: true` (env `SIGRUN_DEV=1`), core adds a "Blocks" view to the rail: one
  page per block and display, with sample data, in both channels.
- It doubles as the visual regression fixture (§16) and as the place an
  extension author looks up what a block looks like.

### 14.5 Documentation

`docs/extending.md` gains "Building surfaces": the placement table, the
block catalog with one builder example each, the action kinds, and three
complete examples taken from the sizing pass (a lanes board, a settings
section, a dashboard).

## 15. Security

- Extension and agent strings are text everywhere. `markdown` escapes
  raw HTML.
- **Links allow `https:`, `http:` and `mailto:` only,** in markdown and in
  `open` actions, in both channels. Each channel applies an explicit
  three-scheme URL transform: today's webui renderer passes links through
  (`webui/src/entries/Markdown.tsx`), and react-markdown's default also
  allows `tel:` and `irc:`. Other schemes render as plain text.
- No block can carry script, style or HTML. SVG is never accepted.
- Trees are validated server-side before any channel sees them.
- `params` are size-capped (4 KiB) and passed to `render` as data; the
  extension validates them like any input.
- Actions are rate-limited per principal per surface (20 per second,
  burst 40) → `429`.
- Access: §6.5. The server enforces it per principal: an action is
  checked against **that principal's** most recent render of the
  instance (60 s cache, a miss re-renders), `read` → `403`, `none` →
  `404`, before the handler runs.
- Events (§7.3) reach only watching principals with access, carry no
  data, and name the instance by a hash, never by its params.
- Image proxy: §11.2. Expiring HMAC signatures over the exact URL bytes
  prevent use as an open proxy; connecting only to the vetted address
  prevents DNS rebinding; the range checks (IPv4-mapped forms included)
  prevent SSRF into the cluster or LAN.
- Agent-authored blocks can't navigate to core targets the user can't
  access; navigation goes through the normal routes and their 404s.

## 16. Testing

- **Schemas:** every block's typebox schema accepts the gallery samples
  and rejects a mutation per required prop; `validateTree` reports paths.
- **Placements:** every row of the §5.7 table, accepted and rejected.
- **Limits:** each §4.5 limit returns `413 surface_too_large`.
- **Data updates:** applying `DataOp`s is property-tested
  (fold(data, ops) equals the server's data); a `rev` gap forces a full
  refetch.
- **Events:** `surface.changed` carries no data and no params (`k` is a
  hash); only principals in the watcher registry get it; a watcher entry
  expires 10 minutes after the last fetch and drops when its stream
  closes; `access: "none"` gets no event and a 404 on every surface
  route; `sharedData: false` surfaces never return ops; channels ignore
  an unknown event type.
- **Moves:** optimistic apply; accept with an update (it reaches a second
  client); accept without an update (the server applies the move, and a
  refetch keeps it); reject (snap back + toast); timeout (snap back); an
  update arriving while a move is pending (no duplicate or lost item);
  two clients moving concurrently converge.
- **Access:** two principals on one surface instance with `read` and
  `write`: the `read` one's forged action gets 403 and the `write` one's
  succeeds, in either order; a cache miss re-renders before allowing.
- **Validation of handler names:** `reorder` without `onMove`, a handler
  name with no entry in `actions`, and `turn` outside `chat` all fail
  with their paths.
- **Routes:** an extension declaring a `surfaces/` or `assets/` route is
  quarantined; an asset symlink out of the assets dir is a 404.
- **Versions:** a `v: 2` tree with an unknown block in a `v: 1` channel
  shows the fallback text and "Not supported in this client".
- **Chat blocks:**
  - `show_blocks` validation errors name paths;
  - the ranking example (§8.5) end to end with the faux provider: three
    moves make no turns, the next user message's turn has one change
    note with the current order, "Use this order" makes exactly one
    turn, and a double click makes one turn (`actionId`);
  - change notes are appended after earlier entries (the earlier prompt
    bytes are unchanged);
  - a note while the agent is busy is queued ahead of the steer that
    triggers it; a crash between the note write and `notedThrough`
    advancing re-sends nothing new (`requestId` dedup);
  - changes by two users name both authors;
  - a fork at an earlier entry has that entry's state, `rev` and change
    records; edits after the fork in either conversation don't reach the
    other;
  - `since` fetches across a fork return full data for the child (its
    ops history starts at the fork);
  - `update_blocks` returns the post-update projection.
- **Interactions and ambient:** a legacy-shaped record fails
  validation; the rewritten seam fixtures render in both channels; a
  four-question ask-user-question tree (with `preview` and `allowOther`)
  answers in one submit as `{values: {q1, q2, q3, q4}}`; an
  interaction form with a `file` or `daterange` field fails validation;
  a `footer` ambient record with three zones renders in both channels; a
  `quiet` row is folded by default.
- **Settings:** a live key applies without restart and fires
  `onSettingsChanged`; a restart key shows in `pendingRestart`; restart
  is hidden when unsupervised (including the bare Docker image);
  `POST /v1/admin/restart` is admin-only.
- **Images:** the proxy refuses unsigned and expired URLs, private
  ranges (including IPv4-mapped IPv6 and via redirect), a fake resolver
  that answers public then `127.0.0.1` (the connection uses the first,
  vetted address), more than 3 redirects in total, non-images, SVG and
  AVIF; caches under `cacheDir`; `as=png` converts a JPEG; the TUI
  renders inline with a faked Kitty capability and shows alt text
  without one and under `TMUX` (unless `PI_IMAGE_PROTOCOL` is set);
  markdown links with `tel:` or `javascript:` render as text in both
  channels.
- **Width:** each §12.3 fallback, in the webui (container sizes) and the
  TUI (pane widths), from the gallery.
- **Visual:** Playwright screenshots of every gallery page at the three
  width classes; TUI snapshots at 72, 100 and 160 columns.
- **Keyboard:** every §12.4 path, in all three keymaps.

## 17. Not in this spec

- **The kanban extension.** It is the first consumer and lives in its
  own repo; it gets its own spec, built on this one.
- **`embed`.** Reserved; needs its own security design.
- **Cut blocks:** `tabs`, `divider`, chart `pie`/`scatter`/`heatmap`/dual
  axis, `color` and time-only fields, `modal`. Each comes back when a
  real extension needs it (the sizing pass lists the evidence that would
  justify each).
- **Per-width alternative layouts.**
- **User-arranged dashboards** (dragging panels around a layout): that's
  layout editing, not data editing.
- **Extension-to-extension actions** (a recipe's "add to shopping
  list"). Needs a capability model between extensions.
- **Extension-authored chat blocks with their own handlers.** Extensions
  reach chat through interactions (answers) and ambient surfaces
  (status); `show_blocks` is the agent's.
- **i18n of extension-provided strings.**
- **Per-extension restart** (reloading one extension in place).

## 18. Workstreams

All land after core-hardening W5 (they need W1's principal and access,
W3's `/v1/events` and extension settings, and W5's extension routes and
contract type).

| id | delivers | depends on |
|---|---|---|
| U0 | `shared/src/blocks/` (types, `applyOps`, `toText`) and `src/blocks/` (schemas, `validateTree`, placements, limits, the `sigrun/blocks` builders and `exports` map); recursive purity test | — |
| U1 | webui renderer for every block, display, field and width fallback; the gallery view | U0 |
| U2 | TUI renderer for the same, keymap bindings, inline images | U0 |
| U3 | extension surfaces: contract field, routes (reserved prefixes), per-principal access cache, watcher registry and `surface.changed`, data fetch with `since`, optimistic-move server side, actions, uploads, assets, rail and panel registration | U0 |
| U4 | settings: `apply`, `settings.changed`, `onSettingsChanged`, `pendingRestart`, restart route, supervised detection, core sections rebuilt, extension sections | U0, U1, U2, U3 |
| U5 | chat: `show_blocks`, `update_blocks`, `sigrun.blocks` entries and the rewindable state family, chat surface routes, edits, change notes in the submit path, answers | U0, U1, U2, U3 |
| U6 | interactions and ambient on trees: record schemas carry trees only, `{values}` answers, channel renderers switched to trees, core seam fixtures rewritten | U1, U2 |
| U7 | image proxy (signing, vetted-address fetching, cache, `sharp` PNG conversion), icon set, docs | U0 (U1/U2 consume the icons) |

U1 and U2 can run in parallel; so can U3 and U7 once U0 lands. U5 follows U3 (chat surfaces reuse its routes, access cache and watcher registry).

## 19. Open questions

None. Rulings 1–20 settle the design questions raised so far.

## 20. Review disposition

Reviewed by deepseek-v4.1-flash (BLOCK) and glm-5.3-flash (BLOCK), with
artifacts in `docs/superpowers/specs/reviews/2026-10-19-ui-blocks-review-*`.
Every claim against the code was checked before folding.

- **Folded:** `access: "none"` (§6.5); per-principal access enforcement
  (§6.5, §15); the watcher registry and hashed instance keys (§7.3);
  chat state as a rewindable `asOf` family on the surface routes, not
  the view stream (§8.2); handler-name props (§5.5, §5.6, §6.1); DNS-
  rebinding-safe proxy fetching, expiring signatures and a persisted key
  (§11.2); tree size caps and the 192 KiB data-URL cap (§4.5, §11.1);
  `{values}` answers (§9.1, ruling 20); the change-note write in the
  submit path with `requestId` dedup (§8.3); `InputEntry` answers (§8.4);
  the confirmed-data plus overlay model and server-assigned revs (§4.3,
  §6.3); `shared/` versus `src/blocks/` and a recursive purity test
  (§4.1); reserved route prefixes (§7.2); the corrected interaction and
  ambient envelopes, `footer` restored (§9); `status`/`quiet`/`deps` card
  slots (§5.5.1); bulk-action forms, `meter`/`badge` table cells and log
  tones (§5.3, §5.5); structural props as literals (§4.2); typed
  uploads over raw octet-stream (§7.1, §7.2); `person` carrying its
  display name (§5.5.1); open event types (§7.3); `turn` only in chat
  (§6.2); `update_blocks` returning the projection (§8.1); `treeRev` on
  data responses (§7.2); server/channel/core terms (§3); an explicit link
  scheme transform (§15); the tmux and PNG facts and `sharp` (§11.3,
  ruling 17); supervised restart only in compose and the chart (§13.3);
  `cacheDir` for the image cache (§11.2); unevidenced props cut (§5,
  §10.1, §12.2).
- **Rejected:** broadcasting `surface.changed` to every signed-in user
  (glm's simpler option for B2). Even without data, it would tell users
  which instances other people are viewing.
- **Ruled by the user:** `sharp` (17); superseding core-hardening's
  restart rule without editing it (18); fork semantics (19); the answer
  shape (20).
