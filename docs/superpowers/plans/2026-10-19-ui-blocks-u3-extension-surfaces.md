# U3 — Extension Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensions declare views and panels; the server renders them per principal, enforces access, routes actions (with dedup, rate limits and the move rules), takes uploads, serves assets, and announces changes to exactly the streams watching each instance; the webui and TUI show them in the rail and right panel.

**Architecture:**
- **Contract:** `surfaces` on the factory result (`src/extension.ts`), validated at load (`src/harness/loader.ts`); malformed → quarantine.
- **Service:** `src/server/surfaces/` holds a `SurfaceService` with four parts: the per-principal access cache, the per-instance `rev` counter and (for `sharedData`) op log, the action dedup window, and the watcher registry.
- **Routes:** `src/server/routes/surfaces.ts` mounts under `/v1/ext/<slug>/surfaces/…` and `/assets/…`, beside W5's `registerExtensionRoutes`, which now rejects the reserved prefixes.
- **Events:** W3's `/v1/events` gains a `hello {streamId}` first frame (spec §7.3 amendment); `surface.changed` goes through the `EventHub` with a per-stream filter supplied by the watcher registry.

**Tech Stack:** Fastify 5, `@sigrun/shared/blocks`, `src/blocks/validate.ts` (U0), W1 `Principal`/`accessOf`, W3 `EventHub`, W5 `SigrunHost`.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §6.1–§6.5, §7, §11.1 (assets), §15, §16 (Events, Moves, Access, Validation of handler names, Routes).

**Depends on:** U0 for Tasks 1–4. Task 5 also needs U1 and U2 merged (it wires their `SurfaceView`s).

## Global Constraints

- Routes (all through W1's auth pipeline):
  - `GET /v1/ext/<slug>/surfaces/<id>?params=<json>` → `{tree, data, rev, treeRev, access}`;
  - `GET /v1/ext/<slug>/surfaces/<id>/data?params=<json>&since=<rev>` → `{rev, treeRev, data}` or `{rev, treeRev, ops}`;
  - `POST /v1/ext/<slug>/surfaces/<id>/actions` body `{action, payload, actionId, params}` → `{ok: true, rev, ops?, navigate?, toast?}` or `{ok: false, error: {message, field?}}`;
  - `PUT /v1/ext/<slug>/surfaces/<id>/uploads/<field>/<name>?params=<json>`, raw `application/octet-stream` (the shape of core's `PUT /v1/conversations/:id/uploads/:name`; reuse its `validUploadName` and octet-stream default);
  - `GET /v1/ext/<slug>/assets/<path>`.
- `access: "none"` → `404 surface_not_found` on all four surface routes. `read` → actions `403`.
- Access cache: key `(slug, id, key, principal.user)`, TTL 60 s; a miss re-renders for that principal before deciding.
- `params`: JSON object, ≤ 4 KiB serialized; else `400 invalid_field params`.
- `key` = `instanceKey(params)`, default canonical JSON of `params` (sorted keys). Event `k` = `sha256(slug + "\0" + id + "\0" + key)` hex.
- Action dedup: one handler call per `actionId` per instance within 10 minutes; a duplicate returns the first result.
- Rate limit: 20 actions/s per principal per surface, burst 40 → `429`.
- Action timeout: 10 s → `{ok: false, error: {message: "timed out"}}` (the channel snaps back).
- Op log (only `sharedData: true`): last 100 updates per instance.
- Watcher entry: `(streamId, slug, id, key, access)`; refreshed by any surface/data fetch carrying `X-Sigrun-Stream`; dropped on stream close or 10 minutes after the last fetch.
- Reserved route prefixes under `/v1/ext/<slug>/`: `surfaces/`, `assets/`.
- `render`/handler throws → `500 surface_failed`; invalid tree → `500 surface_failed` with errors logged (and in the body when `server.dev: true`). The extension stays loaded.

## Review Focus

1. **The same principal with two tabs on one instance** — both streams are watchers; each gets the event; closing one tab drops only its entry. Owner: Task 4.
2. **A principal demoted from write to read while a tab is open** — within 60 s their action is refused (cache expiry re-renders), and their next data fetch returns the new `access`. Owner: Task 2.
3. **`params` key order** — `{a:1,b:2}` and `{b:2,a:1}` are the same instance (same `key`, same watcher entry, same dedup window). Owner: Task 2.
4. **An extension that calls `changed` from its factory body before boot completes** — rejected or deferred per the existing seam-binding contract, never crashing boot. Owner: Task 4.
5. **An upload exceeding `maxBytes` streamed without `Content-Length`** — the server stops reading at the cap and answers `413`, without buffering the rest. Owner: Task 3.

---

### Task 1: Contract, load-time validation, reserved prefixes

**Files:**
- Modify: `src/extension.ts` (types: `SurfaceDef`, `SurfaceContext`, `UploadedFile`, `ActionResult`, `SurfacesContribution`; `SigrunExtensionResult.surfaces?`; `SigrunHost.surfaces: { changed(id: string, key: string, update?: DataOps): void }`)
- Modify: `src/harness/loader.ts` (collect `surfaces`; validate ids, titles, icons, placements, `refreshMs ≥ 5000`, `data()` present when `refreshMs` is set; collected as `LoadedExtensions.surfaces: {extension: slug, defs}[]`)
- Modify: `src/harness/loader.ts` route validation (the W5 check near the `route.path.startsWith("/")` rule) — quarantine an extension declaring a route path starting `surfaces/` or `assets/`
- Test: `test/surfaces-contract.test.ts`, `test/fixtures/fixture-surfaces/` (a view `board` with lanes and a panel `stats`), `test/fixtures/fixture-surfaces-bad/`, `test/fixtures/fixture-surfaces-route-clash/`

**Interfaces:**
- Produces (verbatim from spec §7.1): `SurfaceDef<P>`, `SurfaceContext`, `UploadedFile`, `ActionResult` (`update?: DataOps`).

- [ ] **Step 1: Write failing tests:** `fixture-surfaces` loads and appears in `GET /v1/extensions` with its surfaces; `fixture-surfaces-bad` (duplicate surface id; unknown icon; `refreshMs: 1000`; `refreshMs` without `data()`) is quarantined with one message per problem; `fixture-surfaces-route-clash` declaring `path: "surfaces/x"` is quarantined naming the route; the contract d.ts (W5's `tsconfig.extension.json` build) exports the new types.
- [ ] **Step 2: Run** `npx vitest run test/surfaces-contract.test.ts` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** + `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `git commit -m "surfaces: extension contract field, load-time validation, reserved route prefixes"`.

### Task 2: Render and data routes, access cache, instance keys

**Files:**
- Create: `src/server/surfaces/service.ts` (`SurfaceService`), `src/server/surfaces/access-cache.ts`, `src/server/surfaces/instance.ts` (`canonicalJson`, `instanceKey`, `eventKey`), `src/server/routes/surfaces.ts`
- Modify: `src/server/index.ts` / `src/server/context.ts` (register routes; `ServerContext.surfaces`)
- Test: `test/surfaces-routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class SurfaceService {
    render(slug: string, id: string, params: JsonObject, principal: Principal, stream?: string): Promise<RenderResult>;
    data(slug: string, id: string, params: JsonObject, principal: Principal, since?: number, stream?: string): Promise<DataResult>;
    accessFor(slug: string, id: string, key: string, params: JsonObject, principal: Principal): Promise<SurfaceAccess>; // cache or re-render
    bumpRev(slug: string, id: string, key: string, ops?: DataOp[]): number;  // ops kept only for sharedData
  }
  ```

- [ ] **Step 1: Write failing tests** (in-process server, fixture extension whose `render` returns `access` from a test-controlled map):
  - alice (`write`) gets `{tree, data, rev: 0, treeRev: 0, access: "write"}`; the tree passed `validateTree` with `handlers` = the surface's action keys;
  - bob (`none`) gets `404 surface_not_found` on surface and data routes, the same body as an unknown surface id;
  - `params` over 4 KiB → `400`; `{a:1,b:2}` and `{b:2,a:1}` produce the same `key` (Review Focus 3);
  - principal-specific surface: every data fetch calls `data()` (spy count) and returns full data; `sharedData` surface: after `changed(id, key, {ops})`, `?since=0` returns `{rev: 1, ops}`, and `?since=` older than the 100-update window returns full data;
  - an invalid tree from `render` → `500 surface_failed`, the body has `errors` only when `server.dev` is true;
  - Review Focus 2: flip alice to `read`, advance fake time 61 s, her next action is `403`;
  - `render` throwing → `500 surface_failed`, the extension still listed as loaded.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "surfaces: render and data routes, per-principal access cache, instance keys, shared op log"`.

### Task 3: Actions, moves, uploads, assets

**Files:**
- Modify: `src/server/routes/surfaces.ts`, `src/server/surfaces/service.ts` (`act`, `upload`)
- Create: `src/server/surfaces/dedup.ts`, `src/server/surfaces/rate-limit.ts`, `src/server/routes/ext-assets.ts`
- Test: `test/surfaces-actions.test.ts`, `test/surfaces-assets.test.ts`

- [ ] **Step 1: Write failing tests:**
  - an action with a name not in `actions` → `400 unknown_action`;
  - `read` → `403`; `none` → `404`; both before the handler runs (spy not called);
  - two posts with one `actionId` call the handler once and return identical bodies;
  - 41 actions in one second from one principal → the 41st is `429`;
  - a handler sleeping 11 s → `{ok: false, error: {message: "timed out"}}` at 10 s (fake timers);
  - accept with `update: {ops}` → `{ok: true, rev: 1, ops}`; for a `sharedData` surface the ops are in the log; for a principal-specific one only `rev` advances;
  - accept without ops → `{ok: true, rev: <next>}` and no ops recorded (extension surfaces own their data, §6.3);
  - `navigate` and `toast` pass through;
  - upload: `fixture-surfaces`' `onUpload` receives `{field, name: "a.png", mime: "image/png", bytes}` with the MIME sniffed (a `.png` name over JPEG bytes reports `image/jpeg`); a `<name>` failing `validUploadName` (e.g. `..`) → `400`; over the field's `maxBytes` → `413` without reading the whole body (Review Focus 5: a chunked body larger than the cap, assert the socket is closed before the end is sent);
  - assets: `GET …/assets/img/a.png` serves the file with a sniffed type and `X-Content-Type-Options: nosniff`; `…/assets/../package.json` and a symlink inside `assets/` pointing outside it both → `404` (realpath containment).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** The package's assets dir comes from `package.json` `sigrun.assets`; absent → every asset request is 404.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "surfaces: actions (dedup, rate limit, timeout, move accept rules), uploads, contained asset serving"`.

### Task 4: Watchers, the `hello` frame, `surface.changed`

**Files:**
- Create: `src/server/surfaces/watchers.ts`
- Modify: `src/server/routes/events.ts` (W3: first frame `event: hello` / `data: {"streamId": "<uuid>"}`; `visible()` gets an explicit `surface.changed` branch that delivers only to streams in the watcher registry — its default branch treats any other event as conversation-scoped and must not see this one), `shared/src/views.ts` (`HostEventWire`, which lives there since W3, gains `{type: "surface.changed"; slug: string; id: string; k: string; rev: number; treeRev: number}`), `src/harness/seam-host.ts` (`host.surfaces.changed` bound through the existing lazy-binding contract)
- Modify: `webui/src/api.ts` / the shared `EventSource` from W3 (store `streamId`; send `X-Sigrun-Stream`), `tui/src/sse.ts` (same)
- Test: `test/surfaces-events.test.ts`, `webui/src/stream.test.ts`, `tui/test/sse.test.ts`

**Interfaces:**
- Produces: `export class WatcherRegistry { touch(stream: string, user: string, slug: string, id: string, key: string, access: SurfaceAccess): void; dropStream(stream: string): void; streamsFor(slug: string, id: string, key: string): string[] }`.

- [ ] **Step 1: Write failing tests:**
  - `/v1/events` first frame is `hello` with a UUID `streamId`; channels ignore event types they don't know (feed an `x.unknown` event to both clients' parsers: no error);
  - alice fetches with `X-Sigrun-Stream: s1`; `host.surfaces.changed("board", key)` → `s1` receives `surface.changed` whose `k` is the sha256 and which contains no params and no data; a stream that never fetched receives nothing; a watcher whose stored access is `none` receives nothing;
  - entries drop on stream close and 10 minutes after the last fetch (fake timers); a fetch at 9 minutes keeps it;
  - Review Focus 1 (two streams, one closes);
  - Review Focus 4 (`changed` in the factory body);
  - webui and TUI send `X-Sigrun-Stream` on surface fetches after `hello`, and after a reconnect with a new `streamId` they re-fetch every visible surface.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** root, webui and TUI suites — PASS.
- [ ] **Step 5: Commit** `git commit -m "surfaces: watcher registry, /v1/events hello frame (W3 amendment), surface.changed to watching streams only"`.

### Task 5: Rail, panel and transports in both channels

**Files:**
- Create: `webui/src/blocks/extTransport.ts` (`SurfaceTransport` over the routes above), `tui/src/blocks/ext-transport.ts`
- Modify: `webui/src/layout/Rail.tsx` (one entry per extension `view`, after core entries, in the user's saved order kept in `localStorage` `sigrun.railOrder`), `webui/src/layout/RightPanel.tsx` (one tab per `panel`), `webui/src/App.tsx` (route `/ext/<slug>/<id>?params=…`, browser back/forward through `navigate(params)`), `tui/src/ui/app.ts` + `tui/src/ui/sidebar.ts` (views listed under a "Views" group; panels in the side pane)
- Create: `webui/e2e/ext-surface.spec.ts`
- Test: `webui/src/layout/Rail.test.tsx`, `webui/src/layout/RightPanel.test.tsx`, `tui/test/app.test.ts` (extend)

- [ ] **Step 1: Write failing tests:** both transports refetch data every `refreshMs` while the surface is visible and stop when it's hidden; while visible, they make a `since` fetch every 5 minutes (the watcher keepalive); `navigate({target})` opens the core target (conversation, job, settings section, or another extension view) through the normal routes, and a target the user can't see shows the usual not-found state; with `fixture-surfaces` loaded, the rail shows the `board` view with its icon and title and the right panel a `stats` tab; reordering the rail persists across reload; a surface the principal can't see (`none`) has no rail entry; `navigate({board: "b2"})` changes the URL and back returns to `b1`; the TUI lists the view and opens it in the main pane; Playwright: alice drags a card across lanes in one browser context and it appears moved in bob's context (shared board) within 2 s; bob with `read` sees no drag handles.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui run test && npm run typecheck:webui && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck && npm run test:e2e` — PASS.
- [ ] **Step 5: Commit** `git commit -m "surfaces: rail and panel registration, transports in webui and TUI, two-browser e2e"`.
