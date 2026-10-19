## Review

**Verdict: BLOCK** — three wire/contract gaps make U3/U5 unimplementable as written, two of them security-relevant.

I read the design spec, the sizing pass, core-hardening §5/§7/§9, `docs/approval-ux-seams.md`, `shared/src/{interactions,ambient,views}.ts`, `test/views-purity.test.ts`, `src/{config.ts,harness/naming.ts}`, `webui/src/entries/Markdown.tsx`, `tui/src/keymaps/*`, and the installed `@earendil-works/pi-durable@1.2.0` / `pi-tui@1.3.0` type and runtime sources. Rulings 1–16 are taken as given; what follows is only whether the spec implements them.

---

## Blockers

### B1. `access` has no "none" — a principal without access cannot be told apart from an error (§7.1, §6.5, §16)

`render(ctx)` returns `access: "read" | "write"`; §16 requires "a principal without access gets … a 404 on fetch". There is no way to express that: throwing produces `500 surface_failed` (§7.2), and returning a tree leaks it.

Evidence: §7.1 `render(ctx): Promise<{tree; data; access: "read" | "write"}>`; §7.2 "A surface that throws in `render` … returns `500 surface_failed`"; §16 "a principal without access gets no event and a 404 on fetch".

Fix: `access: "none" | "read" | "write"`; `"none"` → `404` on both the surface and data routes, no event emission, and no entry in the rail. Add the matching test row.

### B2. Read-only enforcement is cached per surface instance, not per principal (§15, §6.5)

§15: "actions on a surface whose last render returned `access: "read"` are rejected with `403`". A surface instance is shared by every principal with access (§7.3 says exactly that for `sharedData`). So the last render wins globally: principal A's `read` render blocks principal B's legitimate write, and — the bad direction — B's `write` render un-blocks A's forged action until A re-renders. That is the enforcement path for ruling 14/§6.5.

Fix: key the cached access by `(slug, id, key, principal.user)` with a short TTL, and treat a missing entry as "re-check by re-rendering", never as "allow". State in §15 that the check is per principal.

### B3. The blocks state cannot ride the conversation view (§8.2)

§8.2 puts live state in "a conversation-scoped document **family**, `sigrun.blocks.state`, keyed by entry id". The view contract carries only singletons: `ConversationView.docs` is "Built-in conversation documents **keyed by kind**" (`pi-durable/dist/harness/view.d.ts:10-13`), and W3 §7.3's delta frame is `"docs": {"set": {"<kind>": {}}, "unset": ["<kind>"]}`. Family members keyed by entry id have no wire slot, so neither channel can render or update a chat surface, and `shared/src/views.ts` cannot type it.

Fix: pick one and write it down — (a) one singleton conversation doc `sigrun.blocks` = `{[entryId]: {rev, data, pending}}` (rides `docs` for free; whole doc per delta, bounded by §4.5), or (b) keep the family and add `GET /v1/conversations/:id/blocks/:entryId` plus a `blocks.changed` event. (a) is smaller and reuses the reducer.

### B4. Fork behaviour as specified needs rewindable history (§8.2)

"Forks copy it, so a fork starts from the state at the fork point." pi-durable copies conversation documents by `fork` policy: `asOf` sources are read at the fork entry's commit seq, `current` sources at present (`dist/session/forks.js:10-13,19-30`). `LatestConversationSemantics` allows only `fork: "current" | "initial"`; `"asOf"` requires `history: "rewindable"` (`dist/types.d.ts:31-40`). So `latest` gives a fork the parent's *current* state, not the state at the fork point.

Fix: declare `history: "rewindable", fork: "asOf"`, and state the cost (history retained for as-of reads; set `checkpointWhen` so per-op updates do not each become a checkpoint) — or accept `fork: "current"` and say a fork may include edits made after the forked entry.

### B5. The handler-name wiring is missing/inconsistent — no schema can be written (§5.5, §5.6, §6.1, §14.1)

§6.1 makes `move`/`edit` carry `name` (the handler). §5.5's `collection` props are `reorder?: {within?, across?}`, `checkable?: "item field"`, `itemAction?` — none of which has a place for a name. §14.1 then uses `onMove: "move"`, `onCheck`, `onActivate`, `onSubmit`, which appear nowhere in §5. `checkable`'s "toggling is an edit action" has the same hole.

Fix: add `onMove`, `onCheck`, `onActivate` (and `onSubmit` on forms) as the handler-name props in §5.5/§5.6, state that they are what `validateTree` resolves into `{type: "move"|"edit"|"submit", name}`, and require `onMove` when `reorder` is set. Same for the calendar `resize`/`createByDrag` handlers, which have no name prop at all.

### B6. `surface.changed` targeting is undefined, and `key` leaks params (§7.3)

"to every connected principal subscribed to that surface instance" — no subscribe/unsubscribe message, route, or lifecycle exists anywhere in the spec, so the server cannot know. The fallback reading (broadcast) sends `{slug, id, key}` to every principal, and `key` "defaults to the canonical JSON of `params`" — so user A learns that user B is viewing a board, and sees B's params verbatim (a conversation id, a search string).

Fix: define subscription as a server-side registry populated by the surface and data fetches, keyed `(principal, slug, id, key)` with a TTL, dropped on stream close; or make the publisher name recipients (`changed(id, key, {users?})`) and default to the caller only. Make `key` an opaque digest of params (`sha256(canonicalJSON)`), not the JSON.

### B7. The image proxy is not DNS-rebinding-safe (§11.2)

"DNS-resolve first and refuse loopback, private, link-local, CGNAT and unique-local ranges, re-checked on every redirect (max 3)". Resolve-then-fetch is TOCTOU: the fetch re-resolves and can land on `127.0.0.1`. Re-checking redirects does not help the first hop.

Fix: pin the vetted address for the connection (custom `lookup` returning only the checked address, or dial the IP with `Host`/SNI preserved), refuse a second resolution for that request, and cap the total (not per-hop) redirect budget. Also: sign the exact canonical URL byte string (a single parse, no re-encoding after verification), add an expiry to `s`, and state that the signature is not principal-bound (a leaked signed URL is shareable to any authenticated user — acceptable, but say it).

---

## Should-fix

### S1. `shared/src/blocks/` with typebox contradicts the shared-leaf contract (§4.1, §14.1, U0)

`shared/package.json` describes `@sigrun/shared` as "the pure client-shared leaf — **zero imports**", and `test/views-purity.test.ts` enforces: every import in a wire module is `import type` and sibling-only, no external package, no `node:`. Typebox schemas are runtime values from an external package. Worse, the guard enumerates `readdirSync(SHARED_SRC).filter(name => name.endsWith(".ts"))` — a new `shared/src/blocks/` **directory** is silently outside the guard.

Fix: keep `shared/src/blocks/` type-only (types + `DataOp` apply + pure helpers, no external imports), put typebox schemas and `validateTree` in a runtime home (`src/blocks/`, re-exported by `sigrun/blocks`), and make the purity guard recursive so the new subdirectory is covered.

### S2. Interaction answers cannot carry several field types (§9.1, §5.6)

`InteractionAnswer.values` is `Record<string, string | number | boolean>` (`shared/src/interactions.ts`). §5.6's field table includes `daterange`, `list`, `file`, `date`; nothing restricts which fields a `form` in the `interaction` placement may contain, so `{"range": {from, to}}` or `{"steps": [...]}` is unrepresentable.

Fix: restrict interaction-placement fields to `text`/`longtext`/`number`/`toggle`/`secret`/`choice` in the §5.7 validation table, or widen `values` to `JsonObject`. Also reserve the names `ids` and `text` (the §9.1 mapping keys off them) and say so.

### S3. "structured part" is the wrong mechanism (§8.4)

Content parts go to the model. pi-durable's place for channel-visible structure is the input entry: `InputEntry = {kind, data}` — "an application kind, and data the transcript shows, such as its author. Its model message is still the input's user message" (`dist/harness/types.d.ts:14-21, 29-30`).

Fix: `submit({type: "input", content: <text projection>, entry: {kind: "sigrun.blocks.answer", data: {blocksAnswer: …}}, requestId: "blocks:" + actionId})`. `requestId` exists on `SubmissionDraft` (types.d.ts:23-24), so the idempotency claim holds.

### S4. "At the start of the agent's next turn" has no defined interception point, and is wrong while busy (§8.3)

Two problems. (a) Nothing in pi-durable 1.2.0 hooks run start and can append durably: `GenerationHooks.beforeRequest` returns messages "for that request only" (`types.d.ts:688-694`), and `subscribeCommits` listeners "must not block or call Session APIs" (`types.d.ts:826-827`). (b) A write that affects model context while busy is queued in `pi.inbox` and placed "at the next boundary" (`types.d.ts:594-599`) — so if the user submits while the agent is mid-run, the note lands *mid-run*, contradicting "next turn".

Fix: state the mechanism — core appends the note (a `type: "write"` submission with `model: [UserMessage]`) in the core submit path immediately before admitting the input that starts the turn, so ordering is note→input; and state the busy case ("while busy the note is placed at the next boundary and may be seen mid-run; if that is unacceptable, gate on idle"). Also: "then clears `pending`" must be the same transaction as the append, or a crash between loses the changes.

### S5. Optimistic moves can corrupt the client array (§6.3, §4.3)

"accept → the update … replaces the host's optimistic state" — but a `DataUpdate` is ops, and §4.3's only recovery is a `rev` gap. A client holding an optimistic array with an optimistically bumped rev sees no gap and applies "move 3→0" on top of its own move, producing a duplicate/missing item. Also undefined: a handler that returns `ok: true` with no `update`.

Fix: the channel keeps `confirmedData` + `optimisticOverlay`; server ops always apply to `confirmedData`; the overlay is dropped when the response carrying that `actionId` arrives; a no-update accept confirms the overlay and bumps `rev` server-side (say so, otherwise the next refetch silently reverts the drag).

### S6. Data-URL cap exceeds the data cap (§11.1 vs §4.5)

`data:` URLs are allowed "up to 512 KiB, counted in the data limit", but the limits are 256 KiB (`chat`), 64 KiB (`interaction`/`ambient`), 4 MiB (`view`/`panel`/`settings`). A legal 512 KiB data URL is illegal in three of six placements. Fix: one number (suggest 192 KiB, leaving room in `chat`), and state whether the cap counts base64 text or decoded bytes.

### S7. The image cache belongs in `cacheDir`, not `dataDir` (§11.2)

`src/config.ts:131-142` defines `dataDir`/`cacheDir`/`stateDir` as separate roots; core-hardening §5.8 uses the cache root precisely because it "is pod-local and never a backup section". A 256 MiB LRU under `dataDir` lands on the data PVC and in backup scope. Fix: `<cacheDir>/images/`.

### S8. The ambient mapping drops three `rows` affordances (§9.2)

`docs/approval-ux-seams.md` records that `rows` carries `quiet?` ("folded away by default — warden's quiet verdicts"), `deps?: ids[]` ("dependency markers (rpiv-todo blockedBy)") and `spinnerLabel?` ("present-continuous spinner label while the row is active"). §9.2 maps rows to `collection(list)` with "`badges`, `tone`, `children`, `metrics`" — none of the three survives, and `deps` is not "nesting" (the sizing doc conflates them). Since §9.1 makes pi-warden's verdict stack a named port, this is a real regression.

Fix: add card slots/props `quiet`, `spinner`, and `deps` (or a `links` slot), or state explicitly that the port drops folding and dependency markers.

### S9. Three sizing-doc cases the block set cannot express (§5.5, §5.3)

- H2 "bulk bar (status select + bulk action)": `bulkActions` is a flat action list; there is no way to prompt for a parameter (`@setStatus(choice)`).
- H8 "table columns: … share(bar)": `columns[].format` covers numbers, not a bar/meter cell.
- H9 "monospace output with severity colour": `log.lines` has `level?` but no level→tone mapping.

Fix: `bulkActions?: {action, form?: Tree}[]` (or accept that a bulk parameter is a `form` block in the toolbar — then say where toolbars live); `columns[].cell?: "text" | "meter"`; `log.tones?: {[level]: Tone}`.

### S10. `turn` means two different things (§6.1/§6.2 vs §6.4)

§6.2: "any action with `turn: true`" is an answer that starts a turn. §6.4: for `view`/`panel`, "`turn` flags are not used". The Action type allows `turn` everywhere, so a view author gets a silently ignored prop. Fix: reject `turn` in `view`/`panel`/`ambient` at validation, or drop it from the base `Action` and put it only on the chat placement's actions.

### S11. `meta: {person: user}` has no directory to resolve against (§5.5.1)

Rendering a name from a user id needs a lookup, but W1's only users route is admin-only (`GET /v1/users`, core-hardening §5.8 "Users API (admin)"). W1 §5.9's share picker has the same latent need. Fix: specify either that `person` carries the display name in the data (`{person: {user, name}}`, extension-supplied) or a non-admin `GET /v1/directory` returning `{user, name}` only — and say which.

### S12. TUI image facts are wrong on two counts (§11.3)

`pi-tui@1.3.0` hard-disables inline images under tmux — `if (process.env.TMUX || term.startsWith("tmux")) return { images: null, … }` (`dist/terminal-image.js:45-46`) — so "inside tmux, image passthrough depends on tmux's `allow-passthrough`" is false; only `PI_IMAGE_PROTOCOL=kitty|iterm2` overrides it (`:100-102`). Second, `Image` renders non-PNG as text fallback on Kitty unless a transcoder is registered (`dist/components/image.d.ts:5-9`), and `tui/package.json` has no image library.

Fix: state that tmux yields `[image: alt]` unless the user sets `PI_IMAGE_PROTOCOL`; and decide PNG-only (server converts, or the proxy only admits PNG) versus registering a transcoder.

### S13. Cross-spec contradictions

- §13.1 moves `namingModel`, `providers.refreshIntervalMinutes`, `jobHistory.*` to `live`, but core-hardening §5.7 says "Everything else lives under `server.auth`… All of it is restart-required, like every `server.*` key". (Note `namingModel` is *already* live: `src/harness/naming.ts:96-98,138`.) Amend §5.7 in place.
- §7.3 adds `surface.changed` and §13.2 adds `settings.changed` to `/v1/events`, but W3 §7.4's event table is presented as the closed set. Note the amendment and require clients to ignore unknown event types.

### S14. Route namespace is shared with extension-declared routes (§7.2 vs W5 §9.2)

Both live under `/v1/ext/<slug>/`. An extension declaring `path: "surfaces/x"` or `path: "assets/…"` collides with core. Fix: reserve `surfaces/`, `assets/` (and `settings` if core serves it) and quarantine a declaration that uses them, with the precedence stated.

---

## Nits

1. **§12.2 `visibleAt` has four values; the sizing doc evidences one.** "So `visibleAt: "atLeast:regular"` on a block earns its place." `atMost:compact`, `atLeast:wide`, `atMost:regular` have no case. Ship `atLeast:regular` (or all four with a note that three are speculative).
2. **Unevidenced props** (drop or mark host-default): `stat.delta`, `fields.copy`, `section.actions`, `log.maxLines`, `chart` series `tone`, `choice.display` (four variants), `image.fit/aspect`, and `emphasis` (§10.1) which no block in §5 declares.
3. **"host" is overloaded three ways**: channel (§6.3 "the host applies the move"), server (§6.1 "the host keeps a 10-minute dedup window" — this one *must* be server-side to make retries safe), platform (§12.3 "Hosts own the narrow fallbacks"). Define `server` / `channel` / `core` and use them.
4. **§7.1 `data?()` optional** means a "data-only refetch" may re-run `render`; require `data()` when `refreshMs` or `changed(update)` is used.
5. **§4.1 vs §14.3**: the default `fallback` is described as a generic summary in one and `toText` in the other. Pick `toText`.
6. **§7.2 data response has no `treeRev`**, so a client that missed the event cannot detect a stale tree. Add it.
7. **§7.2 action body carries `rev`** with no defined use. Define it (optimistic concurrency for `edit`) or drop it.
8. **§13.3** `SIGRUN_SUPERVISED` set by the Dockerfile makes a bare `docker run` advertise a Restart button that kills the container for good. Set it in compose/chart only; also, `SIGRUN_DEV`/`SIGRUN_SUPERVISED`/`SIGRUN_DEV_GALLERY` appear in no config surface.
9. **`sigrun/blocks`** needs an `exports` map; root `package.json` has none today (adding one is the first breaking-ish change to that surface).
10. **§7.2 uploads are multipart**; `@fastify/multipart` is not a dependency, and W2 §6.2 chose raw octet-stream for core uploads. Reuse the raw shape.
11. **§5.1 `page.empty`** "shown when `main` binds to nothing" — define "nothing" (missing path, `[]`, `null`).
12. **§8.1 `show_blocks` appends an entry *and* a tool result**: say how the transcript avoids rendering both rows.
13. **§15 link allowlist** is not what the renderer does: `webui/src/entries/Markdown.tsx:153-156` spreads links straight through, and react-markdown's default `urlTransform` also permits `irc:`/`tel:`. Add an explicit three-scheme transform in both channels.
14. **§11.2 `Content-Security-Policy: default-src 'none'`** on an image response is a no-op; `nosniff` plus the webui's own `img-src 'self' data:` is the actual control.
15. **§11.1 assets** are readable by every authenticated principal — say so, and require `realpath` containment (not just lexical `..` rejection) for `asset:` and the assets route.
16. **§11.2 AVIF** is accepted by the proxy but not by `data:` URLs or by pi-tui's dimension readers (`terminal-image.d.ts:95-99`). Drop it or state the fallback.
17. **§8.3 note text** says "Changes **the user** made"; conversations are shareable with `write` (W1 §5.9), so name the author per line (`ChangeRecord.by` already exists).
18. **Missing tests** worth naming in §16: `access: "none"` → 404; two principals on one surface with different access; the change note while the agent is busy; fork-asOf state; `since` ops across a fork; proxy rebinding (fake resolver flipping to `127.0.0.1`); a `v: 2` tree in an old TUI; handler-name validation (`reorder` without `onMove`).

---

**What is already right** (so the plan keeps it): the closed-set discipline and per-placement table (§5.7) is the strongest part — it is checkable and the sizing doc backs nearly every row; layout/data separation with `DataOp` + `rev`/`treeRev` is the correct shape and matches how the existing view deltas work; events carrying no data (§7.3) is the right call and correctly reasoned from principal-specific `render`; `apply: live|restart` + `pendingRestart` + a supervised restart is well-bounded; the interaction/ambient re-expression drops the two-shape seam cleanly; `toText` doing four jobs is good economy.