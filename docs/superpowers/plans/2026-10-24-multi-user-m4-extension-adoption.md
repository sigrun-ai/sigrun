# M4 — Extension Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The memory extension never shows one conversation's or user's history to another, and the MCP extension offers an admin catalog plus (when allowed) user-supplied servers, with each user's servers and tokens running in that user's jail.

**Architecture:** `@sigrun/memory-markdown` scopes recall to the calling conversation and capture to the event's `owner`. `@sigrun/ext-mcp` splits servers into shared (today's system children) and per-user (M2 `userServices` + `setUserTools`), keeps per-user tokens in `stores.user(u).secrets`, moves its OAuth paste flow behind extension routes keyed by the caller, and adds user-supplied servers gated by an admin setting.

**Tech Stack:** TypeScript (NodeNext), each extension repo's own vitest suite, committed `dist/`.

**Spec:** `docs/superpowers/specs/2026-10-23-sigrun-multi-user-design.md` §12, §10, §16 (M9, m3).

**Waits for:** Task 1 waits for nothing. Tasks 2–6 wait for M2 merged to sigrun `main`.

## Global Constraints

- Repos: `~/repos/sigrun-memory-markdown` (`@sigrun/memory-markdown`), `~/repos/sigrun-ext-mcp` (`@sigrun/ext-mcp`, declared name `sigrun.mcp`, slug `sigrun-mcp`). Each change rebuilds and commits `dist/`; verification is the repo's `npm test` + `npm run typecheck`, plus sigrun's `npm test` when core's built-in resolution is affected.
- **No npm publishing and no version bumps for release** (Michael's ruling while the npm-publish automation runs). Changelog entries go under `[Unreleased]`.
- MCP catalog server fields: `credentials: "user" | "shared"` (default `"user"`); `shared` requires `sharedAuthority: string` (non-empty) and may carry `users: string[]`; `availability: "all" | "opt-in"` (default `"all"`).
- Admin setting `userServers: "none" | "remote" | "all"` (default `"none"`).
- User server tool names: `u_<server>/<tool>`; a catalog server whose name starts with `u_` is a config error naming it.

## Review Focus

1. **Recall in a conversation that has never settled a run** — searches that conversation (possibly empty), never another one. Owner: Task 1.
2. **A shared catalog server with a `users` list** — only listed users' conversations get its tools; others get nothing and no error. Owner: Task 3.
3. **A user's OAuth completion arriving for a server that is not theirs or not OAuth-enabled** — refused, nothing stored. Owner: Task 4.
4. **An admin flipping `userServers` from `all` to `remote`** — that user's stdio servers stop and their tools disappear without a restart. Owner: Task 5.
5. **A catalog server disabled by the user while one of its calls is in flight** — the call finishes; the next conversation run no longer offers it. Owner: Task 3.

---

### Task 1: Memory recall stays in its own conversation (fix now)

Live today: `memory_recall` says it searches "this conversation's" transcript but searches whichever conversation settled most recently, any owner (`createMemory().runSettled` overwrites one global `attachRecallSource`).

**Files (memory repo):** Modify `src/degenerate.ts` (recall tool, backend), `CHANGELOG.md` (`[Unreleased]` → Security); Test `test/*.test.ts` (the existing recall suite).

**Interfaces:**
- The recall tool reads the calling conversation: `const handle = await api.conversation(api.conversationId, context)`; `recallFromEntries({ id: api.conversationId, entries: handle.entries.bind(handle) }, query, context)`. If pi-durable's `ConversationHandle` has no `entries`, keep a `Map<ConversationId, RecallSource>` filled by `runSettled` and read the caller's entry instead; never a global source.
- `attachRecallSource` / `hasRecallSource` are removed; the "No conversation bound" error goes away.
- The observe ring becomes `Map<string /* owner or "" */, ObserveRecord[]>`, each capped at `capacity`; `records(owner?)`.

- [ ] **Step 1: Write the failing tests:** two conversations A and B; B settles last; recall in A finds A's text and not B's (today it finds B's); recall in a conversation that never settled returns "No matches found." (Review Focus 1); observe records for alice and bob land in separate rings.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "fix(security): memory_recall searches the calling conversation only"`

### Task 2: Memory keyed by owner; transfer on delete

**Waits for:** M2 Task 1 (`owner` on events).

**Files (memory repo):** Modify `src/degenerate.ts` (`runSettled` keys by `event.owner`; `userDeleted`), `src/index.ts` (factory accepts the host when present).

**Interfaces:**
- The backend stays volatile (a degenerate backend is not durable memory), so "stored under `stores.user(owner).paths.data`" (spec §12.2) applies to future durable backends; this backend keys its in-memory rings by owner.
- `userDeleted({user, transferTo})`: the user's ring moves onto `transferTo`'s, each record tagged `transferredFrom: user`.

- [ ] **Step 1: Write the failing tests:** alice's runs observe into alice's ring; ownerless into `""`; deleting alice → bob moves her records with `transferredFrom: "alice"`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS) as Task 1.
- [ ] **Step 5: Commit** `git commit -m "memory: rings keyed by owner; transfer on user delete"`

### Task 3: MCP catalog — credentials, availability, per-user enablement

**Files (ext-mcp):** Modify `src/config.ts` (new fields + validation), `src/extension.ts` (factory takes the host; split shared vs per-user), `src/section.ts` (prompt section lists only the caller's servers); Create `src/user-servers.ts`; Tests `test/config.test.ts`, `test/catalog.test.ts`.

**Interfaces:**
- Config validation: `shared` without `sharedAuthority` → error naming the server; `u_`-prefixed name → error naming it; `users` only with `shared`.
- Per-user enablement in `stores.user(u).settings`: `{ catalog: { [server]: boolean } }` — absent = on for `availability: "all"`, off for `"opt-in"`.
- Shared servers: today's spawn path (M0 `serverSpawnEnv`), started at factory time, tools as system tools, with a per-tool wrapper that returns an error unless the acting user is in `users` (when set) and has the server enabled.
- Per-user (`credentials: "user"`) stdio servers: declared as one `userServices` entry per server whose `start(user)` returns `undefined` when the user has it disabled, else `{ command, args, env: { ...server.env, MCP_ACCESS_TOKEN?: <user's token> } }`. Remote per-user servers connect from sigrun's process with the user's token header. Discovered tools publish through `host.tools.setUserTools(user, tools)`; the factory declares `perUserTools: true`.
- Lazy: a user's servers start on that user's first `conversationCreated`/`runSettled` event or first visit to their settings section, not at factory time; disabling stops that user's service (`release` + `setUserTools` without its tools).

- [ ] **Step 1: Write the failing tests:** config errors as listed; alice and bob get separate stub server processes (two pids) with their own `MCP_ACCESS_TOKEN`; bob's conversations do not list alice's tools; a shared server limited to `users: ["alice"]` refuses bob's call through the wrapper and is absent from bob's section (Review Focus 2); `opt-in` is off until enabled; disabling mid-call lets the call finish and drops the tools afterwards (Review Focus 5).
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS); sigrun's `npm test` too (the built-in resolves this repo).
- [ ] **Step 5: Commit** `git commit -m "feat: catalog credentials (user default, shared with stated authority), per-user servers and tools"`

### Task 4: Per-user OAuth

**Files (ext-mcp):** Modify `src/oauth.ts` (flow state per `(user, server)`), `src/tokens.ts` (per-user read/write through `stores.user(u).secrets` key `token:<server>`; the file store stays for shared servers), `src/extension.ts` (routes), `src/cli.ts` (the CLI flow keeps working for shared servers only); Tests `test/oauth.test.ts`.

**Interfaces:**
- Routes (auth `user`): `POST /v1/ext/sigrun-mcp/oauth/:server/start` → `{ url }` (the same paste flow `startOauth` runs today, PKCE pair kept in memory keyed by `(principal.user, server)` for 10 minutes); `POST /v1/ext/sigrun-mcp/oauth/:server/complete { redirectedUrl }` → `extractCode` + `exchangeCode` → stores the token for `principal.user` → 204. A server that is shared, unknown, or has no `oauth` block → 404 `{error: "unknown_server"}`; no pending flow for this user → 400 `{error: "no_pending_flow"}` (Review Focus 3).
- Storing a token restarts that user's service for the server so it picks the token up.

- [ ] **Step 1: Write the failing tests:** alice's completion stores under alice only; bob's `complete` for alice's pending flow → 400; a shared server → 404; the restarted service sees the new token (stub `getenv` tool from M0).
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat: per-user OAuth through extension routes"`

### Task 5: User-supplied servers

**Files (ext-mcp):** Modify `src/user-servers.ts`, `src/config.ts` (`userServers` admin setting in `mcp.json`); a `scope: "user"` settings section (M2 Task 6) for adding/removing servers; Tests `test/user-servers.test.ts`.

**Interfaces:**
- Per-user settings `{ servers: { [name]: McpStdioServerConfig | McpUrlServerConfig } }`, validated with the same `parseMcpConfig` rules; names must not start with `u_` (the prefix is added).
- `userServers: "none"` → user servers ignored; `"remote"` → URL servers only; `"all"` → stdio too. Stdio user servers run as `userServices` (their own jail); remote ones connect from sigrun's process (no network rules exist, spec §9.4, so a user URL reaches nothing that user's bash could not).
- Tools publish as `u_<server>/<tool>` through `setUserTools`.
- Live: a change of `userServers` stops now-disallowed servers and republishes tools without a restart (Review Focus 4).

- [ ] **Step 1: Write the failing tests:** `none` ignores a user stdio server; `remote` loads a URL server and ignores stdio; `all` runs stdio in a user service; tool names carry `u_`; flipping `all` → `remote` stops the stdio service and drops its tools.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat: user-supplied MCP servers gated by userServers"`

### Task 6: Other built-ins, docs

**Files:** sigrun `test/builtins.test.ts` (one test each for codemode and tool-search: a per-user tool `acme@alice` appears in codemode's namespace and in tool-search results for alice's conversation only — spec §12.3); ext-mcp `README.md` (catalog fields, `sharedAuthority` warning in the spec's words, user servers, per-user OAuth), memory `README.md` (scoping); both `CHANGELOG.md` `[Unreleased]`.

- [ ] **Step 1: Write the failing sigrun tests**, run (FAIL if either built-in reads the registry instead of the conversation's resolved tools; fix there if so), run (PASS).
- [ ] **Step 2: Docs.**
- [ ] **Step 3: Commit** per repo `docs: multi-user (M4)` / `test: per-user tools reach codemode and tool-search (multi-user M4)`.
