# pi-ask-user interaction-shape inspection

Repo: /tmp/pi-ext-inspect/pi-ask-user (main source `index.ts`, 3349 lines; native-sheet bridge `tern.ts`).

## 1. KINDS

**K1. Interactive `ask_user` prompt (the only tool).** Trigger: agent calls `ask_user` (`index.ts:3023` registerTool). Human sees a boxed prompt (`ask_user` title, question, optional markdown context, option list, help line; `AskComponent` constructor ~line 870). Human does: navigate (`↑↓/tab/ctrl+j/k`), fuzzy-search type-to-filter (`WrappedSingleSelectList.searchQuery`, ~line 860), number keys 1-9, toggle multi-select checkboxes, toggle an "extra context" comment row (ctrl+g), open a freeform Editor ("Other" row), or cancel (esc). Blocking: yes — the tool call awaits the answer; emits `herdr:blocked {active:true,label:"Waiting for user response"}` while open (index.ts:2651). Durability: answer/cancel persisted in the tool result `details` (AskToolDetails/AskBatchDetails) plus the rendered tool card; the live UI itself is transient.

**K2. Batch of 2–4 questions** with per-question pages + a review page (tab/shift-tab, 1-4 jump; skip semantics; index.ts:2419-2428). Same interaction mechanics; one shared `timeout` deadline (index.ts:2912-2922). Blocking, durable via AskBatchDetails.

**K3. RPC/headless fallback dialogs** — `ui.select()` / `ui.input()` sequence (askViaDialogs, index.ts:2500-2600), incl. optional comment input; same blocking semantics, no review page. No diff preview, no split pane.

**K4. Native Tern sheet** (pi-tern present): the prompt re-rendered as a clickable ChoiceList sheet with question tabs, review page, action bar (`tern.ts` choiceSheet/reviewSheet; ChoiceRow `{id, kind:"option"|"comment"|"freeform", label, detail?, on?}`). Blocking via the same tool; rendered in the Tern pane. No new payload semantics.

**K5. Tool-call/result widgets** — `renderCall`/`renderResult` (index.ts:3247+): static transcript rendering of the question, option count/labels, `[multi-select]`/`[optional comment]` flags, ✓ answer or Cancelled. Non-blocking, durable (in transcript).

**K6. Status surface:** `herdr:blocked` true/false event pair (transient, no UI of its own). Plus outcome events `ask:answered`/`ask:cancelled` with `{question, response:{kind}}` payloads (README Events; full payload only with `PI_ASK_USER_EMIT_FULL_EVENTS=true`).

Timeout: auto-dismiss returns `null` → cancelled details (README "timeout"; index.ts:2702-2703).

## 2. MAPPING to {text, options, fields, diff}

- **K1/K2/K3 selection mode** — text (question+context) FULL; options FULL: `{title, description?}` maps to `{id,label}` + extra `description` (partial on description → falls to details). Payload (README Result details):
  ```ts
  interface AskToolDetails { question: string; context?: string; options: QuestionOption[]; response: AskResponse | null; cancelled: boolean; }
  type AskResponse = { kind:"selection"; selections: string[]; comment?: string } | { kind:"freeform"; text: string };
  ```
- **Freeform mode** — text FULL (single `fields:[]` string field could cover it).
- **Comment toggle** — PARTIALLY options; the boolean on/off toggle is `fields`-shaped but it's an in-list row, not a form.
- **K4 Tern sheet** — options PARTIAL (adds `{kind, on?, query}` per row + tabs: `ChoiceList {rows, selected, query}` in tern.ts:103). Multi-select "on" state → options+multi primitive.
- **K5 render widgets** — NOT covered (presentation-only; falls to JSON fallback but harmless).
- **K6 events** — NOT covered by any primitive (see GAPS).
- **diff** — NOT USED anywhere in the extension. Zero diff payloads.

## 3. GAPS (fall to JSON fallback)

- `timeout?: number` (AskParams, index.ts:166) — auto-dismiss deadline.
- `herdr:blocked` lifecycle: `{ active: boolean; label: string }` (index.ts:2651/2655) — blocked-state channel, not an interaction payload per se.
- Outcome events with batch position: `{ ...payload, batch: { index: number; total: number } }` (README Events).
- AskBatchDetails: `answers: Array<{status:"answered"; response} | {status:"skipped"}>` — a *skipped* answer state has no primitive.
- Search/filter affordance: `query` in nativeSheet ChoiceList — no primitive expresses "searchable list".
- `allowMultiple`, `allowComment`, `allowFreeform`, `displayMode`, `singleSelectLayout` — behavioral flags, not payload content (covered implicitly by options+fields+text semantics).

## 4. PERSISTENT STATE

Beyond the per-interaction `details` (which pi persists in session transcripts), there is **no standalone state surface**: no todo/goal/counter widgets, no statusbar, no banners, no on-disk storage. The only recurring renders are the static `renderCall`/`renderResult` transcript cards and the transient overlay; `herdr:blocked` is stateless event emission.

## 5. VERDICT

**~95% of interaction volume** is covered by {text, options, fields}: every ask is question text + option list + optional freeform/comment (fields). diff is never used. The single most valuable missing primitive is nothing structural — the notable extras are *metadata*: a **timeout/auto-dismiss attribute** (`timeout?: number`) on the interaction record, and a **skipped/timeout outcome state** (AskBatchDetails `{status:"skipped"}`) distinct from cancelled. If a fifth primitive is wanted, a lightweight **blocked-status flag** `{active, label}` (mirroring herdr:blocked) would let a channel-neutral record represent "waiting for human" without JSON fallback — but text+options+fields already cover the answer payload itself.
