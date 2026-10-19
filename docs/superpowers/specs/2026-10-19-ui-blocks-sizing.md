# UI blocks: evidence-sizing pass

Status: input to the UI-blocks spec. Date: 2026-10-19.

## Purpose

Size the first block set by evidence, the way the interaction
primitives were sized (`docs/approval-ux-seams.md`). Every use case
below is written out as blocks on paper. A block survives only if a case
needs it. Anything nothing needs is cut; blocks are added later when a
real extension outgrows the set.

Rulings already made (2026-10-19 conversation):

1. Option A: the server describes UI from a closed block set; every
   channel (webui, TUI) renders the set natively. No per-extension
   channel code. The TUI is full-featured, not a fallback.
2. No iframes at the view level. A block-level `embed` stays possible
   later (reserved, web-only, mandatory fallback); it is not built.
3. Layout and data travel separately: a view sends its block tree once;
   blocks bind to paths in a data model; updates carry data only.
4. Chat, views, interactions and ambient surfaces share one block set.
   Interaction and ambient formats become subsets of it.
5. Settings are in scope, including extension-declared sections, each
   field marked `apply: "live" | "restart"`, with an admin Restart button
   for the restart-only ones.
6. Drag and drop within and across groups is a general capability, not
   a kanban feature.
7. Blocks adapt to their *container* width, not the viewport. Hosts own
   the narrow-width fallbacks; extensions get three width classes
   (`compact`, `regular`, `wide`) as the only escape hatch.
8. No kanban (or any one domain's) vocabulary in block names.

## Sources

- Prior art: Slack Block Kit (blocks, elements, data table, data
  visualization, container, card), Home Assistant dashboards (views,
  sections, cards, actions, custom cards), WordPress block API
  (`block.json`, core blocks, Interactivity API), Adaptive Cards (host
  config, `Action.Execute`, `Layout.Flow`/`AreaGrid`, `targetWidth`),
  Google A2UI (protocol v0.8, component catalog). Fetched copies:
  `/tmp/blocks-research/` (not committed).
- hermes-webui (`~/repos/hermes-webui` @ `77c8fc17`):
  `static/index.html` (rail, panel views, main views) and
  `static/panels.js` (detail renderers, kanban cards, insights cards,
  plugin pages).
- sigrun's existing seams: interaction records and ambient surfaces
  (`docs/approval-ux-seams.md`, `shared/src/interactions.ts`,
  `shared/src/ambient.ts`).

## Notation

```
block(prop: value, ...) { children }
$path            a binding into the view's data model
@action(payload) an action sent to the extension
~compact: ...    what the host does when the container is compact
```

Candidate block names are used freely in the sketches; the tally at the
end decides which survive and what they are finally called.

## The shared shell (every hermes view uses it)

hermes renders every non-chat view the same way:

- a **sidebar** column: header (title + icon buttons), optional filter
  stack (search box, selects, checkboxes), then a list;
- a **main** area: header (title, optional subtitle or switcher, icon
  actions), body, and an **empty state** (icon, title, hint) shown when
  nothing is selected.

So the shell is one host-owned block:

```
page(title, subtitle?, switcher?, actions[]) {
  sidebar?: { filters?, collection }     // the list column
  main:     blocks                       // the body
  detail?:  blocks                       // optional side pane
  empty?:   empty(icon, title, hint)     // when nothing is selected
}
~compact: sidebar → drawer; detail → pushed page with a back button
```

The selected item is `params`: selecting a sidebar row is
`@navigate({id})`, which re-renders `main` for that id. Deep links and
the browser back button come free from `params`.

## Part 1: the hermes-webui views

The ten non-chat rail views. Chat is core and is covered in Part 3 as
"agent replies".

### H1. Tasks (scheduled jobs)

hermes: job list; detail = a card of label/value rows (schedule, next,
last, model, profile, skills, notifications badge), an attention alert
with actions (resume, run once, copy diagnostics), runs.

```
page(title: "Scheduled jobs", actions: [@refresh, @create]) {
  sidebar: collection(display: list, items: $jobs,
             item: card(title: .name, subtitle: .schedule,
                        badges: [.state(tone)]),
             select: single → @navigate({id}))
  main:
    callout(tone: warn, title, body, when: $job.attention,
            actions: [@resume, @runOnce, copy($job.diagnostics)])
    section("Details") { fields(rows: $job.fields) }
    section("Runs") {
      table(rows: $runs, columns: [when, version, outcome(badge), error],
            rowAction: @navigate({conversation}))
    }
  empty: empty(icon: clock, "Select a scheduled job", hint)
}
```

Uses: page, collection(list), card, badge, callout, section, fields,
table. Host-side: `copy` (clipboard; needs no server round trip).

### H2. Kanban

hermes: sidebar = search, assignee and tenant selects, "include
archived"/"only mine" checkboxes, stats, bulk bar (status select + bulk
action + run dispatcher), quick-add row, task list. Main = board
switcher, actions (new board, view toggle, preview/run dispatcher),
columns of draggable cards (id, title, assignee, age, metrics, stale
highlight, card actions), task preview pane.

```
page(title: "Board", switcher: choice($boards) → @navigate({board}),
     actions: [@newBoard, @newItem, view: choice(board|list)]) {
  sidebar:
    form(live: true, bind: $filter) {
      text(name: q, kind: search)
      choice(name: assignee, options: $people)
      toggle(name: archived), toggle(name: mine)
    }
    stat-row($stats)
  main:
    collection(items: $items, groupBy: .status, groups: $lanes,
               display: $view == "board" ? lanes : list,
               item: card(eyebrow: .id, title: .title,
                          meta: [.assignee(avatar), .age],
                          metrics: .metrics, tone: .staleness,
                          actions: [@open, @archive]),
               select: multi, bulkActions: [@setStatus(choice), @archive],
               reorder: {within: true, across: true} → @move,
               itemAction: @navigate({item}))
    composer(placeholder: "New item", submit: @create)   // quick add
  detail: (when $params.item) fields + markdown + form
}
~compact: lanes → one lane at a time with a lane switcher; across-lane
          moves become a "Move to…" menu; drag still reorders in a lane
```

Uses: page(switcher), form(live), text, choice, toggle, stat, collection
(lanes, list, multi-select, bulk, reorder), card(eyebrow, meta, metrics,
tone, actions), detail pane, a one-line quick-add input.

Observation: "quick add" is a one-field form with an inline submit, not
a new block. `form(inline: true)`.

### H3. Skills

hermes: searchable list; detail = frontmatter metadata, the skill body
as markdown, linked files; editor mode.

```
page(title: "Skills", actions: [@create]) {
  sidebar: form(live, bind: $filter) { text(q, kind: search) }
           collection(display: list, items: $skills, select: single)
  main(mode: view):
    fields($skill.meta)
    markdown($skill.body)
    section("Linked files") { collection(display: list,
             items: $skill.files, itemAction: @navigate({file})) }
  main(mode: edit):
    form(submit: @save) { longtext(name: body, syntax: markdown) }
}
```

Uses: collection(list), fields, markdown, section, form,
longtext(markdown). New need: a **long-text field with syntax**.

### H4. Memory

hermes: side menu of memory sections; detail = mtime, markdown preview,
edit form with notes field.

Same shape as H3: collection(list) → fields(mtime) + markdown + form
(longtext). No new blocks.

### H5. Spaces (workspaces)

hermes: list + "add space"; detail = a card of rows, badges (active,
default), checkpoints; files.

```
main:
  fields($space.fields), badges
  section("Files") { tree(nodes: $files, lazy: @expand({path}),
                          itemAction: @navigate({file})) }
  section("Checkpoints") { table(...) }
```

New need: **tree** (a lazily expanded hierarchy). Second user: sigrun's
own workspace panel already shows a file tree.

### H6. Profiles

hermes: list; detail = rows (model, keys configured badge, gateway
running/stopped badge), form to edit.

collection(list) → fields + badge + form. No new blocks.

### H7. Todos

hermes: the current task list for the conversation.

collection(display: list, item: card(title, status(badge))) with
optional `checkable` → @toggle. This is the ambient `rows` primitive
(status, depth, deps) as a collection. No new blocks.

### H8. Insights

hermes: period select + custom date range; cards: stat grids (totals),
tables (models: sessions, tokens, cache, cost, share; skill usage),
daily-token bar chart, activity-by-day bars, system-health panel,
collapsible model-health table.

```
page(title: "Usage analytics") {
  sidebar: form(live, bind: $range) {
    choice(period: 7|30|90|365|custom), daterange(when: custom) }
  main: grid(min: m) {
    stat($totals.tokens, format: compact), stat($totals.cost, currency) …
    section("Daily tokens", span: full) {
      chart(kind: bar, x: time(day), series: $daily) }
    section("Models", span: 2) { table($models, sort, columns:
      [name, sessions(num), tokens(num, compact), cache(pct),
       cost(currency), share(bar)]) }
    section("Activity by day") { chart(kind: bar, x: category, …) }
    section("Model health", collapsed: true) { table(...) }
  }
}
```

Uses: form(live), choice, daterange, grid, stat, chart(bar, time and
category axes), table (sortable, numeric formats, an inline bar cell),
section(collapsible).

### H9. Logs

hermes: file select, tail length, severity filter, auto-refresh toggle,
wrap toggle, copy all; monospace output with severity colour.

```
page(title: "Logs", actions: [copy($lines)]) {
  sidebar: form(live, bind: $opts) {
    choice(file), choice(tail), choice(severity),
    toggle(follow), toggle(wrap) }
  main: log(lines: $lines, follow: $opts.follow, wrap: $opts.wrap,
            line: {at, level(tone), text})
}
```

New need: **log**, an append-only, tail-following monospace stream with
per-line level. Second and third users: the ambient `ledger` primitive,
and pi-fabric's live-tail pane (the one gap the ambient survey found).

### H10. Settings

hermes: searchable menu of sections (conversation, appearance,
preferences, providers, plugins, extensions, system, help); each pane is
forms. Extension settings support boolean, string, number, integer,
enum.

Covered under S2 below (sigrun's settings, which subsume these).

### Not rebuilt: hermes plugin pages

hermes shows plugin pages as a sandboxed iframe filling the main view.
That is the view-level option C that ruling 2 rejects. No block.

## Part 2: sigrun's target use cases

### S1. Kanban (the sigrun extension)

H2's sketch, plus what sigrun adds:

- boards carry `owner` + `sharing` (spec §5.9); the switcher groups
  "mine" and "shared with me"; a share action opens the same share menu
  conversations use (a form: scope choice + people multi-choice + level);
- a card can link to a conversation (`@navigate` to a core route, not an
  extension route): `link(target: conversation(id))`;
- read-only access renders the same tree with `reorder` off and actions
  hidden. The host does this from `access` on the view; the extension
  doesn't build a second tree.

New need: **core navigation targets** (conversation, job, settings
section, another view) as a closed set of link targets.

### S2. Settings (core + extension sections)

Sections: core (general, interface, providers + credentials, users and
invites [admin], jobs history, backup), one section per extension that
declares settings, and the extension secrets list.

```
page(title: "Settings") {
  sidebar: form(live) { text(q, kind: search) }       // searches labels
           collection(display: list, items: $sections, select: single)
  main: form(bind: $values, submit: @save, apply: per-field) {
    group("Model") {
      choice(name: defaultModel, options: $models, apply: live)
      choice(name: thinking, options: [...], apply: live)
    }
    group("Server") {
      text(name: host, apply: restart), number(name: port, apply: restart)
    }
    group("Secrets") {
      secret(name: apiKey, source: $secretSource)  // write-only
    }
  }
  callout(tone: info, when: $pendingRestart,
          title: "Restart required", body: $pendingKeys,
          actions: [@restart(admin)])
}
```

- every field: `name`, `label`, `help`, `required`, `apply`, validation
  (`min`/`max`/`pattern`/`options`), and a server-side field error;
- a "restart required" marker on fields with a saved-but-not-applied
  value;
- `secret`: write-only; shows "set (stored)" / "set (env)" / "not set";
- `list` field (repeatable group): provider base-URL overrides, model
  allowlists, invite emails;
- search across sections needs the labels of every section's fields,
  so section *definitions* (the form tree) are static and searchable,
  while values come through data. That falls out of ruling 3.

Uses: page, collection(list), form, group, text, number, toggle, choice,
secret, list field, callout. New need: **field metadata** (`apply`,
validation, help) and the **list field**.

### S3. Calendar (personal and shared)

```
page(title: "Calendar", switcher: choice($calendars, multi: true),
     actions: [@create, range: choice(month|week|day|agenda), today]) {
  main: collection(items: $events, display: calendar,
          time: {start: .start, end: .end, allDay: .allDay},
          range: $params.range, tone: .calendar.color,
          item: card(title, subtitle: .location, badges: [.who]),
          reorder: {time: true} → @move({id, start, end}),
          resize: true → @move({id, end}),
          create: {byDrag: true} → @create({start, end}),
          itemAction: @navigate({event}))
  detail: form(@save) { text(title), datetime(start), datetime(end),
          toggle(allDay), choice(calendar), longtext(notes),
          choice(attendees, multi) }
}
~compact: month/week → agenda list grouped by day; drag-to-reschedule
          becomes editing start/end in the detail form
```

Sharing: calendars are owned resources (§5.9), like boards.

Observation: moving an event in time is the same **move** action as a
lane move, with a time target instead of a group target. One move
primitive with a typed destination: `{group?, index?, start?, end?}`.
Resizing (end time) and drag-to-create are calendar-only; they ride on
the `calendar` display, not new blocks.

### S4. Weather

```
page(title: $place.name, switcher: choice($places)) {
  main:
    columns {
      stat(value: $now.temp, unit: °C, icon: $now.condition, size: l,
           caption: $now.summary)
      fields($now.details)      // feels like, wind, humidity, UV
    }
    collection(display: strip, items: $hourly,          // horizontal
               item: card(eyebrow: .hour, icon: .condition,
                          title: .temp, meta: [.precip]))
    chart(kind: line+bar, x: time(hour),
          series: [temp(line), precipitation(bar, axis: right)])
    collection(display: list, items: $daily, item: card(...))
    callout(tone: bad, when: $alerts, ...)
    embed(kind: radar, fallback: image($radarStill))   // reserved
}
```

New needs: a **horizontal strip** display for collections; **mixed
chart series** (line and bar, two y-axes); weather **icons** (a named
icon set needs weather glyphs). The radar is the one place an `embed`
earns its keep; until it exists, the fallback image is the radar.

### S5. Shopping list

```
page(title: $list.name, switcher: choice($lists),
     actions: [@share, @clearChecked]) {
  main:
    form(inline, submit: @add) { text(item, suggest: $history) }
    collection(items: $items, groupBy: .aisle, display: list,
               item: card(title, meta: [.qty]),
               checkable: .done → @toggle({id}),
               reorder: {within: true, across: true} → @move,
               swipe/ menu actions: [@delete, @edit])
}
```

Two people can edit one list at once, so data updates must arrive live
(ruling 3) and moves must be idempotent.

New need: **suggestions** on a text input (typeahead from a data path).
Otherwise only existing blocks: collection(list, groups, checkable,
reorder).

### S6. Recipes

```
page(title: "Recipes", actions: [@import(url), @create]) {
  sidebar: form(live) { text(q, kind: search), choice(tags, multi) }
  main: collection(display: grid, items: $recipes,
          item: card(image: .photo, title, meta: [.time, .serves],
                     badges: .tags), itemAction: @navigate({recipe}))
}
// recipe page (params.recipe)
page(title: $r.name, actions: [@edit, @addToShoppingList, @cook]) {
  main: columns {
    stack { image($r.photo), fields($r.meta),
            number(name: serves, bind: $scale, live) }  // rescales
    stack {
      section("Ingredients") { collection(display: list,
                 items: $r.ingredients, checkable) }
      section("Steps") { collection(display: list, numbered: true,
                 items: $r.steps, item: card(body: markdown)) }
    }
  }
}
// edit
form(@save) { text(name), image upload(photo), number(serves),
  list(ingredients) { number(qty), choice(unit), text(item) }
  list(steps, reorder) { longtext(text) } }
```

New needs: **image upload** field; the **list field with reorder**
(ingredients, steps); a numbered list display. "Add to shopping list" is
an action whose handler writes to another extension's data; that is an
extension-to-extension question, not a block question.

### S7. Dashboards (Prometheus/Grafana-style)

```
page(title: $dash.name, switcher: choice($dashboards),
     actions: [range: daterange(presets: 1h|6h|24h|7d), refresh: choice]) {
  main: grid(min: m) {
    stat($up, tone: threshold, sparkline: $upSeries)
    chart(kind: line, x: time, series: $cpu, unit: %, span: 2,
          thresholds: [{at: 80, tone: warn}, {at: 95, tone: bad}])
    chart(kind: area, stacked: true, x: time, series: $mem, unit: bytes)
    chart(kind: bar, x: category, series: $errorsByService)
    gauge($disk, unit: %, thresholds)
    table($alerts, columns: [name, severity(badge), since(relative)])
  }
}
```

- Data: series bound to `$cpu` etc., pushed as data-only updates on the
  refresh interval (ruling 3); a 15 s refresh never re-sends layout;
- time range and refresh live in `params`, so a dashboard URL is
  shareable.

New needs: chart `stacked`, `thresholds`, `unit` with formats (bytes,
%, durations), a `sparkline` on `stat`, and `gauge`. Heatmaps and
scatter plots: no case needs them yet, so cut.

## Part 3: the existing seams and chat (ruling 4)

### C1. Agent replies in chat

Things a model would reasonably show instead of prose:

- "how's the cluster?" → stats + a line chart + an alerts table (the S7
  blocks, inline);
- "plan my week" → a checkable list;
- "compare these three options" → a table;
- "here's the change I made" → a diff.

```
entry(kind: blocks) { stat…, chart(kind: line, x: time, series: $s),
                      collection(display: table, items: $rows) }
~compact: the chat column is a narrow container; every block applies its
          compact fallback there even on a widescreen monitor
```

Chat blocks need no new block types. They raise two design questions
(listed at the end): how the model emits a tree, and where actions on a
chat block go.

### C2. Interaction records (today: text, options, fields, diff, details)

| today | as blocks |
|---|---|
| `text` | `markdown` |
| `options[] {id, label, description, tone, recommended, multi}` | `choice` field (single/multi; `recommended` and `tone` become option props) |
| `fields[] {name, type: string/number/boolean/secret, label, required}` | `text`, `number`, `toggle`, `secret` fields |
| `diff {before, after, path, lang}` | `diff` |
| `details` (opaque JSON) | `details` |
| `answer {ids, values, text}` | the form's submit action payload |

An interaction is a `form` whose submit is the answer route, restricted
to that subset. Nothing new; the subset becomes "the blocks allowed in
the `interaction` placement."

### C3. Ambient surfaces (today: line+segments, derived metrics, rows, gauge, ledger, details)

| today | as blocks |
|---|---|
| `line {text}`, `segments[] {id, text, place: left/middle/right}` | `markdown` (one line) in the `status` placement; segments are a `columns` of one-line texts |
| derived metrics with `format` hints | `stat` with `format` (the same formats S7 needs: compact, currency, bytes, %, duration) |
| `rows[] {id, label, status, severity, depth, deps, metrics}` | `collection(display: list)` with item `badges` (status), `tone` (severity), nesting (depth/deps), `metrics` |
| `gauge {label, percent, phase, elapsed, recentOutput, checks}` | `meter` + `log` (recentOutput) + a nested collection (checks) |
| `ledger[] {at, kind, summary, detail}` | `log` |
| `details` | `details` |

Again nothing new. Two consequences:

- the dashboard `gauge` (S7) and the ambient `gauge` (progress) are the
  same block, a **meter** (value within min/max, optional thresholds and
  label; a bar in the TUI, a bar or ring on the web);
- **nesting** in lists (depth/deps) is needed by ambient rows and todos
  (H7). It's a collection prop (`children`), not a tree block; the tree
  block (H5) is for lazily loaded hierarchies.

## Tally

Rule: a block survives if two or more cases need it, or one case needs
it and the user named that case as a requirement. Variants that are
props of a surviving block cost little and are listed with it.

### Layout

| block | used by | verdict |
|---|---|---|
| `page` (shell: title, subtitle, switcher, actions, sidebar, main, detail, empty) | H1–H9, S1–S7 | **keep** (host-owned) |
| `stack` | S6, nested slots | **keep** (every slot is implicitly a stack; explicit only inside `columns`) |
| `columns` (weight, minWidth) | S4, S6, C3 (segments) | **keep** |
| `grid` (min item width, span) | H8, S7 | **keep** |
| `section` (title, collapsible, collapsed, tone) | H1, H3, H5, H8, S2 (form groups), S6 | **keep**; also serves as the form field group |
| `tabs` | none (hermes uses menus; view/edit is a mode param) | **cut** |
| `divider` | none (sections separate) | **cut** |

### Content

| block | used by | verdict |
|---|---|---|
| `markdown` | H3, H4, S2, S6, C1, C2, C3 | **keep** |
| `fields` (label/value rows) | H1, H3, H4, H5, H6, S4 | **keep** |
| `stat` (value, unit, format, delta, tone, icon, sparkline) | H2, H8, S4, S7, C1, C3 | **keep**; `sparkline` costs nothing extra because charts already fall back to it |
| `callout` (tone, title, body, actions) | H1, S2, S4 | **keep** |
| `image` | S4, S6, card images | **keep** |
| `chart` | H8, S4, S7, C1 | **keep**: `line`, `area`, `bar`; `stacked`; per-series kind (line+bar); time, category and numeric axes; `unit`/`format`; `thresholds` |
| chart `pie`, `scatter`, `heatmap`, dual y-axis | none (dual axis: S4 only, two charts work) | **cut** |
| `meter` (value, min, max, label, thresholds) | H8 (share bar), S7 (gauge), C3 (progress) | **keep**; merges dashboard gauge and ambient gauge |
| `log` (append-only lines: at, level, text; follow, wrap) | H9, C3 (ledger), pi-fabric live tail | **keep** |
| `tree` (lazy hierarchy) | H5, sigrun's workspace file panel | **keep** |
| `diff` | C1, C2 | **keep** (exists) |
| `details` (opaque JSON) | C2, C3 | **keep** (exists) |
| `embed` | S4 (radar) | **reserved, not built** (ruling 2) |
| icons | properties of card, stat, empty, page actions (named set incl. weather glyphs) | a **property type**, not a block |

### `collection`, the general-purpose item block

| feature | used by | verdict |
|---|---|---|
| display `list` | H1, H2, H3, H4, H5, H6, H7, S2, S5, S6, C3 | **keep** |
| display `table` (columns: type, format, sort, priority) | H1, H5, H8, S7, C1 | **keep**; replaces a separate table block, so tables get select, bulk and reorder for free |
| display `lanes` | H2, S1 | **keep** |
| display `grid` (incl. `overflow: scroll` for a strip) | S6, S4 (hourly) | **keep** (same renderer as the `grid` layout) |
| display `calendar` (month, week, day, agenda) | S3 | **keep** (user-named requirement) |
| `groupBy` + ordered `groups` | H2, S1, S5 | **keep** |
| `select` (single, multi) + `bulkActions` | H2, S1, S5 | **keep** |
| `checkable` | H7, S5, S6 | **keep** |
| `reorder {within, across}` / time moves | H2, S1, S3, S5 | **keep**: one `move` action with destination `{group?, index?, start?, end?}` |
| calendar `resize`, drag-to-create | S3 | **keep** as calendar-display props |
| nesting (`children`, depth) | H7, C3 | **keep** |
| `numbered` | S6 | **keep** (list prop) |
| item template = `card` slots: eyebrow, title, subtitle, body (markdown), image, icon, badges, meta (inline facts incl. person/time), metrics, tone, actions | all collection users | **keep** as fixed slots |

### Inputs (`form` and its fields)

| item | used by | verdict |
|---|---|---|
| `form` (submit / `live` / `inline`) | H2, H3, H4, H6, H8, H9, S1, S2, S3, S5, S6, S7, C2 | **keep** |
| field metadata: label, help, required, validation, server error, `apply: live/restart` | S2, C2 | **keep** |
| `text` (+ `kind: search`, `suggest: $path`) | H2, H3, S2, S3, S5, S6 | **keep** |
| `longtext` (`syntax: plain/markdown/code`) | H3, H4, S3, S6 | **keep** |
| `number` | S2, S6 | **keep** |
| `toggle` | H2, H9, S2, S3, C2 | **keep** |
| `choice` (single/multi, options or `$path`, recommended, tone) | H2, H8, H9, S1, S2, S3, S6, C2 | **keep** |
| `date`, `datetime` | S3 | **keep** (needed by calendar, and by job schedules) |
| `daterange` (with presets) | H8, S7 | **keep** |
| `secret` (write-only, shows source) | S2, C2 | **keep** |
| `file` (accept: image/*, …) | S6, plus the chat composer's existing upload path | **keep** |
| `list` (repeatable group, `reorder`) | S2, S6 | **keep** |
| `color`, time-only | none | **cut** |

### Actions (closed set)

| action | used by |
|---|---|
| `submit(action, payload)` (forms, buttons, live forms debounced) | all |
| `navigate(params)` within the view; `navigate(core target)` to a conversation, job, settings section or another view | H1, H2, S1, S3, S6 |
| `move(itemId, destination)` | H2, S1, S3, S5 |
| `open(url)` | links in markdown and cards |
| `copy(text or $path)` (host-only, no round trip) | H1, H9 |
| `restart` (core, admin) | S2 |
| `confirm` (prop on any action) | destructive actions everywhere |

## Width fallbacks, checked against the cases

| block / display | regular and wide | compact (phone, narrow pane, chat column, small terminal) | cases that exercise it |
|---|---|---|---|
| `page` | rail + sidebar + main (+ detail) | sidebar → drawer; detail → pushed page with back | all views |
| `columns` | side by side by weight | stack when the minimums don't fit | S4, S6 |
| `grid` | as many columns as fit the min item width | one column | H8, S7 |
| `collection` lanes | lanes side by side, drag across | one lane + lane switcher; "Move to…" for across; drag within | H2, S1 |
| `collection` table | full table | rows become cards; `priority: low` columns move into the expanded card | H1, H8, S7, C1 |
| `collection` calendar | month/week grid | agenda; time moves via the detail form | S3 |
| `collection` grid | multi-column cards | single column | S6 |
| `chart` | axes + legend | fewer ticks, legend below; very narrow → sparkline + current value | H8, S4, S7, C1 |
| `form` | labels beside fields where room | labels above fields | S2 |

Every case lays out acceptably on compact without width classes. Two
places want them as an *improvement*, not for correctness:

- S4 weather: hide the hourly strip on compact (the chart carries it);
- S7 dashboards: drop the secondary charts on compact.

So `visibleAt: "atLeast:regular"` on a block earns its place. A whole
alternative layout per width class (Adaptive Cards' multiple layouts)
has no case: **cut** for v1.

## Result: the v1 block set

- **Shell:** `page`.
- **Layout (4):** `stack`, `columns`, `grid`, `section`.
- **Content (11):** `markdown`, `fields`, `stat`, `callout`, `image`,
  `chart`, `meter`, `log`, `tree`, `diff`, `details`.
- **Items (1):** `collection` with displays `list`, `table`, `lanes`,
  `grid`, `calendar`, and the `card` item template.
- **Input (1 + 11 field types):** `form`; `text`, `longtext`, `number`,
  `toggle`, `choice`, `date`, `datetime`, `daterange`, `secret`, `file`,
  `list`.
- **Actions (7):** `submit`, `navigate`, `move`, `open`, `copy`,
  `restart`, plus `confirm` on any of them.
- **Cross-cutting props:** `tone` (neutral, accent, good, warn, bad,
  info), `size`, named icons, number/date `format`s, `visibleAt` width
  classes, `$path` bindings.
- **Reserved:** `embed`.

For scale: Slack has about 20 blocks and 45 elements; A2UI's basic
catalog has 17 components.

**Cut, with the evidence that would bring each back:** `tabs` (a view
whose sections are peers, not a list), `divider`, chart `pie`/`scatter`/
`heatmap`/dual axis, `color` and time-only fields, per-width alternative
layouts, `modal` (A2UI has one; our detail pane and pushed page cover
it).

## Questions for the spec

1. **Agent-authored blocks.** How the model emits a tree (a core tool
   that takes a tree + data and validates it), and where actions on a
   chat block go: back to the agent as a structured user turn (A2UI's
   `userAction`), or to the extension that produced the tree.
2. **Card slots are fixed.** Slack's card and Home Assistant's tile both
   use fixed slots rather than arbitrary nested blocks. That's what keeps
   every extension's cards consistent and gives the TUI a predictable
   shape. Confirm, with `body` (markdown) as the only free-form slot.
3. **Move conflicts.** Shared lists (S5) and boards (S1) take concurrent
   moves. The host applies a move optimistically and reverts on
   rejection; the extension's handler decides the final order and the
   data update corrects everyone else.
4. **Image sources.** Extension-served assets (through W5's
   `/v1/ext/<slug>/` routes) and data URLs are safe. Arbitrary external
   URLs leak the user's IP and break a strict CSP. Proposal: external
   images are proxied or disallowed.
5. **TUI images.** pi-tui (the version sigrun uses) ships an `Image`
   component and detects the Kitty and iTerm2 image protocols
   (`terminal-image.d.ts`: `ImageProtocol = "kitty" | "iterm2" | null`).
   So images render inline where the terminal supports them, and as alt
   text otherwise. Not yet tested inside tmux or with sigrun's TUI
   layout.
