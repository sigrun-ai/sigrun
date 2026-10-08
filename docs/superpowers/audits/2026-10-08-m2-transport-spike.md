# M2 transport spike — `useConversationView` hook shape validated

**Date:** 2026-10-08 · **Status:** validated · **Artifacts:** `spikes/webui-transport/` (spike-only, not shipped)

The §6.3 audit re-baselined M2 to a TS + React rebuild whose core transport is a single
`useConversationView` hook over the §5 SSE stream. This spike de-risked that hook shape
before planning, against the real M1 server (faux provider, no network).

## What was proven

- **One `EventSource` over `GET /v1/conversations/:id/stream`, treating every frame as a
  full revision (replace, don't accumulate), is a clean React data flow.** `snapshot` on
  connect, then `view` frames on every state change. No per-turn delta state machine —
  the §5 full-immutable-revision contract (verified in App C, T9d) makes the reducer a
  one-line `setView`.
- **The entries carry the typed discriminant the renderer needs.** Observed a live frame:
  `entries: [pi.user, pi.system, pi.assistant, pi.user, pi.assistant]` with
  `steer: {busy, queued}` reflecting the run's busy state across the submit → settle
  transition.
- **The submissions endpoint's wait-for-settlement shape** (HTTP 202 held until the run
  settles) is compatible with the stream: the composer POSTs, the stream carries the live
  view concurrently, and the POST returns the settled record.
- **Cross-origin works for the spike** (the spike server sets `access-control-allow-origin:
  *`); the production webui is same-origin per §4.1/§6, so this is a spike-only concern.

## Consequence for the M2 plan

The transport is no longer a risk — the plan can take the `useConversationView`
full-revision hook as a given and spend its design effort on the renderer (entries by
`kind`), the three-panel layout, and the §6.1 ship-gate features. The spike page is the
reference for the hook and the entry-rendering shape.

## Spike limitations

- Faux provider only (deterministic answers); no real model latency or streaming
  partials exercised (the full-revision contract makes partials just another frame, but
  the token-rate cadence is untested).
- React via ESM CDN (no build); the production webui is Vite + TS + React with a build.
- The audit's evidence gap stands: `rcarmo/piclaw` was never consulted (§6.3 pattern
  reference only; cannot flip the rebuild decision).

## Layout mockup (verified rendering)

`spikes/webui-transport/mockup.html` is a static three-panel mockup of the §6.1
ship-gate layout (sessions sidebar, chat center with tool/approval cards, workspace
browser, composer footer with model picker + context ring + steer hint, light/dark +
accent themes, extension/health badges). Rendering verified headlessly (chromium):
no console errors; the DOM carries all four session states, all five message kinds
(user/assistant/tool/approval/assistant), the workspace tree, and the composer draft.
Screenshot at the time of verification: `/tmp/sigrun-mockup.png` (local, not committed).
