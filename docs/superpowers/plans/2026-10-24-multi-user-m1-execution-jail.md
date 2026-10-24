# M1 — Execution Jail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a multi-user Linux server, every agent file and shell operation for user U runs in a Landlock-confined worker that sees only U's workspace, grants, home and temp, and read-only system paths; anything else fails closed.

**Architecture:** A small Rust helper (`sigrun-sandbox`) applies a Landlock policy and `exec`s its command. Core starts one worker per user through it: a Node process hosting pi-durable's unmodified `NodeExecutionEnv`, spoken to over the worker's stdin/stdout. `SandboxedExecutionEnv` forwards every `ExecutionEnv` member to that worker. `forConversation` picks the env from the conversation's owner and the isolation state, so every consumer (tools, file routes, jobs) follows without changes.

**Tech Stack:** Rust (stable, `landlock` crate, `#![forbid(unsafe_code)]`), TypeScript (NodeNext), pi-durable 1.3.0 `ExecutionEnv`, vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-23-sigrun-multi-user-design.md` §6, §8 (the allowlist M0 landed), §9 (all), §13, §16.

## Global Constraints

- Helper language: Rust only, `#![forbid(unsafe_code)]` in the helper crate (ruling 11). No C anywhere in sigrun.
- Landlock ABI ≥ 6 (Linux 6.12+) or isolation is unavailable. The helper applies every right of the running ABI, best effort up to ABI 7.
- Rights: `ro` = `EXECUTE | READ_FILE | READ_DIR`; `rw` = `ro` + `WRITE_FILE | REMOVE_FILE | REMOVE_DIR | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM | REFER | TRUNCATE`. `IOCTL_DEV` is never handled. Scopes: `SIGNAL | ABSTRACT_UNIX_SOCKET`. No network rules.
- Every process the helper starts has `no_new_privs`; the helper refuses uid 0 and gid 0.
- Worker env: the M0 allowlist (`AGENT_ENV_KEYS` in `src/harness/agent-env.ts`) **without `SSH_AUTH_SOCK`**, with `HOME`, `TMPDIR`, `USER` set per user.
- Never granted: `configDir`, `stateDir`, `cacheDir`, `storagePath` and everything under them (except `<stateDir>/sandbox/<user>/tmp`), every `<dataDir>/<slug>/`, other users' `<dataDir>/users/<other>/`, core's install root.
- Settings (restart-required): `server.isolation.mode: "auto" | "always" | "off"` (default `auto`, env `SIGRUN_ISOLATION`), `server.isolation.osUsers: boolean` (default `false`); live: `server.isolation.workerIdleMinutes` (default `10`).
- Error codes: `isolation_required`, `auth_required` (409 on user-adding paths), `isolation_unavailable: <reason>` (every env method), `invalid_grant` (400), `invalid_transfer` (409, `osUser` transfer).
- **No npm publishing** (Michael's ruling while the npm-publish automation workstream runs). The platform packages `@sigrun/sandbox-linux-x64|arm64` are created and built in CI but not published, and core does not list them as dependencies yet. The image and source checkouts get the helper another way (Task 2, Task 9).
- Shared-file note: `src/extension.ts`, `shared/src/views.ts`, `src/harness/settings.ts` are also edited by the in-flight UI-blocks U4–U7 branches. Additions here are self-contained; rebase conflicts are additive.
- This machine has no Rust toolchain (`cargo` absent) and its WSL2 6.6 kernel is below ABI 6. Install rustup stable for Task 1; the kernel suite (Task 10) runs only in CI.

## Review Focus

1. **A command run by the worker writes to the worker's IPC channel** — impossible: the channel is the worker's stdin/stdout, and commands get their own pipes. Owner: Task 5 (`/proc/self/fd` of a command lists only 0, 1, 2).
2. **A store root moves inside an existing grant after the grant was saved** (new `SIGRUN_DATA_DIR` under a granted directory) — the user's worker refuses to start with the reason named; never applied silently. Owner: Task 3.
3. **The second user arrives through a path other than the invite route** (proxy auto-provision, CLI `user add`, login) while isolation is unavailable — refused the same way. Owner: Task 6 (one guard inside `UserDirectory.add`).
4. **A worker crashes mid-`exec`** — the in-flight call returns an error, the next call gets a fresh worker, no crash loop. Owner: Task 5.
5. **Deleting users down to one under `auto`** — the jail stays on until restart (latch). Owner: Task 6.

---

### Task 1: The `sigrun-sandbox` helper (Rust)

**Files:**
- Create: `sandbox/Cargo.toml`, `sandbox/Cargo.lock`, `sandbox/src/main.rs`, `sandbox/src/policy.rs`, `sandbox/src/apply.rs`, `sandbox/tests/policy.rs`, `sandbox/README.md`
- Modify: `.gitignore` (`sandbox/target/`), `package.json` `files` (exclude `sandbox/`), `.dockerignore` (keep `sandbox/` in context, exclude `sandbox/target/`)

**Interfaces:**
- Produces (CLI):
  - `sigrun-sandbox probe` → stdout one JSON line `{"abi": <n>}` (0 when Landlock is unavailable), exit 0.
  - `sigrun-sandbox run -- <command> [args…]` → reads the policy JSON from the environment variable `SIGRUN_SANDBOX_POLICY`, applies it, and `exec`s with that variable removed and the rest of its environment unchanged (core spawns it with the worker's env already built). Not fd 3: Node's extra stdio pipes are socketpairs, which `/proc/self/fd/3` cannot reopen, and adopting a raw fd needs `unsafe`. The policy holds paths and ids, no secrets. Any failure before `exec`: one line on stderr starting `sigrun-sandbox:`, exit 125. Never runs the command unconfined.
- Produces (policy JSON, `sandbox/src/policy.rs` `Policy`): `{"ro": string[], "rw": string[], "minAbi": number, "uid"?: number, "gid"?: number, "groups"?: number[]}`. Paths that do not exist are skipped (logged on stderr), never fatal; a path given in both lists is an error.

- [ ] **Step 1: Write the failing tests** in `sandbox/tests/policy.rs`: parse a full policy; reject unknown fields (`#[serde(deny_unknown_fields)]`); reject `uid: 0` and `gid: 0`; reject a path in both `ro` and `rw`; reject relative paths; the rights masks for `ro`/`rw` equal the Global Constraints sets (assert against `landlock::AccessFs` flags for ABI 7, and that `IoctlDev` is absent from both). A `#[cfg(target_os = "linux")]` test gated on `probe() >= 6` runs `run -- /bin/cat <denied file>` with a policy allowing only `/usr`, `/lib*`, `/bin` and asserts a non-zero exit; it skips with a printed reason when ABI < 6.
- [ ] **Step 2: Run** — `cd sandbox && cargo test` — Expected: FAIL (no crate code).
- [ ] **Step 3: Implement.** `main.rs` carries `#![forbid(unsafe_code)]`. Order in `run`: read+parse `SIGRUN_SANDBOX_POLICY`, optional `setgroups/setresgid/setresuid` through the `nix` crate's safe wrappers (deny 0), `PR_SET_NO_NEW_PRIVS` (`nix::sys::prctl::set_no_new_privs`), ruleset with `handle_access(AccessFs::from_all(abi))`, path rules, `scope(Scope::Signal | Scope::AbstractUnixSocket)`, `restrict_self()` and require `RulesetStatus::FullyEnforced` for the handled set when ABI ≥ `minAbi`, else exit 125 naming the ABI. Then `exec` (`std::os::unix::process::CommandExt::exec`). Release profile: `panic = "abort"`, `lto = true`, static musl target documented in the README (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`).
- [ ] **Step 4: Run** — `cargo test && cargo clippy -- -D warnings` — Expected: PASS (the gated test skips locally).
- [ ] **Step 5: Commit** `git commit -m "sandbox: sigrun-sandbox helper (Rust, landlock, forbid(unsafe_code)) (multi-user M1)"`

### Task 2: Helper resolution, availability, isolation settings, `/v1/meta`

**Files:**
- Create: `src/sandbox/helper.ts`, `src/sandbox/availability.ts`
- Modify: `src/config.ts` (`IsolationConfig`, `SIGRUN_ISOLATION`), `shared/src/settings.ts` (`ServerSettings.isolation`), `src/harness/boot.ts` (probe once, expose `opened.isolation`), `shared/src/views.ts` (`MetaResponse.isolation`), `src/server/routes/meta.ts`
- Test: `test/sandbox-availability.test.ts`, `test/config.test.ts` (isolation cases)

**Interfaces:**
- Produces (`src/sandbox/helper.ts`): `resolveHelper(env: Env, coreRoot: string): string | undefined` — order: `SIGRUN_SANDBOX_HELPER` (absolute, must exist) → the installed platform package `@sigrun/sandbox-linux-<arch>/bin/sigrun-sandbox` via `createRequire` → `<coreRoot>/sandbox/target/release/sigrun-sandbox`. Absent everywhere → `undefined`.
- Produces (`src/sandbox/availability.ts`): `interface IsolationAvailability { readonly available: boolean; readonly abi: number; readonly helper?: string; readonly reason?: string }`; `probeIsolation(opts: { platform: NodeJS.Platform; helper: string | undefined; runProbe(helper: string): Promise<{ abi: number }>; selfTest(helper: string): Promise<boolean> }): Promise<IsolationAvailability>`. Reasons, exact: `"not linux"`, `"sandbox helper not found"`, `"landlock ABI <n> < 6"`, `"self-test failed"`. `selfTest` runs `run -- /bin/sh -c 'cat <probe>'` against a probe file in a fresh tmp dir that the policy does not grant, and passes only when it fails to read.
- Produces (`src/config.ts`): `interface IsolationConfig { mode: "auto" | "always" | "off"; osUsers: boolean; workerIdleMinutes: number }` on `SigrunConfig.isolation`; `SIGRUN_ISOLATION` overrides `mode`; invalid values fail loud like other `SIGRUN_*`.
- Produces (`MetaResponse.isolation`): `{ mode, active, available, abi, reason?, osUsers: "available" | "off" | string }` (`active` is filled by Task 6; this task reports `false`).

- [ ] **Step 1: Write the failing tests:** each reason string from `probeIsolation` with fakes; ABI 6 + passing self-test → `available: true`; `resolveHelper` precedence (env path wins; missing env path falls through and logs once; platform package; repo build); config parses `auto|always|off`, rejects `"on"` naming the variable; `/v1/meta` carries `isolation` with `available: false, reason: "not linux"` when booted with `platform: "darwin"` through a boot seam (`OpenHarnessOptions.isolationProbe`).
- [ ] **Step 2: Run** — `npx vitest run test/sandbox-availability.test.ts test/config.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block. Boot probes once (one log line with the outcome); the `OpenHarnessOptions.isolationProbe` seam replaces `probeIsolation` in tests.
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "sandbox: helper resolution, availability probe, isolation settings, /v1/meta (multi-user M1)"`

### Task 3: Workspaces, grants, validation, reserved slugs

**Files:**
- Create: `src/sandbox/grants.ts`
- Modify: `src/harness/identity/users.ts` (`workspace?`, `grants?`, `osUser?` on `DirectoryUser`; `update` accepts them), `src/server/routes/users.ts` (`PATCH /v1/users/:user` accepts them, validated), `shared/src/views.ts` (`UserWire` gains the three), `src/server/routes/auth.ts` (`whoami` returns the caller's `workspace` and `grants`), `src/harness/reserved-sections.ts` + `src/harness/loader.ts` (reserved slugs)
- Test: `test/sandbox-grants.test.ts`, `test/users-api.test.ts`, `test/loader.test.ts`

**Interfaces:**
- Produces (`src/sandbox/grants.ts`):
  - `type Grant = { readonly path: string; readonly access: "ro" | "rw" }`
  - `interface ManagedPaths { roots: StoreRoots; storagePath: string; coreRoot: string; userAreas(user: string): string /* <dataDir>/users/<user> */ }`
  - `validateGrantPath(path: string, ctx: { managed: ManagedPaths; user: string }): { ok: true; realpath: string } | { ok: false; reason: string }` — absolute, existing, realpath'd, then: not an ancestor of or equal to any store root, `storagePath`, `<dataDir>/users`, any existing `<dataDir>/<slug>`, or `coreRoot`; not inside `configDir`, `stateDir`, `cacheDir`, an extension directory, `coreRoot`, or another user's area. Inside `dataDir` is otherwise allowed.
  - `revalidate(record: DirectoryUser, managed: ManagedPaths): { ok: true } | { ok: false; reason: string }` — runs `validateGrantPath` over `workspace` and every grant.
- Produces (`src/harness/reserved-sections.ts`): `RESERVED_EXTENSION_SLUGS = ["users", "workspace", "models", "sandbox", "settings", "user-settings", "user-secrets", "skills", "prompts", "packages", "git", "core"]`; the loader quarantines an extension whose slug is in it (message `reserved extension slug "<slug>"`), the same way it quarantines a reserved section key.

- [ ] **Step 1: Write the failing tests:** grant cases — `/` refused, the config root refused, a subdirectory of `stateDir` refused, `<dataDir>/workspace` accepted, `<dataDir>/users/alice/workspace` accepted for alice and refused for bob, `<dataDir>/acme-ext` refused when that extension dir exists, a symlink pointing at `configDir` refused (realpath), a missing path refused, a relative path refused, the stored value is the realpath; `revalidate` fails after the test moves `dataDir` under a granted dir (Review Focus 2); `PATCH /v1/users/bob {grants:[{path, access:"rw"}]}` → 200 and stored realpath, an invalid one → 400 `{error: "invalid_grant", path, reason}`; non-admin PATCH → 403; `whoami` shows the caller's own workspace/grants; the loader quarantines a fixture declaring name `sandbox`; a guard test lists every `join(<root>, "<literal>")` directory name in `src/**/*.ts` (regex over source) and fails naming any literal missing from `RESERVED_EXTENSION_SLUGS`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "sandbox: per-user workspace + grants with realpath validation; reserved extension slugs (multi-user M1)"`

### Task 4: The policy builder

**Files:**
- Create: `src/sandbox/policy.ts`
- Test: `test/sandbox-policy.test.ts`

**Interfaces:**
- Consumes: Task 3's `ManagedPaths`, `revalidate`; `AGENT_ENV_KEYS` / `agentEnv` from `src/harness/agent-env.ts`.
- Produces: `interface UserPolicy { readonly user: string; readonly workspace: string; readonly home: string; readonly tmp: string; readonly ro: readonly string[]; readonly rw: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly uid?: number; readonly gid?: number; readonly groups?: readonly number[] }`; `buildUserPolicy(record: DirectoryUser, ctx: { managed: ManagedPaths; nodeBinDir: string; moduleTrees: readonly string[]; osAccount?: { uid: number; gid: number; groups: number[]; home: string } }): { ok: true; policy: UserPolicy } | { ok: false; reason: string }`; `defaultModuleTrees(coreRoot: string): string[]` = `<coreRoot>/dist` or `<coreRoot>/src` (whichever exists), `<coreRoot>/shared`, `<coreRoot>/node_modules`.
- Values: `workspace` = record's or `<dataDir>/users/<user>/workspace`; `home` = `osAccount.home` or `<dataDir>/users/<user>/home`; `tmp` = `<stateDir>/sandbox/<user>/tmp`. `rw` = workspace, `rw` grants, home, tmp, `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/tty`, `/dev/pts`. `ro` = `/usr /bin /sbin /lib /lib32 /lib64 /etc /opt /proc /sys`, `nodeBinDir`, `moduleTrees`, `ro` grants. `env` = `agentEnv()` minus `SSH_AUTH_SOCK`, with `HOME`, `TMPDIR`, `USER` (the sigrun username) overridden.

- [ ] **Step 1: Write the failing tests:** the default policy's exact `rw`/`ro` lists for a plain user; `/dev/shm` absent; core's install root itself absent (only module trees); `osAccount` changes `home` and sets uid/gid/groups; `SSH_AUTH_SOCK` absent even when set in `process.env`; `HOME`/`TMPDIR`/`USER` overridden; a record whose grant now fails revalidation → `{ok:false, reason}` naming the path.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The builder creates `workspace`, `home`, `tmp` (mode 0700) if absent; it never creates grant paths.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "sandbox: per-user Landlock policy builder (multi-user M1)"`

### Task 5: Worker, protocol, pool, `SandboxedExecutionEnv`

**Files:**
- Create: `src/sandbox/protocol.ts`, `src/sandbox/worker.ts` (child entry), `src/sandbox/pool.ts`, `src/sandbox/sandboxed-env.ts`
- Modify: `src/server/shutdown.ts` (`stopSandboxWorkers` step after `gateway.stop`, before `stopProviderRefresh`), `src/serve.ts` (wire it)
- Test: `test/sandbox-worker.test.ts`, `test/sandbox-env.test.ts`, `test/shutdown-order.test.ts`

**Interfaces:**
- Transport: newline-delimited JSON over the worker's **stdin (requests) and stdout (replies/events)**; stderr carries log lines core forwards with a `sandbox[<user>]` prefix. Commands the worker runs get their own pipes, so they never hold the channel (Review Focus 1).
- Produces (`src/sandbox/protocol.ts`): `type Request = { id: number; op: string; args: JsonValue[] }`; `type Reply = { id: number; ok: true; value: JsonValue } | { id: number; ok: false; error: { kind: "file" | "exec"; code: string; message: string; path?: string } }`; `type Event = { id: number; event: "output"; stream: "stdout" | "stderr"; text: string; skipped?: number }`; binary values travel as `{ "$bytes": "<base64>" }`; reader/dir-reader/watcher results travel as `{ "$handle": <n> }` and their methods as ops `handle.<method>` with the handle id first in `args`.
- Produces (`src/sandbox/worker.ts`): reads requests, runs them against `new NodeExecutionEnv({ cwd: <request cwd> })`, never `process.env` for exec (`inheritEnv: false`, the policy env passed in at spawn), writes replies. Exits when stdin closes.
- Produces (`src/sandbox/pool.ts`): `interface Launcher { (policy: UserPolicy): { command: string; args: string[]; env: Record<string, string> } }` (the real launcher puts the policy JSON in `env.SIGRUN_SANDBOX_POLICY` beside the policy's own env); `class WorkerPool { constructor(opts: { launcher: Launcher; idleMinutes: () => number; log: (line: string) => void; workerEntry: { command: string; args: string[] } }); client(policy: UserPolicy): WorkerClient; stopUser(user: string): Promise<void>; stopAll(): Promise<void> }`; `WorkerClient.call(op, args, onEvent?): Promise<JsonValue>`. One worker per user; a policy whose JSON differs from the running worker's drains in-flight calls, stops it, starts a new one. Idle stop after `idleMinutes` with no call and no open handle. Crash: in-flight calls reject with `ExecutionError("crashed", …)`/`FileError("io", …)`; the next call starts a fresh worker; no eager restart.
- Produces (`src/sandbox/sandboxed-env.ts`): `class SandboxedExecutionEnv implements ExecutionEnv { constructor(client: WorkerClient, cwd: string) }` forwarding every required member of `FileSystem` and `Shell`, plus `listFiles` when the worker reports it (`capabilities` reply to a `hello` op at start). `cleanup()` is a no-op (a shared worker serves the user's other conversations). Error values round-trip to `FileError`/`ExecutionError` with their codes.
- Worker entry resolution: `dist/sandbox/worker.js` beside the running module when it exists; otherwise `process.execPath --import tsx <coreRoot>/src/sandbox/worker.ts` (source checkouts and tests).
- Test launcher: `{ command: process.execPath, args: [...workerEntry] }` with no helper, so the pool, protocol and env are tested on any OS; Task 10 exercises the real helper.

- [ ] **Step 1: Write the failing tests:** `sandbox-env.test.ts` runs the existing workspace test cases (list, read, write, edit-shaped read-modify-write, `exec` with streamed output, a nonexistent path's `FileError` code, a failing command's exit code) against `SandboxedExecutionEnv` over the test launcher; `exec("ls /proc/self/fd")` lists only `0 1 2` plus the listing's own fd (Review Focus 1); killing the worker during a `sleep 5` exec rejects that call and the next `exec` succeeds on a new pid (Review Focus 4); idle stop after a fake-timer `idleMinutes`; a changed policy restarts the worker after the in-flight call finishes; `stopAll()` leaves no worker pids; a compile-time test file `test/sandbox-env.typecheck.ts` assigns `SandboxedExecutionEnv` to `ExecutionEnv`; `shutdown-order.test.ts` asserts the new step's position.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "sandbox: per-user worker over stdio, pool, SandboxedExecutionEnv (multi-user M1)"`

### Task 6: Choosing the env; multi-user admission; the latch

**Files:**
- Modify: `src/harness/workspace.ts` (`createWorkspaceService(deps)`), `src/harness/boot.ts` (wire pool + isolation state), `src/harness/identity/users.ts` (admission guard), `src/server/routes/onboarding.ts`, `src/server/auth/pipeline.ts`, `src/cli.ts` (map the guard's error to 409 / exit 1), `src/config.ts` (boot refusals)
- Create: `src/sandbox/isolation.ts`
- Test: `test/sandbox-isolation.test.ts`, `test/workspace.test.ts`, `test/onboarding.test.ts`, `test/auth-pipeline.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces (`src/sandbox/isolation.ts`): `class IsolationState { constructor(opts: { mode: IsolationConfig["mode"]; availability: IsolationAvailability; userCount: () => number; log(line: string): void }); active(): boolean; reason(): string | undefined }` — `always`: active iff available; `auto`: active iff available and `userCount() > 1`, and once active stays active for the process lifetime (Review Focus 5); `off`: never. Every change of `active()` logs one line.
- Produces (`src/harness/identity/users.ts`): `class AdmissionRefusedError extends Error { readonly code: "isolation_required" | "auth_required" }`; `UserDirectory` constructor option `admit?: (currentCount: number) => void` called inside the `add` mutation when `currentCount >= 1`; boot passes a guard that throws `isolation_required` unless isolation is available and mode ≠ `off`, and `auth_required` when the effective auth methods are empty. Every add site (onboarding claim/invite redemption, proxy auto-provision, CLI) maps the error: HTTP 409 `{error: code}`, CLI exit 1 with the message, proxy → 403 `{error: code}` (the request is refused, not the server).
- Boot refusals (`loadConfig`/boot, one error naming both fixes each): directory has ≥ 2 users and effective auth methods are empty; isolation active (or mode `always`) with `proxy` in methods and no `proxy.secretHeader`.
- Produces (`src/harness/workspace.ts`): `createWorkspaceService(deps: { isolation: IsolationState; pool: WorkerPool; directory: UserDirectory; managed: ManagedPaths; ownerOf(conversationId, read: DocumentReader, ctx): Promise<string | undefined> })`. `forConversation` now takes the `EnvTarget`'s `read` (pass-through from `toHarnessEnv`). Decision, in order: directory ≤ 1 user and not active → `AgentExecutionEnv` at the configured workspace (today's behavior); active → owner's record → `buildUserPolicy` → `SandboxedExecutionEnv` (an ownerless conversation uses the first admin's record); otherwise (multi-user, inactive) → an `UnavailableExecutionEnv` whose every method returns `isolation_unavailable: <reason>` as `FileError`/`ExecutionError`. A failed policy (revalidation) → the same failing env with that reason. `ownerOf` reads `SessionMetaDoc` through `target.read.snapshot`.
- First transition: when the second user is added and the first record has no `workspace`, set it to `config.workspace.path` in the same mutation, so the admin keeps today's workspace.

- [ ] **Step 1: Write the failing tests:** the state machine for each mode × available × user count, including the latch after deleting down to one; second user via invite → 409 `isolation_required` when unavailable, via proxy → 403, via CLI → exit 1 with the message; second user with `SIGRUN_AUTH=none` → 409 `auth_required`; boot with two users and no auth → refuses naming both fixes; boot with isolation `always` + `proxy` without `secretHeader` → refuses; on a two-user server with isolation unavailable, a bash tool call, `GET …/files`, an upload, and a job's prompt expansion all fail with `isolation_unavailable: <reason>` (one test each — every consumer passes through `forConversation`); with a fake-available isolation and the test launcher, alice's and bob's conversations run in different worker pids rooted at their workspaces; the first admin's record gains `workspace` = the configured path when bob is added.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "sandbox: per-owner env selection, fail-closed multi-user, admission guard, auto latch (multi-user M1)"`

### Task 7: Fork and ownership transfer

**Files:**
- Modify: `src/server/conversation-ops.ts` (`forkOp`), `src/server/ownership.ts` (core participant), `src/server/routes/users.ts` (`osUser` transfer refusal; grant on `transferTo`)
- Test: `test/fork.test.ts` (or the file that owns `forkOp` tests), `test/users-api.test.ts`

**Interfaces:**
- Fork: inside `forkOp`'s existing `fork.commit`, when the fork's owner differs from the source's owner, `configure(tx, fork.id, { cwd: null })` (`configure` is exported by pi-durable).
- Transfer: the core ownership participant, per conversation it rewrites, also reads `tx.doc(AgentDoc, id).cwd`; a relative `cwd` is rewritten to `resolve(<old owner's workspace>, cwd)`; an absent `cwd` becomes the old owner's workspace path. Then `DELETE /v1/users/:user` adds `{path: <departing workspace>, access: "rw"}` to `transferTo`'s grants (validated; skipped with a log line if it fails validation).
- `osUser` departing user with `transferTo` → 409 `{error: "invalid_transfer", reason: "osUser workspace"}` before any change.

- [ ] **Step 1: Write the failing tests:** bob forks alice's shared conversation whose `cwd` is `projects/x` → the fork's agent has no `cwd`; alice forking her own keeps it; deleting alice → bob: a conversation with relative `cwd` ends with the absolute path under alice's workspace, one without `cwd` gets her workspace root, bob's grants gain alice's workspace `rw`; deleting an `osUser` record with transfer → 409 and nothing changed.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "sandbox: fork-by-other clears cwd; transfer pins cwd and grants the workspace (multi-user M1)"`

### Task 8: OS-account mapping (bare metal, opt-in)

**Files:**
- Modify: `src/sandbox/availability.ts` (`osUsers` probe), `src/sandbox/policy.ts` callers in `src/harness/workspace.ts` (resolve the account), `src/sandbox/helper.ts` (no change to resolution; document `setcap`)
- Create: `src/sandbox/os-account.ts`
- Test: `test/sandbox-os-account.test.ts`

**Interfaces:**
- Produces (`src/sandbox/os-account.ts`): `lookupOsAccount(login: string, read = readFileSync): { uid: number; gid: number; groups: number[]; home: string } | undefined` — parses `/etc/passwd` and `/etc/group` (no native modules); uid/gid 0 → `undefined`.
- `probeOsUsers(helper)`: runs `run -- /usr/bin/id -u` with a policy carrying the uid of the probe account `nobody`; available when it prints that uid. Reported in `/v1/meta.isolation.osUsers` as `"available"`, `"off"` (setting false), or the failure reason.
- A record with `osUser` while `osUsers` is unavailable (always the case in containers, where the entrypoint drops every capability) → its env fails with `isolation_unavailable: osUser requires CAP_SETUID`.
- The README in `sandbox/` documents the one install step: `sudo setcap cap_setuid,cap_setgid+ep <helper>`.

- [ ] **Step 1: Write the failing tests:** passwd/group parsing (supplementary groups, missing account, uid 0 refused) over fixture strings; `osUser` record with `osUsers: false` → failing env with the pinned reason; with a fake-available probe the policy carries the account's uid/gid/groups and home.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "sandbox: optional osUser mapping through a file-capped helper (multi-user M1)"`

### Task 9: Image, chart, CI build

**Files:**
- Modify: `Dockerfile` (a `sandbox` build stage from `rust:1-bookworm` building `--release`; runtime copies the binary to `/usr/local/lib/sigrun/sigrun-sandbox` and sets `ENV SIGRUN_SANDBOX_HELPER=/usr/local/lib/sigrun/sigrun-sandbox`; `tini` installed and placed ahead of the entrypoint script in `ENTRYPOINT`), `docker/docker-compose.yaml` (drop `init: true`, the image provides it now; keep its comment's reason), `.github/workflows/ci.yml` (job `sandbox`: rust toolchain, `cargo test`, `cargo clippy -D warnings`, musl builds for x64 and arm64 uploaded as artifacts), `test/workflows.test.ts`, and the image smoke check the CI `image-build` job runs, to assert the helper probes inside the image
- Create: `sandbox/npm/linux-x64/package.json`, `sandbox/npm/linux-arm64/package.json` (names `@sigrun/sandbox-linux-x64|arm64`, `os: ["linux"]`, `cpu`, `files: ["bin/"]`, version = core's), not published

- [ ] **Step 1: Write the failing tests:** `workflows.test.ts` asserts the `sandbox` job exists with `cargo test` and both musl targets; the image smoke runs `docker run --rm <image> /usr/local/lib/sigrun/sigrun-sandbox probe` and expects a JSON line, and `ps -o comm= 1` is `tini`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The chart needs no change: the pod shape already matches the spike (uid 1000, no capabilities, `RuntimeDefault` seccomp).
- [ ] **Step 4: Run** — `npm test`, plus the local image build per `docs/` if Docker is available; otherwise rely on CI's `image-build` job and say so in the commit body.
- [ ] **Step 5: Commit** `git commit -m "image: bundle sigrun-sandbox, tini as PID 1; ci: build and test the helper (multi-user M1)"`

### Task 10: Kernel integration suite, two-user e2e, docs

**Files:**
- Create: `test/sandbox-it/boundary.test.ts`, `test/sandbox-it/helpers.ts`
- Modify: `vitest.config.ts` (the `sandbox-it` dir runs only with `SIGRUN_SANDBOX_IT=1`), `.github/workflows/ci.yml` (job `sandbox-it` on `ubuntu-24.04`: build the helper, step 1 `sigrun-sandbox probe` must report ABI ≥ 6 or the job **fails**, then `SIGRUN_SANDBOX_IT=1 npx vitest run test/sandbox-it`), `docs/extending.md` + the operator docs (spec §13 wording, verbatim points), `CHANGELOG.md`

- [ ] **Step 1: Write the tests** (real helper, real tools, two users in one sigrun): one test per §6 line — bob's agent cannot read alice's workspace file, `users.json`, `auth.json`, the DB, `<core>/.env` planted for the test, sigrun's `/proc/<pid>/environ`, another worker's `/proc/<pid>/environ` and `/proc/<pid>/mem`; reading sigrun's `/proc/<pid>/mem` fails (that read needs ptrace-attach-level access, so it is the ptrace test without needing `strace` or `gdb` in the image); `kill -TERM <sigrun pid>` fails and sigrun keeps answering `/healthz`; `/dev/shm` not writable; writes outside workspace/home/tmp fail; running the helper from inside the jail with `uid: 1` cannot change uid; a grant moved under a store root stops the worker (Review Focus 2). Each test skips with a named reason when `probe` < 6 locally; CI never skips (the first step fails instead).
- [ ] **Step 2: Run locally** — Expected: all skipped with the ABI reason (WSL2 6.6). Push is the user's call; the CI job is the verification.
- [ ] **Step 3: Docs** — spec §13's statements in `docs/extending.md` (extension-author section: system-level vs per-user) and the operator docs (isolation modes, the ABI 6 requirement, Debian 12/Ubuntu 24.04 kernel notes from spec §14, `setcap` for `osUser`, "file modes are not the boundary", "extensions are trusted code").
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS (IT skipped).
- [ ] **Step 5: Commit** `git commit -m "sandbox: kernel boundary suite (CI on 6.12+), docs (multi-user M1)"`
