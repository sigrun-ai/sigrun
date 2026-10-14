# pi-interview-tool — interaction-shape inspection

## 1. KINDS

All interaction flows through ONE tool, `interview` (`index.ts`, README "How It Works"). The agent writes a questions JSON file and calls the tool; a local HTTP server (`server.ts`) serves an HTML form rendered in Glimpse (macOS WKWebView), a browser tab, or an Orca tab.

- **Interview questionnaire** — trigger: agent calls `interview({questions, timeout?, async?})`. Human sees: a multi-question form (title/description + question cards). Blocking: synchronous mode blocks the tool call until submit/cancel/timeout; `async: true` returns immediately (`index.ts:1213` "Interview <id> started: <url>… answer will arrive later"). Durability: transcript record (tool result text of `Response` values, `index.ts` response format) + optional HTML snapshot in `~/.pi/interview-snapshots/` (`autoSaveOnSubmit`).
- **Async completion message** — `Interview <id> finished.\n\n<text>` injected as a new-turn message (`index.ts:1182`). Blocking: no. Durability: transcript message.
- **Timeout overlay** — in-form warning letting the user stay or close (README "Timeout behavior"). UI-only, transient.
- **Escape×2 cancel overlay** — quick cancel; returns `null` to agent. Transient.
- **Queue toast switcher + session status bar** — multi-agent queue dropdown; status bar shows project path/git branch/session ID (README "Multi-agent behavior"). UI-only, per-form.
- **"Ask about an option" inline assistant panel** — per-option LLM chat with prompt chips + model overrides (README features). UI-only; analysis auto-saved into the form state (localStorage).
- **Generate more / Review options buttons** — agent-side LLM extension of the option list (`server.ts:1421 return { options }`). UI-only.

Question kinds inside the form: `single`, `multi`, `text`, `image` (upload/camera/path), `info` (non-interactive panel) — `Question` type, `schema.ts`.

## 2. MAPPING

Main payloads from `schema.ts` / `server.ts:190`:

```ts
interface Question { id: string; type: "single"|"multi"|"text"|"image"|"info";
  question: string; options?: OptionValue[]; recommended?: string|string[];
  conviction?: "strong"|"slight"; weight?: "critical"|"minor";
  context?: string; content?: ContentBlock; media?: MediaBlock|MediaBlock[]; }
interface ResponseItem { id: string; value: ResponseValue; attachments?: string[]; }
```

- **single/multi** → `options` FULLY (labels) + PARTIALLY (rich options carry `content: ContentBlock`, recommendation metadata: `recommended`, `conviction`, `weight`).
- **text** → `text` FULLY.
- **image / attachments** → NOT AT ALL (no file-upload primitive; `attachments?: string[]`).
- **info** → `text` FULLY (prose + context string).
- **content code/diff blocks** → `diff` PARTIALLY for `lang: "diff"`; markdown/code blocks only PARTIAL via text (lose `lang`, `file`, `lines`, `highlights`, `showSource`).
- **media** (image/chart/mermaid/table/html, `MediaBlock`) → NOT AT ALL.
- **dialog chrome** (timeout, toast, status bar) → `text` PARTIAL at best; they're UI surfaces, not payloads.

## 3. GAPS (fall to JSON fallback)

- `media: MediaBlock` — `type: "image"|"chart"|"mermaid"|"table"|"html"` with `chart: {type, data, options}`, `table: {headers, rows, highlights}`, `position`, `maxHeight` (schema.ts). Charts/mermaid/html have no primitive.
- `attachments?: string[]` on responses (server.ts:193) — human-supplied images.
- `recommended` / `conviction` / `weight` — recommendation pre-selection & prominence semantics; options have `{id,label,tone}` only.
- `content: ContentBlock` on rich options — `{source, lang, file, lines, highlights, showSource}`; only diff-ish content maps to `diff`.
- `image` question type itself (upload interaction).
- Inline `Optional clarification...` per-option note field (README "Option Clarifications").

## 4. PERSISTENT STATE

- **localStorage auto-save** of in-progress answers (README) — browser-side, restored on reload; survives timeout.
- **Recovery files** `~/.pi/interview-recovery/{date}_{time}_{project}_{branch}_{sessionId}.json`, 7-day cleanup (README "Session Recovery").
- **Snapshots** `~/.pi/interview-snapshots/{title}-{project}-{branch}-{ts}[-submitted]/index.html + images/` — self-contained HTML with embedded JSON; revivable by re-passing the path to `interview` (README "Saving Interviews"). Rendered by the form itself; created at save/submit.
No statusbars/banners outside the form; nothing persists into pi beyond the transcript.

## 5. VERDICT

~55–65% of interaction volume covered by {text, options, fields, diff}: the dominant `single`/`multi`/`text`/`info` questions map cleanly. The biggest structural miss is **recommendation metadata** (`recommended`/`conviction`/`weight`) on options — extend `options[]` entries with `{recommended?: boolean, conviction?, weight?}` rather than a new primitive. The most valuable MISSING primitive is a **media/attachment** primitive (`MediaBlock` + response `attachments: string[]`): images, charts, mermaid, tables, and human file uploads otherwise all degrade to opaque JSON, which for an interview tool is a large share of its differentiating value.

---
*Inspection only; no code executed.*
