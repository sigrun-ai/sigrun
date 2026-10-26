# Approval / gating / question UX — seams for extensions

Decision (2026-10-14): **sigrun core ships no approvals, permissions, or
question capabilities.** Like pi, the surface is defined by installed
extensions — competing packages, user choice. The approvals
implementation lives solely in
[`sigrun-ext-approvals`](https://github.com/sigrun-ai/sigrun-ext-approvals);
it works standalone, in-conversation, with no capability retained by
core: tools are gated in-conversation, the `decide_approval` tool
decides, and an extension-owned abort path covers its own records.

**Fail-open posture.** With no gating extension installed, tool calls
proceed ungated; with no question extension installed, models ask
questions in plain text (the conversation stream is always available).
Core never imports an extension package and never assumes one is
installed.

## Why: the capability-freedom ruling

`pi` ships without approvals, permissions, or questions; several
competing extensions cover those spaces, and that competition is good.
`sigrun` preserves it: the core's job is hooks and seams extension
authors can build on — with *a touch more structure than pi*, so that a
`pi-warden`-style hold, an `rpiv-ask-user-question`-style
questionnaire, and any future flavor render consistently across
channels (webui today, TUI next) without each extension shipping
channel UI.

## The seams

1. **Gating seam** (exists — pi-durable `beforeTool`/`afterTool`
   hooks). The mechanism approvals/permissions extensions hang on:
   blocks until answered, crash/resume re-entry, abort unwinding.
   Documented in sigrun-ext-approvals' README; unchanged by this
   ruling.

2. **Interaction seam** (the gap, specified below): a structured,
   channel-neutral record — *the interaction record* — by which an
   extension says "this conversation is waiting on a human decision"
   and receives the answer durably. Answer transport through durable
   doc-family records (the approvals pattern is the proof); resolution
   semantics stay extension-owned.

3. **Section seam** (exists): prompt sections and the webui's
   extension-status chips from `/v1/meta`. Extension-contributed
   sections render; installed/quarantined states are visible.

4. **Ambient surfaces** (specified in the next section): widgets,
   statuslines, banners — persistent read-mostly state panels,
   a *different* seam from pending decisions.

## The interaction record: envelope / block-tree body / details

The design tension (strict enough for channels to render, open enough
for authors) resolves by **sharding, not grading** — one strict
envelope around a block-tree body, with an opaque escape valve:

```
InteractionRecord (core-owned doc family, e.g. sigrun.interaction, keyed by callId)

  envelope — strict, versioned, channel-load-bearing:
    kind        extension-declared id (e.g. "gating.confirm", "questions.form")
    callId      stable join key to the pi.live tool slot
    status      "pending" | "answered" | "skipped" | "expired" | "cancelled"
    createdAt / expiresAt? / answeredBy? / answeredByUser? / settledAt?
    answer      { values: Record<name, value> }   — ruling 20; written via
                  the one generic route; the extension interprets it
                  (first-answer-wins semantics stay hers)

  body — a BLOCK TREE (placement `interaction`): a root `form` whose
         submit is the answer, composed from the closed block set with
         the typed builders in `@sigrun/sigrun/blocks`

  details       opaque JSON, extension-owned; channels render it
                generically and honestly (collapsed, pretty-printed,
                no claimed semantics)
```

**The primitive body types below are superseded** (2026-10-24, UI-blocks
ruling 16 — no compatibility layer): the interaction body is a block
tree from the closed block set, and the mapping from this section's
`text` / `options[]` / `fields[]` / `diff` primitives onto blocks is
UI-blocks design §9.1:
`text` → `markdown`, `options[]` → a `choice` field, `fields[]` →
`text` / `number` / `toggle` / `secret` fields, `diff` → `diff`,
`details` → `details`; the answer shape is `{values}` (every field's
value under its name). Extension authoring examples live in
[extending.md](extending.md) — the two sections below are kept as the
survey evidence that sized the set.

The block set is a **frozen-by-default** set. Adding a block is a
deliberate, evidence-driven act — "a real extension outgrew the set" —
never a casual schema bump; a casually added primitive would be a
de-facto core capability, which the capability-freedom ruling forbids.

## The closed primitive set, sized by evidence (historical)

> Kept as the evidence record. The live contract is the block set +
> spec §9.1 mapping above; "primitive" below means the superseded
> body types the survey measured.

Before freezing, 14 high-download pi extensions with human interaction
were inspected by parallel subagents (cloned source, quote-backed
reports keyed by file:line; control cases included). Coverage verdicts
of the human-facing *decision* volume by
{text, options, fields, diff}:

| Extension | Decision-coverage | Motivating gap (→ details) |
|---|---|---|
| @gotgenes/pi-permission-system | ~95% | evidence-array elision, wizard steps |
| pi-ask-user | ~95% | timeout auto-dismiss, `skipped` state |
| pi-until-loop | ~85–90% | waiver/certified-lexeme payload, diff ledger |
| pi-goal (schovest) | ~80–85% | living statusline metric (ambient seam) |
| pi-guardrails | ~80% | list-CRUD editors (pattern/path lists) |
| pi-goal-x | ~80–90% dialogs | progress/tree dashboard (ambient seam) |
| pi-advisor | ~75–80% | option descriptions, multi-select, secret input |
| pi-warden | ~75–80% | colored token-line widget, hold-outcome ledger |
| rpiv-ask-user-question | ~70–75% | multi-select, per-option markdown preview |
| pi-fabric | ~70% dialogs | deadline/escalation; widget stack (ambient) |
| pi-interview-tool | ~55–65% | media/attachments (image/chart/mermaid/table) |
| rpiv-todo | ~30–40%* | task-list graph + widget placement (ambient) |
| pi-btw | control ~30–70% | bespoke overlay; transcript stream (out of scope) |
| plannotator | ~25–35% | anchored comments, attachments, rich choices |

\* todo/todo-x/fabric's low numbers are dominated by *ambient state
surfaces*, not pending decisions — the correct scoping conclusion is
that the interaction record covers decisions only, not dashboards
(seam 4). Recounted against that boundary, the median
decision-coverage is ~80% and the pure prompt/permission/question
extensions cluster at 90%+.

Refinements the evidence forced (all inside existing primitives, none
new):

- **options gain `description?`, `recommended?`, `multi?`** — wanted by
  pi-advisor (described presets, multi model select), rpiv-ask
  (multiSelect), plannotator (recommended/settled choices),
  pi-interview (recommended/conviction). Multi-select's answer shape is
  `answer.ids: string[]` (now `{values: {<choice>: [ids]}}` — ruling 20).
- **fields gain `"secret"`** — masked API-key entry (pi-advisor,
 .pi-guardrails key inputs). Channels mask by contract.
- **envelope gains `expiresAt?` and `skipped`/`expired` statuses** —
  timeouts (pi-ask-user, pi-fabric deadlines, pi-until expiry windows)
  are lifecycle metadata, not body content.
- **`diff` is rarer than assumed** (used only by pi-warden's stuck-diff
  and pi-fabric tool renders) but load-bearing for gating UX — kept.

Observed-but-deferred demand (candidates for a future, separately
evidenced primitive): `media` (pi-interview images/charts/mermaid,
plannotator attachments), "command block, human-only" (pi-until).
Everything else genuinely degrades — anchored comments (plannotator),
list editors (guardrails), evidence elision (permission-system) — to
`details` without lying about semantics.

## How the two motivating extensions use it

**sigrun-warden** hangs on the `beforeTool` hook: verdict `allow`
returns immediately; `steer` returns a corrected-arguments verdict
(non-blocking); `confirm` seeds a `sigrun.interaction` record
(kind `gating.confirm`) whose tree is a root `form` with a toned
allow/deny `choice`, a `longtext` reason, and `markdown` for the
matched rule and command, then long-polls the answer doc — the
crash-proven pattern. Crash mid-pending: resume re-enters the hook,
re-polls the same `callId`-keyed record.

**sigrun-ask-questions** hangs on a model-facing `ask_questions` tool:
`execute` commits the record (kind `questions.form`) — one `section`
per question holding a `choice` (multi-capable, per-option
`description`/`preview`, `allowOther` for free text) — then long-polls
inside the tool call, so to the harness it is simply a pending tool
slot. The generic answer route writes `answer: {values}`; the tool
returns it into the conversation as its result.

## Channel rendering contract (testable, finite)

Channels commit to exactly this, and nothing more:

1. Render the envelope state (pending/metered/expired) for any record.
2. Render the body tree with the shared block renderers (placement
   `interaction`): the root `form`'s submit becomes the answer POST;
   a `choice` renders as buttons/toggles (`tone` colors, `recommended`
   pre-selected, `multi` checkbox set), a `secret` field is masked,
   a `diff` renders as a before/after view.
3. Render `details` as collapsed generic JSON — never interpreted.
4. Write answers via the one generic route
   (`POST /v1/conversations/:id/interactions/:callId/answer`, body
   `{values}` — every field's value under its name); resolution
   semantics are the extension's.

No per-extension UI code paths. A `uiHint`-style bespoke-render
pointer (factory-result-declared, extension-owned code) is the
documented future escape route but is deliberately out of v1.

## Ambient surfaces: the same envelope discipline

**Also superseded by the block set** (same ruling): an ambient record's
body is a block tree (placement `ambient`), with `status`/`footer`
restricted to one line. The mapping from this section's `line` /
`rows[]` / `gauge` / `ledger[]` primitives onto blocks is spec §9.2:
`line {text}`/`segments[]` → one-line `markdown` or a `columns` of
one-line `markdown`s, derived metrics → `stat` with `format`, `rows[]`
→ `collection(display: list)` cards, `gauge` → `meter` (+ `log` for
`recentOutput`, a nested `collection` for `checks`), `ledger[]` →
`log`, `details` → `details`. The evidence table below stays as the
survey record.

2026-10-14 second survey (8 extensions: pi-goal-x, rpiv-todo, pi-fabric,
pi-warden, plannotator, pi-advisor, pi-goal-schovest, pi-interview-tool;
reports preserved in the interaction-seam survey (ambient-*): the
widget/statusline family is persistent, keyed, state-replacement
rendering — a different lifecycle from interactions (no answer, no
pending join, update-cadence foreign to the conversation stream) but
structurally the same tension. Same resolution: strict envelope +
closed primitives + opaque fallback.

```
AmbientSurface (limited vocabulary; write = full replacement of surface state)

  envelope — strict:
    key       unique keyed slot id (e.g. "goal", "fabric", "rpiv-todos")
    place     "status" (one keyed statusline line) | "footer" (left/middle/
              right zones) | "panel" (above-editor list surface)
    kinds[]   the surface kinds this record uses (mirror of interactionKinds;
              validated fail-loud at factory time)
    budget    "line" | maxRows? | panel mode defaults (collapse policy rides here)
    expires   auto-clear/degrade rule ("never" | "idle" | explicit timeout)
                 — covers `setWidget(key, undefined)`-on-empty and
                   fixed-time status clears
    refresh?  channel re-render hint between data writes
                 — timer-driven slots (countdowns, clocks) request
                   scheduled repaints (pi-usage's 60s countdown line)

  body — a BLOCK TREE (placement `ambient`; `status`/`footer` allow one
         line). The superseded ambient primitives and their §9.2 block
         mapping, kept as the design record:

    line      {text} → one-line `markdown`; `segments[]` ({id, text,
              place?: left|middle|right}) with envelope `overflow:
              drop|wrap` → a `columns` of one-line `markdown`s (the
              segmented-footer shape — pi-powerline's ~20 segments,
              pi-zentui's L/M/R zones — without a second primitive).
    derived   metrics with a `format` hint ("2.5k", currency,
              smart-token formatting) → `stat` with `format`, so hosts
              stop re-implementing formatters.
    rows[]    {id, label, status: enum, severity?, quiet?, detail?, depth?,
               deps?: ids[], spinnerLabel?, metrics?} →
              `collection(display: list)` cards.
    gauge     {label, percent?, phase?, elapsed?, recentOutput?, checks?} →
              `meter`, plus `log` for `recentOutput` and a nested
              `collection` for `checks`.
    ledger[]  {at, kind, summary, detail?} — append-style event feed →
              `log`.

  details       opaque JSON, extension-owned; channels render collapsed.
```

Evidence-sizing (decision-coverage of each surface class, by extension):

| Extension | Coverage | Mechanism of note |
|---|---|---|
| pi-goal (schovest) | ~100% by `line` | keyed status slots are exactly this |
| plannotator | ~100% by `line`+`rows` | checklist widget = rows; statusline = line |
| pi-advisor | ~95–100% | 3 keyed slots + usage counters = line; gauge unused |
| pi-interview-tool | ~95% | countdown badge = gauge; queue switcher = rows |
| rpiv-todo | ~95% | task graph = rows+deps; budget/overflow policy rides envelope |
| pi-warden | ~85–90% | verdict stack = rows w/ severity + quiet-fold; needs the row affordances above |
| pi-goal-x | ~70–75% | dashboard is line+rows+gauge+tree-deps; result card needs a transient note class |
| pi-fabric | ~70% | always-on widget = rows+metrics; **live-tail activity pane** is the one structural gap |
| pi-powerline-footer | ~95% | segmented composition = line `segments[]`; metric formatters forced the derived hint |
| pi-usage | ~100% by line | countdown slot forced envelope `refresh`; statusline = single nested line contract |
| pi-zentui | ~85–90% | chrome-skin case: OWNS the footer working line; pre-styled segments + truncation budgets = envelope policies, no new shape |

The `rows` primitive carries three extensions warden/todo/goal-x forced
(the same shape three different ways): `status` as an *enumerated,
channel-schemed* glyph state (`severity: 0..2` for ordering/color, `quiet?`
for fold-under-defaults, `spinnerLabel?` for live activity labeling),
`deps?: ids[]` for dependency markers, `metrics` for token/cost/counters.
Full-replacement writes (state snapshot, never delta) keep every channel
implementation trivial and reconcile the amendable ledger by giving it
its own append-shaped primitive.

Deferred (evidence noted, not spec'd): a live-tail/log-pane element
(pi-fabric's expanded activity pane), interactive row actions
(interview-tool's "open this queued session", warden's config panel) —
ambient surfaces stay read-only v1; actions re-route through the
interaction seam (a click may *seed an interaction record*, not embed
editing). Bespoke dashboards (pi-fabric dashboard modal, goal-x expanded
mode) legitimately degrade to `details`.

### Allocation: one owner per slot

pi-zentui is the proof-by-conflict: it *replaces* pi's own chrome
(footer, working line) rather than adding surfaces. The seam therefore
allocates, it does not compose silently: a slot key is owned by exactly
one installed extension (later installation wins or fails loud by
config), and a channel may style but not merge. Exact-text-segment
payloads with per-zone budget/truncation policies (zentui's
responsive/compact rules, 50ms throttle cadences) are envelope policy,
not channel inference. Turn summaries (settle-to-persistent history)
are conversation entries, not ambient state — mitigated by `ledger`
when an extension wants them as a feed.

### Why this is one seam, not two halves

Both records share the transport (durable doc-family write channels,
viewed through the conversation lifecycle) and the same factory-time
declaration (validated kinds). They differ only in lifecycle: an
interaction record awaits one answer; an ambient surface is replaced
repeatedly and never blocks. Channels get one rendering discipline for
both: a pending card stack and a persistent panel zone, each fed by
replacement-safe state snapshots.

## Interaction events: notifications carry `callId`; `interactionSettled` fires per transition

Two event surfaces extend the seam (2026-10-23, gateway C5/C6):

- **Answer attribution (C5).** The host's `answerInteraction`
  accepts `opts?: {user?: string}`. With `user`, the record stamps
  `answeredBy: "human"` + `answeredByUser: <user>` — the same
  attribution the generic answer route stamps; without it, the
  extension answered itself (`answeredBy: "extension"`, no user).
  Access checks stay the caller's job (host code is trusted in-process).
- **`interaction.pending` notifications carry the record's `callId`**
  (the only notification type that does). A notifier reads the record
  via `ctx.host.snapshotInteraction(conversationId, callId, context)`
  to read the record's body tree and details — the notification itself
  carries only title/body/url.
- **`interactionSettled` lifecycle handler (C6).** A factory result may
  declare `interactionSettled(event, api, context)` — fired ONCE per
  terminal transition (`answered`/`skipped`/`expired`/`cancelled`) from
  ANY writer (the HTTP route, a host answer, a host
  `settleInteraction`), because exactly one durable document change
  lands per transition. The payload is the record's terminal envelope:
  `{conversationId, callId, kind, status}`. It is deadline-bounded
  like the other lifecycle handlers (see extending.md); a non-function
  declaration quarantines at load. Seeding a pending record fires
  nothing. Channels/edit-your-prompt-message consumers use it to
  resolve delivered prompts (edit the message to the outcome).

## Implementation status (2026-10-14)

Shipped in core + webui (commits bcd4423 + webui commit):

- `src/harness/interactions.ts` + `src/harness/ambient.ts`: the records,
  doc families, validators.
- `src/harness/seam-host.ts`: the host context (factory arity-1, kinds
  write gate, owner allocation).
- Server: `GET/POST /v1/conversations/:id/interactions(/:callId/answer)`,
  `GET /v1/conversations/:id/interactions/:callId`, `GET .../ambient`,
  `/v1/meta seam`.
- Webui: `InteractionCards` + `AmbientPanels` render the record's
  block tree via the shared block renderer (`BlockView`; the TUI's
  `SurfaceView` is its sibling) (toned choices, secret
  masking, diff panes, collapsed details; statuslines, footer zones,
  quiet-folded panel rows), refreshed per stream frame.
- ACHORD LESSON, pinned: never re-read a mutated draft field inside a
  commit callback (`Cannot use a settled overlay`); responses project
  the input answer instead.

Deferred to implementation follow-ups: timer-driven `refresh` in the
webui (the envelope hint is carried; channels may honor it later);
`ledger` per-entry amend transport (v1 seeds whole replacement ledgers);
ambient surfaces whose state outlives one conversation (session-scoped
status slots).

## What this asks of core


All four asks shipped (see Implementation status above). What remains
true: warden/questions stay pure extensions; competing implementations
stay possible; a deploy with neither installed still boots, ungated,
fail-open, with no ambient surface claimed.

## What webui lost in the 2026-10-14 strip

The spec'd §6 approval cards are gone from the webui, not moved: they
coupled the core bundle to an approvals endpoint core no longer
serves. When the interaction seam lands, cards for any extension —
approvals, questions, custom kinds — become the one generic rendering
above, which is the point.

## Non-goals

- No core fail-open policy knob: "un-gated" is the default, not a
  setting.
- No core-owned schema for question *content* beyond the block set:
  the envelope/tree/details transport is the contract; the
  payload shapes inside `details` are theirs.
- No per-capability routes: exactly ONE generic interaction-answer
  route, shared by every extension.
- No ambient dashboard/widget representation in the interaction
  record (seam 4, separate track).
