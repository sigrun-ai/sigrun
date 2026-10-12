# Task 7 Report: Slash commands — registry + composer `/` menu

**Status:** DONE

**Commits:**
- `d3c80a0` feat(server): slash-command catalog + GET /v1/commands (pi parity T7a)
- `328d83b` feat(webui): composer slash-command menu (pi parity T7b)

## What was built

### T7a — The registry (`src/server/commands.ts` + `GET /v1/commands`)

A thin `Map<string, SlashCommand>` of command METADATA — `{ name, description, argsHint?, endpoint: { method, path } }` — with NO server-side execute indirection (the plan's "thin catalog over the endpoints Tasks 4–6 built"). Served by `GET /v1/commands` → `{ commands: [...] }` next to `/v1/meta` in `index.ts` (both boot constants; cache-friendly).

Catalog per the controller rulings:

| Command | Endpoint | Args |
|---|---|---|
| `/new` | POST `/v1/conversations` | — |
| `/fork` | POST `/v1/conversations/:id/fork` | `[at]` |
| `/compact` | POST `/v1/conversations/:id/compact` | `[instructions]` |
| `/export` | GET `/v1/conversations/:id/export` | — |
| `/import` | POST `/v1/conversations/import` | `<jsonl>` |
| `/name` | PATCH `/v1/conversations/:id/meta` (the exact session-meta PATCH route) | `<name>` |
| `/model` | POST `/v1/conversations/:id/configure` (`{model}`) | `<provider/model>` |
| `/thinking` | POST `/v1/conversations/:id/configure` (`{thinking}`) | `<level>` |

`/model` and `/thinking` ARE included: the configure route (verified in source, ~line 780) accepts exactly `{model?, thinking?}` and each command sends one field — a pure client-side call, no new server surface. `/login`//`logout` (core §6.4), `/skill:name` (no endpoint), and prompt templates are excluded per the rulings.

### T7b — The composer menu (`webui/src/composer/Composer.tsx`)

- `/` as the first character opens the menu (`/` + no whitespace yet = query phase; the first space ends it). The catalog is fetched once per mount via `client.listCommands()` (boot constant — cache-friendly; a fetch failure leaves the menu empty but TYPED commands still execute, since the menu is an affordance, not the gate).
- Filtering by name prefix as the user types; ArrowUp/Down move a highlighted option (clamped); Enter selects (only while the menu has matches — otherwise Enter falls through to Send); Escape closes (clears the line).
- Selection: an ARGLESS command executes immediately; an arg-taking command inserts `/name ` for its args.
- Submitting a `/command args` line routes to the corresponding client call, never the submissions POST. Args parsing per command: `/name <string>` (whole rest — multi-word), `/fork [at]` (number; absent = newest), `/compact [instructions]` (whole rest), `/import <pasted JSONL>` (whole rest including newlines — multi-line paste works), `/export` (no args), `/model <provider/model>`, `/thinking <level>`.
- Unknown `/bogus` → `unknown command: /bogus` in the existing `role="alert"` strip — never a silent no-op. Client-side usage errors for missing/invalid args (`usage: /name <name>`, `/fork [at] — an entry id number`, the `/thinking` enum with the level list). Real call failures surface the client's fail-loud error there too. Successes clear the line (persisted, like a sent message) and show a `role="status"` notice.
- `/new`, `/fork`, `/import` navigate to the created conversation via a new optional `onNavigate` prop — App wires it to the same `onSelect` the sidebar uses.
- `/export` downloads the JSONL as `conversation-<id>.jsonl` (anchor + object URL — the download IS the endpoint result; a DOM no-op outside a browser, so tests assert the fetch) and reports `exported N entries`.
- New CSS: `.composer-command-menu` (+ name/args/description spans), `.composer-notice`.

### Client additions (`webui/src/api.ts`)

Thin, fail-loud, mirroring the wire: `listCommands()`, `fork(id, at?)`, `compact(id, instructions?)`, `exportConversation(id)` (raw text GET), `importConversation(jsonl)` (RAW-TEXT POST with the ndjson content-type — the server's own parser hands the route the unparsed string), `configure(id, {model?|thinking?})`, plus `ConversationCreatedWire`/`CommandWire`/`CommandsResponseWire`/`ConfigureInput`/`ConfigureResponseWire` types. `FetchLike` gained a required `text(): Promise<string>` (the ambient fetch has it); every test stub grew a mechanical sibling (the only touch on 7 other test files).

## Tests

- **Server** (`test/server-commands.test.ts`, 3 tests): the catalog shape (the known 8-name set, metadata fields, per-command argsHint presence/absence); every entry's `endpoint.method`+`path` resolves against the live Fastify route table (`app.hasRoute` — the catalog can never dangle); the registry keying (`/name` → meta PATCH; `/model` and `/thinking` share the configure endpoint).
- **Webui** (`Composer.test.tsx`, 12 new tests): `/` opens the menu with the fetched commands (catalog fetched exactly once); `/na` filtering and a plain-text line keeping it closed; selecting `/name` inserts `/name `; selecting argless `/export` executes immediately; selecting `/compact` inserts then submitting POSTs the compact call; `/name foo` PATCHes `{name:"foo"}` and clears the line; unknown `/bogus` errors in the alert strip with no submission; `/compact keep the plan` passes instructions; `/fork 5` POSTs `{at:5}` and navigates; `/export` GETs and reports the count; `/import` POSTs the RAW JSONL (not JSON-encoded) and navigates; `/name` with no args is a usage error; a failing configure call surfaces the client error.

## Verification

- `npm test` — 32 files, 251 tests passed
- `npm run typecheck` — clean
- `npm run test -w @sigrun/webui` — 18 files, 137 tests passed
- `npm run typecheck:webui` — clean
- `npm run test:e2e` — 13 passed in real Chromium: the 12 pre-existing
  ship-gate/smoke tests still green against the built bundle, plus the new
  `webui/e2e/slash-menu.spec.ts` (real browser, real server): `/` opens the
  menu with all 8 commands, `/na` narrows it to exactly `/name`, `/name
  research session` names the session (notice + composer cleared, verified
  via the session-meta PATCH through the real server), and `/bogus` errors
  in the alert strip. Screenshot captured mid-test at
  `.superpowers/sdd/2026-10-12-sigrun-pi-parity/artifacts/task-7-slash-menu.png`.

## UI verification note

The e2e first run FAILED — exposed honestly, not skipped: `textarea.press("Enter")`
inserts a newline (the composer has no Enter-to-send binding; that's
pre-existing — message sending also requires clicking Send), so the
command never executed and the notice never appeared. Fixed by clicking
`button.composer-send` in the spec; the run then passed. Menu-Enter selection
(the keydown path) is exercised by the keyboard-driven component tests.

## Self-review notes (known, accepted edges)

- With no conversation selected the composer textarea is disabled, so `/new` (which wouldn't need an id) is unreachable there; `executeCommand`'s `conversationId === null` guard is therefore a silent early return only in a state the UI cannot reach.
- If the catalog fetch fails, `commands` stays empty: the menu doesn't open and any typed `/command` errors "unknown command" — loud, not silent, and the §5 endpoints still work by other affordances (Compact button, etc.).
- `send()` handles command lines before the `sending` gate; double-clicking Send on a command while one is in flight could re-fire — the same exposure the pre-existing message path has while busy, and the button disables on `sending` when idle.
- `downloadJsonl` guards on `document` presence (jsdom-less test runner); no DOM = no download, but the fetch + notice still assert the behavior.

Nothing remains from the brief or the rulings.