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
   space they're in. Hosts own the narrow fallbacks. Extensions get
   three width classes as the only escape hatch.
10. **Fixed card slots.** Collection items render through a card with
    fixed slots; `body` (markdown) is the only free-form slot.
11. **Optimistic moves.** The host applies a move at once, reverts it if
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

## 3. Concepts

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
| `ambient` | a status line or above-composer panel | extension (existing seam) |

## 4. Wire format

### 4.1 Trees

```ts
type Tree = { v: 1; root: Block };            // v = block-set version
type Block = { type: string; id?: string; visibleAt?: WidthCondition;
               fallback?: string; [prop: string]: unknown };
```

- Types and props are defined in `shared/src/blocks/` (typebox schemas,
  shared by server, webui and TUI; the same pattern as
  `shared/src/views.ts`).
- `id` is required on blocks that carry actions or inputs, and must be
  unique within the tree. The host uses it to route actions and keep
  focus and scroll across re-renders.
- `fallback` is plain text a channel shows when it can't render the
  block (§4.4). Every block may carry it; the server fills a generic one
  ("[chart: CPU, 3 series]") when absent.

### 4.2 Bindings and the data model

Any prop whose value can change at runtime may be a binding instead of a
literal:

```ts
type Binding = { $: string };   // a JSON Pointer into the data model, e.g. "/jobs"
```

- Collections bind their items: `items: {$: "/cards"}`. Inside an item
  template, `{$: "./title"}` is relative to the current item.
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

- A surface's data has a monotonic `rev`. Every update names the rev it
  produces. A channel that sees a gap fetches the full data again.
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

| placement | max blocks per tree | max data size |
|---|---|---|
| `chat` | 200 | 256 KiB |
| `interaction`, `ambient` | 100 | 64 KiB |
| `view`, `panel`, `settings` | 2,000 | 4 MiB |

A collection counts as one block however many items it binds. Over a
limit, the server rejects the tree with `413 surface_too_large` naming
the limit.

## 5. The v1 block set

### 5.1 Shell

**`page`** (placements: `view`, `panel` without `sidebar`)

| prop | meaning |
|---|---|
| `title`, `subtitle?` | header text (bindable) |
| `switcher?` | a `choice` field in the header; selecting navigates |
| `actions?` | header buttons: `{id, label, icon?, action}` |
| `sidebar?` | blocks for the list column |
| `main` | blocks for the body |
| `detail?` | blocks for a side pane, shown when non-empty |
| `empty?` | `{icon, title, hint}`, shown in `main` when `main` binds to nothing |

The host draws the header, the columns, the empty state and their narrow
fallbacks. The extension never positions them.

### 5.2 Layout

| block | props | notes |
|---|---|---|
| `stack` | `children`, `gap?: s/m/l` | every slot is implicitly a stack; explicit only where a slot takes one block |
| `columns` | `children: {weight?, minWidth?: s/m/l, block}[]` | stacks when the minimums don't fit |
| `grid` | `minItemWidth: s/m/l`, `children` with `span?: 1/2/"full"` | as many columns as fit; `span` is capped at the columns available |
| `section` | `title?`, `subtitle?`, `tone?`, `collapsible?`, `collapsed?`, `actions?`, `children` | also groups fields inside a `form` |

Width tokens `s`/`m`/`l` are host-defined (the webui maps them to
16/24/32 rem, the TUI to 30/45/60 cells).

### 5.3 Content

| block | props |
|---|---|
| `markdown` | `text`. The same renderer as chat (tables, code, links). Raw HTML is escaped. |
| `fields` | `rows: {label, value, tone?, icon?, copy?: boolean}[]` (label/value pairs) |
| `stat` | `label`, `value`, `unit?`, `format?`, `delta?`, `tone?`, `icon?`, `size?: s/m/l`, `caption?`, `sparkline?: number[]` |
| `callout` | `tone`, `title`, `body?` (markdown), `actions?` |
| `image` | `src` (§11), `alt` (required), `fit?: contain/cover`, `aspect?` |
| `chart` | §5.4 |
| `meter` | `value`, `min?` (0), `max?` (1), `label?`, `format?`, `thresholds?: {at, tone}[]` |
| `log` | `lines` (binding to `{at?, level?, text}[]`), `follow?`, `wrap?`, `maxLines?` |
| `tree` | `nodes` (binding to `{id, label, icon?, hasChildren?, children?}[]`), `expand` action for lazy children, `itemAction?` |
| `diff` | `before`, `after`, `path?`, `lang?` (the existing interaction primitive) |
| `details` | `value` (opaque JSON; shown collapsed and pretty-printed) |

**Formats** (`format` on `stat`, `meter`, table columns, chart axes):
`number`, `compact` (2.5k), `percent`, `currency:<ISO 4217>`, `bytes`,
`duration` (ms in, "3h 12m" out), `datetime`, `date`, `time`,
`relative` ("5 min ago"). Hosts format with the user's locale.

### 5.4 `chart`

| prop | meaning |
|---|---|
| `title?` | |
| `x` | `{kind: "time" \| "category" \| "number", format?, label?}` |
| `y?` | `{format?, unit?, label?, min?, max?}` |
| `series` | `{name, kind: "line" \| "area" \| "bar", data: binding \| [x, y][], tone?}[]` |
| `stacked?` | stack `area` and `bar` series |
| `thresholds?` | `{at, tone, label?}[]` drawn as horizontal rules |

- Series kinds can be mixed in one chart (line over bars). One y-axis.
- Data points per series: at most 2,000. The host downsamples for
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
| `sort?`, `filter?` | initial sort and filter (users can change them; view-only) |
| `select?` | `single` \| `multi` |
| `bulkActions?` | actions offered when multi-select has a selection |
| `checkable?` | item field holding a boolean; toggling is an edit action |
| `reorder?` | `{within?: boolean, across?: boolean}` (and time moves for `calendar`) |
| `children?` | item field holding nested items (indented in `list`) |
| `numbered?` | `list` only |
| `itemAction?` | action when an item is activated |
| `columns?` | `table` only: `{field, label, format?, sortable?, priority?: "high" \| "low", width?}[]` |
| `time?` | `calendar` only: `{start, end?, allDay?}` item fields, `range: month \| week \| day \| agenda`, `resize?`, `createByDrag?` |
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
| `meta` | inline facts: `{icon?, text}` or `{person: user}` or `{time, format}` |
| `metrics` | `{label, value, format?}[]` |
| `tone` | accent stripe / TUI marker |
| `actions` | up to 3 buttons, then an overflow menu |

Every slot except `title` is optional; each takes a binding relative to
the item.

### 5.6 `form` and fields

**`form`**

| prop | meaning |
|---|---|
| `bind` | path of the object the fields read and write |
| `mode` | `submit` (a Save/Send button), `live` (every change is applied after 300 ms; for filters), `inline` (one row, field plus button; for quick-add) |
| `submit?` | the submit action (§6) and its `label` |
| `children` | fields and `section`s grouping them |

**`choice` options for interactions:** `preview` is markdown shown
beside the options while one is focused (the webui shows it
side by side when there's room, the TUI below the list); `allowOther`
adds a free-text answer row whose value is returned as `{other: text}`.

**Field props, shared by all field types:** `name`, `label`, `help?`,
`placeholder?`, `required?`, `disabled?`, `apply?` (§13; settings only),
validation (`min`, `max`, `minLength`, `maxLength`, `pattern`), and a
server error the host shows under the field.

| field | extra props |
|---|---|
| `text` | `kind?: plain \| search \| email \| url`, `suggest?` (binding to strings) |
| `longtext` | `syntax?: plain \| markdown \| code`, `lang?`, `rows?` |
| `number` | `step?`, `format?` |
| `toggle` | |
| `choice` | `options` (literal or binding): `{id, label, description?, tone?, recommended?, preview?}[]`, `multi?`, `allowOther?: {label?}`, `display?: auto \| radio \| select \| chips` |
| `date`, `datetime` | `min?`, `max?` |
| `daterange` | `presets?: {id, label, duration}[]` |
| `secret` | write-only; the host shows `set (stored)` / `set (env)` / `not set` from a bound status |
| `file` | `accept?` (MIME patterns), `maxBytes?`, `multi?`; uploads through the surface's upload route (§7.2) |
| `list` | `item`: fields for one entry; `reorder?`, `min?`, `max?` (a repeatable group) |

### 5.7 Allowed blocks per placement

| block | view | panel | settings | chat | interaction | ambient |
|---|---|---|---|---|---|---|
| `page` | root, required | root, no `sidebar` | — | — | — | — |
| layout blocks | ✓ | ✓ | `section` only | ✓ | `stack`, `section` | `stack`, `columns` |
| `markdown`, `fields`, `callout`, `diff`, `details` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `stat`, `meter`, `log` | ✓ | ✓ | — | ✓ | — | ✓ |
| `chart`, `image`, `tree` | ✓ | ✓ | — | ✓ | `image` | — |
| `collection` | ✓ | ✓ | `list`, `table` | ✓ | `list` | `list` |
| `form` | ✓ | ✓ | root, required | ✓ | root, required | — |

Validation rejects a tree that uses a block its placement doesn't allow.

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

- `name` is the handler name the extension registered (§7.1). The host
  sends `{action: name, payload, actionId}`.
- `actionId` is a client-generated UUID. Handlers are invoked at most
  once per `actionId` (the host keeps a 10-minute dedup window per
  surface), so retries are safe.

### 6.2 Three kinds (ruling 14)

| kind | examples | where it goes | starts a turn |
|---|---|---|---|
| **view-only** | sort, filter, page, expand/collapse, select, copy, lane switch, `form(mode: live)` over view-only state, `navigate(params)` | nowhere: the host applies it to the surface's view state | never |
| **edit** | `move`, `edit` (checkbox, inline field), `submit` with `turn: false` | the placement's handler (§6.4); the change is saved | only with `turn: true` |
| **answer** | `submit` (default `turn: true`), any action with `turn: true` | the placement's handler, then a turn | yes |

- A `form(mode: live)` is view-only when its `bind` path is under
  `/view/` (the surface's view-state branch, which the host owns and
  never sends to the handler). A live form bound elsewhere is an edit.
  This is how a filter over agent-generated data stays local.
- `navigate` with `params` re-renders the surface with new params; with
  `target` it leaves the surface.

### 6.3 Optimistic moves (ruling 11)

1. The host applies the move to its copy of the data at once.
2. It sends `{action, payload: {itemId, from: {group?, index}, to: {group?,
   index?, start?, end?}}, actionId, rev}`.
3. The handler accepts or rejects:
   - **accept** → it returns (or publishes) a `DataUpdate`. That update
     is authoritative: it replaces the host's optimistic state, for this
     client and every other viewer.
   - **reject** → `{error: {message}}`. The host reverts and shows the
     message as a toast.
4. A handler that hasn't answered in 10 s counts as a reject.

Concurrent moves need no locking: each is applied in arrival order by
the handler, and the data updates converge every viewer.

### 6.4 Routing per placement

| placement | handler | how a turn starts |
|---|---|---|
| `view`, `panel` | the extension's action handler (§7.1) | the handler calls `host.conversations.submit(...)` (W5) if it wants one; `turn` flags are not used |
| `settings` | core: validate, store, publish `settings.changed` (§13) | never |
| `chat` | core: §8 | the core submits for the user (§8.4) |
| `interaction` | core answer route; the extension sees the answer as today | the existing interaction semantics |
| `ambient` | the extension's ambient action handler | as for `view` |

### 6.5 Access

- Every surface render and every action carries the principal (W1).
- Extension surfaces: the extension's `render` and handlers receive the
  principal and do their own `accessOf` checks (core-hardening §5.9).
- The host also reads an `access: "read" | "write"` the render returns.
  With `read`, the host hides every edit and answer action and disables
  `reorder`, `checkable`, inputs and bulk actions. The extension doesn't
  build a second tree for read-only users.
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
  refreshMs?: number;                        // the host refetches data on this interval while visible (min 5000)
  render(ctx: SurfaceContext): Promise<{ tree: Tree; data: JsonObject; access: "read" | "write" }>;
  data?(ctx: SurfaceContext): Promise<JsonObject>;   // data-only refetch; defaults to render().data
  actions?: Record<string, (ctx: SurfaceContext, payload: JsonValue) => Promise<ActionResult>>;
  uploads?: (ctx: SurfaceContext, file: UploadedFile) => Promise<ActionResult>;
}

interface SurfaceContext {
  principal: Principal;
  params: JsonObject;                        // from navigate(params); validated as JSON, size-capped at 4 KiB
  key: string;                               // stable instance key derived from params (§7.3)
  signal: AbortSignal;
}

type ActionResult =
  | { ok: true; update?: DataUpdate; navigate?: Action & { type: "navigate" }; toast?: string }
  | { ok: false; error: { message: string; field?: string } };
```

- Surfaces are validated at load. A malformed `surfaces` field
  quarantines the extension (the loader's existing fail-loud rule).
- The rail shows views in the user's saved order (a client preference,
  like hermes' tab order), after the core entries.

### 7.2 Routes

All under W5's extension prefix, with W1's auth pipeline:

| route | returns |
|---|---|
| `GET /v1/ext/<slug>/surfaces/<id>?params=<json>` | `{tree, data, rev, treeRev, access}` |
| `GET /v1/ext/<slug>/surfaces/<id>/data?params=<json>&since=<rev>` | `{rev, data}` or `{rev, ops}` when the server holds the ops since `since` |
| `POST /v1/ext/<slug>/surfaces/<id>/actions` | body `{action, payload, actionId, params, rev}` → `ActionResult` |
| `POST /v1/ext/<slug>/surfaces/<id>/uploads` | multipart, size-capped by the field's `maxBytes` (server max `server.maxUploadBytes`) → `ActionResult` |
| `GET /v1/ext/<slug>/assets/<path>` | static files from the package's declared `assets` dir (§11) |

A surface that throws in `render` or a handler returns `500
surface_failed`; the channel shows an error state with a retry button.
The extension stays loaded.

### 7.3 Live updates

- Extensions publish changes with `host.surfaces.changed(id, key, update?)`.
  `key` identifies the instance (a board id, a calendar id). The default
  key is the canonical JSON of `params`.
- The server sends `surface.changed {slug, id, key, rev, treeRev}` on
  `/v1/events` (W3) to every connected principal subscribed to that
  surface instance. **The event carries no data.**
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
- **`update_blocks {entryId, ops}`** applies `DataOp`s to one of the
  conversation's own block surfaces. It records no change note (the
  agent made the change), and is how an agent keeps a progress table or
  a live chart current.

The tool descriptions teach the action kinds in two sentences:
"Interactive elements save the user's edits silently; you'll receive a
summary of edits at your next turn. A `submit` sends you the result
immediately; set `turn: true` on a `move` or `edit` only if each one
needs an immediate reply."

### 8.2 Storage

- The surface is a typed pi-durable entry, kind `sigrun.blocks`:
  `{title, tree, data}` as created. It never changes.
- Its live state is a conversation-scoped document family,
  `sigrun.blocks.state`, keyed by entry id: `{rev, data, pending:
  ChangeRecord[]}`. Forks copy it, so a fork starts from the state at
  the fork point.
- `ChangeRecord = {at, by: user, action, summary, opsRev}`.

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
- **At the start of the agent's next turn** (whatever starts it), core
  appends one context entry for all surfaces with pending changes, then
  clears `pending`:

  > Changes the user made to your UI since your last turn:
  > • Ranking: moved 'Clair de Lune' 4th → 1st; moved 'Gymnopédie' 5th → 2nd.
  > Current state of Ranking: 1. Clair de Lune 2. Gymnopédie 3. …

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
- The message carries:
  - a text projection: "Submitted 'Ranking': 1. Clair de Lune 2. …";
  - a structured part `{blocksAnswer: {entryId, action, payload,
    state}}` for agents that read structure;
  - any pending changes for that surface, folded in rather than sent
    again in the next change note.
- The message is idempotent per `actionId`: `requestId =
  "blocks:" + actionId`.

### 8.5 Worked example: ranking songs

1. User: "help me pick the playlist order."
2. The agent calls `show_blocks` with a `collection(display: list,
   numbered: true, reorder: {within: true})` bound to `/songs`, and a
   `form` with one `submit` labelled "Use this order".
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
  | `answer {ids, values, text}` | the form's values: the `choice` field's value is `ids`, the other fields are `values`, a `longtext` named `text` is `text` |

- The envelope (`key`, `interactionKinds`, `expiresAt`, `answeredBy`,
  first-answer-wins) is unchanged. The answer route is unchanged.
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
    props added for it (§5.6);
  - pi-warden: an allow/deny `choice` with tones, a `longtext` reason,
    `markdown` for the matched rule and command, and its verdict stack
    as an ambient `collection` with severity tones.
- When an interaction form has more than one `section` holding a
  `choice`, channels may present the sections one at a time (a step
  through, with a review before submit). That's a host presentation of
  the same tree, not a new block.

### 9.2 Ambient surfaces

- Records gain `body: Tree` (placement `ambient`). The envelope
  (`key`, `place: status | panel`, `budget`, `expires`, `refresh`) is
  unchanged.

  | today | tree |
  |---|---|
  | `line {text}` / `segments[]` | one-line `markdown`; segments are a `columns` of one-line `markdown`s |
  | derived metrics with `format` | `stat` with `format` |
  | `rows[]` (status, severity, depth, deps, metrics) | `collection(display: list)` with `badges`, `tone`, `children`, `metrics` |
  | `gauge` | `meter`, plus `log` for `recentOutput` and a nested `collection` for `checks` |
  | `ledger[]` | `log` |
  | `details` | `details` |

- `place: status` allows one line: a single `markdown` or one `columns`
  of one-line blocks. Validation enforces it.
- No compatibility layer, as for interactions: records carry trees only.

## 10. Styling and icons

### 10.1 By meaning only

- Extensions never set colours, fonts, pixel sizes or spacing values.
  They set:
  - `tone`: `neutral`, `accent`, `good`, `warn`, `bad`, `info`;
  - `size`: `s`, `m`, `l` where a block offers it;
  - `emphasis`: `normal`, `strong`, `subtle` on text-bearing slots.
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
| `asset:<path>` | a file from the extension package's `assets` directory (declared in its package manifest `sigrun.assets`), served at `/v1/ext/<slug>/assets/<path>`; path traversal rejected |
| `data:image/png\|jpeg\|gif\|webp;base64,…` | up to 512 KiB, counted in the data limit |
| `https://…` | rewritten by the server to the proxy (§11.2) before the tree leaves the server |

SVG is never accepted (it can carry script). `http:` URLs are rejected.

### 11.2 The proxy (ruling 12)

- `GET /v1/image?u=<url>&s=<sig>`, authenticated like every route.
- `s` is an HMAC of the URL with a server key. The server signs only
  URLs that appear in a tree it is serving, so the proxy can't be used to
  fetch arbitrary URLs.
- Fetch rules:
  - https only;
  - DNS-resolve first and refuse loopback, private, link-local, CGNAT
    and unique-local ranges, re-checked on every redirect (max 3);
  - 10 s timeout, 10 MiB cap;
  - the response must sniff as PNG, JPEG, GIF, WebP or AVIF.
- Cache: under the data dir, keyed by URL hash, 256 MiB LRU,
  `max-age` clamped to between 1 hour and 7 days.
- Served same-origin with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'`.
- Failures render the block's `alt` text.

### 11.3 In the TUI (ruling 13)

- The TUI fetches the same URLs with the user's credentials and renders
  them with pi-tui's `Image` component (base64 data + MIME type) when
  `getCapabilities().images` is `"kitty"` or `"iterm2"`.
- Otherwise it shows `[image: <alt>]`.
- Images are sized to the block's width in cells and capped at 20 rows.
- Inside tmux, image passthrough depends on tmux's `allow-passthrough`.
  The TUI keeps pi-tui's detection; the test list (§16) covers tmux.
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

Any block may set `visibleAt: "atLeast:regular" | "atLeast:wide" |
"atMost:compact" | "atMost:regular"`. It is the only width-dependent
thing an extension can say. There are no per-width alternative layouts.

### 12.3 Host fallbacks

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
- Core keys keep their documented behaviour, and the plan audits
  `server.*`:
  - moved to `live`: `namingModel`, `providers.refreshIntervalMinutes`
    (the scheduler re-arms), `jobHistory.*` (already live);
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
  again: `server.supervised: true`, set by the Dockerfile
  (`SIGRUN_SUPERVISED=1`), the Helm chart and the compose file.
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

`sigrun/blocks` (a new package export, part of W5's contract surface)
exports typed builder functions for every block and field, plus the
types:

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
  the server log and, in development (`SIGRUN_DEV=1`), in the response.

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

- With `SIGRUN_DEV_GALLERY=1`, core adds a "Blocks" view to the rail: one
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
  raw HTML; links allow `https:`, `http:` and `mailto:` only.
- No block can carry script, style or HTML. SVG is never accepted.
- Trees are validated server-side before any channel sees them.
- `params` are size-capped (4 KiB) and passed to `render` as data; the
  extension validates them like any input.
- Actions are rate-limited per principal per surface (20 per second,
  burst 40) → `429`.
- Access: §6.5. The read-only rendering is enforced by the server too:
  actions on a surface whose last render returned `access: "read"` are
  rejected with `403` before the handler runs.
- Image proxy: §11.2. The HMAC signature prevents use as an open proxy;
  the range checks prevent SSRF into the cluster or LAN.
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
- **Events:** `surface.changed` carries no data; a principal without
  access gets no event and a 404 on fetch; `sharedData: false` surfaces
  never return ops.
- **Moves:** optimistic apply, accept (authoritative update reaches a
  second client), reject (revert + toast), timeout (revert), and two
  clients moving concurrently converge.
- **Read-only:** the host hides edit actions; a forged action returns
  403.
- **Chat blocks:**
  - `show_blocks` validation errors name paths;
  - the ranking example (§8.5) end to end with the faux provider: three
    moves make no turns, the next user message's turn has one change
    note with the current order, "Use this order" makes exactly one
    turn, and a double click makes one turn (`actionId`);
  - change notes are appended after earlier entries (the earlier prompt
    bytes are unchanged);
  - a fork copies the state.
- **Interactions and ambient:** a legacy-shaped record fails
  validation; the rewritten seam fixtures render in both channels;
  answers keep their `{ids, values, text}` shape; a four-question
  ask-user-question tree (with `preview` and `allowOther`) answers in
  one submit.
- **Settings:** a live key applies without restart and fires
  `onSettingsChanged`; a restart key shows in `pendingRestart`; restart
  is hidden when unsupervised; `POST /v1/admin/restart` is admin-only.
- **Images:** proxy refuses unsigned URLs, private ranges (including via
  redirect), non-images and SVG; caches; TUI renders inline with a
  faked Kitty capability and alt text without; tmux passthrough checked
  by hand.
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
| U0 | `shared/src/blocks/`: schemas, `validateTree`, placements, limits, `DataOp` apply, `toText`, the `sigrun/blocks` builders | — |
| U1 | webui renderer for every block, display, field and width fallback; the gallery view | U0 |
| U2 | TUI renderer for the same, keymap bindings, inline images | U0 |
| U3 | extension surfaces: contract field, routes, `surface.changed`, data fetch with `since`, actions, uploads, assets, rail and panel registration | U0 |
| U4 | settings: `apply`, `settings.changed`, `onSettingsChanged`, `pendingRestart`, restart route, supervised detection, core sections rebuilt, extension sections | U0, U1, U2, U3 |
| U5 | chat: `show_blocks`, `update_blocks`, `sigrun.blocks` entries and state, edits, change notes, answers | U0, U1, U2 |
| U6 | interactions and ambient on trees: record schemas carry trees only, channel renderers switched to trees, core seam fixtures rewritten | U1, U2 |
| U7 | image proxy, icon set, docs | U0 (U1/U2 consume the icons) |

U1 and U2 can run in parallel; so can U3, U5 and U7 once U0 lands.

## 19. Open questions

None. Rulings 1–16 settle the design questions raised so far.
