# W5 — Extension integration points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give extensions the surfaces the planned packages need:
- one documented contract type;
- HTTP routes (webhooks, OAuth callbacks);
- slash commands;
- skills shipped in packages plus a user skills dir;
- an in-process conversation API for channel bridges;
- identity/access helpers for shared resources (kanban);
- notifier transports.

**Architecture:** Every new factory-result field follows the existing loader pathway:
1. validate in `resolvedFromFactory` (a malformed field quarantines);
2. collect with the slug on `LoadedExtensions`;
3. thread through `OpenedHarness`;
4. list in `GET /v1/extensions`.

Host-bound APIs extend the existing seam host and bind lazily post-open. They are never usable from a factory body.

**Tech Stack:** TypeScript (NodeNext), Fastify 5, web-standard `Request`/`Response` (Node ≥ 22), vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` §9.1–§9.7, plus the §10 W5 tests.

**Depends on:**
- W1: `Principal`, `accessOf`, the pipeline's unclaimed gate covering `/v1/ext/*`.
- W3: the `EventHub`, `/v1/extensions`.
- W4: `jobs` already collected (this plan documents it in the contract type).

## Global Constraints

- Extension routes mount at `/v1/ext/<slug>/<path>`.
- `auth: "user" | "admin" | "public"`:
  - `public` skips stage 5 (authentication) but NOT stages 1 or 4 (Host/Origin, unclaimed gate);
  - `admin` requires `principal.admin`.
- Route `bodyLimit` defaults to 1 MiB (1 048 576).
- No Fastify type crosses the contract: handlers take `Request` and return `Response`.
- `server.publicUrl` (env `SIGRUN_PUBLIC_URL`) is an absolute http(s) URL with no trailing slash. When unset, notification `url` is omitted.
- **Commands:**
  - the core names `new`, `fork`, `compact`, `export`, `import`, `name`, `model`, `thinking`, `jobs` (from `src/server/commands.ts`) are reserved;
  - a colliding extension command is dropped with one warning;
  - extension-vs-extension collisions are last-registered-wins, recorded in `/v1/meta` `collisions.commands`;
  - invoking needs `write` on the conversation.
- **Skills:**
  - precedence is workspace > user (`<configDir>/skills/`) > packages (install order);
  - `skills.sectionMaxBytes` is a live setting, default 4096;
  - a skills-only package (manifest declares skills, no loadable entry) loads `ok`;
  - a declared entry that does not resolve still quarantines.
- **Host APIs** reject when called before the harness binds (the existing seam-host lazy binding pattern).
- **Notifier delivery:**
  - runs on the event-bus side lane, deadline `config.memorySeam.hookDeadlineMs`;
  - errors are logged, never retried.
- **Verification:** per task `npm test` + `npm run typecheck`; Task 1 adds `npm run build`; Task 4 adds `npm --workspace @sigrun/webui test` if the skills UI changes (it does not).

## Review Focus

1. **A `public` extension route hit while the server is unclaimed.** The pipeline answers 403 `setup_required` (spec §5.8). Task 2 pins it.
2. **A route handler that throws or returns a non-`Response`.** The adapter maps it to 500 `{error:"extension_route_failed", extension}` and logs. It never crashes the process. Task 2 pins both.
3. **A `Request` body read twice.** The adapter hands the handler a fresh `Request` built from the buffered Fastify body; a second `request.text()` rejects per the web spec. Task 2 documents that, and needs no special handling.
4. **A skills-only git package with a `pi.extensions` TypeScript module.** The loader must NOT try to import the `.ts` (the build spec removed the `.ts` entry fallback under plain node). The skills load, and one warning names the skipped pi extension. Task 4 uses a fixture shaped like `obra/superpowers`.
5. **`host.conversations.submit` with a user that is not in the directory** (a channel's unmapped user). It stamps the given string as owner on create, and submit does not verify. The docs say extensions own their user mapping. Task 5 pins that it does not throw.

---

### Task 1: The documented contract type

**Files:**
- Create: `src/extension.ts`, a **types-only**, self-contained module.
  - It may `import type` only from `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@sigrun/shared/*`.
  - It exports `SigrunExtensionResult`, `SigrunHost`, `SigrunExtensionFactory`, and every field type: `ProviderContribution`, `WebuiBundleContribution`, `ExtensionWorker`, `JobSpec`, `ExtensionRouteContribution`, `ExtensionCommandContribution`, `NotifierContribution`, the lifecycle handler payloads, `InteractionRecord`, `AmbientRecord`, `Sharing`, `Access`, `DirectoryUserWire`.
- Create: `tsconfig.extension.json` (extends `tsconfig.json`; `emitDeclarationOnly: true`, `declaration: true`, `rootDir: "src"`, `outDir: "dist"`, `files: ["src/extension.ts"]`).
- Modify: `package.json`:
  - `"exports": { ".": "./dist/index.js", "./extension": { "types": "./dist/extension.d.ts" } }`;
  - `build` appends `&& tsc -p tsconfig.extension.json`.
- Modify: `src/harness/loader.ts`. The internal `ResolvedExtension` and the validated candidate type reference the public field types from `src/extension.ts`, so the two cannot drift. Add a compile-time assertion that every key the loader reads (`extension`, `name`, `providers`, `webuiBundles`, `health`, `runSettled`, the lifecycle handlers incl. `userDeleted`, `interactionKinds`, `ambientKinds`, `workers`, `jobs`, `routes`, `commands`, `skills`, `notifiers`) is a key of `SigrunExtensionResult`.
- Modify: `docs/extending.md`:
  - a "The factory result" section — one table, field → type → what core does with it → which section documents it;
  - the rule "the first parameter is the host, never a defaulted options object (`factory.length > 0` gates the host argument)";
  - the import line `import type { SigrunExtensionResult, SigrunHost } from "sigrun/extension"`.
- Test: `test/extension-contract.test.ts` (new): `npm run build` emits `dist/extension.d.ts` with no runtime `.js` for it, and a fixture `.ts` file type-checks against it (`tsc --noEmit -p test/fixtures/contract-consumer/tsconfig.json`, consuming the emitted d.ts via a `paths` mapping).

- [ ] **Step 1: Write the failing test** above.
- [ ] **Step 2: Run** `npx vitest run test/extension-contract.test.ts`. Expected: FAIL (no `src/extension.ts`).
- [ ] **Step 3: Implement** the types, tsconfig, exports, the loader assertion, and the docs table. The types for routes/commands/skills/notifiers/host APIs are declared here even though Tasks 2–6 implement them. The table marks each with its task until it lands; the final task removes those markers.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: green, and `ls dist/extension.d.ts`.
- [ ] **Step 5: Commit** `git commit -m "extensions: one documented contract type (sigrun/extension, types-only) + loader drift assertion"`.

### Task 2: Extension HTTP routes

**Files:**
- Create: `src/server/routes/extension-routes.ts`, holding `registerExtensionRoutes(app, ctx)`. It mounts every collected route, plus the `Request`/`Response` adapter.
- Modify: `src/harness/loader.ts`:
  - validate `routes` (array; each `method` in GET/POST/PUT/PATCH/DELETE, `path` a string not starting with `/` and not containing `..`, `auth` in the three values, optional positive `bodyLimit`, `handler` a function);
  - collect `LoadedExtensions.routeBindings: {extension: slug, routes}[]`;
  - expose `OpenedHarness.extensionRoutes`.
- Modify:
  - `src/server/auth/pipeline.ts`: a request whose path starts `/v1/ext/` resolves its route's `auth`, and `public` skips stage 5 only;
  - `src/config.ts` / `src/harness/settings.ts` / `shared/src/settings.ts`: `server.publicUrl` + env `SIGRUN_PUBLIC_URL` (validated: absolute http(s) URL; a trailing slash is stripped).
- Modify: `src/server/routes/extensions.ts` (W3). `GET /v1/extensions` entries gain `routes: [{method, path, auth}]`.
- Create: fixture `test/fixtures/fixture-routes/index.js`, declaring:
  - `GET ping` (user) → `Response.json({user: ctx.principal?.user})`;
  - `POST hook` (public) → echoes `await request.text()`;
  - `GET boom` (user) → throws;
  - `GET bad` (user) → returns `"not a response"`;
  - `GET admin-only` (admin) → 204.
- Test: `test/extension-routes.test.ts` (new).

**Interfaces:**
- Produces, in `src/extension.ts` (Task 1):
  ```ts
  export interface ExtensionRouteContribution {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly path: string;
    readonly auth: "user" | "admin" | "public";
    readonly bodyLimit?: number;
    handler(request: Request, ctx: { readonly principal?: Principal; readonly host: SigrunHost }): Promise<Response>;
  }
  ```
- **The adapter** builds `new Request(absoluteUrl, {method, headers, body: rawBody})`, where `absoluteUrl` uses `server.publicUrl` when set, else `http://<Host header>`. The raw body is registered with a per-route `addContentTypeParser("*", {parseAs: "buffer"})` inside an encapsulated Fastify plugin scope, so core routes keep their parsers. It writes `Response.status` / `headers` / `arrayBuffer()` back to the reply.

- [ ] **Step 1: Write failing tests** (token method, claimed server):
  - `GET /v1/ext/fixture-routes/ping` with alice's token → `{user:"alice"}`;
  - without a token → 401;
  - `POST …/hook` without a token → 200 echoing the body;
  - on an UNCLAIMED server `POST …/hook` → 403 `setup_required`;
  - `…/boom` → 500 `{error:"extension_route_failed", extension:"fixture-routes"}`, and the server still answers `/healthz`;
  - `…/bad` → 500, the same body;
  - `…/admin-only` as a non-admin → 403;
  - a body over 1 MiB to `hook` → 413;
  - a fixture route with `path: "../x"` → the extension is quarantined.
- [ ] **Step 2: Run** `npx vitest run test/extension-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "extensions: HTTP routes under /v1/ext/<slug>/ (Request/Response contract, per-route auth, server.publicUrl)"`.

### Task 3: Extension slash commands

**Files:**
- Modify: `src/harness/loader.ts`:
  - validate `commands` (each `name` matching `^[a-z][a-z0-9-]*$`, `description` a string, optional `args` a string, `run` a function);
  - collect `commandBindings`.
- Modify: `src/server/commands.ts`. `buildCommandCatalog(core, bindings)` returns:
  - the merged list, each extension entry carrying `extension: slug` and `endpoint: {method:"POST", path:"/v1/conversations/:id/commands/<name>"}`;
  - the dropped/collided records.

  `SLASH_COMMANDS` stays the core table.
- Modify:
  - `shared/src/commands.ts`: `SlashCommand.extension?: string`;
  - `shared/src/views.ts`: `MetaResponse.collisions.commands: {kind:"command", name, previous, contributor}[]`;
  - `src/server/routes/meta.ts`: `/v1/commands` serves the merged catalog, and `/v1/meta` adds `collisions.commands`.
- Create: route `POST /v1/conversations/:id/commands/:name {args?: string}` in `src/server/routes/submissions.ts` (`loadConversation(ctx, "write")`):
  - unknown name → 404 `command_not_found`;
  - calls `run({conversationId, args: args ?? "", principal, host})`;
  - returns `200 {notice?}`;
  - a throw → 500 `{error:"command_failed", extension}`.
- Modify:
  - webui composer `/` menu (`webui/src/composer/Composer.tsx`): entries with `extension` POST to their endpoint and render a returned `notice` as a transient banner;
  - TUI `tui/src/actions.ts`: the same, rendering the notice in the status bar.
- Create: fixture `test/fixtures/fixture-commands/index.js`, declaring `hello` (returns `{notice: "hi " + args}`) and `new` (core collision).
- Test: `test/extension-commands.test.ts` (new); the client tests for the notice.

- [ ] **Step 1: Write failing tests:**
  - `/v1/commands` lists `hello` with `extension:"fixture-commands"` and lacks a second `new`;
  - `/v1/meta` `collisions.commands` is empty for the core-name drop (the drop is warned, not recorded) — and a second fixture also declaring `hello` produces one `collisions.commands` record, with last-registered winning;
  - `POST …/commands/hello {args:"bob"}` → `{notice:"hi bob"}`;
  - a read-only sharee → 403.
- [ ] **Step 2: Run** `npx vitest run test/extension-commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/webui test && npm --workspace @sigrun/tui test`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "extensions: slash commands (catalog merge, core names reserved, collisions in /v1/meta, write-gated invoke)"`.

### Task 4: Skills from packages, a user skills dir, and skills-only packages

**Files:**
- Modify: `src/skills/index.ts`.
  - The constant `skillsExtension` becomes `createSkillsExtension(opts: SkillsOptions)`, which still installs as the core extension named `sigrun.skills` (the reserved-section owner is unchanged).
  - Discovery merges three roots: workspace (through `ExecutionEnv`, today's `scanSkills`), user (`<configDir>/skills/` via `node:fs`), and packages (each root via `node:fs`, in install order).
  - First-wins in precedence order. A name collision logs `skills: "<name>" from <lower root> shadowed by <higher root>`.
  - `load_skill` reads the winning skill's body from its root: env for workspace, fs for the others.
  - The section cap reads `opts.sectionMaxBytes()` per render.
- Modify: `src/harness/packages.ts`.
  - `ExtensionResolution` becomes a union: `{kind: "entry", entry, enabled, skills?: string[]} | {kind: "skills-only", name, skills: string[], enabled}`.
  - A manifest's skill dirs come from `sigrun.skills` (string[]), else `pi.skills` (string[]), resolved against the package root, keeping only existing directories.
  - `findExtEntry` (git) and the npm/file resolution path skip any `pi.extensions` entry ending in `.ts`, with one warning: `pi-compat: skipping TypeScript pi extension <path> (not loadable under node); loading the package's skills only`.
  - "Declares skills, no loadable entry" → `skills-only`. "Declares an entry that does not resolve" or "declares neither" → keep today's throw (quarantine/sync error).
- Modify: `src/harness/loader.ts`.
  - A `skills-only` input records outcome `{name: slug-of-name, status: "ok"}`, imports nothing, and appends its skill dirs to `LoadedExtensions.skillRoots: {extension, dir}[]`.
  - Entry-bearing packages with manifest skills, and factory results' `skills` field (absolute dirs, validated as existing directories), append too.
- Modify: `src/harness/boot.ts`. Install `createSkillsExtension({userDir: join(roots.configDir, "skills"), packageRoots: () => collectedSkillRoots, sectionMaxBytes: () => settingsStore.read().skills?.sectionMaxBytes ?? 4096})`, where `collectedSkillRoots` is a `let` array filled after `loadExtensions` (sections render per request, so the late fill is visible).
- Modify: `shared/src/settings.ts` + `src/harness/settings.ts` (`skills?: {sectionMaxBytes?: number}`, a positive int, live). `docs/extending.md` names `skills/` as a config-root entry.
- Modify: `README.md`. The extensions example restores `"git:github.com/obra/superpowers@main"`, described as a skills-only package.
- Create: fixture `test/fixtures/fixture-skills-only/` — `package.json` `{name, pi: {extensions: ["./.pi/extensions/x.ts"], skills: ["./skills"]}}`, plus `skills/demo/SKILL.md`, plus the `.ts` file containing a syntax error (proving it is never imported).
- Test: `test/skills.test.ts`, `test/packages.test.ts`, `test/loader.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface SkillsOptions { readonly userDir: string; readonly packageRoots: () => readonly { extension: string; dir: string }[];
    readonly sectionMaxBytes: () => number }
  export function createSkillsExtension(opts: SkillsOptions): Extension;
  ```

- [ ] **Step 1: Write failing tests:**
  - `fixture-skills-only` loads with outcome `ok`, one warning naming the skipped `.ts`, and the section lists `demo`;
  - a package declaring `sigrun.extension: "./missing.js"` → quarantined;
  - precedence: the same skill name in workspace, user, and package → the section shows the workspace one, and `load_skill` returns the workspace body; removing the workspace copy → the user one wins;
  - `skills.sectionMaxBytes: 200` in settings → the section is truncated with the notice, live (no restart).
- [ ] **Step 2: Run** `npx vitest run test/skills.test.ts test/packages.test.ts test/loader.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "skills: user skills dir, package-shipped skills, skills-only packages (pi-compat .ts extensions skipped)"`.

### Task 5: Host conversation, identity, users, and access APIs

**Files:**
- Modify: `src/harness/seam-host.ts`. `SeamHost` gains (each binding lazily through the existing `harness()` promise, plus a server-provided bridge set at `createServer` time):
  ```ts
  readonly conversations: {
    create(opts: { owner?: string; sharing?: Sharing; name?: string; source?: string }): Promise<ConversationId>;
    submit(id: ConversationId, input: SubmissionInputPart[], opts?: { user?: string; requestId?: string; whenBusy?: WhenBusyMode }): Promise<SubmissionRecordWire>;
    watch(id: ConversationId, listener: (view: ConversationViewWire) => void): Promise<() => Promise<void>>;
    list(opts?: { owner?: string; archived?: boolean }): Promise<ConversationSummary[]>;
    meta(id: ConversationId): Promise<SessionMeta>;
  };
  readonly users: { list(): Promise<DirectoryUserWire[]>; get(user: string): Promise<DirectoryUserWire | undefined> };
  readonly access: { accessOf(principal: AccessPrincipal, resource: { owner?: string; sharing?: Sharing }): Promise<Access> };
  readonly identity: { actingUser(conversationId: ConversationId): Promise<string | undefined> };
  ```
- Create: `src/server/host-bridge.ts`, holding `createHostBridge(ctx: ServerContext): HostBridge`. It implements `create`/`submit`/`list`/`meta` with the SAME code paths as the HTTP routes (extract the route bodies into shared functions in `src/server/conversation-ops.ts`: `createConversationOp`, `submitOp`, `listConversationsOp`, `readMetaOp`), so content-part resolution, the served-model check, and activity stamping are identical. `watch` wraps `conversation.watch` + `serializeConversationView`. `source` defaults to the calling extension's slug.
- Modify:
  - `src/harness/boot.ts`: `OpenedHarness.bindHostBridge(bridge)` sets the bridge on all seam hosts;
  - `src/server/index.ts`: calls it after `ServerContext` is built.
- Create: fixture `test/fixtures/fixture-channel/index.js`, a factory stashing `host` and exposing (via the factory result's `health` closure, the existing test-retrieval trick, or a module-level export) a `drive()` that creates a conversation owned by `"alice"`, submits `"hello"`, and returns the id.
- Test: `test/host-conversations.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - after boot, the fixture's `drive()` → `GET /v1/conversations` as alice lists it with `owner:"alice"` and `source:"fixture-channel"`;
  - its transcript shows the user entry `"hello"` and a faux answer;
  - `host.identity.actingUser(id)` → `"alice"`;
  - `host.access.accessOf({user:"bob"}, {owner:"alice"})` → `"none"`;
  - `host.users.list()` includes alice;
  - `host.conversations.create({owner:"unmapped-user"})` does not throw;
  - a `host.conversations.*` call made inside the factory body rejects or waits per the existing seam binding contract (assert it does not resolve before boot completes).
- [ ] **Step 2: Run** `npx vitest run test/host-conversations.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "extensions: host conversations/users/access/identity APIs over the same code paths as the HTTP routes"`.

### Task 6: Notifiers

**Files:**
- Create: `src/server/notifications.ts`, holding `startNotifications(ctx)`.
  - It subscribes to the `EventHub` and the jobs service.
  - It builds `NotificationEvent`s.
  - It resolves recipients:
    - the resource owner;
    - for `interaction.pending`, also every directory user with `write` via `accessOf`.
  - It delivers to every collected notifier through the event bus's bounded side lane (a new `eventBus.runBounded(label, fn)` exposing the existing `#bounded`).
- Modify: `src/harness/loader.ts`. Validate and collect `notifiers` (each `{name: string, notify: function}`) as `notifierBindings`.
- Modify: `src/server/routes/stream.ts`. Maintain `watchersByConversation: Map<ConversationId, number>` on `ServerContext` (increment on stream start, decrement in `finish`), which the `"unwatched"` rule reads.
- Modify: `shared/src/settings.ts` + `src/harness/settings.ts` (`notifications?: {runSettled?: "unwatched"|"cron"|"always"|"never"}`, live, default `"unwatched"`).
- Modify: `docs/extending.md`, a "Notifiers" section (the event shape, recipients, best-effort delivery; transports live in extensions).
- Create: fixture `test/fixtures/fixture-notifier/index.js`, recording every `notify(event)` in an exported array.
- Test: `test/notifications.test.ts` (new).

**Interfaces:**
- Produces:
  ```ts
  export interface NotificationEvent {
    readonly type: "interaction.pending" | "job.failed" | "run.settled";
    readonly conversationId?: number; readonly jobId?: string;
    readonly user: string | undefined;   // the recipient
    readonly title: string; readonly body: string; readonly url?: string; // url = `${publicUrl}/#/c/<conversationId>` when publicUrl is set
  }
  export interface NotifierContribution { readonly name: string; notify(event: NotificationEvent, ctx: { readonly host: SigrunHost }): Promise<void> }
  ```
- **Title/body copy:**

  | type | title | body |
  |---|---|---|
  | `interaction.pending` | `"Sigrun needs you"` | the conversation display name |
  | `job.failed` | `"Job <name> failed"` | the error |
  | `run.settled` | `"Reply ready"` | the conversation display name |

  The display name is `name ?? autoName ?? "Conversation <id>"`.

- [ ] **Step 1: Write failing tests:**
  - with the fixture notifier, an interaction seeded in bob's conversation → one `interaction.pending` to bob; with a `write` share to dave, a second one to dave;
  - a run settling while a `/stream` client is attached → no `run.settled`; after the stream closes, the next settle → one `run.settled` to the owner;
  - `notifications.runSettled: "never"` → none;
  - a job whose run fails → `job.failed`;
  - a notifier that throws → logged, other notifiers still receive the event, and no unhandled rejection;
  - with `SIGRUN_PUBLIC_URL=https://sigrun.example.invalid`, `url === "https://sigrun.example.invalid/#/c/<id>"`; unset → `url` absent.
- [ ] **Step 2: Run** `npx vitest run test/notifications.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the "lands in Task N" markers from the `docs/extending.md` table (Task 1).
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "extensions: notifier contributions (interaction.pending, job.failed, unwatched run.settled) with per-user recipients"`.
