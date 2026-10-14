# pi-btw interaction-shape inspection

Repo: /tmp/pi-ext-inspect/pi-btw (README.md, extensions/btw.ts 3047 lines, btw-extension-tools.ts, btw-ssh-workspace.ts). No code run.

## 1. KINDS

- **BTW overlay modal (transcript + composer + status)** — trigger: `/btw`, `/side`, `/btw:new`, `/btw:tangent`, `/btw:ask` (README "Commands"; btw.ts:2289 `ctx.ui.custom<void>`, component class `BtwOverlayComponent` btw.ts:1317). Human sees: top-centered modal overlay with title (mode-specific, btw.ts ~1300 "BTW tangent"), streaming transcript (badged user/assistant/thinking/tool-call/tool-result blocks, btw.ts:1036-1160), a status line (`setOverlayStatus`, e.g. "⏳ streaming..." btw.ts:1876), and a free-text composer (own draft, keyboard handling incl. slash-command autocomplete at btw.ts:1420-1470). Human does: free text input, Enter/Tab (command completion), Esc (abort → dismiss, btw.ts:1944-1962), Alt+w / Alt+/ etc. focus and layout toggles (config via `PI_BTW_FOCUS_KEYS`, btw.ts:79). **Non-blocking** to the main agent; runs "runs right away even while the main agent is still busy" (README). Durability: transcript/status are transient UI; the underlying thread is persistent (hidden `appendEntry` records, see §4).
- **Transient notify toasts** — trigger: errors/warnings/success texts (`notify()` helper btw.ts:1287, `ctx.ui.notify(message, level)` at 1289; 20+ sites: "Saved BTW note to the session.", "Cleared BTW thread.", no-credentials fallback warnings btw.ts:1985). Human sees: pi-level notification with info/warning/error level. Does: nothing (passive). Non-blocking, transient UI-only.
- **Visible saved session note** — trigger: `--save` flag (or degraded/no-overlay path, btw.ts:2827-2856). Human sees: a custom message rendered in the main transcript via `pi.sendMessage({customType: "btw-note", display: true, details: BtwDetails})` (saveVisibleBtwNote, btw.ts:1249-1273; constants at line 58). Human does: nothing (read-only). Non-blocking; **persistent** (session transcript).
- **RPC/SDK degraded mode** — same as above: on non-TUI hosts the composer cannot open; notifyInlineQuestionRequired warns (btw.ts:1280-1286) and responses render as saved notes (btw.ts:2833-2856 "if (!overlayAvailable)"). Non-blocking, persistent.

## 2. MAPPING

- **Overlay modal**: NOT covered by any of the 4 primitives. It is a composite ui.custom component with free-text composer, streaming list widget and status line. Streams one *PARTIAL* win: it renders text transcripts (`BtwTranscriptEntry` variants `user-message`/`assistant-text` are pure text, btw.ts:254-271) and its composer is a plain string (`overlayDraft`/`getDraft()`). But tool-call rows (`tool-call: {toolCallId, toolName, args}` / `tool-result: {content, truncated, isError}`) and live streaming/streaming-boolean state are beyond primitives. The human's *action* is free text — one-way "prompt body" fits composition, not the widget.
- **Notify toasts**: FULLY covered by `text` + a trivial tone (level info|warning|error → options-free prose). No options/fields/diff needed.
- **Saved note**: FULLY/PARTIALLY covered by `text` — payload is `buildBtwMessageContent(question, answer)` (prose Q&A); the structured `BtwDetails` is metadata, not interaction content.
- **Degraded-mode warning**: FULLY covered by `text` (one-line prose notify).

## 3. GAPS (to JSON fallback)

The structure that resists all four primitives is the transcript entry stream:

```ts
type BtwTranscriptEntry =
  | { id; turnId; type: "turn-boundary"; phase: "start"|"end"; outcome?: "completed"|"aborted"|"failed" }
  | { id; turnId; type: "user-message"; text: string }
  | { id; turnId; type: "thinking"; text: string; streaming: boolean }
  | { id; turnId; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | { id; turnId; type: "tool-result"; toolCallId; toolName; content: string; truncated: boolean; isError: boolean; streaming: boolean }
```
(btw.ts:252-272) — plus status strings like "⏳ running tool: <name>" (btw.ts:1866). `BtwDetails` (btw.ts:203-214) also carries `usage?: AssistantMessage["usage"]`, `provider`, `model`, `workspaceIdentity` — session metadata, not interaction. None motivate a *new* primitive unless the pending-interaction record must reproduce live streaming previews; if so, a generic "stream/entry-list" primitive would cover them.

## 4. PERSISTENT STATE

- **Hidden BTW thread** — `pi.appendEntry(BTW_ENTRY_TYPE, details)` (btw.ts:2832, details = `BtwDetails[]` thread), plus reset (`BTW_RESET_TYPE`, {timestamp, mode} btw.ts:2615), model override (`BTW_MODEL_OVERRIDE_TYPE` union btw.ts:228), thinking override (btw.ts:232), and mode (contextual|tangent|readonly, btw.ts:195). Rendered by the overlay modal on rehydrate; survives reload/restart (README "Hidden BTW thread state"); NOT in LLM context.
- **Visible `btw-note`** — custom message in session transcript, rendered by pi's core renderer; written once.
- **Transient chrome**: status line, composer draft, overlay width mode (window|full, btw.ts:178) — module-level vars (`overlayStatus` 1758, `overlayDraft`), restored across overlay reopens but not durable across restart.

## 5. VERDICT

Interaction *volume*: the extension is overwhelmingly a self-contained bespoke widget + free-text loop. Of human-touchable payloads: toasts/warnings (~most notify volume) ≈ 100% `text`; saved notes ≈ `text`+JSON metadata; the overlay itself ≈ 0% without a widget primitive — arguably ~70% covered counting text-only notify/note traffic, ~30% counting overlay presence as one interaction kind. The single most valuable missing primitive is not among the four: a **transcript/entry-stream** primitive (typed rows: user/assistant/thinking/tool-call/tool-result with streaming + truncation flags — payload above from btw.ts:252-272). options/fields/diff are entirely unused by this extension — it is a valid control case: zero choice-buttons, zero forms, zero diffs.
