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

## The interaction record: envelope / primitives / details

The design tension (strict enough for channels to render, open enough
for authors) resolves by **sharding, not grading** — one strict
envelope around a body built from a closed set of primitives, with an
opaque escape valve:

```
InteractionRecord (core-owned doc family, e.g. sigrun.interaction, keyed by callId)

  envelope — strict, versioned, channel-load-bearing:
    kind        extension-declared id (e.g. "gating.confirm", "questions.form")
    callId      stable join key to the pi.live tool slot
    status      "pending" | "answered" | "skipped" | "expired" | "cancelled"
    createdAt / expiresAt? / answeredBy? / answeredAt?
    answer      { ids?: string[], values?: Record<name,value>, text?: string }
                  — written via the one generic route; the extension
                    interprets it (first-answer-wins semantics stay hers)

  body — composed ONLY from the closed primitives:
    text        prose/markdown (prompt, context, deny reason)
    options[]   { id, label, description?, tone?, recommended?, multi? }
    fields[]    { name, type: "string"|"number"|"boolean"|"secret",
                  label?, required? }
    diff        { before, after, path?, lang? }

  details       opaque JSON, extension-owned; channels render it
                generically and honestly (collapsed, pretty-printed,
                no claimed semantics)
```

The primitives are a **frozen-by-default** set. Adding one is a
deliberate, evidence-driven act — "a real extension outgrew the set" —
never a casual schema bump; a casually added primitive would be a
de-facto core capability, which the capability-freedom ruling forbids.

## The closed primitive set, sized by evidence

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
  `answer.ids: string[]`.
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
(kind `gating.confirm`) with `text` (command + reasons + scores) and
toned `options` (allow/deny), then long-polls the answer doc — the
crash-proven pattern. Crash mid-pending: resume re-enters the hook,
re-polls the same `callId`-keyed record.

**sigrun-ask-questions** hangs on a model-facing `ask_questions` tool:
`execute` commits the record (kind `questions.form`) — `text` prompt,
`options` (multi-capable) or `fields` per question — then long-polls
inside the tool call, so to the harness it is simply a pending tool
slot. The generic answer route writes `answer`; the tool returns it
into the conversation as its result.

## Channel rendering contract (testable, finite)

Channels commit to exactly this, and nothing more:

1. Render the envelope state (pending/metered/expired) for any record.
2. Render the four primitives generically: `text` as prose,
   `options` as buttons/toggles (`tone` colors, `recommended`
   pre-selected, `multi` checkbox set), `fields` as a light form,
   `diff` as a before/after view.
3. Render `details` as collapsed generic JSON — never interpreted.
4. Write answers via the one generic route
   (`POST /v1/conversations/:id/interactions/:callId/answer`);
   resolution semantics are the extension's.

No per-extension UI code paths. A `uiHint`-style bespoke-render
pointer (factory-result-declared, extension-owned code) is the
documented future escape route but is deliberately out of v1.

## Ambient surfaces: the same envelope discipline, four primitives

2026-10-14 second survey (8 extensions: pi-goal-x, rpiv-todo, pi-fabric,
pi-warden, plannotator, pi-advisor, pi-goal-schovest, pi-interview-tool;
reports preserved in `docs/interaction-seam-survey/ambient-*`): the
widget/statusline family is persistent, keyed, state-replacement
rendering — a different lifecycle from interactions (no answer, no
pending join, update-cadence foreign to the conversation stream) but
structurally the same tension. Same resolution: strict envelope +
closed primitives + opaque fallback.

```
AmbientSurface (limited vocabulary; write = full replacement of surface state)

  envelope — strict:
    key       unique keyed slot id (e.g. "goal", "fabric", "rpiv-todos")
    place     "status" (one keyed statusline line) | "panel" (above-editor
              list surface)
    kinds[]   the surface kinds this record uses (mirror of interactionKinds;
              validated fail-loud at factory time)
    budget    "line" | maxRows? | panel mode defaults (collapse policy rides here)
    expires   auto-clear/degrade rule ("never" | "idle" | explicit timeout)
                 — covers `setWidget(key, undefined)`-on-empty and
                   fixed-time status clears

  body — composed ONLY from the closed ambient primitives:
    line      {text} — the statusline primitive: prose for a keyed slot;
              everything pre-flat today (goal, advisor-usage, plannotator
              phase) is exactly this
    rows[]    {id, label, status: enum, severity?, quiet?, detail?, depth?,
               deps?: ids[], spinnerLabel?, metrics?: {tokens?, cost?,
               current?, total?, completed?}}
    gauge     {label, percent?, phase?, elapsed?, recentOutput?: string[],
               checks?: rows[]-shaped}
    ledger[]  {at, kind, summary, detail?: string[]} — append-style event
              feed for trace/audit/history surfaces (amendable per entry,
              the one stateful non-replacement case)

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

### Why this is one seam, not two halves

Both records share the transport (durable doc-family write channels,
viewed through the conversation lifecycle) and the same factory-time
declaration (validated kinds). They differ only in lifecycle: an
interaction record awaits one answer; an ambient surface is replaced
repeatedly and never blocks. Channels get one rendering discipline for
both: a pending card stack and a persistent panel zone, each fed by
replacement-safe state snapshots.

## What this asks of core


1. The `sigrun.interaction` doc-family definition + view mounting.
2. The one generic answer route.
3. `interactionKinds` declared on factory results — validated
   fail-loud exactly like `health`/`submit`, listed in `/v1/meta`.
4. The ambient-surface seam: an extension-owned state doc per
   surface (or a session-meta-style side resource — sized at
   implementation), view projection through the same conversation
   lifecycle, and allocation of channel real-estate (statusline slots,
   the panel zone) by the channel, rendered from the record.
   Interaction records correspondingly unblock the pending-card stack.
5. Nothing else. Warden/questions remain pure extensions; competing
   implementations stay possible; a deploy with neither installed
   still boots, ungated, fail-open — with no ambient surface claimed
   either.

## What webui lost in the 2026-10-14 strip

The spec'd §6 approval cards are gone from the webui, not moved: they
coupled the core bundle to an approvals endpoint core no longer
serves. When the interaction seam lands, cards for any extension —
approvals, questions, custom kinds — become the one generic rendering
above, which is the point.

## Non-goals

- No core fail-open policy knob: "un-gated" is the default, not a
  setting.
- No core-owned schema for question *content* beyond the primitives:
  the envelope/primitives/details transport is the contract; the
  payload shapes inside `details` are theirs.
- No per-capability routes: exactly ONE generic interaction-answer
  route, shared by every extension.
- No ambient dashboard/widget representation in the interaction
  record (seam 4, separate track).
