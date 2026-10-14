# Plannotator (@plannotator/pi-extension) — user-interaction shapes

Repo: `/tmp/pi-ext-inspect/plannotator` (monorepo; Pi extension at `apps/pi-extension/`, shared core at `packages/core/`). All interaction is (a) inline-terminal surfaces for the human in Pi, plus (b) external browser/web-UI handoffs whose decision returns as a new message.

## 1. KINDS
- **Plan-review handoff** — trigger: agent calls `plannotator_submit_plan`; extension opens browser UI (`apps/pi-extension/README.md`). Human sees plan markdown + Plan Diff; human acts: Approve / Deny / Approve with notes (buttons). NON-blocking (README: "does not wait for you... returns as soon as the review opens"). Persistent: result `{ reviewId, approved, feedback, savedPath?, agentSwitch?, permissionMode? }` on `plannotator:review-result` (`apps/pi-extension/plannotator-events.ts:84`), is stored (archive browser, `ArchivedPlan.status: "approved"|"denied"` at `packages/core/storage-types.ts:1`).
- **Code-review handoff** — `/plannotator-review`; browser diff UI; human annotates diff lines + submits feedback → `PiReviewDecision { approved: boolean; feedback?: string; exit?: boolean; platform?: boolean }` (`apps/pi-extension/review-outcome.ts:1`). Non-blocking. Persistent via same archive.
- **Markdown/annotate/last-message handoff** — `/plannotator-annotate`, `/plannotator-last`, same flows; returns feedback textified as `Plannotator: notes.md (pn-3f2a9c) — Feedback · 2 comments.` Non-blocking; persistent annotation records.
- **plannotator tool / inbox tool (agent→in person)** — `plannotator-tool-host.ts` registry lists open reviews; `plannotator_inbox` tool (`packages/core/inbox-types.ts`) spawns long-lived message threads.
- **Terminal surfaces (in-tui)**: `ctx.ui.notify(msg, type)` notices (many, `apps/pi-extension/index.ts:219,614,978,999…`), `ctx.ui.setStatus("plannotator", label)` phase/status line (index.ts:553-562), and `ctx.ui.setWidget("plannotator-progress", lines)` checklist progress widget (index.ts:577-579) — transient, UI-only.
- **Inbox threads** — persistent server: `InboxMessage { id, project_id, thread_id, author:{kind:"person"|"agent"}, subject, body, …, set_aside?, reopened? }` (`packages/core/inbox-types.ts` ~line 390 region); append-only JSONL under `${dataDir}/inbox/` (inbox-types.ts header comment).
- **Inbox questions** — parsed from markdown directive blocks: `ParsedQuestion { kind: 'single'|'multi'|'text', prompt, context, choices: QuestionChoice[], recommendation?, decision?, replaces? }` (`packages/core/question-block.ts:94-141`); answered by `QuestionAnswer { v:1, key, kind, prompt, selected: string[], other?, text?, note?, skipped?, by_reply?, sourceLine? }` (question-block.ts:849). Blocking-capable via `wait_for_reply`; durable (per-question `InboxQuestion` records).

## 2. MAPPING
- Plan/code/annotate decisions: **text FULLY** (feedback is a string); the approve choice is options-like but delivered out-of-band. Result payloads are plan previews = text; **diff PARTIALLY** for code review/Plan Diff (diff exists but not as a payload primitive — the review UI pulls from files/PRs; `patchFile` is a path, not payload).
- `ParsedQuestion`+`QuestionAnswer`: single/multi = **options PARTIALLY** (choices carry `label, description?, aliases?, settled, recommended` — far richer than `{id,label,tone}`); `text` kind = fields-like but answer shape also has `other`, `note`, `skipped` → **PARTIAL/NOT**.
- `notify`/status: text FULLY (one-way); status is not a pending interaction at all.
- Inbox attachments: `InboxAttachment { kind: "markdown"|"text"|"html"|"mermaid"|"graphviz"|"code"|"image"|"pdf"|"file", … }` (`packages/core/inbox-attachments.ts:47-68`) — **NOT AT ALL**.
- Annotations: `InboxAnnotationRecord { path, version, guide?, annotation: Record<string,unknown>, … }` (inbox-attachments.ts:132) — anchored inline comments; **NOT AT ALL** (opaque annotation object).
- Guided snapshots: `InboxGuideRef { sha256, input_sha256, bytes, title, sections }` (inbox-types.ts:346) — **NOT AT ALL**.

## 3. GAPS → JSON fallback
- Question meta: `aliases`, `settled`, `recommended`, `decision`/`decisionOnAnswer`, `replaces[]`, `suggestedText` (question-block.ts:96-141) — decision linkage is unrepresentable.
- Answer extras: `other`, `note`, `skipped`, `by_reply`, `sourceLine` (question-block.ts:849-878).
- Attachment kinds incl. `image`/`pdf`/`mermaid` (inbox-attachments.ts:47).
- Anchored comments: `annotation: Record<string, unknown>` bound to `path` + `sourceLine`/`version` (inbox-attachments.ts:116-150) — the extension's centerpiece (inline comment anchoring) = rich text-selection-position record, no primitive fits.
- Thread bookkeeping: `set_aside`, `reopened`, `person_seen_seq`, `superseded_by` (inbox-types.ts).

## 4. PERSISTENT STATE
- Inbox JSONL store `${dataDir}/inbox/` append-only, one full snapshot per line, `INBOX_RECORD_VERSION=1` (inbox-types.ts:14,23) — rendered by Plannotator web window/phone; updates on send.
- Review registry: per-Pi-process global registry (`pi-tool-host.ts:~200` `__plannotatorPiReviewRegistry_v1`) of open reviews keyed by Pi session id; survives `/reload`.
- Plan archive: `ArchivedPlan[]` in Plannotator data dir (storage-types.ts).
- Terminal widget/status: `ctx.ui.setWidget("plannotator-progress")` + `setStatus` (index.ts:577), transient, updated per checklist tick, todo-provider sync optional (index.ts:611).

## 5. VERDICT
~25-35% coverage by {text, options, fields, diff}: raw decision/feedback text is covered, but the extension's human value is anchored-comment annotation records, attachment-mediated review, and enriched question blocks — none fit. Most valuable missing primitive: an **anchored comment/annotation record** `{targetPath/id, range|line anchor, commentThreadId, status}` motivated exactly by `InboxAnnotationRecord.path+version+annotation` and `QuestionAnswer.sourceLine`. Second-best: a richer choice type (label+description+recommended/settled) for `QuestionChoice`.
