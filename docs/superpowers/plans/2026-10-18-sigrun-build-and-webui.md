# Sigrun build + webui channel surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sigrun an installable binary (build step, spawn-the-tui), make the webui positively optional and replaceable (`server.webui.enabled`/`bundle`), and let extensions contribute web UI bundles.

**Architecture:** `@sigrun/shared` becomes a published leaf (theme tokens + wire types); `@sigrun/tui` becomes a published package spawned as a child process; sigrun core builds `src`→`dist` and ships the built webui bundle; the webui surface gains enable/select config + an extension bundle-contribution seam mirroring the provider pathway.

**Tech Stack:** TypeScript (NodeNext), tsconfig project references, vitest, tsx (dev), fastify + @fastify/static (bundle serving), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-18-sigrun-build-and-webui.md`

## Global Constraints

- `dist` is build output: gitignored, never committed, tarball-only. Dev keeps tsx (`start`/`tui`); production entries are `node dist/...`.
- `tsconfig.build.json` overrides the base: `noEmit: false`, `rootDir: "src"`, `include: ["src"]` (the base's `noEmit: true` + `include: ["src","test"]` don't pin the layout).
- `tsx` moves to devDependencies. The extension `.ts`-entry fallback is REMOVED under plain node (breaking change, changelog) — git/path extension sources must ship `dist/index.js`.
- The default webui bundle anchors to the PACKAGE ROOT (`import.meta.url`-relative from the built module); explicit selector paths stay cwd-relative.
- `server.webui` settings touch-list: `validateServer` allowed-keys + `update()` second-level sub-merge for `webui` (the `compaction`/`memorySeam` pattern) + `resolvedServerSection` projection.
- Selector discrimination is SYNTACTIC: contains `/` or `\` or starts with `.` → PATH; matches `^[a-z][a-z0-9_-]*$` → contributed-bundle NAME; anything else → validation error.
- Bootstrap omits BOTH `server.webui` and legacy `server.webuiBundle` when defaulted; `server.webuiBundle` reads as a deprecated alias for `server.webui.bundle` (precedence: env > `server.webui.bundle` > legacy > default), accepted with a deprecation warn for one release.
- Bundle name collisions: warn + retained sink on `OpenedHarness` (mirroring provider collisions); a `/v1/meta` `collisions` field is a plan step.
- Verification per task: `npm test` + `npm run typecheck` green (repo convention). Build tasks add `npm run build` green.

## Review Focus

1. An installed CLI run from an arbitrary cwd must still find its shipped default bundle (package-root anchor) — pinned in T3.
2. `PATCH {server:{webui:{enabled:false}}}` must not drop a previously set `bundle` (second-level sub-merge) — pinned in T4.
3. A defaulted first boot must leave neither `server.webui` nor `server.webuiBundle` in the file (the legacy key would otherwise re-arm the cwd bug on next boot) — pinned in T5.
4. `sigrun run`/`attach` with `@sigrun/tui` absent must fail with "install @sigrun/tui", not a module-not-found crash (optional dep) — pinned in T2.
5. A contributed bundle whose `dir` lacks `index.html` fails at serve time naming the extension (the loader has no fs coupling) — pinned in T6.

---

### Task 1: `@sigrun/shared` becomes a published package

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.build.json`; move `src/shared/*` → `shared/src/*`
- Modify: root `package.json` (workspaces += `shared`), importers of `src/shared` (tui + webui + core)

**Interfaces:**
- Produces: `@sigrun/shared` — publishable (`private` removed, `exports`, `files:["dist"]`, own build). Exports the theme tokens (from `themes.ts`), the conversation/turn shapes (`conversations.ts`, `turns.ts`), AND the wire types the tui reads from the server (`SessionMeta`, `SessionMetaPatch` from `src/server/session-meta.ts`; `CommandsResponse`, `SlashCommand` from `src/server/commands.ts`; the response views the tui consumes from `src/server/views.ts`) — moved INTO shared so the tui is a pure client of the wire, never a relative importer of server source.
- Consumes: nothing (pure leaf, zero imports — the existing invariant).

- [ ] **Step 1: Write the failing test** — `test/shared-package.test.ts`: importing `@sigrun/shared/themes` resolves to the built package, and the moved modules no longer live under `src/shared`.

- [ ] **Step 2: Run to verify failure** — FAIL (package doesn't exist).

- [ ] **Step 3: Implement** — move `src/shared/{themes,conversations,turns}.ts` to `shared/src/`, AND move the wire types (`session-meta.ts`, `commands.ts`, the tui-consumed `views.ts` shapes) into shared (they become the canonical wire definitions; `src/server/` re-exports them for the server's own use). Add `shared/package.json` (`@sigrun/shared`, build → `dist`), add `shared` to root workspaces, update every importer (`rg -l "src/shared"` across core/tui/webui, plus the tui's `src/server/` type imports) to `@sigrun/shared/...`, add the workspace dep to each consumer's package.json.

- [ ] **Step 4: Run** — `npm install` (re-link workspaces) + `npx tsc -p shared/tsconfig.build.json` + `npm test` + all three typechecks green.

- [ ] **Step 5: Commit** — `git commit -m "shared: extract @sigrun/shared as a publishable leaf package"`

---

### Task 2: `@sigrun/tui` becomes a spawned package

**Files:**
- Modify: `tui/package.json` (publishable: remove `private`, add `bin: {"sigrun-tui": "dist/launch.js"}`, `exports`, `files:["dist"]`, real `dependencies` incl. `@earendil-works/pi-tui` + `@sigrun/shared`), `tui/tsconfig.build.json`
- Modify: `tui/src/api.ts` (server type imports → wire), `tui/src/launch.ts` (entry reads server URL + user from argv/env), `tui/src/theme.ts`, `tui/src/ui/sidebar.ts`, `tui/src/ui/conversation-pane.ts`
- Modify: `src/cli.ts` (`run`/`attach` spawn the bin)
- Test: `tui/test/packaging.test.ts` (new), `test/cli-spawn.test.ts` (new)

**Interfaces:**
- Produces: `@sigrun/tui` publishable; `sigrun-tui` bin; `launch.ts` main reads `--server`/`--user` (or `SIGRUN_SERVER`/`SIGRUN_USER`) and runs the TUI against the API.
- Consumes: `@sigrun/shared` (T1 — including the wire types it now owns, so the tui's `src/server/` type imports re-point to shared, not a relative path).
- `src/cli.ts` `run`/`attach` spawn `sigrun-tui` via `node <resolved bin>`; the parent watches the child exit to preserve agent-dies-with-tui; a missing package errors "install @sigrun/tui".

- [ ] **Step 1: Write the failing tests**

```ts
// tui/test/packaging.test.ts
test("tui builds to dist with a bin entry", () => { /* tsc emits dist/launch.js; package.json bin points at it */ });

// test/cli-spawn.test.ts
test("run spawns the sigrun-tui bin as a child process", async () => { /* mock spawn; assert node + resolved bin argv */ });
test("a missing @sigrun/tui errors 'install @sigrun/tui', not a crash", async () => { /* spawn rejects; assert the message */ });
test("the parent shuts down the server when the tui child exits", async () => { /* agent-dies-with-tui */ });
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** — tui packaging + the import re-points + the cli spawn swap. The tui's wire-type imports re-point to `@sigrun/shared` (T1) — if a type lives only in `src/server/`, move it to shared first (the load-bearing coupling per review).

- [ ] **Step 4: Run** — `npm --workspace @sigrun/tui run test` + `typecheck` + root `npm test` + typecheck green.

- [ ] **Step 5: Commit** — `git commit -m "tui: publishable @sigrun/tui spawned by the CLI (replaces in-process import)"`

---

### Task 3: core build step

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json` (`bin`→`dist/cli.js`, `files` swap, `build`/`prepublishOnly` scripts, `tsx`→devDeps, `@sigrun/tui` optional dep), `src/cli.ts` shebang → `#!/usr/bin/env node`, `.gitignore` (`dist/`)
- Modify: `Dockerfile` (build stage `RUN npm run build`, CMD `node dist/index.js`, deps stage `COPY tui/package.json`), `charts/sigrun/values.yaml` (entry + backup CronJob → `node dist/...`), `docker/docker-compose.yaml` (entry), `src/harness/packages.ts` (remove the `.ts` entry fallback)
- Test: `test/build.test.ts` (new)

**Interfaces:**
- Produces: `npm run build` → `dist/`; `sigrun` (via `dist/cli.js`) runs `serve` with no tsx; `webui/dist` ships in the tarball; the default bundle resolves from the package root.
- Consumes: `@sigrun/tui` as optional dep (T2).

- [ ] **Step 1: Write the failing tests**

```ts
test("npm run build emits dist/cli.js and dist/index.js", () => { /* build, assert both exist */ });
test("node dist/cli.js serve boots with no tsx", () => { /* spawn the built entry, assert listen, kill */ });
test("the default webui bundle resolves from the package root regardless of cwd", () => { /* chdir elsewhere, resolve, assert the package-anchored path */ });
test("a .ts-entry extension quarantines with a clear error under plain node", () => { /* packages.ts fallback removed */ });
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** — build config, package.json surface, shebang, the default-bundle anchor (`src/server/static.ts` or `config.ts`: default resolves package-root-relative, explicit stays cwd-relative), the three deploy files, the `.ts`-entry removal.

- [ ] **Step 4: Run** — `npm run build` + `npm test` + `npm run typecheck` green.

- [ ] **Step 5: Commit** — `git commit -m "build: tsc dist step; node entrypoints; package-root default bundle; drop ts .ts extension fallback"`

---

### Task 4: `server.webui` settings surface

**Files:**
- Modify: `src/harness/settings.ts` (validateServer allowed-keys + `update()` second-level sub-merge for `webui` + validation), `src/config.ts` (parse `enabled`/`bundle`, env `SIGRUN_WEBUI` strict parse, legacy alias precedence), `src/serve.ts` (bootstrap omits defaulted webui keys)
- Test: `test/webui-settings.test.ts` (new)

**Interfaces:**
- Produces: `SigrunConfig.webui: { enabled: boolean; bundle?: string }`; env/file/legacy resolution per Global Constraints.
- Consumes: settings store, config loader.

- [ ] **Step 1: Write the failing tests**

```ts
test("SIGRUN_WEBUI=false parses strict (true/false only, '' unset, else throws)", () => {});
test("PATCH {server:{webui:{enabled:false}}} preserves an existing bundle", () => { /* second-level sub-merge */ });
test("legacy server.webuiBundle reads as server.webui.bundle with a deprecation warn", () => {});
test("precedence: env > server.webui.bundle > legacy server.webuiBundle > default", () => {});
test("invalid enabled/bundle values fail validation naming the field", () => {});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** the settings + config + bootstrap changes.

- [ ] **Step 4: Run** — new suite + `test/config.test.ts` + `test/settings*.test.ts` PASS, `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "webui: server.webui enabled/bundle settings surface + legacy webuiBundle alias"`

---

### Task 5: bundle resolution + selection

**Files:**
- Modify: `src/server/static.ts` (resolve by enabled → name → path → default), `src/config.ts` (selector plumbing)
- Test: `test/webui-resolution.test.ts` (new)

**Interfaces:**
- Produces: `resolveWebuiBundle(config, contributedBundles)` honoring the resolution order; syntactic name/path discrimination; boot error on an explicit-but-unresolvable selector.
- Consumes: the contributed-bundle registry (T6 wires it; T5 accepts it as a parameter).

- [ ] **Step 1: Write the failing tests**

```ts
test("enabled:false mounts nothing even with a present bundle", () => { /* capabilities.channels [] */ });
test("a NAME selector resolves the contributed bundle", () => {});
test("a PATH selector (contains /) resolves the directory; missing index.html boot-errors", () => {});
test("an explicit selector resolving to nothing boot-errors naming it", () => {});
test("unset selector defaults to the built-in bundle; absent default → API-only", () => {});
test("capabilities.channels reports the selected bundle's name", () => {});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** the resolution.

- [ ] **Step 4: Run** — PASS + `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "webui: enabled gate + name/path bundle selection at serve time"`

---

### Task 6: extension-contributed bundles

**Files:**
- Modify: `src/harness/loader.ts` (`webuiBundles` on `ResolvedExtension` + validation + collect on `LoadedExtensions`, mirroring `providerContributors`), `src/harness/boot.ts` (collect into a name→dir registry, collision warn+sink, thread to `createServer`), `src/server/index.ts` (pass the registry to `resolveWebuiBundle`; `/v1/meta` `collisions` field)
- Test: `test/webui-contributions.test.ts` (new)

**Interfaces:**
- Produces: factory-result `webuiBundles?: {name, dir}[]`; `LoadedExtensions.webuiBundles`; `OpenedHarness.webuiBundles` + `webuiBundleCollisions`; `/v1/meta.collisions`.
- Consumes: the `providerContributors` loader pattern; T5's resolution.

- [ ] **Step 1: Write the failing tests**

```ts
test("an extension contributing webuiBundles registers them", async () => {});
test("a malformed webuiBundles entry quarantines the extension", async () => {});
test("a name collision warns, last-wins, and records to the sink", async () => {});
test("a contributed dir resolves against the extension module URL", async () => {});
test("a contributed dir lacking index.html fails at serve time naming the extension", async () => {});
test("/v1/meta reports the collisions (webui + provider sinks)", async () => {});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** the loader + boot + server wiring + the meta field (webui sink, and carry the provider sink too).

- [ ] **Step 4: Run** — PASS + `npm test` + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "webui: extension-contributed bundles (loader seam, collision sink, /v1/meta)"`

---

### Task 7: docs + full gate

**Files:**
- Modify: `docs/extending.md` (the `webuiBundles` contract), `docs/superpowers/specs/2026-10-18-sigrun-build-and-webui.md` status → implemented, `CHANGELOG.md` (the `.ts`-entry breaking change + the tui packaging change)

- [ ] **Step 1: Docs.**

- [ ] **Step 2: Full verification** — `npm run build && npm test && npm run typecheck` green.

- [ ] **Step 3: Commit** — `git commit -m "docs: webui bundle contribution contract + build changelog"`
