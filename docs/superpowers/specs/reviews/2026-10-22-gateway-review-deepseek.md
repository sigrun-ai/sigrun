## Review

Scope: `docs/superpowers/specs/2026-10-22-sigrun-gateway-design.md` against the repo at HEAD (read-only). Every claim below was checked against source; `file:line` is the evidence. The known `/link`-vs-access-check issue is excluded per instructions.

---

### BLOCKER

**B1. §8.5 `/model` "no arg: show current and list served models" has no host seam — unimplementable as specced.**
C4 enumerates the new host methods (`abort/configure/compact/fork/patchMeta/upload/readFile` + `host.commands`) and none is a model catalog. `SigrunHost` has no `models` member at all (`src/extension.ts:400-520`); the catalog is reachable only as (a) the HTTP route `GET /v1/models` (`src/server/routes/providers.ts:230`) or (b) inside a *tool* invocation via `api.models` (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:161-162`). A gateway chat command runs from the inbound pipeline, not from a tool, so it has neither. `/model <ref>` can work (it just calls `configure`), but the "list served models" half cannot, and §10's C4 test list would silently not cover it.
*Fix:* add `host.models.list(): Promise<readonly ModelRefWire[]>` (or `host.conversations.models(id)`) to C4, and add it to §10's C4 parity list.

**B2. §8.7 "When the record settles from anywhere, the engine edits the prompt … to show the outcome and removes its buttons" has no seam to observe settlement.**
`interaction.settled` is emitted on the host event hub (`src/harness/event-bus.ts:960-967`) but is **not** a `NotificationEvent` type (`src/extension.ts:351` is `"interaction.pending" | "job.failed" | "run.settled"`) and `src/server/notifications.ts:236-243` handles only `interaction.pending`/`run.settled`/`job.changed`. Interaction records are a doc *family* (`src/harness/interactions.ts:64-75`) and the conversation view mounts only `Agent/Live/Inbox/Provider/Usage` (`node_modules/@earendil-works/pi-durable/dist/harness/view.js:13-19`), so `host.conversations.watch` cannot see them either. C6 adds `callId` to `interaction.pending` only. Consequence: prompts stay pending-looking with live buttons after a webui/TUI answer, and a tap on a stale button produces a spurious refusal reply.
*Fix:* extend C6 to `interaction.settled` (same `callId`), or add an explicit `host.interactions.onSettled(cb)`; either way make it part of §10's core tests.

**B3. C7/§8.8: stamping `deliver` onto a *shared, long-lived* conversation's `SessionMeta` makes delivery sticky and re-delivers every later run.**
C7 says `fire.ts` stamps `deliver` "for both `"new"` and existing-conversation actions"; §8.8 triggers delivery on "a conversation whose meta has `deliver`". For `action.conversation: <id>` that conversation is a normal user conversation that keeps running forever (`src/jobs/fire.ts:264-300` submits into it and writes **no** meta today). Once one job fires, every subsequent answer in that conversation — including the owner's webui replies and other jobs' runs — is fanned out to the job's chat targets, with no clearing rule anywhere in the spec. That is a lost/duplicated delivery path plus a privacy leak, in the exact feature ruling 4 scopes ("cron-to-adapter").
*Fix:* key delivery to the run, not the conversation — e.g. stamp `{deliver, jobId, fireAt}` and have the engine match `runSettled`'s run identity, or clear the field at settle. §8.8 and C7 both need the wording.

---

### MAJOR

**M1. §8.0/§8.12 `health` claim is false about the current code.**
"`health` | the §8.12 health rule, read synchronously from engine state" implies a gateway health surface exists. It does not: factory-result `health` producers are consumed in exactly two places — identity-matched to the *memory owner* (`src/harness/boot.ts:884-886`) and folded into `health.providers` via `collectProviders` (`src/harness/boot.ts:910-914` → `src/harness/providers/index.ts:270-274`). `MetaResponse.health` has exactly `backup | memory | providers` (`src/server/routes/meta.ts:72-76`), and §8.12 says health is "`degraded` when …" — which would make the **providers** field degrade on a gateway adapter backoff, misattributing the cause.
*Fix:* either add a `health.gateway` slot in core (and say so in §6), or drop the health bullet and expose state only through `GET /v1/ext/gateway/status`.

**M2. §8.0 contradicts C2 and §11 on replacement identity.**
§8.0: "A replacement engine published under the same package name keeps the slug and inherits the state; one under another name starts empty." C2: "a second extension declaring `gateway` is quarantined, naming both." §11: "Replacement: a configured extension whose package name is `@sigrun/ext-gateway` replaces the built-in." An engine under another name therefore can never load (it is the second `gateway` declarer → quarantined), so "starts empty" describes an unreachable state. The builder must guess which rule wins.
*Fix:* delete the "another name" sentence, or scope C2's quarantine to "when the built-in gateway also loaded".

**M3. §8.4 step 8 vs §9: unlinked group senders' text does reach the model, as the owner.**
§8.4 sets `user` = "the owner for unlinked group senders" (i.e. §8.3's group `owner`), while §9 states flatly "**Unknown senders never reach the model.** Access runs before any submit" and "Unlinked senders can't control anything: in groups they can't run commands or answer interactions". The second clause is the accurate one; the first is false for groups. It matters because the model acts *as the owner* (tools run with the owner's workspace/identity) on text from any group member.
*Fix:* restate §9 as "unknown senders never reach the model **in DMs**; a listed group is the approval, and its members' messages are admitted attributed to the group owner", and say whether the model is told the sender differs from the acting user.

**M4. §8.7's dedupe key silently collapses the per-recipient fan-out.**
"Where it renders, deduplicated on `(conversationId, callId)`" — then "not bound → in each recipient's home chat". Core delivers one `NotificationEvent` **per recipient** (`src/server/notifications.ts:102-130`, `recipients` = owner + every write-access user), so a `(conversationId, callId)` key fires once and only the first recipient's home chat gets the prompt; every other approver never sees it. §10's required scenario "unbound conversation's approval lands in the home chat" would pass with a single-user fixture and hide the bug.
*Fix:* dedupe on `(conversationId, callId, user)` for the unbound branch (and state it).

**M5. §8.13/C2 shutdown ordering delivers settled runs to an already-stopped engine.**
C2 inserts `stop()` "after `app.close()` and before the event bus's workers-then-handlers sequence". That sequence (`src/serve.ts:170-175` → `src/harness/event-bus.ts:680-699`) is exactly where `runSettled` (`event-bus.ts:1374`) and `harnessShutdown` (`:694`) are dispatched, and the bus's own contract says "a run that settled just before shutdown delivers before the shutdown flush" (`event-bus.ts:671-672`). So any run settling in that window is dispatched to an engine that has already aborted adapter signals and awaited `adapter.stop()` (§8.13 steps 1-2) — delivery either throws or is silently lost, violating the anti-goal "a final reply lost without a ledger state and a log line".
*Fix:* split `stop()` into `stopIntake()` (before the bus sequence: abort receives) and `stopDelivery()` (after `harnessShutdown`, before `harness.close()`), or move the whole stop after `shutdownSequence`.

**M6. §8.6's retry ladder cannot fit the deadline that bounds it.**
Retries at 1 s, 5 s and 30 s need ≥36 s, but `runSettled` and notifier calls are raced against `hookDeadlineMs` (`SIGRUN_HOOK_DEADLINE`, default 30 000 — `src/config.ts:86-87,345`; the race is `src/harness/event-bus.ts:1374` and `src/server/notifications.ts:122-127` → `event-bus.ts:1551-1575`). The abandoned handler keeps running as a zombie with no lifecycle owner. §8.13 step 3 also assumes in-flight sends are observable at shutdown.
*Fix:* say delivery is detached from the handler's deadline (engine-owned durable queue with its own scheduler), or cap the ladder under `hookDeadlineMs`.

**M7. No access re-check on delivery, and no revocation story.**
§8.6 delivers "to every chat bound to it" unconditionally; §8.3's `/attach` checks `host.access.accessOf` once at bind time. A user whose sharing is later revoked (or whose conversation is re-owned) keeps receiving full answers in their DM, and a `chat_gone`-style cleanup never covers it. §9 claims "Unlinked senders can't control anything" but says nothing about stale links.
*Fix:* re-verify `accessOf` per delivery (cheap: `host.conversations.meta` + `host.access.accessOf`), and state that a failing check unbinds and logs.

**M8. `/home` may target a group, but pairing codes and "Reply ready" notices are sent to home chats.**
§8.8: "`/home` changes it; it can be any chat the user may write to." §8.2: "each admin's home chat (§8.8) gets the request as text with the same commands" — i.e. the 8-character pairing code — and "Codes are never logged". A `/home` pointing at a group publishes a single-use admin credential to every member, and §8.8's notifications leak conversation names/links.
*Fix:* home chats are DMs only (reject `/home` in groups), or send codes only to a DM.

**M9. `/link <code>` is accepted in any chat, including groups.**
§8.5: "`/link` works for anyone" with no chat-type restriction; §8.2 step 2 is "The user sends `/link <code>` to the bot from the platform." In a group the code is visible to all members and the confirmation reply ("linked to alice") is public — an account-linking takeover of any pending code.
*Fix:* restrict `/link <code>` to `chatType: "dm"`.

**M10. Group conversations cannot be shared, so §8.2's "linked to a user with write access" gate is unsatisfiable for group members.**
§8.3 creation passes only `owner`/`source`/`name`; C4's `patchMeta` covers only `{name, archived}`. `createConversationOp` accepts `sharing` (`src/server/conversation-ops.ts:126-134`) but no C4 method exposes it, and `accessOf` returns `"none"` for any non-owner without `sharing` (`shared/src/access.ts:78-84`). Net: in a group only the configured `owner` can run commands or answer interactions; every other member is refused — the opposite of §8.2's intent ("Any group member's message is admitted").
*Fix:* create group conversations with `sharing: {scope:"people", users:[…linked users…], level:"write"}` (maintained on link/unlink), or add `sharing` to `patchMeta`.

**M11. `host.commands.run`'s principal is undefined, and `/pair`'s admin gate depends on it.**
C4 types it `run(conversationId, name, args, opts: {user?: string})`, but `ExtensionCommandContribution.run` receives a full `Principal` — `user`, `name`, `email`, `admin`, `service`, `method` (`src/extension.ts:308-317,341-346`) — and the extension is free to gate on `admin`. §8.2 makes `/pair` "admin only". A builder must invent the synthesized principal, and guessing `admin: true` (the trusted-host posture of `src/server/host-bridge.ts:19-24`) would let any linked chat user approve pairings.
*Fix:* specify the synthesized principal (e.g. `{user, admin: directory.admin, service:false, method:"none"}` resolved via `host.users.get`) in C4.

**M12. Submit-time failures have no defined branch in the inbound pipeline.**
§8.4 step 8 resolves `"admitted"` "once `submit` returns". But `submitOp` throws `UnservedModelError` for a conversation pinned to an unserved model (`src/server/conversation-ops.ts:226-228`) and `ConversationOpError` for bad input/`whenBusy` (`:213-216`, `:249-254`). `receive` then rejects with no `outcome`, the adapter has no ack rule (it must ack after `"admitted"`), and the user gets silence — §8.6's "unanswered outcomes" notices only cover settled runs.
*Fix:* define the catch: reply with a short notice, log, resolve `"dropped"` (and add a §10 scenario).

**M13. §8.12's logging rule contradicts itself.**
"Logs carry channel id and **binding key**" vs "Chat and sender ids are replaced by an 8-hex sha256 prefix at info level". The binding key is `<channel>:<account>:<chatType>:<chatId>[:<threadId>]` (§8.3) — it *is* the chat id, so the two sentences cannot both hold.
*Fix:* say the binding key is logged hashed at info and verbatim at debug.

**M14. Deployments with no directory users (naive loopback) have no anchor for identity.**
Self-link binds "to the invoking user" (§8.2), home chats are "per user", `/pair approve <code> <user>` maps "to an existing directory user". Under the naive method `principal.user` is whatever `X-Sigrun-User` says and may be `undefined` (`src/server/auth/pipeline.ts:324-331`), and `host.users.list()` is then empty — so `/pair approve` has no user to name and admin-ness is `admin: true` for *any* caller. The spec never says what the gateway does in that deployment.
*Fix:* state the behavior (refuse to start channels without a claimed directory, or a configured `gateway.defaultUser`).

---

### MINOR

- **§8.11 media size rule is self-contradictory.** "Anything over `media.maxBytes` (by declared `size`, else after fetch) becomes a note line … and is never uploaded" — but the "after fetch" branch has already downloaded it, contradicting §7's "Lazy so oversized or unwanted media is never downloaded".
- **§8.1 `mention: "always"` is never defined.** §8.2 only specifies `"required"`. State what `"always"` means (every message admitted regardless of mention?) or drop it.
- **§8.2 pairing limits leave the 4th sender undefined.** "at most 3 pending requests per channel" — does the 4th get a reply, a drop, or an error? Also, 3-per-channel is global across senders, so one attacker can fill the queue and starve real users; say so or add a per-sender cap only.
- **§8.2 lockout guards a command only admins can run.** "5 wrong codes within an hour lock `/pair approve` for that channel" is a self-DoS surface with no unprivileged guessing path described (codes are only sent to admins). Justify or drop.
- **§8.6 formatting/chunking order is unspecified.** "Finals longer than `maxMessageLength` split … A code fence cut by a split is closed and reopened" — fence repair only makes sense *before* `adapter.format` for `plain`/`native`, and after for `markdown`. State the order.
- **C4 `readFile`'s cap is unspecified.** The repo has two: `FILE_CONTENT_MAX_BYTES` 1 MiB (`src/server/helpers.ts:337`) for `files/content`, `server.maxFileReadBytes` 16 MiB (`src/config.ts:191-198`) for `files/raw`. §8.9's `send_message` files are capped at `media.maxBytes` (20 MiB default), which exceeds both.
- **C7's "alongside the existing `jobId`" is not a `SessionMeta` field.** `SessionMeta` has no `jobId` (`shared/src/session-meta.ts:36-79`); `fire.ts` writes it through a cast (`src/jobs/fire.ts:330`). Since C7 says "`SessionMeta` gains `deliver?: string[]`", declare `jobId` at the same time (and note `deliver` stays server-owned, non-patchable, like `autoName`).
- **C3's "defaults to `true`" needs two files the spec does not name.** The settings validator allowlists exactly `["codemode","mcp","toolSearch"]` (`src/harness/settings.ts:484-492`) and `BuiltinExtensionsSettings` names the same three (`shared/src/settings.ts:273-277`); a `gateway: false` write fails `SettingsValidationError` until both are widened.
- **§8.0 lists `commands` (`/pair`, `/link`) and §8.5 also lists them as chat commands** with no statement that one implementation backs both. Say it, or the builder will write two.
- **§8.13's "within the remaining core hook deadline" is unknowable to an extension.** `SIGRUN_HOOK_DEADLINE` is core config (`src/config.ts:86-92`); the engine has no read. Give a concrete bound (e.g. "10 s total").
- **§8.0's state directory is not pre-created.** `<stateDir>/<slug>` is not ensured at boot — only the root is (`src/harness/stores.ts` `ensureStoreRoots`; `docs/extending.md:175` "the ROOT is ensured at boot; your `<slug>` subdir is not"). §8.0's "`host.stores.paths.state` (= `<stateDir>/gateway/`)" reads as given.
- **§7's credentials bullet overstates the store handle.** `host.stores.secrets.get` returns only the stored value; the `SIGRUN_EXT_<SLUG>_<KEY>` env fallback is the extension's own `process.env` read, not part of the handle (`src/harness/stores.ts` `scopedExtensionStores`; `docs/extending.md:163-167`). Say "resolve stored-then-env yourself", or the adapter will assume the fallback is built in.

---

### Verified correct (selected, with evidence)

- §6 preamble claim that the host bridge exposes "only `create/submit/watch/list/meta`" is exact (`src/server/host-bridge.ts:63-135`); `abort`/`configure`/`compact`/`fork`/`patchMeta`/`upload`/`readFile` genuinely exist only as routes (`src/server/routes/submissions.ts:237,145,288`, `conversations.ts:138,409`, `files.ts:105,149,360`).
- C6's premise is exact: `HostEventWire` already carries `callId` for interactions (`shared/src/views.ts:840-845`) but `NotificationEvent` does not (`src/extension.ts:350-360`).
- C5's premise is exact: `applyAnswer` already accepts `answeredByUser` (`src/harness/interactions.ts:297-317`) and the route stamps it (`src/server/routes/interactions.ts` answer handler); only the host method lacks the option.
- C2's "no engine ⇒ adapters load but nothing calls them" is consistent with the loader's contributor-only path (`src/harness/loader.ts:1189-1202`), and C1's "quarantine a malformed entry" matches every existing validator's posture (`validateRoutes`/`validateCommands`/`validateNotifiers`).
- §8.4's dedupe `requestId` genuinely dedupes across a crash: `admitSubmission` short-circuits on a known `requestId` (`node_modules/.../harness/submissions.js:129-137`), and the scope is the conversation.
- §8.10's `PromptInput.conversationId` exists for the prompt section (`.../harness/types.d.ts:273-283`), so "renders only for bound conversations" is implementable.
- §8.0's `pi.live` read is real: `docs["pi.live"]` carries `generation.message` (the committed partial) and is mounted in every view frame (`.../harness/live.d.ts:82-96`, `.../harness/view.js:13-19`), and `webui/src/entries/liveDoc.ts` is the hand-mirror the spec proposes to move to `@sigrun/shared` (the purity guard permits it — `test/views-purity.test.ts` sibling-type-only rule).

---

### Test commands a supervisor must run (not executed here)

`npm test && npm run typecheck` (root), plus `npm --workspace @sigrun/shared run build` once C1/C4/C6 types land, and `npm run typecheck:webui` if the `pi.live` narrowing moves into `shared/`.

---

**Verdict:** BLOCK — B1 (no model-catalog seam), B2 (no settlement seam, so §8.7's edit-and-clear-promise is unimplementable) and B3 (sticky `deliver` re-delivering every later run) must be settled in the spec before a builder can implement §8.5/§8.7/§8.8 correctly; the MAJORs are contract-gap wording fixes, not redesigns.