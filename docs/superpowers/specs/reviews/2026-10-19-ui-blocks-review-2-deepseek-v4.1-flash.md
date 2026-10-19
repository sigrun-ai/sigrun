## Review

**Verdict: BLOCK** — the round-1 inventory is almost entirely folded (and folded correctly), but the revision introduces one mechanism that cannot hold (§6.3 "accept without an update" on extension surfaces) plus a handful of concrete contract gaps that U2/U3/U5 would hit on day one.

I re-verified every round-1 item against the revised text and against `@earendil-works/pi-durable@1.2.0`. Fork semantics (ruling 19) and the change-note write both check out against the shipped runtime, which is the strongest part of this revision.

---

### Round-1 items not resolved

**R1. §4.1 — the purity guard's *sibling* rule rejects `../` imports, so `shared/src/blocks/` cannot import `shared/src/json.ts`.**
§4.1 says the subdirectory is "pure code with no imports outside `shared/`", but the guard's rule is narrower: `statement.specifier.startsWith("./")` (`test/views-purity.test.ts:107`). A `blocks/types.ts` doing `import type { JsonValue } from "../json.js"` fails "must import siblings only". The recursion fix is assigned (U0, §18), the specifier-width fix is not.
*Fix:* state that U0 widens the sibling rule to `./` **or** `../` that stays inside `shared/src/`, and add the `@sigrun/shared/blocks` entry to `shared/package.json`'s `exports` map (it currently has 10 entries and no `./blocks`).

**R2. §9.1 — the interaction envelope list still names a field that does not exist.**
"timestamps (`createdAt`, `expiresAt?`, `answeredAt?`)" — the record has `settledAt` (`shared/src/interactions.ts:91`), not `answeredAt`, and omits `answeredByUser` (`:100`), which is the field the answer route stamps from the principal. The glm-5.3 `key`/`interactionKinds` error was fixed; this one survived.
*Fix:* `createdAt`, `expiresAt?`, `settledAt?`, `answeredBy?`, `answeredByUser?`, `answer?`, `details?`.

**R3. §9.1 + §5.6 — `InteractionAnswer.values` still cannot hold the values ruling 20 produces.**
`values?: Readonly<Record<string, string | number | boolean>>` (`shared/src/interactions.ts:75`). §5.6 says a `multi` choice's value is ids (`string[]`) and `allowOther` yields `{other: text}` or `[...ids, {other}]`. §16's own test asserts a four-question tree "with `preview` and `allowOther`" answers as `{values: {q1…q4}}` — which is unrepresentable. The §5.7 field restriction fixed the `daterange`/`list`/`file` half of round-1 S2; this half is open.
*Fix:* widen to `Readonly<Record<string, JsonValue>>` in §9.1 and say so in the U6 row.

---

### New blockers

**B1. §6.3 step 3 "accept without an update" presumes server-held data that only chat surfaces have.**
The spec says: "**accept without an update** (`{ok: true}`) → … The server applies the move itself as a `DataOp.move`, so the next `rev` and every other viewer see it. Without this, the next refetch would silently undo the drag."

For `view`/`panel` surfaces there is no server-side data to move. The extension's `render()`/`data()` is the source of truth (§7.1, §7.2's data route returns `{data}` straight from it), and §7.3 keeps only *ops* — and only for `sharedData: true`, explicitly ignoring `update` for principal-specific surfaces. So on an extension surface an `{ok: true}` accept either (a) records an op nobody can read back (non-shared: `since` returns full data from `data()` without the move → the drag is undone, the exact failure the paragraph claims to prevent), or (b) records an op other viewers apply while the extension's own next `render()` contradicts it.

§16's test "accept without an update (the server applies the move, and a refetch keeps it)" is unpassable for `view`/`panel` as written.
*Fix:* scope the rule — "accept without an update is valid only where core owns the data (`chat`); for `view`/`panel`/`ambient` a `move` accept must return `update` or the server rejects the action with `500 surface_failed`/`409`, and the channel treats it as a reject." Add the placement to §16's test row.

---

### New should-fix

**S1. §14.1 — extension packages cannot resolve `sigrun/blocks` at runtime.**
`HOST_RUNTIME_MODULES` is `@earendil-works/pi-ai`, `pi-durable`, `chord`, `typebox` (`src/harness/packages.ts:79-84`); `sigrun` is not linked into the packages dir, so an extension importing `{ page } from "sigrun/blocks"` (a *value* import, unlike W5's types-only `sigrun/extension`) fails `ERR_MODULE_NOT_FOUND` and quarantines. Compounding: the root `package.json` is `"private": true` (`package.json:4`), so the package is not installable from npm either, and `exports` does not exist yet.
*Fix:* either add `sigrun` to `HOST_RUNTIME_MODULES` with an **exact** version rule (like pi-durable at `src/harness/loader.ts:490-492` — builders must emit the host's `v`), or expose the builders on the host context (`host.blocks.page(...)`) and keep `sigrun/blocks` types-only. Pick one in §14.1.

**S2. §11.3 invents a route shape §11.2 does not define.**
"assets and data URLs converted the same way through `GET /v1/image?as=png&src=asset:…`". §11.2's route is `?u=<url>&e=<expiry>&s=<sig>`: no `src` parameter, and no signing rule for one. A 192 KiB base64 `data:` URL cannot ride `u` (it would need to be signed byte-exact and would blow URL limits).
*Fix:* define the second form explicitly — `GET /v1/image?src=<asset:…|data:…>&as=png`, same authenticated route, no signature needed (both sources are already server-validated: asset realpath containment §11.1, data-URL MIME allowlist), 10 MiB cap, same cache.

**S3. §8.3 vs §8.4 — two mechanisms fire on the block-answer path with no stated order.**
§8.3 puts the change note "in core's submit path (the one every turn starter goes through: the composer route, **block answers**, jobs and W5's `host.conversations.submit`), immediately before the input". §8.4 says a block answer folds "the surface's unnoted change records … into `content` and `notedThrough` advances, so they aren't sent again in a change note." If §8.3 runs first, `notedThrough` has already advanced and the answer's `content` carries no state — contradicting §8.4's claim that the answer carries the final order ("Use this order" is the whole point of §8.5 step 5).
*Fix:* one sentence: "for a block answer, core folds the surface's unnoted records into `content` **before** the note step, so that turn writes no change note; other turn starters write the note."

**S4. §7.3's stream id is a new `/v1/events` protocol element not declared as an amendment.**
W3 §7.4 (`2026-10-19-sigrun-core-hardening-design.md:732-747`) defines the stream as `event: <type>` frames with JSON data and no id/hello frame; the spec's §20 lists only the two new event *types* as amendments. §7.3 requires "its id is sent in the stream's first frame" and `X-Sigrun-Stream` on fetches — both new wire requirements that both channels must implement, and W3's delta-view stream (§7.3) has no equivalent.
*Fix:* state the amendment in §7.3 ("W3 §7.4 gains a `hello` frame `{streamId}` on connect, and a client that reconnects re-registers") and name it in the §20 folded list so the plan carries it into W3's tests.

**S5. §4.3 vs §7.1 — `ActionResult.update` is typed `DataUpdate`, which requires a server-assigned `rev`.**
§4.3: "Extensions and tools submit ops **without a rev**; the server applies them in arrival order, increments `rev`." §7.1: `{ok: true; update?: DataUpdate}` where `DataUpdate = {rev: number; ops: DataOp[]}`. An implementer writing the contract type cannot satisfy both. The same leak appears at §5.3 `tree.onExpand` ("it returns a `DataUpdate` inserting them") and §6.1's `validateTree` mapping.
*Fix:* introduce `type DataOps = {ops: DataOp[]}` and use it in `ActionResult.update`, `onExpand`, and any handler return; keep `DataUpdate` for what the server sends.

**S6. §5.5 `groups` is bindable in the example but the "structural props are literals" list does not name it.**
§14.1's worked example passes `groups: bind("/lanes")`, and §4.2's literal list covers `groupBy`, `reorder`, `select`, `mode`, `display` — not `groups`. Since `groups` determines lane identity/order and the tree is cached by `treeRev`, a binding here is a structural change behind a data-only update, which §4.3 says channels will not notice.
*Fix:* add `groups` to the §4.2 literal list (and change the example to a literal), or state that `groups` is data and reordering lanes is a data op.

---

### Nits

1. **§9.2** maps `rows[]` to `collection(list)` listing "`tone`" — `AmbientRow` has `severity: 0|1|2`, not `tone` (`shared/src/ambient.ts:31-33`), and `detail` is unmapped. Give the mapping (0→bad, 1→warn, 2→subtle) or the port loses row severity.
2. **§10.2** says "v1 set (60 names)"; the enumerated list is 49 (14 + 17 + 6 + 12).
3. **§8.3** "queues it in `pi.inbox` **ahead of the input** when it's busy" — ordering actually comes from `applyBoundary`, which places *every* write before *any* user item at each boundary (`dist/harness/inbox.js:30-52`), not from queue order. Related: writes are placed at the **earliest** boundary (`postTools`), while `followUp` inputs wait for `final` — so a note for a follow-up can land in the previous run. "placed at the next boundary along with its input" is imprecise.
4. **§6.5/§7.3** — an event is sent "only after their cached access (§6.5) for that instance is not `none`", but the access cache expires in 60 s and the watcher entry lives 10 min. Say the watcher entry stores the access determined at its last fetch, so an event never triggers a re-render per watcher.
5. **§11.2** cache "keyed by URL hash" is ambiguous: hashing the *signed* URL (which changes on every serve, since `e` is re-signed) thrashes the 256 MiB LRU. Say `sha256(u)` (+ the `as` variant).
6. **§6.1** `{type: "open"}` carries the comment "http(s) only" while the bullet allows `mailto:`.
7. **§12.1** `regular` "40–75 rem" and `wide` "≥ 75 rem" overlap at exactly 75; make it `40–75` / `> 75`.
8. **§14.3** `toText` is claimed deterministic ("same input gives the same bytes") but formats are locale-dependent (§5.3 "Channels format with the user's locale"). Say deterministic *per locale*, since the model projection is cached.

**Verified sound** (so the plan keeps it): fork-at-creation is real — `LatestConversationSemantics.fork: "current" | "initial"` (`dist/types.d.ts:31-36`) and `prepareForkDocumentCopies` copies `fork: "current"` documents at present (`dist/session/forks.js:10-13`); entry ids are preserved across a fork (the child reads the parent chain), so the entry-keyed family resolves. `requestId` dedup is enforced, not merely available: `admitSubmission` returns the existing submission for a known request id (`dist/harness/submissions.js:118-127`), and a `write` with a `model` message is non-display-only so it queues in `pi.inbox` and is placed first. `InputEntry`/`SubmissionDraft` match §8.4 exactly (`dist/harness/types.d.ts:18-36`). The view stream genuinely cannot carry block state (`dist/harness/view.d.ts:10-13`), so §8.2's move to surface routes is right. `cacheDir`/`stateDir` exist (`src/config.ts:191-193`), and `server.maxUploadBytes` is already a real knob (`src/config.ts:1177`).