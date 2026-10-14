# Approval / gating / question UX — seams for extensions

Decision (2026-10-14): **sigrun core ships no approvals, permissions, or
question capabilities.** Like pi, the surface is defined by installed
extensions — competing packages, user choice. The approvals
implementation lives (solely) in
[`sigrun-ext-approvals`](https://github.com/sigrun-ai/sigrun-ext-approvals);
it works standalone: tools are
gated in-conversation, the `decide_approval` tool decides, and an
extension-owned abort path covers its own records.

**Fail-open posture.** With no gating extension installed, tool calls
proceed ungated; with no question extension installed, models ask
questions in plain text (the conversation stream is always available).
Core never imports an extension package and never assumes one is
installed.

## What core must provide (the seams)

Extension authors need pi-level flexibility with a bit more structure, so
that a `pi-warden`-style hold, an `rpiv-ask-user-question`-style
questionnaire, and any future flavor render consistently across
channels (webui today, TUI next). The seams, ranked by necessity:

1. **Gating seam** (exists — pi-durable `beforeTool/afterTool` hooks):
   the mechanism approvals/permissions extensions hang on. A hook that
   returns without a terminal verdict faults the phase; crash/resume
   re-runs it. Documented in sigrun-ext-approvals' README and unchanged
   by this strip.

2. **Interaction seam** (the gap): a structured, channel-neutral way for
   an extension to say "this conversation is waiting on a human
   decision" and receive the answer durably — richer than pi's
   (dialog-only, channel-locked), looser than a fixed schema. Sketch of
   the shape core could standardize:
   - A registered **interaction kind** per extension (`gating.hold`,
     `questions.form`, arbitrary): id, prompt payload, and the
     meta-schema of the answer the extension expects.
   - Answer transport through the existing durable doc families (the
     approvals doc-family pattern is the proof) — the channel only
     writes a record; resolution semantics stay extension-owned.
   - Channels render from the conversation view's live tool slots plus
     the interaction record — no per-extension UI code paths.

3. **Section seam** (exists): prompt sections and the webui's
   extension-status chips. Extension-contributed sections already
   render; the webui shows installed/quarantined states from
   `/v1/meta`.

## What webui lost in this strip

The spec'd §6 approval cards are gone from the webui (this strip), not
moved: they coupled the core bundle to an approvals endpoint core no
longer serves. When the interaction seam (#2) lands, cards for any
extension — approvals, questions, custom — become one generic
rendering, which is the point: the happy path for extension authors
should produce consistent UX without each extension shipping channel
UI.

## Non-goals

- No core Fall-open policy knob: "un-gated" is the default, not a
  setting.
- No core-owned schema for questions: the doc-family transport is the
  contract; the payload shapes are theirs.
- No server routes per capability: interaction decisions travel through
  the conversation lifecycle the same way any record does.
