# Sigrun multi-user: isolation, per-user extensions, and login

Status: draft for review, revision 3 (builder check and deepseek review folded). Date: 2026-10-23.

Inputs:

- the core-hardening spec (`2026-10-19-sigrun-core-hardening-design.md`),
  whose §5 built the request layer this spec extends: `Principal`, the
  auth pipeline, the user directory, tokens, invites, onboarding,
  forward auth, `accessOf` sharing, and the `host.users` / `host.access`
  / `host.identity` extension APIs (§9.7);
- the gateway spec (`2026-10-22-sigrun-gateway-design.md`) and its two
  plans, in flight: chat-account links (`identities.json`, engine Task 3)
  and effective admin from proxy groups (C8, core Task 5);
- the UI-blocks plans, in flight: extension settings sections (U4);
- the image-workflow plan (`2026-10-23-sigrun-image-workflow.md`), in
  flight: the Dockerfile rework, entrypoint, and chart;
- the sandbox spike of 2026-10-23 (§5);
- the user rulings of 2026-10-23 (§3);
- the builder check of 2026-10-23 (five questions, all settled in the
  text; the resulting calls are in §14);
- the deepseek-v4.1-flash review
  (`reviews/2026-10-23-multi-user-review-deepseek.md`), folded into
  revision 3; finding ids like B2 or M7 refer to it (§16).

## 1. Intent

Sigrun has carried multi-user criteria through every spec so far, but
only at the HTTP layer. A request is authenticated and authorized; the
agent run it starts is not. Every conversation shares one workspace, the
agent's shell runs as the sigrun process with sigrun's environment,
extension credentials are global, and the only login sources are tokens
and one forward-auth header set shaped around Authelia.

This spec makes multi-user a first-class feature from top to bottom:

- **Isolation:** each user's agent runs in a kernel-enforced jail that
  sees that user's workspace and granted paths, and nothing of sigrun's
  own state or other users' files.
- **Per-user extensions:** extensions can keep per-user credentials,
  settings, data, long-lived processes, and tools, with core doing the
  scoping and the process lifecycle.
- **Login:** a core login seam that identity-provider extensions plug
  into, with OIDC and generic OAuth2 shipped as a bundled extension.

Success: a household runs one sigrun; each person signs in through the
household IdP (or a token), connects their own GitHub account, has their
own memory, and their agent cannot read or damage another person's
files, credentials, or conversations — by accident or by asking it to.

## 2. Goals, non-goals, anti-goals

**Goals:**

- A boundary that holds against a user deliberately driving their own
  agent at it, not only against accidents (ruling 1).
- The same isolation on bare-metal, docker, and k8s, with no sandbox
  image, sidecar, or per-user container for operators to maintain
  (ruling 2).
- Extensions choose system-level or per-user; per-user is cheap to build
  (ruling 5).
- Admin-provided MCP servers selectable per user, plus user-supplied MCP
  servers when the admin allows them (ruling 6).
- Login providers are extensions; OIDC and OAuth2 ship bundled
  (rulings 7, 8).
- Optional mapping of sigrun users onto host OS accounts, for a shared
  bare-metal computer (ruling 4).

**Non-goals:**

- Sigrun as an identity provider. An IdP is something an extension may
  build; core consumes identities.
- Resource limits (CPU, memory, disk quotas) between users. One user's
  agent can still exhaust shared resources.
- Restricting outbound network. The jail confines files, processes,
  signals, and sockets; network reach is unchanged (§9.4).
- Confining extension code. Extensions are trusted code running inside
  sigrun, like any installed package (§13).
- Multi-user agent execution on non-Linux hosts. macOS and Windows stay
  single-user.
- Per-user containers or VMs as a core feature. They remain possible as
  an `ExecutionEnv` extension.
- OAuth device flow for the TUI. The TUI keeps API tokens.
- Atproto (Bluesky) and other provider-specific protocols in the bundle.

**Anti-goals:**

- A security-shaped boundary that is not a security boundary (ruling 1).
  Anything this spec calls isolation is kernel-enforced, fails closed,
  and has its limits stated in the docs (§13).
- A routine maintenance cost for operators: no sandbox images to
  rebuild, no per-user infrastructure (ruling 3).
- Isolation that silently degrades: a missing kernel feature disables
  multi-user agent execution loudly, never runs it unconfined.
- Auto-linking an external identity to an existing directory user by
  email or username (account takeover).

## 3. User rulings (2026-10-23)

1. **The boundary is true or it is not built.** Sigrun protects against
   accidents, not malicious users. But a boundary that looks like a
   security boundary will eventually be trusted as one, so it gets the
   extra effort to be one, provided that effort does not degrade the
   experience or add substantial routine maintenance. Up-front cost is
   acceptable; routine cost is not.
2. **No sidecar.** A sandbox sidecar container is overcomplicated for
   now; the jail is a process-level mechanism.
3. **Full user separation outside containers too.** Sigrun may run as a
   service account on a bare-metal host, with users selective about what
   their workspace and sessions can reach.
4. **Deployment shape.** The typical multi-user install has one admin
   whose workspace maps to their own system account, and every other
   user internal to sigrun. Mapping several sigrun users onto several OS
   accounts (two people sharing a computer) is supported when cheap;
   anyone needing more runs docker or k8s.
5. **Extensions must be able to support multiple users.** Some are
   inherently system-level; a GitHub extension or a memory extension
   operates per user. There is a path for per-user MCP servers.
6. **MCP: both.** Admin-provided servers selectable from a list, and
   user-supplied servers when the admin allows them.
7. **OIDC and OAuth2 are extensions**, not core.
8. **Bundled.** The OIDC/OAuth2 extension ships as a built-in.
9. **Gateway handover.** The account-link table lands as M3a. The
   gateway engine kept running meanwhile (it was not paused after all)
   and built its links on its own `identities.json`; engine Task 13
   moves them to `host.accounts` before the gateway merges, so no
   release ever stores links in the engine (§11.7). The rest of M3
   follows M3a.
10. **Do not step on in-flight work.** The gateway, UI-blocks, and
    image-workflow workstreams are underway; this spec's changes to
    shared files wait for them (§7).
11. **No memory-unsafe languages.** The sandbox helper may not be
    written in C or any other memory-unsafe language.
12. **The bundled extension is `ext-oauth`,** not `ext-login`: it names
    what it speaks, colloquially covering OAuth 2 and OIDC.

## 4. Approaches

### 4.1 Where the agent runs

| Approach | Verdict |
|---|---|
| Per-user containers (Hermes's docker/modal terminal backends) | Rejected for core: the operator maintains the image, lifecycle, volumes, credential injection, and (on k8s) pod-creation RBAC. That is the routine cost ruling 1 refuses. Stays possible as an extension. |
| A sandbox sidecar sharing only the workspace volume | Rejected by ruling 2. |
| `chroot` | Rejected: needs root, root escapes it, and it needs a populated root filesystem (the image problem again). |
| bubblewrap (mount + user namespaces) | Rejected: fails in every non-privileged pod on the spike cluster (§5). |
| OS uid per user (`setpriv`) | Kept as an optional layer (§9.8): needs `CAP_SETUID`, which the image's entrypoint drops and the `restricted` pod policy forbids. |
| Landlock, path check for in-process file tools | Rejected: Node cannot open a path race-free beneath a directory (`openat2` `RESOLVE_BENEATH` is unavailable), so a symlink swapped between check and open escapes. A boundary with a known escape violates ruling 1. |
| **Landlock, every `ExecutionEnv` operation in a confined per-user worker** | **Chosen.** Kernel-enforced, unprivileged, works unchanged in the chart's pod shape, no image or sidecar, no race. |

### 4.2 Login

| Approach | Verdict |
|---|---|
| OIDC built into core, others as extensions | Rejected by ruling 7. |
| **Core login seam + protocols as extensions; OIDC/OAuth2 bundled** | **Chosen** (rulings 7, 8). The seam ships with its main consumer, so they cannot drift apart; the extension is inert until configured. |
| Everything unbundled | Rejected: login is where version skew between seam and implementation fails most dangerously. |

### 4.3 MCP servers

Admin catalog only, user-supplied only, or both. **Both** (ruling 6):
the jail makes user-supplied servers safe in a way they are not today.

## 5. Spike evidence

Run 2026-10-23 on a Talos 1.13.8 cluster (kernel 6.18, containerd 2.2.6,
PodSecurity default `baseline`). Node facts: LSMs
`lockdown,capability,yama,selinux,bpf,landlock`;
`user.max_user_namespaces = 0`.

Each test ran as uid 1000 with no capabilities and `no_new_privs` (the
chart's pod shape), under `RuntimeDefault` seccomp, `Unconfined`
seccomp, and a privileged pod. A process owned by uid 1000 held
`SIGRUN_API_TOKEN` in its environment; the core files were owned by uid
1000, mode 0600.

| Mechanism | Result |
|---|---|
| None (shell shares sigrun's uid) | Read `users.json` and `SIGRUN_API_TOKEN` from `/proc/<pid>/environ`. |
| Landlock (ABI 7) | Same-uid shell denied the core files, denied sigrun's `/proc/<pid>/environ` even with `/proc` readable, wrote only its allowed paths; `ps` worked. Identical under both seccomp profiles. No capability needed. |
| `setpriv` uid per user | Full separation (core files, environ, other users' workspaces). Needs `CAP_SETUID`/`CAP_SETGID`: as root with only those, or uid 1000 with a file-capped helper plus `allowPrivilegeEscalation: true`. |
| bubblewrap | Fails in normal pods (no user namespaces; as root it needs `SYS_ADMIN`). Works only privileged. |

Also found while checking the code:

- pi-durable's `NodeExecutionEnv` runs shell commands with
  `{...process.env, ...}`, so the agent's `env` prints
  `SIGRUN_API_TOKEN`, `SIGRUN_PROXY_SECRET`, and provider keys today.
- sigrun-ext-mcp spawns stdio servers with `{...process.env, ...}`
  (`client.ts:824`): the same leak.
- The file tools call `env.readTextFile` / `env.writeFile`, which
  `NodeExecutionEnv` implements with `node:fs` inside the sigrun
  process; only `env.exec` starts a child. Landlock on a child cannot
  cover in-process file access.
- pi-durable's registry allows tool names to repeat across extensions,
  and `selectExtensions` (`harness/agent.js:232`) silently skips
  selected names that are not installed.

## 6. Threat model and the boundary

**Actors.** Directory users of one sigrun, trusted not to attack it but
able to drive their own agent anywhere — by intent or by a model
mistake. The agent acts as the conversation's owner (core-hardening
§5.9); a write-sharee drives the owner's agent in the owner's jail.

**The boundary, when isolation is on:** an agent run for user U can
read and write only:

- U's workspace and U's grants (§9.5);
- U's private home and temp directories;
- read-only system paths.

It cannot:

- read or write sigrun's store roots, database, or credential files;
- read another user's workspace, home, temp, or grants they lack;
- inspect sigrun or any process outside U's own jail: Landlock's
  implicit ptrace restriction (every ABI) allows ptrace and related
  access only to a sub-domain of the caller, and the kernel docs state
  that sensitive `/proc/<pid>` files are restricted the same way. sigrun
  is outside every jail, and two jails started separately are siblings,
  so neither can read the other's `/proc/<pid>/environ` or memory (the
  spike measured exactly this, same uid, `/proc` readable);
- signal sigrun or any process outside U's own jail (ABI 6 signal
  scoping);
- connect to abstract Unix sockets outside U's jail (ABI 6 scoping);
- read sigrun's environment: its children get the scrubbed allowlist
  (§8), and its own `/proc/<pid>/environ` is behind the ptrace
  restriction above;
- use another user's credentials or per-user tools (§10);
- read the credentials held by U's own per-user services: they run in a
  separate jail (§10.3), so a prompt-injected agent cannot read U's
  GitHub token out of a service's environment.

**Outside the boundary** (stated in the docs in these words, §13):
extension code; resource exhaustion; outbound network; non-Linux hosts.

## 7. Workstreams and dependencies

| Id | Workstream | Waits for |
|---|---|---|
| M0 | Environment-leak fix (§8) | nothing; not part of this spec's plans |
| M1 | The execution jail (§9) | gateway-core Task 5 (auth pipeline); image-workflow Task 1 (image) and Task 4 (chart) for the image and chart parts only |
| M2 | Per-user extension surface (§10) | M1; the `src/extension.ts` changes of U0, U3, U4, U6 and gateway-core merged; U4 for per-user settings sections |
| M3a | Account links (§11.3): `AccountStore`, `host.accounts`, `/v1/auth/accounts`, link removal on delete. Plan: `2026-10-23-multi-user-m3a-account-links.md` | gateway-core (merged). Gateway-engine Task 13 waits for M3a; the gateway merge waits for Task 13 |
| M3 | Login (§11), the rest | M3a |
| M4 | Extension adoption (§12) | M2 (MCP); M2 (memory) |

M1 and M3 run in parallel once their waits clear. Each workstream gets
its own plan. Files the in-flight workstreams own are not edited until
the listed task has merged to `main`:

- `Dockerfile`, `docker/`, `charts/sigrun/` — image-workflow;
- `src/server/auth/pipeline.ts`, `src/harness/identity/users.ts`,
  `src/harness/identity/invites.ts`, `src/server/routes/users.ts`,
  `src/server/routes/onboarding.ts` — gateway-core Task 5;
- `src/extension.ts`, `shared/src/views.ts` — UI-blocks U0/U3/U4/U6 and
  gateway-core (Task 6 adds `Principal.method: "host"`; M3 adds
  `"session"` alongside it);
- `src/harness/settings.ts` — UI-blocks U4 (`onSettingsChanged`) and
  gateway-engine Task 1 (`builtinExtensions`);
- the gateway engine's `src/state/identities.ts` — gateway-engine
  Task 4.

## 8. M0: the environment leak (prerequisite, outside the plans)

Lands before M1 as its own change, now:

**Landed** (core `src/harness/agent-env.ts`; sigrun-ext-mcp
`src/spawn-env.ts`).

- pi-durable's bash tool builds each execution with
  `inheritEnv: true` and an empty `env` (`dist/tools/bash.js`
  `prepareExecution`), and `NodeExecutionEnv` merges `process.env`
  under any `shellEnv` (`dist/env/node.js` `getShellEnv`), so neither a
  constructor option nor `shellEnv` can subtract.
- The fix is `AgentExecutionEnv`, a `NodeExecutionEnv` subclass whose
  `exec` forces `inheritEnv: false` and builds the env from the
  allowlist plus the call's own `env`. `forConversation` returns it, and
  every consumer passes through `forConversation` (tools, file routes,
  jobs), so one class covers the bash tool and any extension tool that
  calls `api.env.exec`. A bash `prepare` hook would duplicate it and is
  not used.
- sigrun-ext-mcp spawns stdio servers with the same allowlist plus the
  server's configured env and token (`serverSpawnEnv`). The list is a
  copy, since extensions import only core's types-only contract.
- **Allowlist:** `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TZ`, `TERM`,
  `USER`, `LOGNAME`, `SHELL`, plus `NPM_CONFIG_CACHE` (the image points
  npm at `/cache/npm` under a read-only root filesystem; without it an
  agent's `npm install` fails) and `SSH_AUTH_SOCK` (a socket path, not
  a secret; a single-user workstation's agent uses it for `git push`).
  Values come from sigrun's environment. Nothing prefixed `SIGRUN_`,
  nothing from `auth.json` or `secrets.json`, no provider key
  variables.
- Tests: the agent's `env` output in a test conversation contains no
  `SIGRUN_*` and no configured provider key; an arbitrary non-allowlisted
  variable set in sigrun's environment is absent from both a bash-tool
  `exec` and a direct `api.env.exec`.

M1 reuses the same allowlist inside the worker **minus
`SSH_AUTH_SOCK`**: Landlock restricts connecting to pathname Unix
sockets only from ABI 9, so on an ABI 6–8 kernel another user's worker
handed the service account's agent socket could use its keys.

## 9. M1: the execution jail

### 9.1 Isolation mode

Setting `server.isolation`, restart-required, env `SIGRUN_ISOLATION`:

| Value | Meaning |
|---|---|
| `auto` (default) | Jail on when the directory holds more than one user; off for a single-user server. Latched per process: once the jail has been active, it stays active until restart even if users are deleted down to one. Every transition logs one line. |
| `always` | Jail on for every user, including a lone admin who wants their agent confined to their grants. |
| `off` | No jail. Permitted only while the directory holds at most one user. |

**Multi-user without a jail is refused, never silent:**

- Adding a second user (invite redemption, proxy auto-provision, CLI
  `user add`, a login provider's first login) while isolation is `off`
  or unavailable fails: HTTP 409 `isolation_required`, CLI exit 1, both
  naming the reason.
- A server whose directory already holds two or more users and whose
  isolation is `off` or unavailable boots and serves HTTP, but every
  `ExecutionEnv` resolution fails closed. The decision sits in
  `WorkspaceService.forConversation`, the one seam every consumer
  passes through (tools, `files` routes and uploads, context files,
  skills, job prompt expansion: `src/server/helpers.ts`,
  `src/jobs/fire.ts`): it returns an env whose every method fails with
  `isolation_unavailable: <reason>`. Boot logs the reason once;
  `/v1/meta` reports it.

**Multi-user requires real authentication:**

- With more than one directory user, `server.auth.methods` must be
  non-empty. Adding a second user while it is empty fails 409
  `auth_required`. A server already in that state refuses to boot with
  one error naming both fixes. The no-auth loopback mode treats anyone
  reaching the port as superuser, and an agent can reach the port.
- With isolation on and `proxy` among the methods,
  `server.auth.proxy.secretHeader` is required (boot error otherwise).
  Agents run inside the trusted network position (the same pod, or
  loopback), so peer address alone cannot distinguish an agent from the
  ingress. `SIGRUN_PROXY_SECRET` never reaches a jail (§8).

### 9.2 Availability

Isolation is available when all hold:

- the host is Linux;
- Landlock reports ABI **6 or later** (Linux 6.12+): ABI 6 adds signal
  and abstract-socket scoping, without which a jailed `pkill node` kills
  sigrun — an accident this spec exists to prevent. (The ptrace and
  `/proc` restriction of §6 is implicit in every ABI.)
- the native helper (§9.3) resolves for the platform and its self-test
  passes at boot.

The boot self-test runs the helper once with a policy that denies a
probe file, and confirms the denial. `/v1/meta` gains
`isolation: {mode, active, available, abi, reason?}`.

### 9.3 The helper and the worker

**`sigrun-sandbox`** is a small static native binary:

- input: a JSON policy on fd 3, the command after `--`;
- it sets `no_new_privs`, creates a Landlock ruleset handling every
  filesystem right of the running ABI (best-effort up to ABI 7), adds
  the policy's path rules, enables signal and abstract-socket scoping,
  restricts itself, and `exec`s the command;
- optionally switches uid/gid first (§9.8), refusing uid 0 and gid 0;
- any failure before `exec` exits non-zero with one line on stderr; it
  never runs the command unconfined.

**Invariant:** every process the helper starts has `no_new_privs` set,
and every process inside a jail inherits it. That is what keeps the
file-capped helper (§9.8) unprivileged when a jailed command executes
it: with `no_new_privs`, `execve` grants no file capabilities. No change
may relax it; the integration suite asserts that running the helper
from inside a jail cannot change uid.

**Language: Rust**, with the `landlock` crate (maintained alongside the
kernel feature) and `#![forbid(unsafe_code)]` in the helper crate, so
every unsafe operation lives in reviewed dependencies (user ruling 11).
Rust over Go: before ABI 8 a Landlock ruleset binds only the calling
thread, and Go's runtime is multithreaded before `main` runs, so a Go
helper must apply the ruleset to every thread through the runtime's
all-threads syscall path. A single-threaded Rust binary that restricts
itself and then `exec`s has no such step to get wrong. It ships as npm
optional platform packages
`@sigrun/sandbox-linux-x64` and `@sigrun/sandbox-linux-arm64`
(the esbuild pattern), dependencies of core, built and published by CI.
It lives in the core repo under `sandbox/`.

**The worker** is a Node process started through the helper:
`sigrun-sandbox -- node <worker entry>`. The entry is resolved from
core's own module URL: `dist/sandbox/worker.js` in a built install, and
the `src/` module run through `tsx` in a source checkout (the dev and
unit-test shape; `dist/` is not committed). It hosts pi-durable's own
`NodeExecutionEnv`, unmodified, and serves it to sigrun over an IPC
channel.

- **One worker per user**, started on the first `ExecutionEnv` call for
  a conversation owned by that user, serving all of that user's
  conversations. `cwd` travels with each call.
- **Idle stop:** no call and no open handle for 10 minutes (setting
  `server.isolation.workerIdleMinutes`, live).
- **Crash:** in-flight calls fail with a tool error; the next call starts
  a fresh worker. No eager restart (no crash loops).
- **Policy change** (grants or workspace edited): the worker drains
  in-flight calls, exits, and the next call starts one with the new
  policy.
- **Shutdown:** workers stop in the existing workers-then-handlers
  shutdown order, before the harness closes.
- The IPC channel is not inheritable by commands the worker runs. That
  is an invariant with a test: a command run through `exec` cannot write
  to the channel's descriptor.

**`SandboxedExecutionEnv`** is core's `ExecutionEnv` that forwards every
member of `FileSystem` and `Shell` to the user's worker:

- typed `implements ExecutionEnv`, so a pi-durable upgrade that adds a
  required member fails to compile until it is forwarded. Optional
  members (today `listFiles?`) are forwarded when the worker's env
  implements them; the upgrade checklist in the M1 plan names checking
  for new optional members;
- `cleanup()` from a conversation is a no-op on the shared worker (it
  would kill the user's other conversations' commands); the worker's
  commands are killed when the worker stops;
- readers, directory readers, and watchers become handle ids on the
  wire, closed on `close()` or worker exit;
- `exec` output streams forward incrementally (the bash tool's live
  output keeps working);
- error values (`FileError`, `ExecutionError`) round-trip with their
  codes.

`createWorkspaceService().forConversation` returns a
`SandboxedExecutionEnv` when isolation is active, the failing env of
§9.1 when the server is multi-user without active isolation, and
today's `NodeExecutionEnv` (with the §8 wrapper) for a single-user
server. No tool changes.

### 9.4 The policy

Rights per access level, applied as the intersection with what the
running ABI supports:

| Level | Landlock filesystem rights |
|---|---|
| `ro` | `EXECUTE`, `READ_FILE`, `READ_DIR` |
| `rw` | `ro` plus `WRITE_FILE`, `REMOVE_FILE`, `REMOVE_DIR`, `MAKE_CHAR`, `MAKE_DIR`, `MAKE_REG`, `MAKE_SOCK`, `MAKE_FIFO`, `MAKE_BLOCK`, `MAKE_SYM`, `REFER`, `TRUNCATE` |

`EXECUTE` is in `ro` so `./script.sh` and `bash script.sh` behave alike.
`REFER` is `rw`-only (cross-directory rename and link, which git and npm
need inside the workspace). `IOCTL_DEV` is never handled, so device
ioctls follow ordinary permissions. Nothing outside this table is ever
granted.

Read-write:

- the user's workspace (§9.5);
- the user's grants marked `rw`;
- the user's home: `<dataDir>/users/<user>/home`, or the OS account's
  home for an `osUser` record (§9.8). It is the worker's `HOME` (git
  config, tool caches);
- `<stateDir>/sandbox/<user>/tmp` (the worker's `TMPDIR`; `/tmp` is not
  granted);
- device files `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`,
  `/dev/urandom`, `/dev/tty`, and `/dev/pts/`. Nothing else under
  `/dev`; in particular not `/dev/shm`, which would be a same-uid
  rendezvous outside the jail's own directories.

Read-only:

- system paths: `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`,
  `/etc`, `/opt`, `/proc`, `/sys`, and the Node binary's directory;
- the module trees the worker loads: core's `dist/` (or `src/` in a
  source checkout), `shared/`, and `node_modules/`. Never core's install
  root itself: a source checkout's root holds `.env` and private docs;
- the user's grants marked `ro`;
- package directories of per-user services the user runs (§10.3).

Never granted, whatever the configuration (enforced by the §9.5
validation, since Landlock grants are allowlists and cannot subtract):

- `configDir`, `stateDir`, `cacheDir`, `storagePath`, and everything
  under them, except each user's own `<stateDir>/sandbox/<user>/tmp`;
- every extension directory `<dataDir>/<slug>/`;
- other users' `<dataDir>/users/<user>/` areas.

Network: unrestricted (Landlock TCP rules are not applied). The agent's
`curl` already reaches whatever the host reaches; this spec does not
change that (§2 non-goals). Sigrun's own API needs credentials the jail
cannot read (§9.1).

The worker's environment is the M0 allowlist with `HOME`, `TMPDIR`, and
`USER` (the sigrun username) set per user.

### 9.5 Workspaces and grants

The directory record gains, all admin-edited through
`PATCH /v1/users/:user`:

```ts
workspace?: string;            // absolute path; default <dataDir>/users/<user>/workspace
grants?: { path: string; access: "ro" | "rw" }[];
osUser?: string;               // §9.8
```

- **The admin's account.** On the first transition to multi-user, the
  claimant's record gets `workspace` set to the configured
  `workspacePath` (`SIGRUN_WORKSPACE_PATH` / `server.workspacePath`), so
  the admin keeps today's workspace. Other users default to their
  sigrun-created directory, created on first worker start. Its mode is
  0700, but for workers sharing sigrun's uid file modes are hygiene,
  not isolation: Landlock alone confines them, and the docs say so.
- **Grant validation** applies to `workspace` and every grant (400
  `invalid_grant`, naming the path). The path is absolute, existing,
  and stored as its `realpath` (Landlock follows the resolved
  hierarchy, so a symlink to a store root must not pass as a string).
  Then:
  - it is not an ancestor of, or equal to, any store root,
    `storagePath`, `<dataDir>/users`, or an extension directory
    `<dataDir>/<slug>`;
  - it is not inside `configDir`, `stateDir`, `cacheDir`, an extension
    directory, or another user's `<dataDir>/users/<other>/`.

  Being inside `dataDir` is otherwise allowed, so the default
  `<dataDir>/workspace` (`config.ts` `defaultWorkspacePath`) and each
  user's `<dataDir>/users/<user>/workspace` pass, and the chart's
  `/data/workspace` (a sibling of the roots) passes. Landlock cannot
  subtract a path from a granted ancestor, so granting `~` on a
  workstation whose store roots live under `~` is refused; the error
  says to grant subdirectories.
- **Revalidated** at boot and every time a worker's policy is built,
  since a store root can move under an existing grant (e.g. a new
  `SIGRUN_DATA_DIR` inside a granted directory). A grant that now fails
  stops that user's worker from starting, with the reason named in the
  tool error and in `/v1/meta`; it is never silently applied.
- **Reserved slugs.** Every directory core owns directly under a store
  root is a reserved extension slug, and the loader quarantines an
  extension that claims one (same mechanism as the reserved-section
  quarantine, R11). Today: `users`, `workspace`, `models`
  (`<dataDir>/models`, the provider model store) under `dataDir`;
  `sandbox` under `stateDir`; `settings`, `user-settings`,
  `user-secrets`, `skills`, `prompts`, `packages`, `git` under
  `configDir`. The M1 plan audits `src/` for any other core-owned
  directory and adds it; a test fails when a new core directory name
  is not in the list.
- Users see their own workspace and grants (`GET /v1/auth/whoami` gains
  them) and cannot edit them. Narrowing one's own access is done by the
  admin; the self-service editor is a non-goal of this revision.
- **The conversation's env follows its current owner.** `agent.cwd` is
  resolved against the owner's workspace exactly as today.
- **Fork by a different user:** core clears the fork's `agent.cwd` in
  the fork's create commit when the fork's owner differs from the
  parent's, so the fork starts at its owner's workspace root.
- **Ownership transfer on user delete:** the departing user's workspace
  stays where it is and becomes an `rw` grant on the `transferTo` user.
  Each transferred conversation's `agent.cwd` is rewritten in the
  transfer commit to the absolute path it resolved to under the old
  owner (a relative `cwd` would otherwise silently retarget into the
  new owner's workspace). The admin removes the grant when done.
- **`osUser` transfer:** an `osUser` record's workspace is that OS
  account's home, which the receiving worker cannot read. Deleting such
  a user with `transferTo` fails 409 `invalid_transfer` naming the
  reason; the admin clears `osUser` (or moves the files) first.

### 9.6 Single-user servers

With isolation inactive (single user, `auto` or `off`), behavior is
today's plus M0: in-process `NodeExecutionEnv`, the configured
workspace, full host access. The docs say so in those words.

### 9.7 Containers

- The jail needs nothing from the pod spec beyond today's chart shape
  (uid 1000, no capabilities, `RuntimeDefault` seccomp) — proven in §5.
- The image carries the helper for its architecture. This change lands
  after image-workflow Task 1.
- **Process reaping.** Orphaned grandchildren of workers reparent to PID
  1. The image's `ENTRYPOINT` gains `tini` ahead of the entrypoint
  script; compose's `init: true` (image-workflow Task 5) is removed in
  the same change, since the image now provides it. Lands after
  image-workflow Tasks 1 and 5.
- `osUser` (§9.8) is unavailable in containers: the entrypoint drops to
  `SG_UID` with no capabilities. A record with `osUser` in a container
  reports `isolation_unavailable: osUser requires CAP_SETUID` for that
  user's tools.

### 9.8 OS-account mapping (bare metal, opt-in)

For two people sharing one computer with sigrun as a service account:

- Setting `server.isolation.osUsers: true` (restart-required) plus a
  directory record's `osUser: "<login>"`.
- The operator grants the installed helper
  `cap_setuid,cap_setgid+ep` with `setcap` once at install; the boot
  self-test verifies the switch and reports `osUsers: available | <reason>`.
- That user's worker runs as the OS account's uid/gid (supplementary
  groups from the account), then applies Landlock as usual. Files the
  agent creates are owned by that account.
- Default workspace and `HOME` for an `osUser` record: the account's
  home directory. Grant validation still applies; the service account's
  store roots are not under that home.
- Everything else is unchanged; users without `osUser` run as the
  service account's uid under Landlock.

### 9.9 Tests

- Unit: policy construction, grant validation, mode transitions (second
  user refused when `off`/unavailable/no-auth), fork `cwd` clearing,
  transfer grant, `SandboxedExecutionEnv` forwarding against a fake
  worker (every method, handles, streaming, error codes).
- Kernel integration (`SIGRUN_SANDBOX_IT=1`, Linux with Landlock ABI 6+):
  the §6 boundary list, one test per line, through real tools in real
  conversations; the IPC-descriptor invariant; worker crash and idle
  stop; `osUser` switch when the helper has file capabilities. Named
  cases from the review: a jailed shell reading
  `/proc/<sigrun>/environ`, `/proc/<service>/environ`, and
  `/proc/<other worker>/mem`, and a `ptrace` attach on each; a file
  planted at `<core>/.env` is unreadable; running the helper from
  inside a jail cannot change uid; a grant that becomes an ancestor of
  a moved store root stops the worker; `/dev/shm` is not writable.
  - The suite needs a 6.12+ kernel with Landlock enabled. WSL2's 6.6
    does not qualify. GitHub's `ubuntu-24.04` runner image lists kernel
    `6.17.0-1022-azure` (image `20260927.320.1`), so the suite runs
    there. The first CI job asserts only the boot self-test, so a kernel
    without Landlock fails CI loudly rather than turning the suite into
    skips. If it fails, the suite moves to a CI job in a pod on a 6.12+
    host. Elsewhere the suite is skipped with a named reason. A skip is
    never reported as a pass.
- e2e: two users, one sigrun; user B's agent is asked to read A's
  workspace file, `users.json`, and sigrun's environment, and to
  `pkill node`; all fail and sigrun stays up.

## 10. M2: the per-user extension surface

### 10.1 The acting user on every call

- `RunSettledEvent` and every lifecycle payload with a `conversationId`
  gain `owner?: string`: the conversation's owner when the event was
  produced.
- Job runs carry `owner` in their handler context.
- Tool execution keeps `host.identity.actingUser(conversationId)`.
- Routes keep `principal`.

### 10.2 Per-user stores

```ts
host.stores.user(user: string): {
  secrets: { get(key): Promise<string | undefined>; set(key, value): Promise<void>; delete(key): Promise<void> };
  settings: { get(): Promise<Record<string, unknown>>; set(value): Promise<void> };
  paths: { data: string; state: string; cache: string };
}
```

- Layout:
  - secrets: `<configDir>/user-secrets/<user>.json`, mode 0600, one
    top-level section per extension slug;
  - settings: `<configDir>/user-settings/<user>/<slug>.json`;
  - paths: `<dataDir>/<slug>/users/<user>/`,
    `<stateDir>/<slug>/users/<user>/`, `<cacheDir>/<slug>/users/<user>/`,
    created on first access.
- `user` must exist in the directory; otherwise the call throws. The
  one exception: during a user's `userDeleted` fan-out (§10.6), that
  user resolves even though the record is gone, so handlers can read
  secrets to revoke tokens at the provider.
- All of these sit under store roots, so no jail can read them (§9.4).
  Extension data stays out of the user's workspace so the user's agent
  cannot corrupt it.
- Same store semantics as today: atomic writes, mtime reload.
- Extensions are trusted code: `stores.user()` scopes by the user the
  extension names; it is not an enforcement point against extensions.

**Routes** (self only; admins cannot read or write another user's
per-user secrets or settings — configuration authority, not content
authority):

- `GET /v1/me/extensions/:slug/settings`, `PUT` the same;
- `GET /v1/me/extensions/:slug/secrets` (keys only, no values),
  `PUT /v1/me/extensions/:slug/secrets/:key {value}`, `DELETE` the same.

### 10.3 Per-user services

Extensions declare long-lived per-user processes; core owns their
lifecycle and runs them inside the user's jail.

```ts
// factory result
userServices?: {
  name: string;
  start(user: string, ctx: HandlerContext): Promise<ServiceSpec | undefined>; // undefined = not for this user
  idleMinutes?: number;   // default 10
}[];

type ServiceSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;     // merged over the M0 allowlist; never process.env
  cwd?: string;                     // default: the user's home (§9.4)
  readPaths?: string[];             // extra read-only paths, e.g. the extension's package dir
};

host.services.connect(name: string, user: string, ctx: HandlerContext): Promise<ServiceHandle>;

type ServiceHandle = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  release(): void;   // this caller is done; the process may idle-stop
};
```

- `connect` starts the process on first use for that (extension, name,
  user), and reuses it while it runs. Several callers may hold handles;
  stdio is shared (protocols like MCP JSON-RPC multiplex by id).
- Core starts the process through the helper with the user's policy
  (same files as the user's worker, plus `readPaths`), in its **own
  Landlock domain**, not inside the user's worker. The worker and the
  service are sibling domains, so neither can inspect or signal the
  other: the user's agent cannot read credentials injected into a
  service's environment. With `osUser` (§9.8) the service runs as that
  account.
- `readPaths` are validated like grants and added read-only for this
  process only. The extension's own resolved package directory is added
  automatically and is exempt from the validation's "not inside
  `configDir`" rule, since installed packages live under
  `<configDir>/packages`; the exemption covers exactly that directory.
- **Idle stop:** no held handle and no stdio traffic for `idleMinutes`.
- **Crash:** `exited` resolves; the next `connect` starts it again.
  Three crashes within 5 minutes mark the service `failed` for that user
  until the user's settings for that extension change or sigrun
  restarts; `connect` then rejects with the last stderr lines.
- **Stopped on:** user delete, the extension's quarantine, and shutdown
  (workers-then-handlers order).
- **Isolation inactive (single-user server):** services run as plain
  children with the M0 allowlist env. Same API.
- `GET /v1/extensions` gains each extension's services with per-user
  state (`running | idle | failed`), admin-visible; users see their own
  under `/v1/me/services`.

### 10.4 Per-user tools

pi-durable has one registry; a conversation sees every installed
extension unless its stored selection says otherwise.

```ts
host.tools.setUserTools(user: string, tools: readonly ToolRegistration[]): void;
```

- Core installs (or replaces, or with an empty list uninstalls) a
  registry extension named `<slug>@<user>` holding those tools. Tool
  names may repeat across users' entries.
- **Default selection excludes per-user entries.** Core's
  `HarnessSettings.extensions` getter returns the installed extensions
  minus every `*@*` entry.
- **Each conversation selects its owner's entries.** Factories declare
  `perUserTools: true`. At create, core adds `<slug>@<owner>` for every
  such slug to the conversation's stored `extensions` edit
  (`{add: [...]}`), whether or not the entry is installed yet; pi-durable
  skips uninstalled names and picks them up once installed.
- **Fork by another user and ownership transfer** rewrite the stored
  selection in the same commit, in both shapes: an edit object loses the
  old owner's `*@<old>` names and gains the new owner's; an array loses
  every `*@<old>` name (and gains nothing, since arrays are exact).
- **Array selections are otherwise exact.** A conversation whose stored
  `extensions` is an array (for example a gateway group with a fixed
  tool set) is not edited at create or by the boot sweep; per-user tools
  reach it only if its creator listed them. Core rejects any write of a
  `*@<u>` name into a conversation whose owner is not `u` (400 on the
  routes, a thrown error on `host.conversations`).
- **Existing conversations:** a boot sweep adds the owner's entries to
  every non-array selection that lacks them. Idempotent.
- **Enforcement inside the tool.** `setUserTools` wraps every tool it
  installs: before running, the wrapper resolves the calling
  conversation's acting user and returns a tool error unless it is the
  entry's user. Hooks only run for selected extensions
  (`agentHooks` iterates the conversation's selection), so a hook alone
  could be bypassed by a selection naming the entry without the guard;
  the wrapper cannot be. Selection is the convenience; the wrapper is
  the boundary.

### 10.5 Per-user settings sections

U4's settings sections gain `scope: "admin" | "user"` (default `admin`,
U4's behavior):

- `user` sections render under "My settings" in the webui and TUI, read
  and write the caller's `host.stores.user(principal.user).settings`,
  and are editable by every signed-in user for themselves.
- Per-user secret fields write through the §10.2 routes.
- `onSettingsChanged` gains the user for `user`-scope changes.

### 10.6 User deletion

In order:

1. existing: ownership transfer (with the §9.5 `cwd` rewrite and the
   §10.4 selection rewrite) and token revocation; remove the user's
   account links (§11.3);
2. stop the user's worker and services; uninstall every `*@<user>`
   registry entry;
3. existing: `userDeleted {user, transferTo}` to extensions. The user's
   per-user secrets are still readable here (§10.2's deletion
   exception), so an extension can revoke tokens at the provider;
4. remove the directory record;
5. delete the user's per-user secrets file and
   `<configDir>/user-settings/<user>/`. Credentials belong to a person
   and never transfer.

Per-user data and state directories are the extension's call in step 3;
core deletes the user's cache directories.

### 10.7 Tests

Stores layout and permissions; self-only routes (admin gets 404 on
another user's); service lifecycle (first connect, reuse, idle stop,
crash restart, failed after three, stop on delete and shutdown);
per-user tool selection across create, fork-by-other, transfer, array
selections, and the boot sweep; the enforcement hook blocks a forged
cross-user call; deletion order.

## 11. M3: login

### 11.1 Core login seam

Extensions contribute login providers:

```ts
// factory result
loginProviders?: {
  id: string;                         // unique per extension; core prefixes the slug
  label: string;
  icon?: string;
  begin(flow: LoginFlow, ctx: HandlerContext): Promise<{ redirectUrl: string }>;
  complete(flow: LoginFlow, callback: { query: Record<string, string>; body?: unknown }, ctx: HandlerContext): Promise<LoginResult>;
}[];

type LoginFlow = {
  state: string;                      // core-generated, core-verified
  callbackUrl: string;                // core's callback route for this provider
  data: Record<string, string>;       // provider scratch (PKCE verifier, nonce), kept server-side
};

type LoginResult = {
  subject: string;                    // stable, provider-scoped
  profile: { username?: string; name?: string; email?: string; emailVerified?: boolean };
  groups?: string[];
};
```

- Routes, public in the pipeline: `GET /v1/auth/login/:provider` (begin;
  `?return=` a same-origin path) and `GET`/`POST /v1/auth/callback/:provider`.
- Core generates `state`, binds it to the browser with a short-lived
  `HttpOnly` cookie, keeps `flow.data` in memory for 10 minutes, and
  verifies `state` before calling `complete`. A restart mid-login fails
  that login only.
- `GET /v1/auth/providers` (public) lists configured providers for the
  login screen.
- The webui login screen lists providers above the token login. The TUI
  keeps tokens.

### 11.2 Sessions

- A successful login creates a session token in the existing token
  store, with new fields `kind: "session"`, `expiresAt` (default 30
  days, setting `server.auth.sessionDays`), and `name: "login:<provider>"`.
  It is set as `sigrun_session` exactly like today's token login.
- Logout revokes that session token. Users see and revoke their sessions
  in their token list.
- **Expiry is enforced:** the token authenticator rejects an expired
  token as unknown (401), `GET /v1/auth/tokens` shows `expiresAt`, and
  expired records are pruned on the next token-store write. Tokens
  without `expiresAt` (API tokens) behave as today.
- `Principal.method` gains `"session"`; `Principal` gains
  `provider?: string`.
- A session principal has the same rights as today's cookie token,
  including creating the user's own API tokens: that is how a user who
  signs in through an IdP gets a token for the TUI. Revoking a session
  does not revoke tokens created with it; the token list shows each
  token's creation time so a user can revoke them.
- Provider access and refresh tokens are not stored by core.
- The flow store (state, `flow.data`, expiry) is an in-memory map owned
  by the login routes module and constructed with the server
  (`createServer`), like the login limiter. It is not a harness
  singleton and holds no secrets beyond a flow's 10-minute life.

### 11.3 Account links

One table for every external identity, shared with the gateway:

- `<configDir>/accounts.json`, mode 0600, store semantics as today:
  `{provider, subject, user, linkedAt, via: "login" | "self" | "pairing" | "admin"}`.
  The gateway's static `allow[]` entries stay configuration and are
  never written as links.
- Provider ids: login providers `login:<slug>:<id>`; chat channels
  `chat:<channel>`.
- `host.accounts: { lookup(provider, subject), link(provider, subject, user, via), unlink(provider, subject), listForUser(user) }`.
- **One writer path.** Extensions run in sigrun's process, so
  `host.accounts` is core code: every write goes through core's
  `AccountStore` with the json-store discipline (serialized mutations,
  atomic writes, mtime reload so the CLI is a live second writer), the
  same as `users.json`.
- **Backup:** `accounts.json` lives in `configDir`, so the existing
  `config` backup section carries it with `users.json`.
- **Connect an account:** a signed-in user starts a login with
  `?link=1`; the result links to the caller instead of signing in.
- **Listing and removing links** mirror `/v1/auth/tokens`:
  `GET /v1/auth/accounts[?user=]` (own; admins may name anyone) and
  `DELETE /v1/auth/accounts?provider=&subject=` (own; admins may remove
  anyone's). Settings renders them.
- **One link per `(provider, subject)`.** Re-linking to the same user is
  a no-op; linking to a different user is refused
  (`account_link_conflict:`), never re-pointed, since re-pointing is an
  account-takeover path. The holder or an admin removes the old link
  first.
- User deletion removes the user's links (step 1 of §10.6).

### 11.4 First login (no link)

- **Never auto-link** to an existing user by username or email.
- **Unclaimed server:** a login claims only with the setup code (the
  login page asks for it). An external IdP may admit anyone (Google), so
  it is not a trusted proxy.
- **Claimed server, per provider `autoProvision`** (default `false`):
  - `true`: create a user, `source: "login"`, `admin: false`, link the
    account. Optional per-provider `allowedGroups` / `allowedDomains`
    filters refuse others with 403 `not_allowed`. `allowedDomains`
    matches only when the provider reports the email verified
    (`profile.emailVerified === true`); an unverified address never
    satisfies a domain filter.
  - `false`: the login page asks for an invite code; redemption creates
    the user and links the account.
- **Username assignment:** `profile.username`, else the email local
  part, else the subject; lowercased and mapped onto
  `^[a-z0-9][a-z0-9._-]*$`; on collision `-2`, `-3`, and so on. The
  user may not choose it in this revision; the admin can see it in the
  users list.
- These paths obey §9.1: a second user is refused without isolation
  and real authentication.

### 11.5 Groups

- The directory record gains `groups?: { source: string; values: string[]; updatedAt: number }[]`,
  one entry per source (`proxy`, `login:<slug>:<id>`), replaced on each
  login or proxy request from that source.
- This generalizes gateway C8 and **retires its `groupAdmin` field** in
  the same change: C8's write-through of `groupAdmin` becomes a write of
  the `proxy` groups entry, `DirectoryUserWire.groupAdmin` becomes a
  value derived from stored groups, and nothing persists `groupAdmin`
  any more (an existing value is dropped on the record's next write).
  Effective admin is `record.admin || any stored group ∈
  server.auth.adminGroups`, the same answer on the web, in chat, and
  host-side. `recordAdminCount` (the last-admin guard) keeps counting
  `record.admin` only, as core-hardening §5.8 requires.
- **Sharing to groups** (deferred to OIDC by core-hardening ruling 10):
  `Sharing`'s `people` scope gains `groups?: string[]`; `accessOf`
  matches the principal's stored groups.
- **Groups are trusted input only from authenticating sources:** proxy
  headers that passed the trusted-peer and secret checks, and a login
  provider's `LoginResult`. Token and session principals read stored
  groups from the record; nothing on a token- or session-authenticated
  request can set or add groups. The login and callback routes are
  public (no principal), so the proxy-secret rule does not touch them.
- Staleness: groups refresh at the next login or proxy request. The
  docs state it.

### 11.6 `@sigrun/ext-oauth` (bundled)

- Own repo `sigrun-ext-oauth`; a core dependency; built-in key `oauth`,
  slug `oauth`; `builtinExtensions.oauth` defaults to `true`; disable
  and replacement as for every built-in (`builtins.ts` rulings 5–7).
  Named for the protocol family it speaks (OAuth 2 and OIDC on top of
  it, user ruling 12); the core seam it plugs into stays
  `loginProviders`, and other login extensions (atproto, say) sit
  beside it under their own names.
- Inert until its admin settings section lists a provider: no
  providers, no routes beyond core's, nothing on the login screen.
- Provider kinds:
  - `oidc`: `issuer` (discovery), `clientId`, client secret (extension
    secret), `scopes` (default `openid profile email`), `usernameClaim`
    (default `preferred_username`), `groupsClaim` (default `groups`),
    `autoProvision`, `allowedGroups`, `allowedDomains`. Authorization
    code + PKCE + nonce; ID-token validation.
  - `oauth2`: `preset: "github" | "discord"` or explicit
    `authorizeUrl` / `tokenUrl` / `userinfoUrl` with field paths for
    subject, username, name, email, groups; plus the same provisioning
    fields. Authorization code + PKCE where the provider supports it.
- Library choice is the builder's.

### 11.7 Gateway handover

The engine built Tasks 3–12 with links in its own `identities.json`
(synchronous `userFor`, refusing to re-point a linked sender). Engine
Task 13, after M3a merges and before the gateway merges to `main`:

- `IdentityStore` stores links in core through `host.accounts`
  (`chat:<channel>`); home chats stay gateway state in
  `identities.json`, whose `links` key is retired. `userFor` and
  `admitGroupEvent` become async;
- no data migration: the gateway has never shipped, so no deployment
  holds engine links. A dev install whose file still has links logs one
  warning naming the count (those senders pair or self-link again);
- a self-link or pairing approval that hits an existing link to another
  user is refused through core's `account_link_conflict:` with the same
  replies as before, which now point at a fix that exists
  (`/v1/auth/accounts`);
- `userDeleted` clears home chats only, since core removed the links
  before the event;
- `/link` and `/pair` otherwise behave exactly as the gateway spec says;
- an engine booting on a core without `host.accounts` fails loud at
  factory time (quarantined, one error naming the minimum core
  version); it never falls back to writing links into `identities.json`.

### 11.8 Forward auth

The `proxy` method stays in core unchanged apart from storing groups
(§11.5) and the §9.1 secret-header rule. It is the Authelia-style path
for deployments that already put an authenticating proxy in front.

### 11.9 Tests

Seam: state binding, replay and mismatch rejection, return-path
validation, flow expiry. Provisioning matrix: unclaimed + code, claimed
× autoProvision × filters × invite, collisions, the §9.1 refusals.
Links: connect, unlink, deletion, gateway migration idempotence.
Groups: admin derivation, group sharing in `accessOf`. Extension: OIDC
against a local test issuer; OAuth2 presets against fake endpoints.

## 12. M4: extension adoption

### 12.1 sigrun-ext-mcp

- **Catalog** (admin settings), each server gains:
  - `credentials: "user" | "shared"`, default `"user"`. User servers
    run per user as `userServices` (§10.3) with the user's token from
    `stores.user(u).secrets`, in a jail separate from the user's agent.
    Shared servers run once as system children (M0 allowlist env, the
    admin's token, not jailed). A shared server's tools give every
    permitted user's agent the admin's authority on that service, driven
    by whatever that user asks, so a shared entry must carry
    `sharedAuthority: "<one-line reason>"` (the catalog refuses it
    otherwise), may carry `users: string[]` to limit who gets it, and the
    admin UI shows that warning beside it.
  - `availability: "all" | "opt-in"`: `all` is on for every user unless
    they turn it off; `opt-in` is off until they turn it on.
- **User-supplied servers:** admin setting
  `userServers: "none" | "remote" | "all"` (default `none`). Users add
  servers in their "My settings" section. Stdio servers run as
  `userServices`; remote servers connect from sigrun's process, which
  has the same network reach as the agent's bash (no network rules,
  §9.4), so a user URL reaches nothing the user's agent could not.
  Tool names are prefixed `u_<server>_`, and catalog loading rejects a
  catalog server whose name or tool prefix starts with `u_`, so a user
  server cannot shadow a catalog server.
- **OAuth per user:** the extension's OAuth routes use the route's
  `principal` and store tokens in that user's secrets.
- **Tools:** per-user servers' tools publish through
  `host.tools.setUserTools`; shared servers' tools stay system tools.
- Discovery is lazy: a user's servers start on that user's first
  conversation run or settings visit, not at factory time.

### 12.2 sigrun-memory-markdown

- Records and recall are keyed by the event's `owner`, stored under
  `stores.user(owner).paths.data`.
- A shared conversation's memory is its owner's (the agent acts as the
  owner).
- `userDeleted` moves the departing user's memory to `transferTo`'s
  store under a `transferred/<user>/` prefix — memory is content, and
  content transfers with ownership.

### 12.3 Other built-ins

codemode, tool-search, and the gateway read each conversation's resolved
tool list, so per-user tools reach them without changes. The M4 plan
verifies this with one test each.

## 13. Documentation

`docs/extending.md` and the operator docs state, in these words:

- **When isolation is on**, a user's agent can reach only their
  workspace, their grants, their home and temp directories, and
  read-only system paths. It cannot read sigrun's files or environment,
  other users' files, or signal processes outside its jail.
- **Not covered:** extensions run inside sigrun with full access, like
  any installed package — install only extensions you trust. One user's
  agent can still exhaust CPU, memory, or disk. Outbound network is not
  restricted. macOS and Windows hosts run single-user only.
- **Shared MCP servers** hand every permitted user's agent the admin's
  credential for that service.
- **File modes are not the boundary.** Workers that share sigrun's uid
  are confined by Landlock alone; `0700` directories are hygiene.
- **Single-user servers** run the agent with full host access.
- **Every peer in `trustedProxies` can forge any identity**; with
  isolation on, the shared secret is required for that reason.
- Extension authors: when to use `stores.user`, `userServices`,
  `setUserTools`, and `scope: "user"` sections; system-level extensions
  need none of them.

## 14. Calls I made (marked for review)

- ABI 6 minimum (§9.2; ABI 6 = Linux 6.12 per Landlock's own release
  notes): excludes Debian 12's default 6.1 (bookworm-backports' 6.12
  qualifies) and Ubuntu 24.04's GA 6.8 (its HWE 7.0 qualifies).
- `auto` mode turns the jail on at the second user and latches until
  restart (§9.1).
- No Landlock TCP rules; network unrestricted (§9.4).
- Workspaces and grants are admin-edited; no self-service narrowing in
  this revision (§9.5).
- Departing user's workspace becomes a grant on `transferTo` (§9.5).
- Fork by another user clears `agent.cwd` (§9.5).
- Per-user secrets and settings are invisible to admins (§10.2).
- Service crash policy: three in five minutes → failed (§10.3).
- Sessions: 30 days, stored as tokens (§11.2).
- `autoProvision` defaults `false` for login providers (§11.4); the
  proxy method keeps its `true` default.
- Usernames assigned, not chosen (§11.4).
- Shared MCP servers run unjailed as system children, default off
  (`credentials: "user"`), and need a stated reason (§12.1).
- Per-user services run in their own jail, sibling to the user's
  worker, so the user's agent cannot read service credentials (§10.3).
- Workspace/grant validation forbids containing or entering sigrun's
  managed paths rather than all of `dataDir`, works on `realpath`, and
  re-runs at every worker start; every core-owned directory name is a
  reserved slug (§9.5).
- Transfer rewrites `agent.cwd` to an absolute path; `osUser`
  workspaces refuse transfer (§9.5).
- `/dev` limited to the named device files (§9.4).
- Per-user tool enforcement lives in a wrapper around each tool, not a
  hook (§10.4).
- C8's `groupAdmin` is retired in favor of stored groups (§11.5).
- Sessions may create API tokens; revoking a session leaves them
  (§11.2).
- Memory transfers on user delete (§12.2).
- No migration of the engine's interim `identities.json` links: the
  gateway merges only after engine Task 13 (§11.7).
- The integration suite runs on GitHub's `ubuntu-24.04` runners
  (kernel 6.17), with a pod on a 6.12+ host as the fallback (§9.9).

## 15. Left to the builder

- The IPC wire format.
- The worker's handle-id scheme and stream framing.
- The OIDC/OAuth2 library.
- File and module layout within each repo, beyond the paths named here.

## 16. Review disposition

The deepseek-v4.1-flash review
(`reviews/2026-10-23-multi-user-review-deepseek.md`), folded into
revision 3:

| Finding | Disposition |
|---|---|
| B1, B1b (`/proc` and ptrace not covered by ABI 6) | **Declined, text clarified.** Landlock's implicit ptrace restriction applies at every ABI: ptrace and related access only to a sub-domain of the caller, and the kernel docs state that sensitive `/proc/<pid>` files are restricted the same way. The spike measured a same-uid jailed shell denied sigrun's `/proc/<pid>/environ` with `/proc` readable. §6 and §9.2 now name the mechanism; §9.9 adds the review's `/proc` and ptrace cases as tests. |
| B2 (enforcement hook is selection-scoped) | **Accepted.** Confirmed (`agentHooks` iterates the selection). Enforcement moved into a wrapper around each per-user tool; array selections are rewritten on fork and transfer; cross-owner `*@<u>` writes rejected (§10.4). |
| B3 (M0 mechanism does not exist) | **Accepted.** Confirmed (bash tool hardcodes `inheritEnv: true`). M0 uses the bash tool's `prepare` hook plus an `exec` wrapper (§8). |
| B4 (core install root exposes `.env`) | **Accepted.** Only module trees are granted (§9.4). |
| M1 (slug collisions) | **Accepted.** Every core-owned directory name is reserved, with a guard test (§9.5). |
| M2 (relative `cwd` after transfer) | **Accepted** (§9.5). |
| M3 (deletion order) | **Accepted.** Record removal moved after `userDeleted`; deletion exception in §10.2 (§10.6). |
| M4 (fail-closed scope) | **Accepted.** Decision moved into `forConversation` (§9.1, §9.3). |
| M5 (`/dev`) | **Accepted** (§9.4). |
| M6 (realpath, revalidation) | **Accepted** (§9.5). |
| M7 (rights per level) | **Accepted** (§9.4 table). |
| M8 (`groupAdmin`; shared files) | **Accepted** (§11.5, §7). |
| M9 (shared MCP authority) | **Accepted.** Default `user`, stated reason required, optional user list, documented (§12.1, §13). |
| M10 (`osUser` HOME, transfer, file modes) | **Accepted** (§9.4, §9.5, §9.8, §13). |
| M11 (`auto` un-jails) | **Accepted.** Latched per process, transitions logged (§9.1). |
| M12 (`no_new_privs` invariant) | **Accepted.** Stated as an invariant with a test; helper refuses uid/gid 0 (§9.3). A root-owned uid allowlist was not added: with `no_new_privs` inside every jail, the file-capped helper is unprivileged there. |
| m1, m2, m3, m4, m5, m6, m8, m9, m10 | **Accepted** (§9.3, §10.3, §11.2, §11.3, §11.4, §12.1, §9.9). |
| m7 (`login:login:oidc` ids) | **Resolved by the rename** (user ruling 12): the bundled extension's ids read `login:oauth:<id>`. |
