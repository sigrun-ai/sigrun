All evidence is gathered. The fork mechanics, submission machinery, purity guard, and seam types are all verified. Here is the complete second-round review.

## Review — `2026-10-19-sigrun-ui-blocks-design.md` (round 2)

**Verdict: OK with notes** — every round-1 blocker and should-fix from both reviews is addressed (two imprecisely, listed below); the revised mechanisms mostly hold against pi-durable 1.2.0 and the seam sources. No new blockers; seven new should-fixes, all precision holes a plan can fix locally.

### Round-1 items not resolved

All 7 blockers (glm B1–B3, deepseek B1–B7) and 24 should-fixes are resolved in the revised text — verified individually against `shared/src/interactions.ts`, `shared/src/ambient.ts`, `test/views-purity.test.ts`, `node_modules/@earendil-works/pi-durable/dist/{types.d.ts,session/forks.js,harness/{types,submissions,inbox}.*}`, and core-hardening W1/W3/W5. Two were resolved incorrectly or imprecisely:

1. **§9.1 — the "corrected envelope" still names a field that doesn't exist.** glm-S8 flagged the envelope listing as factually wrong; the fix removed `key`/`interactionKinds` but introduced `answeredAt?`. The canonical `InteractionRecord` (`shared/src/interactions.ts`) has `settledAt?` ("Epoch ms when a terminal status landed") — there is no `answeredAt` anywhere in the file. The listing also omits `answeredByUser?` and `details?` while claiming "The envelope is unchanged." Fix: `timestamps (createdAt, expiresAt?, settledAt?)` and add the two omitted fields.

2. **§4.1 — the purity-test claim misstates current code.** "the purity test scans `shared/src/` recursively, so the new subdirectory is covered" is false today: `test/views-purity.test.ts` `sharedModuleSources()` does `readdirSync(SHARED_SRC).filter((name) => name.endsWith(".ts"))` — top-level only; a `shared/src/blocks/` directory is returned as `"blocks"`, filtered out, and its files are never read. U0 does deliver "recursive purity test", so the guard lands — but §4.1 as written tells a reader the new directory is *already* covered. Fix: "U0 makes the purity test recursive so the new subdirectory is covered."

### New blockers

None found. Specifically verified sound: §8.2's `history: "latest", fork: "current"` claim matches `forks.js` — `collectCopies` copies only `fork: "current"` documents in its second pass, at the parent's current state, wholesale (so copied keys not in the child's history are present but unreachable, as §8.2 says); §8.3's note-before-input ordering is guaranteed twice over (`inbox.d.ts:44-48`: "Writes are placed first and user items after them, each in ID order", plus core issuing the write first); `requestId` dedup exists (`submissions.js:129-137`, `tx.submissionByRequest` returns the existing submission "without writing", with a type check); §8.4's `entry: {kind, data}` is exactly `InputEntry` (`harness/types.d.ts:18-21`, kind must not start `pi.`); §6.5's cache is per `(slug, id, key, principal.user)` with miss-never-allows; §11.2's custom-`lookup` vetted-address fetch, total redirect budget, and HMAC over exact `u + "\n" + e` bytes are coherent; §7.3's hashed `k` removes the params leak.

### New should-fix

1. **§8.3 — the exactly-once story has two holes on the busy path.**
   (a) `requestId` is `blocks-note:<conversationId>:<sha of the noted (entryId, seq) set>`. If a crash lands between admission and `notedThrough` advancing and *new change records arrive before the retry*, the recomputed set differs → different sha → dedup misses → the note is written twice. Fix: derive the key from the pre-advance `notedThrough` values (`sha of (entryId, notedThrough) pairs`) — stable, since they advance only after admission.
   (b) "notedThrough advances after the write is **admitted**" — a busy conversation only *queues* the write in `pi.inbox` (`submissions.js:120`: "A busy conversation queues anything else in `pi.inbox`"); placement happens at a boundary. Advancing at admission means a crash before that boundary loses the records permanently (dedup can't help; nothing was written). Fix: advance when the note write's submission settles `done` (placed), which is observable via `SubmissionRecord.status`.

2. **§6.3 vs §7.3 — accept-without-update is only coherent for `sharedData` surfaces.** §6.3: the server applies the move itself "so the next `rev` and every other viewer see it." But §7.3: for principal-specific surfaces, "ops are only kept for surfaces declared `sharedData: true`… `update` is ignored and each channel refetches full data, because one principal's ops could describe rows another can't see." A principal-specific instance has no single server-side data for the synthesized `DataOp.move` to land on, and other viewers' copies legitimately differ. Fix: scope the server-applied move to `sharedData` surfaces; for principal-specific surfaces require the handler to return an `update` (or have the server discard its cached data for the instance so the next fetch re-renders).

3. **§7.2/§7.3 — no freshness rule for principal-specific surface data.** What `GET …/data` serves (last render's cache vs re-running `data()`) and what advances `rev` for a non-shared surface is unspecified. Without a rule, "each channel refetches full data" (`changed` without update, §7.3) can return the same stale cached render forever. Fix: one sentence — for principal-specific surfaces the data route re-runs `data()` per fetch (rev advances only from that principal's own applied updates, or stays 0).

4. **§7.3 — the stream-id first frame silently amends W3 §7.4.** "Its id is sent in the stream's first frame" — core-hardening §7.4 (lines 732–747) defines `GET /v1/events` as "one SSE stream per client" with an event table and **no id frame, handshake, or header** anywhere (grep for `stream id`/`first frame`/`X-Sigrun-Stream` in that spec: nothing). U3's watcher registry keys on this id; a W3 implementer following §7.4's text won't build it. Fix: state explicitly that this spec amends W3 §7.4 with a connection-id first frame and the `X-Sigrun-Stream` request header (the §7.4 amendment for event types is already stated; this one isn't).

5. **§9.1/ruling 20 — the new `values` type is unstated where the old one is too narrow.** `InteractionAnswer.values` today is `Record<string, string | number | boolean>`; ruling 20's `{values: {<field>: value}}` must hold a multi-choice's `string[]` and `{other: text}` objects (§5.6). Say so where the answer route body is typed, or the shared rewrite will preserve the old value union.

### Nits

1. **§6.1** — the `open` line's inline comment says "http(s) only" while the prose (and §15) allow `https:`, `http:` and `mailto:`. Align the comment.
2. **§15 vs §8.2** — "Events… name the instance by a hash, never by its params" vs chat's `surface.changed {conversation, entry, rev}` (plaintext ids). True for extension surfaces only; qualify, since chat events go only to conversation watchers anyway.
3. **§6.3** — "assigns the next `rev`, returns it": `ActionResult` (§7.1) has no `rev` slot. Say the server wraps the result with the assigned rev, or that the acting channel learns it from the announce + `since` fetch.
4. **§6.3** — accept-without-update: unpinned whether the channel drops its overlay at response time or when the server op lands; dropping early shows a snap-back-then-move flicker. One sentence (drop when the matching op/rev arrives).
5. **§20** — the disposition's "the corrected interaction … envelopes" claim is undercut by the `answeredAt` error above; worth fixing together.

### Checked and holding

Ruling 19's revision is consistently implemented (§2, §8.2, §16 fork tests) and mechanically verified against `forks.js`; §4.5 tree caps + 192 KiB data-URL cap are mutually consistent and fit every placement that allows `image`; §5.7's field/block restrictions close deepseek-S2 with matching §16 tests; §12.2 ships only `atLeast:regular`; §9.2's envelope now matches `AmbientRecord` field-for-field including `footer`; `InputEntry`, `submissionByRequest`, `view.d.ts`'s kind-keyed `docs` (absence claim correct), `host.conversations.submit` (core-hardening:1313), and the reserved `surfaces/`/`assets/` prefixes all check out.