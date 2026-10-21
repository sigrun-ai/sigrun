# U5 — Blocks in Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent can put interactive blocks in chat (`show_blocks`), keep them current (`update_blocks`), and the user's edits are saved silently and summarised to the agent before its next turn, while answers (`submit`, or `turn: true`) start exactly one turn.

**Architecture:**
- A `show_blocks` call appends a typed `sigrun.blocks` entry; its live state is a conversation-scoped document family `sigrun.blocks.state`, keyed by entry id, `history: "latest", fork: "current"` (ruling 19).
- **Chat surfaces reuse U3's machinery** (routes, access cache, watcher registry, action dedup), addressed by `(conversationId, entryId)`. Core is the action handler: it applies moves, checks and edits itself and appends change records.
- **The note step lives where turns are admitted.** Core-hardening already funnels the composer route and W5's `host.conversations.submit` through `submitOp` (`src/server/conversation-ops.ts`); W4's `fireJob` (`src/jobs/fire.ts`) calls `conversation.submit` directly in two places. A new `writePendingNote` runs immediately before each of those three `conversation.submit` calls. Block answers go through `submitOp`, which gains an `entry` option for the `InputEntry`.

**Tech Stack:** pi-durable 1.3.0 (release Task 0; `defineEntry`/typed entries, `defineDocFamily`, `SubmissionDraft` with `requestId` and `InputEntry`, `submissionByRequest`), U0 (`validateTree`, `applyOps`, `toText`), U3 (surface service).

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §8 (all), §6.2–§6.4 (chat rows), ruling 19, §16 (Chat blocks).

**Depends on:** U0, U1, U2, U3.

## Global Constraints

- Tools: `show_blocks {title: string, tree: Tree, data: JsonObject}` → result text = `toText(tree, data, {width: 100, locale: <server locale>})` + `\nentryId: <id>`; `update_blocks {entryId: string, ops: DataOp[]}` → result text = the post-update projection.
- Placement `chat`; limits 200 blocks / 256 KiB tree / 256 KiB data. Handler names in chat are free labels (no `handlers` set passed to `validateTree`).
- Entry kind `sigrun.blocks` (data `{title, tree, data}`, immutable). Note entry kind `sigrun.blocks.note`. Answer input entry kind `sigrun.blocks.answer`.
- State family `sigrun.blocks.state`, conversation scope, `history: "latest"`, `fork: "current"`, keyed by entry id: `{rev: number, data: JsonObject, changes: ChangeRecord[], notedThrough: number}`; `ChangeRecord = {seq: number, at: number, by: string, action: string, summary: string}`. Trim records at or below `notedThrough` once more than 50 accumulate.
- Chat routes: `GET /v1/conversations/:id/blocks/:entryId` (`{tree, data, rev, treeRev: 0, access}`), `GET …/data?since=`, `POST …/actions`. Access = the conversation's (`read`/`write`; hidden = 404). Chat data is shared by everyone who can see the conversation, so ops are kept like `sharedData`.
- Events: `surface.changed {conversation, entry, rev}` to watchers of that conversation's block.
- Note `requestId`: `blocks-note:<conversationId>:<sha256 of the sorted (entryId, notedThrough) pairs before advancing>`.
- Answer `requestId`: `blocks:<actionId>`.
- Note text, per surface: `• <title> (<user>): <summaries joined by "; ">` then `Current state of <title>: <toText of each changed collection>`; more than 50 lines per surface → the oldest become "…and N earlier changes". Header line: `Changes made to your UI since your last turn:`.
- Tool description sentence (verbatim): "Interactive elements save the user's edits silently; you'll receive a summary of edits at your next turn. A `submit` sends you the result immediately; set `turn: true` on a `move` or `edit` only if each one needs an immediate reply."

## Review Focus

1. **The user edits a block while the agent is mid-run and then steers** — the note and the steer both queue; the agent sees the note first at the next boundary; no second note is written for the same changes afterwards. Owner: Task 4.
2. **`update_blocks` with ops written against indexes the user has since moved** — the ops apply to current data (or fail with `DataOpError`), and the tool result shows the actual resulting state so the model can correct itself. Owner: Task 1.
3. **A shared conversation where alice and bob both edit** — each change record names its author, and both appear in one note. Owner: Task 2.
4. **Answering a block in a conversation the user can only read** — 403, nothing submitted. Owner: Task 3.
5. **Forking while a move is pending in the channel** — the fork copies confirmed state only; the pending move completes in the parent. Owner: Task 5.

---

### Task 1: Entries, state family, `show_blocks` and `update_blocks`

**Files:**
- Create: `src/harness/blocks/entries.ts` (`BlocksEntry`, `BlocksNoteEntry` tokens), `src/harness/blocks/state.ts` (`BlocksStateDoc`), `src/harness/blocks/tools.ts` (the two tools in a core pi-durable extension `sigrun.blocks`)
- Modify: `src/harness/boot.ts` (install the extension for every agent)
- Test: `test/blocks-chat-tools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BlocksEntry: Entry<{ title: string; tree: Tree; data: JsonObject }>;   // kind "sigrun.blocks"
  export const BlocksStateDoc: ConversationDocFamilyToken<BlocksState, string>;     // kind "sigrun.blocks.state"
  export interface BlocksState { rev: number; data: JsonObject; changes: ChangeRecord[]; notedThrough: number }
  export function readBlocksState(harness: Harness, conversationId: number, entryId: string, ctx: Context): Promise<BlocksState | undefined>;
  ```

- [ ] **Step 1: Write failing tests** (faux provider scripting tool calls):
  - a valid `show_blocks` appends one `sigrun.blocks` entry and creates state `{rev: 0, data, changes: [], notedThrough: 0}`; the tool result is the `toText` projection plus `entryId`;
  - an invalid tree (a `secret` field; 201 blocks; `chart` with `x.kind: "nope"`) returns a tool error listing each JSON path, and appends nothing;
  - `update_blocks` applies ops, increments `rev`, records no change record, publishes `surface.changed`, and returns the new projection;
  - Review Focus 2: after a simulated user move, an `update_blocks` op targeting the old index applies to current data and the returned projection shows the resulting order; an op on a missing path returns a tool error naming the op index;
  - `update_blocks` on another conversation's entry id → tool error "no such block in this conversation".
- [ ] **Step 2: Run** `npx vitest run test/blocks-chat-tools.test.ts` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "chat blocks: sigrun.blocks entries, state family (latest/current fork), show_blocks and update_blocks tools"`.

### Task 2: Chat surface routes, edits and change records

**Files:**
- Create: `src/server/blocks/chat-surfaces.ts` (adapts a chat block to U3's `SurfaceService` with core as handler), `src/server/blocks/summaries.ts` (change-record summaries from the tree)
- Modify: `src/server/routes/surfaces.ts` (mount the chat routes), `src/server/surfaces/service.ts` (an address type covering both `{slug, id, key}` and `{conversationId, entryId}`)
- Test: `test/blocks-chat-routes.test.ts`, `test/blocks-summaries.test.ts`

**Interfaces:**
- Produces: `export function summarizeAction(tree: Tree, data: JsonObject, action: Action, payload: JsonValue): string;`

- [ ] **Step 1: Write failing tests:**
  - the routes return the block for a `write` principal, `404` for a hidden conversation, and `403` on actions for a `read` principal;
  - `move` on a `reorder` list applies `DataOp.move`, bumps `rev`, appends `{seq: 1, by: "alice", action: "reorder", summary: "moved 'Clair de Lune' from 4th to 1st in 'Ranking'"}`, and returns `{ok: true, rev, ops}`;
  - a cross-group move also sets the item's `groupBy` field; a check appends "checked 'milk' in 'Shopping'"; a `turn: false` submit writes the form values at its `bind` and appends "set 'Notes' to '…'" (values over 80 characters truncated with `…`);
  - Review Focus 3: alice and bob each move once → two records with their own `by`;
  - a duplicate `actionId` applies once;
  - more than 50 records with `notedThrough` past them are trimmed on the next append.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Summaries use the labels the user saw: the item's `title` slot value, its 1-based position, the group's `title`, and the field's `label`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "chat blocks: surface routes with core as handler; moves, checks, edits; authored change records"`.

### Task 3: Change notes in the submit path, answers

**Files:**
- Create: `src/server/turns/submit-turn.ts`, `src/server/blocks/notes.ts`, `src/server/blocks/answers.ts`
- Modify: `src/server/conversation-ops.ts` (`submitOp` calls `writePendingNote` before `conversation.submit`; `SubmitOpOptions` gains `entry?: InputEntry` and `skipNoteFor?: string`), `src/jobs/fire.ts` (both `conversation.submit` call sites call `writePendingNote` first)
- Test: `test/blocks-notes.test.ts`, `test/blocks-answers.test.ts`, `test/submit-turn-callers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function writePendingNote(harness: Harness, conversation: Conversation, skipEntry: string | undefined, ctx: Context): Promise<void>;
  export function pendingNote(harness: Harness, conversationId: number, skipEntry: string | undefined, ctx: Context):
    Promise<{ text: string; requestId: string; advance: { entryId: string; through: number }[] } | undefined>;
  ```
- `writePendingNote` order: compute `pendingNote`; if present, `conversation.submit({type: "write", entry: {kind: "sigrun.blocks.note", model: [userMessage(text)]}, requestId})`, then advance each `notedThrough` in one commit. The caller then submits the input.

- [ ] **Step 1: Write failing tests** (the §8.5 ranking example end to end with the faux provider):
  - three moves make no turns (submission count unchanged);
  - the next composer message produces, in order, one `sigrun.blocks.note` entry whose model text matches the §8.3 format with the full current order, then the user entry;
  - a fourth message with no new edits writes no note;
  - "Use this order" (`submit`, `turn` default) produces one input submission with `content` "Submitted 'Ranking': 1. … 2. …", `entry.kind === "sigrun.blocks.answer"`, `entry.data` `{entryId, action, payload, state}`, `requestId: "blocks:<actionId>"`, and folds that surface's unnoted changes into `content`; no note is written for that surface; a pending change on a *different* block in the same conversation still gets a note;
  - a double click (same `actionId`) makes one turn;
  - crash between the note write and `notedThrough` advancing (inject a throw after admission), then a new edit, then another message: the retry computes the same `requestId` from the pre-advance positions, pi-durable returns the existing submission, and exactly one note entry exists;
  - Review Focus 1: with the agent busy (faux provider holding a tool call), an edit followed by a steer queues the note write and the steer; at the boundary the note entry is placed before the steer entry;
  - Review Focus 4: an answer from a `read` principal → 403, no submission;
  - every turn starter writes pending notes: the composer route and `host.conversations.submit` (both via `submitOp`) and `fireJob` on a fixed-conversation job (spy on `writePendingNote`); a grep-style test asserts `conversation.submit(` with `type: "input"` appears in `src/` only at those three call sites, so a new turn starter can't skip notes silently.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "chat blocks: change notes written before every turn admission (submitOp, fireJob) with a stable requestId; block answers as InputEntry turns"`.

### Task 4: Transcript rendering and transports in both channels

**Files:**
- Create: `webui/src/entries/BlocksEntry.tsx`, `webui/src/blocks/chatTransport.ts`, `tui/src/blocks/chat-transport.ts`
- Modify: `webui/src/entries/TurnList.tsx` / `ToolResultEntry.tsx` (a `show_blocks` call whose result names an `entryId` renders as the surface, not a tool row; `sigrun.blocks.note` entries render as a collapsed "UI changes sent to the agent" row; `sigrun.blocks.answer` inputs render as the user's message with a "from <title>" chip), `tui/src/ui/conversation-pane.ts` (same three)
- Create: `webui/e2e/chat-blocks.spec.ts`
- Test: `webui/src/entries/BlocksEntry.test.tsx`, `tui/test/conversation-pane.test.ts` (extend)

- [ ] **Step 1: Write failing tests:** the block renders inline in the chat column in its compact class (a 60 rem window still renders the chat column's compact fallbacks); the tool row is not shown; a `read` viewer sees no drag handles; the note row is collapsed and expands to the note text; Playwright: drag the ranking list in one tab, the second tab (same user) updates within 2 s, then "Use this order" produces exactly one user turn in the transcript.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** webui, TUI and e2e suites — PASS.
- [ ] **Step 5: Commit** `git commit -m "chat blocks: inline rendering, note and answer rows, transports in webui and TUI"`.

### Task 5: Forks

**Files:**
- Test: `test/blocks-fork.test.ts` (and whatever fix the tests force in `src/harness/blocks/state.ts`)

- [ ] **Step 1: Write failing tests:**
  - create a ranking block at entry E1, add messages E2 and E3, move items (state rev 3), then fork from E2: the child's block (E1 is in its history) shows the rev-3 state, `changes` and `notedThrough` exactly as in the parent at fork time;
  - after the fork, a move in the child doesn't change the parent and vice versa;
  - a block created at E3 (after the fork point) is not addressable in the child (`404` from the chat route), even though its state document was copied;
  - Review Focus 5: a move still unanswered in the channel at fork time is absent from the child, and lands in the parent when the handler answers;
  - a `since` fetch against the child with a parent-era `rev` returns full data (the child's op log starts empty).
- [ ] **Step 2: Run** — FAIL or PASS (state is declared `fork: "current"` in Task 1; fix anything the tests expose).
- [ ] **Step 3: Run** the full gate: `npm test && npm run typecheck && npm --workspace @sigrun/webui run test && npm run typecheck:webui && npm run build:webui && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck && npm run test:e2e` — PASS.
- [ ] **Step 4: Commit** `git commit -m "chat blocks: fork tests (state as of fork creation, then divergence)"`.
