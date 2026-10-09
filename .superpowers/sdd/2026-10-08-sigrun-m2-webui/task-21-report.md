# Task 21 report: transport hook + conversation view state

Status: COMPLETE

## Shapes (as built)

- `webui/src/stream.ts`: `openConversationStream(conversationId, handlers, baseUrl = "", options?)`
  → `{ close() }`. Handlers (all optional): `onSnapshot(view)`, `onView(view)`,
  `onError(message)`, `onOpen()`. Parses `snapshot`/`view` single-line JSON frames;
  a malformed frame (JSON.parse failure OR well-formed non-object JSON like
  `42`/`[1,2]`/`null`) → `onError("malformed … frame")` and the stream STAYS
  OPEN (the spike's guard). Transport `error` → `onError`, close the source
  (per-source `failed` latch so repeated error events schedule ONE reconnect),
  reconnect with exponential backoff 250ms doubling capped at 4s, reset on a
  successful `open`. Reconnect = re-attach: the server sends a fresh snapshot
  (App C full-revision contract, no replay). Heartbeat `: ping` comment lines
  are consumed by the EventSource parser itself — tolerance is inherent
  (documented in the module docstring). `close()` cancels a pending reconnect,
  closes the live source, and latches so late frames are ignored.
- `webui/src/useConversationView.ts`: `useConversationView(conversationId, options?)`
  → `{ view, status, frames, error }`, status
  `"idle" | "connecting" | "snapshot" | "live" | "error"`. Full-replace per frame
  (never accumulate; snapshot → "snapshot", view → "live"); `frames` counts
  accepted frames and survives reconnects; `error` carries the failure
  description whenever status is `"error"` and clears on the next good frame.
  `null` id → `idle`, no stream. Effect cleanup closes the stream on unmount
  and on id change; an id change also resets view/frames/error (no stale view
  under a new conversation).
- Types decision: EXTENDED the T20 hand-mirror in `webui/src/api.ts` with
  `ConversationViewWire` (`{conversation, entries, docs, steer:{busy,queued}}`)
  plus `ConversationEntryWire`, `MessageWire`, `ContentBlockWire`, `UsageWire`.
  No second source file, no codegen — same documented drift risk as T20.
  `docs` stays `Record<string, unknown>`; known-doc typing (`pi.live`,
  `pi.inbox`, `pi.usage`) is deferred to the T22/T23 consumers that read them.
- Test seam: `EventSourceFactory = (url) => EventSourceLike` injected via
  `{ createEventSource }` on both the wrapper and the hook; default is the
  browser native `EventSource` (structurally compatible with the minimal
  `EventSourceLike` interface). Tests drive a `StubEventSource` — no real
  server anywhere. Hook rendering uses `react-test-renderer` (added as a
  dev-only dep + `@types/react-test-renderer`; the workspace has no
  jsdom/testing-library, and the hook needs a React renderer to exercise).

## Verification

- `cd webui && npx tsc --noEmit` — clean (no output).
- `cd webui && npx vitest run`:
  ```
   Test Files  3 passed (3)
        Tests  21 passed (21)
  ```
  (7 pre-existing api.test.ts + 9 stream.test.ts + 7 useConversationView.test.ts)
- Root suite unaffected — `cd . && npx vitest run`:
  ```
   Test Files  28 passed (28)
        Tests  208 passed (208)
  ```

## Commit

`ea21aee` `feat: webui transport hook (useConversationView)` (code + tests +
api.ts type mirror + dev deps); this report committed separately (docs commit).

## What T22 needs

- The hook's `view` is the full `ConversationViewWire`; T22's entry renderers
  consume `view.entries` and dispatch on `entry.kind` (`pi.user` /
  `pi.assistant` / `pi.tool-result` / `pi.system`). Text content lives in
  `entry.model[].content` (a `string` for system entries, or
  `ContentBlockWire[]` with `type === "text"` blocks for user/assistant).
  Assistant messages carry `provider`/`model`/`usage`/`stopReason`.
- `docs` is untyped by design: T22 narrows `docs["pi.live"]` (live run +
  pending gated calls for approval cards); T23 narrows `docs["pi.inbox"]`
  (queued submissions) and `docs["pi.usage"]` (context ring).
- `view.steer = {busy, queued}` is ready for the composer's send→steer flip.
- The hook takes `{ baseUrl?, createEventSource? }` — T22+ tests reuse the
  `StubEventSource` + react-test-renderer harness pattern from
  `useConversationView.test.ts` (incl. `IS_REACT_ACT_ENVIRONMENT = true`).
