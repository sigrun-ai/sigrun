# rpiv-ask-user-question — interaction-shape inspection

Repo: `/tmp/pi-ext-inspect/rpiv-mono/packages/rpiv-ask-user-question` (reconnaissance only; no code executed).

## 1. KINDS

- **K1 — Questionnaire dialog (the whole extension).** Trigger: the model calls the `ask_user_question` tool (`ask-user-question.ts:120`, `ASK_USER_QUESTION_TOOL_NAME`). Human sees a tabbed terminal overlay of 1–4 questions (`MAX_QUESTIONS = 4`, `tool/types.ts:6`), each with a 16-char `header` chip, question text, 2–4 authored options (label + description, optional markdown `preview` pane), an auto-appended `Type something.` free-text row, a multi-select mode, per-question `n` notes, and a final Submit review tab with a submit/cancel picker. Human does: arrow/enter selection, multi-check, free text, notes, Esc decline, collapse (`ctrl+]`). **Blocking** (tool call awaits; emits `rpiv:ask-user:blocked {active, toolCallId}` during the wait — `events.ts:31-40`). Durability: transient UI, but a persistent record lands in the **tool result** (`details: QuestionnaireResult`, `tool/response-envelope.ts:buildToolResult`).
- **K2 — RPC/native-dialog walker.** Same tool on RPC/ACP hosts (Zed, VS Code pendant): walks host's native `ui.confirm`/`select`-style dialogs (`rpc-fallback.ts:runRpcQuestionnaire`); notes are terminal-only. Blocking; transient.
- **K3 — Outbound notice events.** `rpiv:ask-user:prompt` (questions payload, `hasPreview` instead of content — `events.ts:13-27`, `AskUserPromptQuestion/Option`) and `rpiv:ask-user:blocked` (`events.ts:31`). Non-blocking side-channels for external consumers; JSON-safe payloads by stability policy (`events.ts:6-17`).
- **K4 — Inbound external answer channel.** Listens for `rpiv:ask-user:answer {toolCallId, answers[]|globalNote|cancel}` and answers the open dialog programmatically (`events.ts:60-100`, `tool/external-answer.ts`); verdicts on `rpiv:ask-user:answer-result {ok, code, reason, requestId}`. Not a human surface per se, but it fully re-encodes the dialog's answer space (`optionIndexes`/`text`/`notes` per question).
- **K5 — Terminal attention bell.** One BEL byte on TTY when the wait begins (`ask-user-question.ts:97-107`). Transient, non-blocking.

## 2. MAPPING to {text, options, fields, diff}

Core payload (quoted from `tool/types.ts`):

```ts
OptionSchema = { label: string(≤60), description: string, preview?: string }
QuestionSchema = { question: string, header: string(≤16),
                   options: OptionSchema[2..4], multiSelect?: boolean }
QuestionAnswer = { questionIndex, question,
                   kind: "option"|"custom"|"multi",
                   answer: string|null, selected?: string[],
                   notes?: string, preview?: string }
QuestionnaireResult = { answers: QuestionAnswer[], cancelled: boolean,
                        globalNote?: string, unanswered?: number[], error? }
```

- K1 dialog: **options = PARTIAL** — labels/descriptions map to `{id,label,tone}` only loosely (no tone; `description` and `preview` overflow); question text = text ✓; per-question `multiSelect` and the auto free-text row are NOT covered (fields[] lacks multi-select semantics). Free-text answer path ≈ fields string. Verdict: PARTIAL.
- K1 answer record: `selected[]` (multi) → NOT AT ALL (no primitive expresses multi-select); `notes`/`globalNote` → fields-like PARTIAL (optional, untyped string).
- K1 option `preview` (markdown rendered in a preview pane): **NOT AT ALL** — degrades to JSON fallback.
- K2 RPC walker: covered same as K1 minus notes.
- K3 events: prompt payload ≈ text+options PARTIAL; `hasPreview` boolean has no primitive.
- K4 external answer: `{optionIndexes, text, notes}` → options+fields PARTIAL; multi `optionIndexes` NOT covered.
- K5 bell: NOT covered (opaque fallback is fine).
- `diff` primitive: **unused anywhere** in this extension.

## 3. GAPS (fall to JSON fallback)

- `preview?: string` markdown artifact per option (`tool/types.ts` OptionSchema) — the richest uncovered payload.
- Multi-select: `multiSelect?: boolean` on the question and `selected?: string[]` + `kind: "multi"` on the answer — no primitive expresses "check several of these".
- `header: string(≤16)` chip label per question (tab strip label).
- Notes: `notes?: string` per answer + `globalNote?: string` on the result.
- `unanswered?: number[]` partial-submit marking and `error?: QuestionnaireError` (10 error codes, `tool/types.ts`).
- Sentinels: reserved rows appended by the runtime ("Other"-like / next) via `SENTINEL_LABELS`/`ROW_INTENT_META` (`tool/types.ts:15-31`).
- Event plumbing fields: `toolCallId`, `requestId`, reject `code` enum.

## 4. PERSISTENT STATE

None beyond the tool call itself. No todos, counters, statusbars, or banners. All state is per-questionnaire in-session (TUI session object + reducer, `state/`), collapsed into the durable **tool result** record: `content[0].text` (human-readable envelope, `response-envelope.ts`) + `details: QuestionnaireResult` in the session transcript. Config is read-only at `~/.config/rpiv-ask-user-question/config.json` (README table; collapseKey + guidance fields) — never written, not an interaction surface.

## 5. VERDICT

~**70–75%** of interaction volume is covered by {text, options, fields}: question prose (text), 2–4 choice buttons (options), custom free-text answers (fields string), notes (optional fields string). The dominant single-question/single-select flow is nearly fully covered; multi-select questions, markdown previews, and the header/notes/sentinel metadata are the remainder.

**Most valuable missing primitive: multi-select options** — a `multi?: boolean` on options[] with the answer as `{selectedIds[], text?}`. Concrete payload motivating it: `QuestionSchema.multiSelect` + `QuestionAnswer { kind: "multi", answer: string|null, selected?: string[] }` and the external channel's `optionIndexes?: number[]` (`events.ts:88-96`). Second would be a per-option rich-content slot (`preview: markdown string`) rendered beside the list; a generic `details` fallback is acceptable for header/notes/error fields.
