## Review — sigrun multi-user design (`2026-10-23-sigrun-multi-user-design.md`, rev 2)

Review-only: no files modified. Read the spec, then verified load-bearing claims against `src/`, `charts/`, `package.json`, the in-flight plans/specs, and `node_modules/@earendil-works/pi-durable/dist` (1.3.0). One spec detail was masked by the tool's credential filter (the per-user secrets file path in §10.2/§10.6), so that single path is unverified.

### Verified as correct (evidence)

- `NodeExecutionEnv` really does merge `process.env` into every `exec` (`dist/env/node.js:197-205`, called at `:737`), and `sigrun-ext-mcp` really spawns stdio servers with `{ ...process.env, ... }` (`node_modules/@sigrun/ext-mcp/dist/client.js:671` — the spec cites the source line in that repo; substance matches).
- `selectExtensions` silently drops selected-but-uninstalled names (`dist/harness/agent.js:243-247`); the registry documents duplicate tool names across extensions (`dist/harness/types.d.ts:319`). Both §5 claims hold.
- Core resolves the per-conversation env exactly once through `createWorkspaceService().forConversation` behind `toHarnessEnv` (`src/harness/workspace.ts:76-129`), and every non-tool consumer (`files` routes, uploads, context files, jobs) goes through the same seam (`src/server/helpers.ts:307-326`, `src/jobs/fire.ts:232-238`). The §9.3 swap point is therefore the right one — but see M4/M7.
- `slugifyName` can never emit `@` (`src/harness/stores.ts`, "fold `[^a-z0-9_-]+`" plus trailing-`@version` strip), so the `*@*` exclusion in §10.4 cannot collide with a real slug.
- Reserved-section quarantine is genuinely load-time and leaves nothing installed (`src/harness/loader.ts:1684-1742`), so reusing that mechanism for reserved slugs (§9.5) is sound.
- Bubblewrap/Landlock/setpriv spike results are consistent with the container shape in `charts/sigrun/values.yaml:38-42` (uid 1000, no caps), so ruling 1/2 are compatible with the current chart.
- Chart paths confirm the §9.5 validation examples: `/data/workspace` is a sibling of `/data/data`, `/data/config`, `/data/state` (`charts/sigrun/values.yaml:69-98`), and `defaultWorkspacePath` is `<dataDir>/workspace` (`src/config.ts:327-329`).
- §10.3's service-jail/sibling-domain idea, §11.3's single-writer `accounts.json`, and §11.1's server-scoped flow store are all architecturally consistent with existing patterns (`src/harness/identity/json-store.ts`, `src/server/auth/login-limiter.ts`).

---

### Blockers

**B1 — BLOCKER — §6, §9.2, §10.3, §14: Landlock ABI 6 scoping is signal + abstract-socket only; the boundary claims "ptrace scoping", and sigrun's own environment stays readable.**

The spec's own §9.2 names the mechanism correctly ("ABI 6 adds signal and abstract-socket scoping"), but §6 then promises the agent "cannot … inspect or signal sigrun or any process outside U's own jail (ptrace and signal scoping)" and "read sigrun's environment (scrubbed, and the process is outside the jail's ptrace scope)", §13 repeats it in operator-facing words, and §14 makes per-user-service credential isolation a design *call* premised on sibling domains. Landlock's signal scope hooks signal delivery; it does not restrict `/proc/<pid>/{environ,mem,maps}` reads or `ptrace` attach. `/proc` is explicitly granted read-only (§9.4), and the worker runs as the **same uid** as sigrun, so nothing in the described mechanism stops:

- `cat /proc/$(pgrep -f 'dist/index.js' | head -1)/environ` → `SIGRUN_API_TOKEN`, `SIGRUN_PROXY_SECRET`, `BIFROST_API_KEY`/provider keys. M0 (§8) scrubs the *child's* env; it does nothing about the *parent's*, which is exactly what the jail is claimed to hide.
- the same read against a per-user service's environment (§10.3), which is where the user's GitHub token lives — the single most valuable secret in the design.
- `/proc/<pid>/mem` against a same-uid sibling worker, if Yama is not `ptrace_scope>=1` on the target host (the spec never states a Yama dependency).

The spike row "denied sigrun's `/proc/<pid>/environ`" therefore has no matching kernel hook in the surface §9.2 cites; whatever produced it needs naming, because the whole §10.3 credential story rests on it.

*Fix (pick one and state it):* (a) every process the helper starts sets `PR_SET_DUMPABLE=0` — that is what makes `/proc/<pid>/environ` root-owned and unreadable to a same-uid peer — and sigrun sets it for itself at boot (helper subcommand, or a `process.binding`-free native shim; document systemd `ProtectProc=invisible` as the bare-metal belt-and-braces); plus an IT line each for `/proc/<sigrun>/environ`, `/proc/<service>/environ`, `/proc/<sibling-worker>/mem`, and a `ptrace` attach attempt. Or (b) delete the ptrace/"inspect" claim from §6/§13 and move service credentials off `ServiceSpec.env` (see B1b below). Do not ship (c) "it works because the spike said so".

**B1b — BLOCKER (same root cause, separate fix) — §10.3: the service token is only protected by the mechanism B1 falsifies.**

"Core starts the process through the helper … in its **own Landlock domain** … so the user's agent cannot read credentials injected into a service's environment." Given B1, `ServiceSpec.env` is the wrong channel for credentials. Make the token a file in a path granted to the service domain only — `<dataDir>/<slug>/users/<user>/…` is already excluded from every agent jail by §9.4, so it is a free, working channel — or pass it on a pipe fd. Keeping the credential in `env` is acceptable only if B1(a) lands and is tested.

**B2 — BLOCKER — §10.4: "the hook is the boundary" does not hold, because hooks are selection-scoped and array selections are explicitly never edited.**

`tool.beforeTool` handlers come from the conversation's *selected* extensions only: `agentHooks()` iterates `agent.extensions` (`dist/harness/agent.js:146-155`), and for a stored array selection `selectExtensions` returns exactly that array (`agent.js:232-241`). Now combine §10.4's two rules: "Array selections are exact … is never edited" and "Fork by another user and ownership transfer rewrite *the edit*: remove the old owner's `*@<old>`". There is no `{add, remove}` edit to rewrite for an array, so after a fork-by-other (or a transfer) the array still names `<slug>@<old-owner>`, the new owner's conversation selects the old owner's per-user registry entry, and — because the core guard extension is likewise not in that array — nothing blocks the call. That is exactly the §6 line "use another user's credentials or per-user tools (§10)" failing, and it is reachable with no misconfiguration beyond using a gateway-group-style fixed tool set.

*Fix:* enforce at the tool, not at selection — wrap each tool in `setUserTools` so `execute` compares `api.conversationId`'s owner (owner → acting user, per §10.1) against the entry's user and returns a tool error otherwise; keep the hook as a second layer. And make fork-by-other/transfer also rewrite array selections (strip `*@<old>`, and reject any `*@<other>` name arriving in `agent.extensions` edits) rather than only the object form.

**B3 — BLOCKER — §8: M0 as written cannot be implemented through `NodeExecutionEnv`; "`inheritEnv: false` semantics" is not a constructor option, and the bash tool hardcodes `inheritEnv: true`.**

Spec: "Core's workspace service builds every `NodeExecutionEnv` with an explicit environment and `inheritEnv: false` semantics for every `exec`". Reality: `NodeExecutionEnv`'s constructor accepts only `{cwd, shellPath, shellEnv, watch}` (`dist/env/node.d.ts:12-17`); `shellEnv` is merged **over** `process.env` (`node.js:200-204: { ...process.env, ...baseEnv, ...extraEnv }`), so it can add or override but never subtract. `inheritEnv` exists only per call in `ShellExecOptions` (`dist/env/index.d.ts:237-241`), and core never calls `env.exec` — pi-durable's bash tool builds the execution itself with `env: {}, inheritEnv: true` (`dist/tools/bash.js:34-38`) and forwards it (`:51-56`). So the leak survives the change described, silently, and M1 reuses "the same allowlist inside the worker" on the same false premise.

*Fix:* the documented seam is `createBashTool({ prepare })` (`dist/tools/bash.d.ts:28-30`): `prepare(execution) { execution.inheritEnv = false; execution.env = allowlist(); }`, wired where core builds the tool (`src/harness/tools.ts:97`). Belt: a `SandboxedExecutionEnv`/wrapper that forces `options.inheritEnv = false` on every `exec`. Keep the §8 test, and add one asserting a *non-empty* env var from a `shellEnv`-less path cannot appear.

**B4 — BLOCKER — §9.4: granting "the core install directory" read-only exposes a checkout's `.env` and private docs to every jail.**

`AGENTS.md` (this repo): "`docs/private.md` is gitignored", "`.env` stay untracked by design", and the supported install shapes include "git source". A git-clone install that boots with `tsx src/index.ts` has the repo root as the core install dir — so the read-only grant hands user B's agent `./.env` (provider keys, possibly `SIGRUN_API_TOKEN`) and `docs/private.md`. §6 forbids "read sigrun's … credential files"; this grants exactly one.

*Fix:* grant the *resolved module subtrees* the worker actually needs (`<pkg>/dist` or `<pkg>/src`, the pi-durable package dir, the helper binary) rather than the install root, and add a test that a file planted at `<core>/.env` is unreadable inside the jail. Cheapest defensible version: grant `<core>/dist` **and** `<core>/node_modules/@earendil-works/**`, and never `<core>` itself.

---

### Major

**M1 — MAJOR — §9.4/§9.5: `<stateDir>/sandbox/<user>/tmp` collides with an extension whose slug is `sandbox`, and only `users`/`workspace` are reserved.**

Per-user tmp is rw-granted to the agent (§9.4), and extension raw dirs are `paths.state = join(roots.stateDir, slug)` (`src/harness/stores.ts`, `scopedExtensionStores`). An extension declaring slug `sandbox` gets `<stateDir>/sandbox` as its state dir — the same directory core fills with agent-writable per-user tmp. The reserved-slug rule covers only `dataDir` names (`users`, `workspace`).

*Fix:* reserve `sandbox` too, and state the general rule ("every directory core owns directly under a store root is a reserved slug"), listing them: `users`, `workspace`, `sandbox`, `models` (`fileModelsStore(config.dataDir)` → `<dataDir>/models`, `src/harness/providers/models-store.ts:61`), plus config-root names `settings`, `user-settings`, `skills`, `prompts`, `packages`, `git`.

**M2 — MAJOR — §9.5: "transferred conversations keep their `agent.cwd`" contradicts "`agent.cwd` is resolved against the owner's workspace", and a relative cwd silently retargets.**

`toHarnessEnv` resolves a relative cwd against the env base: `resolve(env.cwd, target.cwd)` (`src/harness/workspace.ts:123-127`). After a transfer the base is the *new owner's* workspace, so a conversation whose cwd was `projects/x` now operates in `transferTo`'s `projects/x` (or fails) while the files stayed behind under the new rw grant. The absolute case works; the relative case is a silent wrong-directory write.

*Fix:* on ownership transfer (and on any workspace change for a conversation), rewrite `agent.cwd` to the absolute path under the grant, exactly as the fork rule clears it; say that explicitly and test both shapes.

**M3 — MAJOR — §10.6 vs §10.2: step 3 cannot read per-user secrets, because step 1 already removed the user record and `stores.user()` "throws" for unknown users.**

Spec §10.2: "`user` must exist in the directory; otherwise the call throws." Spec §10.6 order: 1 … **record removal**; 3 `userDeleted {user, transferTo}` — "per-user secrets are still readable here, so an extension can revoke tokens at the provider". The stated purpose of step 3 is impossible unless the handle bypasses the existence check.

*Fix:* move record removal after step 3 (it is a directory write, cheap), or give `userDeleted` a deletion-scoped handle (`stores.user(user, { allowMissing: true })` / a `UserHandle` passed in the event). State which, and add it to the §10.7 deletion-order test.

**M4 — MAJOR — §9.1: fail-closed is scoped to "every agent tool call", leaving every other env consumer unspecified.**

"…fails every agent tool call that would touch an `ExecutionEnv` with the tool error `isolation_unavailable`". But uploads (`PUT /v1/conversations/:id/uploads/:name` → `env.writeFile`, `src/server/routes/files.ts:133-134`), listing/content/raw (`:208/:246/:259/:309/:325`), context files (`SOUL.md`/`AGENTS.md` sections), skills rendering, and job prompt expansion all resolve the same env via `src/server/helpers.ts:307-326` and `src/jobs/fire.ts:232-238`. §9.3 says `forConversation` "returns … today's `NodeExecutionEnv` otherwise", which for a two-user server with isolation unavailable means **unconfined** access for those surfaces.

*Fix:* put the decision in `WorkspaceService.forConversation`: when the directory has ≥2 users and isolation is not active, return an env whose every method fails with `isolation_unavailable: <reason>` (that is the one place all consumers pass through), and reword §9.1 to "every `ExecutionEnv` resolution" rather than "every agent tool call".

**M5 — MAJOR — §9.4: `/dev` granted read-write wholesale.**

"`/dev` read-write for files (device ioctls are not handled)". On bare metal (ruling 3/4 shape) that includes every device node the service account can open — block devices when the account is in `disk`, `/dev/fuse`, `/dev/pts/*`, `/dev/shm` (a same-uid shared-memory rendezvous any other sigrun process can read, and the one place a jailed agent can leave state that survives its worker), plus `/dev/tty`. The container is device-cgroup-limited, but the spec promises bare-metal parity.

*Fix:* enumerate the minimal set (`/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/tty`, `/dev/pts`) and grant `/dev/shm` only if a tool truly needs it (a per-user `TMPDIR` already covers the need).

**M6 — MAJOR — §9.5: grants are validated only at PATCH time, and the validation is not canonicalized.**

Two distinct holes: (i) nothing re-validates when a store root *moves* — grant `~/shared`, later set `SIGRUN_DATA_DIR=~/shared/sigrun-data`, and an existing `rw` grant now contains `dataDir` (Landlock cannot subtract, §9.5 says so itself); (ii) "The path is absolute and existing" does not say *realpath*-ed — a grant that is a symlink to a store root passes the string test and, since Landlock matches the resolved inode hierarchy, grants the target. The same applies to the workspace default.

*Fix:* validate and store `realpath`; re-run the whole validation at boot and at each worker policy build (refuse to start the worker with a named reason if any grant now intersects a store root after a root move).

**M7 — MAJOR — §9.3/§9.4: the Landlock right mask per access level is undefined.**

"It creates a Landlock ruleset handling every filesystem right of the running ABI … adds the policy's path rules" — but not which rights `ro` vs `rw` carry. Guessing wrong is not cosmetic: without `LANDLOCK_ACCESS_FS_REFER` on rw paths, cross-directory `rename`/`link` fails and `git`/`npm` break in obscure ways; including it on `ro` paths would make read-only grants writable in the one operation Landlock gates separately; excluding `EXECUTE` from the workspace makes `./script.sh` fail while `bash script.sh` works (a confusing, model-visible asymmetry).

*Fix:* tabulate it in §9.4 — `ro` = `READ_FILE | READ_DIR` (+ `EXECUTE` if intended, say so); `rw` = `ro` + `WRITE_FILE | REMOVE_FILE | REMOVE_DIR | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM | REFER | TRUNCATE | IOCTL_DEV` as available by ABI; nothing else ever granted.

**M8 — MAJOR — §11.5 vs in-flight gateway-core Task 5: two sources of truth for group-derived admin, and `shared/src/views.ts` is missing from §7's shared-file list.**

Gateway-core Task 5 (C8) adds `DirectoryUser.groupAdmin?: boolean`, persists it write-through from `resolveProxy`, and exposes `UserWire.groupAdmin?` — and it is one of M3's stated waits. §11.5 then introduces `groups?: {source, values, updatedAt}[]` with effective admin = `record.admin || any stored group ∈ adminGroups`, which supersedes `groupAdmin` but never says so. A builder will implement both and they will disagree (proxy writes `groupAdmin`, login writes `groups`, `recordAdminCount` mixes them). Separately, three in-flight plans touch the same two type files: gateway-core Task 6 adds `method: "host"` and this spec adds `"session"` to `Principal.method` (`src/extension.ts`, `shared/src/views.ts`), and U4 defines `onSettingsChanged(keys)` while §10.5 makes it `(keys, user)`. §7 lists `src/extension.ts` but not `shared/src/views.ts`.

*Fix:* state that M3 retires `groupAdmin` (or keeps it as a derived read of `groups[source="proxy"]`) in the same change, and add `shared/src/views.ts`, `src/harness/settings.ts`, `src/server/routes/onboarding.ts`, `src/harness/identity/invites.ts` to §7's wait list.

**M9 — MAJOR — §12.1: "shared" MCP servers hand every user's agent the admin's credentials, driven by prompts.**

`credentials: "shared"` → "run once as system children (M0 allowlist env, **admin's token**, not jailed — admin-configured, trusted like extensions)". The trust argument borrowed from §13 does not transfer: extension code is fixed and reviewable, whereas a shared server's tools are invoked *by a model steered by any user*, so user B can ask their agent to call `github_delete_repo` with A's (admin's) token. That is precisely the §6 line "use another user's credentials" — the credential here is admin's, not another user's, but the exposure is the same and larger.

*Fix:* default `credentials` to `"user"`; for `"shared"`, document in §13's "not covered" list that a shared server's tools grant every user's agent the admin's authority on that service, and require an explicit per-server opt-in with a one-line rationale in the admin UI.

**M10 — MAJOR — §9.8: osUser interacts badly with §9.4's HOME, §9.5's transfer, and DAC.**

Three unstated consequences: (i) §9.4 sets the worker's `HOME` to `<dataDir>/users/<user>/home` unconditionally, while §9.8 makes an `osUser` record's *workspace* the OS account's home — so `git config`/tool caches land in a sigrun-owned home while the repo is in alice's home (and `git` writes to a home owned by the wrong account); (ii) §9.5's transfer turns the departing workspace into an `rw` **grant**, but an OS account's home is normally `0700 alice` — the service account running transferTo's worker gets EACCES, so the transfer silently does nothing and §10.6 step 1 has already committed the ownership change; (iii) the `0700` mode language throughout §9.5/§10.2 implies DAC protection that does not exist for same-uid workers — say so, or an operator will believe it.

*Fix:* for `osUser` records, `HOME` = the account's home; on transfer of an `osUser` workspace, refuse (409 `invalid_transfer`, naming the reason) rather than create an unreadable grant; add one sentence that with same-uid workers only Landlock confines, and file modes are hygiene, not isolation.

**M11 — MAJOR — §9.1: `auto` un-jails an existing multi-user install when the last second user is deleted.**

`auto` = "Jail on when the directory holds more than one user". Delete the second user and the lone admin's agent silently regains full host access mid-life, with no event beyond `/v1/meta`. §2's anti-goal is "Isolation that silently degrades"; this is a deliberate downgrade, but it is still silent, and it happens to the *admin's* conversations that may have been operating under `always`-grade expectations.

*Fix:* latch — once a boot has observed ≥2 users (or once a jail has ever been active in this process), `auto` stays on until restart; log one line on every transition in either direction. (Cheap, and it removes a surprising class of bug.)

**M12 — MAJOR — §9.8/§9.3/§9.7: `no_new_privs` is load-bearing for the setcap helper and the spec does not say so.**

The helper installed with `cap_setuid,cap_setgid+ep` is executable read-only inside every jail (§9.4 grants the core install dir), and it will `setuid` to whatever uid its fd-3 policy names. What stops a jailed agent from exec'ing it with `uid: 0` is exactly `PR_SET_NO_NEW_PRIVS` on the worker (inherited by all its children): with NNP set, `execve` does not grant the file capabilities. That invariant is currently an implementation detail of one bullet in §9.3, not a stated rule — and the next person who "fixes" a tool that needs privileges will relax it.

*Fix:* state it as an invariant ("every process the helper starts sets `no_new_privs`; the file-capped helper is therefore unprivileged inside any jail"), have the helper refuse `uid 0` and any uid not in a root-owned allowlist file, and add the IT case "exec the helper from inside the jail → nonzero exit, no uid change".

---

### Minor

**m1 — §9.3 "forwards all 26 methods"** — `FileSystem` has 26 members counting the *optional* `listFiles?` and `cleanup`, plus `Shell.exec` (`dist/env/index.d.ts`). So the count is 27 and, more importantly, "a pi-durable upgrade that adds a method fails to compile" only holds for required members: `listFiles?` is optional and `NodeExecutionEnv` does not implement it (`dist/env/node.d.ts`), so a future optional addition compiles silently and silently degrades. Say "every required member; optional members forwarded when the worker's env implements them".

**m2 — §9.3: `cleanup()` forwarded to a shared per-user worker has user scope.** `Shell.cleanup` is documented "kill every command this environment still runs; for its owner's shutdown" (`dist/env/index.d.ts`). With one worker per user, one conversation's cleanup kills every other conversation's in-flight commands for that user. Specify `cleanup` as a no-op except on worker stop.

**m3 — §12.1: the `u_<server>_` prefix does not guarantee "cannot shadow a catalog server"** unless catalog tool names are forbidden from starting with `u_`. Reserve the prefix (validate at catalog load), or namespace catalog tools too.

**m4 — §10.3: "`readPaths` are validated like grants" would reject the automatically added extension package dir** (which commonly lives under `configDir/packages`, a path grants may not enter). State the exception for the auto-added dir explicitly, or the builder will either drop the validation or the dir.

**m5 — §10.3 internal contradiction:** "Stopped on: … and isolation being inactive" immediately followed by "Isolation inactive (single-user server): services run as plain children with the M0 allowlist env." Delete the first clause.

**m6 — §11.4/§11.3: `via: "allowlist"` has no described flow**, and `profile.emailVerified` is collected but unused — `allowedDomains` will admit unverified addresses from IdPs that do not verify. Require `emailVerified !== false` for `allowedDomains` matching, and either describe the allowlist path or drop the enum member.

**m7 — §11.3/§11.6: bundled-provider ids read `login:<slug>:<id>` and the bundled slug is `login`**, so OIDC shows up as `login:login:oidc`. Consider `login:<id>` for the bundled extension or a pinned provider id in §11.6.

**m8 — §11.2: session-token expiry is stored but never enforced or listed.** The token store entry shape (`core-hardening §5.4`) has no expiry, and nothing says the authenticator rejects expired tokens, that `GET /v1/auth/tokens` shows `expiresAt`, or that expired records are pruned. One sentence, one test.

**m9 — §9.3: `<core>/dist/sandbox/worker.js`.** `package.json` `exports`/`bin`/`files` ship `dist`, so this works for a published install — but the repo runs from `src/` via tsx and does not commit `dist` (AGENTS.md), so a dev checkout and the §9.9 unit tests have no such file. Resolve the worker from `import.meta.url` with a source fallback, and say which one the IT suite uses.

**m10 — §9.9: the `ubuntu-24.04` kernel claim** (`6.17.0-1022-azure`, image `20260927.320.1`) is unverifiable from the repo and is load-bearing for the only CI that runs the boundary suite. Keep the hedge, but make the first CI job's *only* assertion the boot self-test, so a silent kernel regression cannot be reported as a suite skip-as-pass.

---

### Verdict

**BLOCK** — four must-fix items before M1 planning: B1/B1b (the ptrace/`/proc` boundary claim is not backed by ABI 6 scoping, which also undercuts the per-user-service credential story), B2 (the per-user-tool enforcement hook is selection-scoped and array selections are never rewritten), B3 (M0's stated mechanism does not exist in `NodeExecutionEnv`; the fix is the bash tool's `prepare` hook), and B4 (the read-only core-install grant exposes a checkout's `.env`). The remaining majors are cheap to fold in as spec text and one test each.

*Tests a supervisor must run once M0/M1 land:* `npm test`, `npm run typecheck`, plus the new `SIGRUN_SANDBOX_IT=1` suite on a 6.12+ kernel — and specifically the four `/proc`/`ptrace` cases from B1, the array-selection cross-user case from B2, and the `<core>/.env` case from B4.