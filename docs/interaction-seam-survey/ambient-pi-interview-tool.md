# pi-interview-tool — ambient surfaces inspection

Ambient surface inventory for `pi-interview` (interview form tool). The tool's "UI" is a web form (Glimpse WKWebView/browser); in-terminal surfaces are tool render call/results only.

## 1. SURFACES

**S1. Session status bar** — top strip of the form: `form/index.html:16-19` (`div.session-bar` with `#session-project`, `#session-id`). Static project path + git branch + session id; populated once at page load (form/script.js); fixed width with main content (not fixed-budget). Trigger: tool invocation opening a form. Persistence: rendered from server-provided page data; snapshots (HTML save) embed it. No migration semantics; replaced on reload via localStorage auto-save answer state.

**S2. Countdown badge** — corner circular gauge: `form/index.html:77-83` (SVG ring + `countdown-value`); update loop `form/script.js:120-177` (per-second tick, second-aligned; `~96%` idle-render reduction per CHANGELOG.md:59). States: `minimal` (≤120s expands), `urgent` (≤30s), hidden on expiry (`script.js:212`). Trigger: form open; resets on activity (`refreshCountdown` script.js:194-199). Expiry drives modal expired overlay w/ close-countdown (`script.js:201-231`). In-memory only, page lifetime.

**S3. Queue toast switcher** — top-right toast: `form/index.html:85-97` (`#queue-toast` with dismiss ×, `select#queue-session-select`, "Open" button). Trigger: poll of `GET /sessions?session=<token>` every 6s (`pollQueueSessions` / `startQueuePolling` script.js:340-358); server side `server.ts:1545-1548` reads `~/.pi/interview-sessions.json` registry (`SessionEntry` server.ts:33-41; 30s stale prune, 10s server keep-alive tick server.ts:2132-2135). Dismissed via ×; hidden when no other sessions (script.js:288-292).

**S4. Save toast** — transient notice with save path: `form/index.html:117` (`#save-toast`, aria-live). Trigger: manual Save button or auto-save-on-submit; auto-hides after short timer. In-memory.

**S5. Tool result panel (in-terminal)** — keyed text rows rendered by renderResult, `index.ts:1674-1705`: status line `STATUS (N responses)` color-mapped completed=success / cancelled|timeout|queued=warning / else error, plus QUEUED/STARTED headers with queuedMessage body; renderCall shows `Interview: <path>` (index.ts:1664-1666). Trigger: tool execution, re-rendered once on async delivery ("Interview <id> finished." → new turn). Persistence: pi session transcript. In-memory only per render.

No overlays outside modals (success/expired/camera dialogs are prompts, out of scope). No statusline API usage, no pi-side widget/tree primitives.

## 2. DATA MODEL

```ts
// server.ts:33-41
interface SessionEntry { id: string; url: string; cwd: string; gitBranch: string | null; title: string; startedAt: number; lastSeen: number }
// index.ts:324-327 (tool details)
status: "completed" | "cancelled" | "timeout" | "aborted" | "queued" | "started";
queuedMessage?: string;
```
Form-side DOM shapes: `countdown` = {secondsLeft, totalSeconds, ringProgress(strokeDashoffset)}; queue toast labels built in `formatSessionLabel` (script.js:276-282): `"Active|Waiting: <title> — <cwd+branch> · <timeAgo>"`, truncated to 36/32 chars.

## 3. INTERACTIVITY
- S1: read-only.
- S2: read-only; expiry escalates to interactive "Stay" button (`#stay-btn`, script.js:4078).
- S3: INTERACTIVE — dropdown select + Open button switches to another queued interview (navigates/reloads active form); × dismisses toast (state replacement, not deltas).
- S4: read-only.
- S5: read-only text; humans operate on theRESULT via the form, never through the terminal surface.

## 4. MAPPING
- S1 (status bar): B fully (label + detail as a one-line widget row; no status glyph needed) — placement is form-top, not aboveEditor-envelope.
- S2 (countdown): C fully (gauge: label "remaining", percent ring, phase=urgent, elapsed≈timeout−remaining). Progress ring = the canonical gauge.
- S3 (queue toast): D partially (session list with status enum active/waiting, labels, relative time). Missing: interactive open/dismiss actions carry through the envelope only if D's banner/toast variant permits interactive affordances.
- S4 (save toast): A fully (statusline text {key:"save", text:"Saved to …"}).
- S5 (result panel): B fully (label, statusGlyph per enum, detail=queuedMessage) — but it lives in the tool-result channel, not an ambient panel.

Opaque fallback needed for: the form itself from the agent's perspective (whole web app is a channel beyond ambient scope); the SSVG ring (a bare percent works but loses the minimal/urgent visual ladder unless phase is honored).

## 5. VERDICT
Coverage ≈ **95%** by {A statusline, B rows, C gauge, D tree/list}: A covers S4 + delivered-state lines of S5; B covers S1 + S5; C covers S2; D covers S3's contents. Every surface's ENVELOPE (form placement, top-right toast, corner badge, urgency classes) must ride placement/budget/collapse metadata. Most valuable missing primitive: **interactive seek/switch action on a list row** (S3's "open this queued session") — payload {action:"open", url}; pure read-only D forces an opaque toast. Users consistently ACT on S3 (switch sessions, dismiss) and via S2's Stay button; the rest are read-only.
