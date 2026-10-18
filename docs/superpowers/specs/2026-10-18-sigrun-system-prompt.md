# Sigrun system prompt — identity, persona, per-model guidance

Status: implemented. Date: 2026-10-18.

## Why

Today sigrun has no core-authored identity or persona text at all.
pi-durable's `renderSections` composes the system message from tagged
extension sections; core sections today are `persona` (from `SOUL.md`,
absent when the file is missing), `workspace-instructions` (from
`AGENTS.md`, same), `skills`, and — when no memory extension is installed —
the no-op `long-term-memory` placeholder ("long-term memory backend not
configured"). So a fresh deploy is not a *blank* actor, but it has no
identity, no personality, and no behavioral contract — the first "hi" is
answered with no self-description at all.

Hermes (which sigrun replaces) puts `SOUL.md` first in its stable tier with a
hardcoded behavior-spec fallback; OpenClaw ships a flat one-line identity and
pushes personality to the user's `SOUL.md` (external-codebase framing —
motivation, not verified against this repo). Both treat *voice* as user
territory; neither ships a real default personality. Sigrun differentiates:
it ships a default persona with an actual voice, replaced wholesale by the
user's `SOUL.md` when present.

## Design

### Sections and order

Core-owned sections, installed before every extension (registry install order
is prompt order), never quarantined:

1. **`identity`** — always present, fully static facts about the runtime.
   Not documentation, not instructions: what sigrun is. The resolved model is
   deliberately *not* named here — interpolating it would re-emit the whole
   identity section on every mid-conversation model swap, defeating the
   minimal-patch design (builder-check finding; the model name lives nowhere
   in the prompt by design). Default text (my call, user to review):

   ```text
   You are sigrun, an AI assistant running as a persistent server built on the
   pi-durable harness. Conversations are durable: they survive restarts and can
   span channels (web UI, terminal UI, HTTP API). Multiple conversations may be
   active at once; each is independent.
   ```

   Identity carries no tool claims (user ruling): the pi-durable system
   prompt already declares the actually-offered tools per request, and naming
   tools in identity would be wrong whenever an operator disables defaults
   (e.g. no `bash`). Identity is runtime facts only.

2. **`persona`** — `SOUL.md` when present (unchanged from today, read via the
   conversation's `ExecutionEnv`, cwd-anchored). When absent, the shipped
   default persona (my call, user to review):

   ```markdown
   You are Sigrun. You choose, and you say why — a valkyrie doesn't dither
   over the field. You have opinions and you give them straight: if a plan is
   bad, say it's bad and say what would make it good. Hedging is a way of
   lying politely.

   Match your reply to the weight of the ask. No filler openers, no restating
   the request, no narrating what the user can already see. When you don't
   know, say so and name what would settle it.

   Dry wit when it lands. Never forced, never at the user's expense — punch
   at the problem, not the person. Warmth is welcome; flattery is not.
   ```

   Full replacement, never merge: a present `SOUL.md` owns the section
   exactly as it does today. The default carries no profanity; that register
   is user `SOUL.md` territory. When the conversation has no env
   (`PromptInput.env === undefined` — the no-workspace case), the persona
   falls back to the default too: env-less is "absent SOUL.md" by another
   route, not a third state.

3. **`tool-guidance`** — per-model-family tool-use guidance. Absent when the
   request's model matches no entry.

4. **`execution-guidance`** — per-model-family execution-style guidance
   (persistence, verification, turn-taking). Absent when no entry.

The split of 3/4 into separate keys (rather than one `guidance` blob) is
load-bearing for value-level patching: a *matched→matched* model swap that
only changes tool guidance re-emits a few lines instead of a paragraph.

Full core-section install order (two review findings folded in):
`identity` → `persona` → `workspace-instructions` → `skills` →
extension sections → `long-term-memory` (no-op or real) → **`tool-guidance`
→ `execution-guidance` (LAST, after `loadExtensions` and the memory
section)** → `instructions` (pi-durable reserved, appended by `resolveAgent`).

Guidance placement is load-bearing, not cosmetic (deepseek review, verified
in `prompt.js planSections`): `patchedOrder` is shown∩desired in *shown*
order plus appended new keys; when a guidance section appears whose desired
position precedes already-shown sections, the orders differ and pi-durable
falls back to remove-all/re-add-all — a full prompt re-emit. Since guidance
is absent by design for unmatched models, mid-list placement would make every
matched↔unmatched transition re-emit the whole prompt. Installed LAST, new
guidance sections can only ever be appended after everything else, so
appear/disappear is a minimal patch. Matched→matched swaps patch by value
regardless of placement.

pi-durable re-adds *all* sections when order changes, so this order is a
one-time decision worth pinning now: a later correction costs a full
system-prompt re-emit per existing conversation.

### Per-request model keying (verified mechanism)

Sections re-render before every request with `PromptInput.agent.model?:
ModelRef` carrying the request's resolved model. **Section renderers have no
access to the `Models` catalog** (both reviews: `Agent` has no `models`
field; `Models` lives on `HarnessOptions`/`ToolExecutionApi`/`HookApi`,
never on `PromptInput`). So the guidance matcher keys off the
`provider/model-id` string alone — name-substring matching. A rule that
needs catalog metadata (e.g. the model's `reasoning` flag) is not
implementable in a section renderer; the seed "reasoning models" entry is
therefore a name-pattern entry (`kimi`, `deepseek`, etc.), not a metadata
lookup.

`planSystemEntries` then writes the minimal patch: changed sections are
re-emitted as delta `pi.system` entries, unchanged sections keep their bytes
(see the placement caveat above for appear/disappear).

### Model-family table

A core-owned, code-resident table: ordered (matcher, toolGuidance,
executionGuidance) entries. Matching is by substring on the resolved
`provider/model-id`, case-insensitive, first match wins. Seeded small — the
mechanism is the deliverable, entries accumulate with operational experience:

- Models known to under-call tools get a `tool-guidance` entry (use tools
  instead of answering from memory when the answer is checkable).
- Reasoning models get an `execution-guidance` entry (spend thinking on
  planning; verify before finalizing).

Both seed entries are my call; wording lands in the plan. An unmatched model
yields absent sections — the designed empty case, same convention as a
missing `SOUL.md`.

### Where the code lives

- `identity` joins `src/harness/sections/context-files.ts` ahead of
  `persona` as static text — no file read.
- The persona fallback lands in the existing `persona` section renderer:
  `SOUL.md` read succeeds → file body; `not_found` → default text; no env →
  default text; any other read error → render throws and upstream keeps the
  previously shown text + reports the error (`renderSections` semantics —
  "fail loud" means reported-and-kept, not abort).
- The guidance table + matchers are a new
  `src/harness/sections/model-guidance.ts`, core-owned, installed in boot
  **after `loadExtensions` and the memory-section install** (the placement
  rule above).
- **Reserved-key assertion**: pi-durable's registry only rejects the
  `instructions` key and duplicate keys within one extension — a loaded
  extension declaring `persona` would silently replace the core section
  (`resolveAgent` composes with `sections.set(key, section)`, last writer
  wins). Boot asserts after `loadExtensions` that the reserved core keys
  (`identity`, `persona`, `workspace-instructions`, `skills`,
  `tool-guidance`, `execution-guidance`) are each owned by exactly the core
  extension that defines them; a collision fails boot loud.

## Review disposition

Three reviews folded in. First builder check (fresh reviewer) verified the
mechanism claims against pi-durable dist. DeepSeek review (verified in
source): guidance-last placement (the load-bearing fix), `agent.models`
nonexistence, pinned order completing `long-term-memory` + `instructions`,
reserved-key assertion, persona env-less case, fail-loud = reported-and-kept,
unset-model test level. GLM review: identity text accuracy (tools exist),
section-key validation regex passes, no-op memory prose correction,
`agent.models` correction with the name-substring consequence (no catalog
metadata in renderers), env-less persona recommendation (adopted: default
persona), external-claims framing note (adopted). Conflict resolved: GLM
placed guidance mid-list (correct that it's achievable and that
matched→matched patching holds); deepseek's matched↔unmatched full-re-emit
analysis is verified correct in `planSections`, so guidance goes last.

## Non-goals

- Persona picker or per-conversation persona selection (spec C territory).
- Provider-plugin-contributed prompt sections (openclaw-style replaceable
  named sections) — deferred until the provider plugins exist and a real
  need is demonstrated.
- User-editable identity. `identity` is core facts; users edit `SOUL.md`.
- Localization.

## Tests

- Section composition: fresh boot (no files) renders identity + default
  persona; with `SOUL.md` renders identity + file body; with `AGENTS.md`
  unchanged. Env-less boot renders the default persona.
- Persona fallback: `not_found` → default; `permission_denied` → render
  throws, upstream reports the error and keeps the previously shown text
  (assert the real `renderSections` behavior).
- Model keying (unit-level on the renderer/table; `no_model` fails before
  section rendering upstream, so there is no end-to-end unset-model path):
  matched→matched swap patches only the guidance values; matched↔unmatched
  transitions are append/remove of the two trailing sections — never a
  remove-all/re-add-all pair (assert the patch shape, this is the placement
  invariant); unmatched model omits both sections.
- Table: first-match-wins order, case-insensitivity, no-match → undefined.
- Composition order matches the pinned install order above, including
  guidance-last and the reserved-key assertion firing on a colliding
  extension.
