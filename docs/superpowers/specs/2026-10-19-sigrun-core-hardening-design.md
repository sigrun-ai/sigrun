# Sigrun core: hardening, identity, jobs, and the integration surface

Status: draft for review. Date: 2026-10-19.
Source: the 2026-10-19 whole-repo review (findings cited as R1–R19) plus
the user's rulings in the same conversation.

## 1. Intent

Sigrun's foundations work: one durable loop, equal clients, extension
contracts with fail-loud loading. What keeps it from being the user's
always-on assistant is the core, not missing extensions. Today:

- `sigrun serve` is an unauthenticated remote shell (R1). Workstation mode
  is reachable from any web page through DNS rebinding (R2).
- Operational traps:
  - a provider blip pulls the pod from the Service (R3);
  - phone photos fail to upload (R4);
  - workstation first boot fails (R5);
  - extensions silently run a different pi-durable than the host (R6).
- The API is shaped for one tab on a LAN:
  - submits hold the request open for the whole run (R9);
  - streaming re-sends the whole transcript ~10×/s (R8);
  - the sidebar re-reads every transcript every 10 s (R7).
- There is no scheduler. Spec B's cron lane and CONTEXT §2's "routine
  maintenance" have no core to stand on.
- Extensions cannot serve HTTP, add slash commands, ship skills, drive
  conversations, or notify anyone. Those are exactly the points a Discord
  bridge, an ask-user port, a warden port, or honcho plug into.

This spec brings the core to the point where those things are just
extensions. Honcho, research, Forgejo, Discord, calendar and the like are
**out of scope**: they are unbuilt extensions, and this spec gives them
their surface.

## 2. Scope

**In:** everything core-owned from the review, the jobs/scheduler
subsystem, and the extension integration points.

**Out:**

- **The in-flight build/packaging/webui-channel work**
  (`2026-10-18-sigrun-build-and-webui.md`): the build step, the spawned
  TUI, `server.webui`, contributed bundles, the `node dist/` deploy
  invocations, and the `/v1/meta` `collisions` field. This spec starts
  after that branch merges and builds on its result.
- **`sigrun-ext-approvals`.** It will be deleted and replaced by an
  ask-user port (rpiv-ask-user-question shape) and a warden port (user
  ruling). Only the core touchpoints in §6.7 are in scope.
- **OIDC.** It is the planned successor to forward auth; §5 is shaped so
  it slots in as one more authenticator.

## 3. Workstreams and order

| # | Workstream | Depends on |
|---|---|---|
| W0 | Server restructure | build-and-webui merged |
| W1 | Identity and access | W0 |
| W2 | Operational correctness | W0 (items independent of each other) |
| W3 | API shape | W0, W1 |
| W4 | Jobs | W1, W3 |
| W5 | Extension integration points | W1, W3, W4 |

Each workstream gets its own implementation plan. W2 items ship one per
commit.

---

## 4. W0 — Server restructure (R17, R18)

- `src/server/index.ts` (one ~1,870-line `createServer`) splits into
  route modules by resource: `probes`, `meta`, `conversations`,
  `submissions`, `interactions`, `files`, `providers`, `settings`, `jobs`,
  `extensions`, `events`, `auth`. `createServer` composes them.
- One `preHandler` serves every `/v1/conversations/:id/*` route. It:
  - resolves the conversation;
  - 404s `conversation_not_found`;
  - applies the W1 visibility rule;
  - sets `request.conversation`.

  This removes the copy-pasted lookups.
- `request.principal` (W1) replaces `request.sigrunUser`.
- Comments drop task-history labels (T26a, Task 9e, review M2) and state
  what the code does. These wrong comments are fixed:
  - the loader's "extra arguments are inert";
  - submissions' "until the watch stream lands";
  - backup's "VACUUM-into API";
  - the composer's "the submissions route awaits full settlement"
    (`Composer.tsx:589`), fixed with §7.1.
- `/v1/meta` moves to the `meta` module with the build spec's
  `capabilities.channels` and `collisions` behavior intact.
- No behavior change. The suite passes with only import-path edits.

---

## 5. W1 — Identity and access (R1, R2)

### 5.1 Principal

```ts
type Principal = {
  user: string | undefined; // undefined only under "none" without X-Sigrun-User
  name?: string;
  email?: string;
  admin: boolean;
  service: boolean; // true only for the env token (§5.4)
  method: "none" | "token" | "proxy"; // "oidc" later
};
```

- **`principal.user`:**
  - under `token`/`proxy` it is a username in the **user directory**
    (§5.8);
  - under `none` it is the unverified `X-Sigrun-User` value;
  - for the env token it is the service name.
- **`admin`** is the effective admin: the user record's `admin`, OR the
  request's proxy groups intersecting `server.auth.adminGroups`. Groups
  are read per request for this check only. They are not stored, and
  they are not a sharing target (§5.9).
- `SessionMeta.owner` is stamped from `principal.user` at create, fork,
  import, and job-run creation. This is today's stamping, now from a
  verified source.

### 5.2 Request pipeline and authenticators

Every request passes these stages in order (fixed; the plan pins it with
a test):

1. **Host/Origin** (§5.5).
2. **Public routes** pass straight to their handler:
   - `/healthz` and `/readyz`;
   - webui statics;
   - `/v1/onboarding*`;
   - `POST /v1/auth/login` and `POST /v1/auth/logout`;
   - `/metrics` when `server.metrics.public`.
3. **Env service token**: a matching `SIGRUN_API_TOKEN` resolves the
   service principal and skips stage 4.
4. **Unclaimed gate** (§5.8): `403 {error: "setup_required"}`.
5. **Authenticate**: the methods below; no match → `401 {error:
   "unauthenticated"}`.
6. **Authorize**: admin routes (§5.6), then the content check via the
   conversation pre-handler or the route.

`server.auth.methods` is an ordered list of authenticator ids. Each
request tries them in order; the first that yields a principal wins.

| id | resolves when | principal from |
|---|---|---|
| `proxy` | the socket peer is in `trustedProxies`, the shared-secret header matches (when configured), AND the user header is non-empty | the forwarded headers |
| `token` | `Authorization: Bearer <t>` or the `sigrun_session` cookie matches a stored token | the token record |

An empty list means **no authentication**: the principal is `{method:
"none", admin: true}`, with `user` taken from `X-Sigrun-User` (today's
naive mode). `X-Sigrun-User` is ignored under every other method.

**Defaults (user ruling):**

- `methods` defaults to `[]` on a loopback listen host (`127.0.0.0/8`,
  `::1`, `localhost`) and to `["token"]` otherwise.
- An explicit value always wins, including `[]` on a non-loopback bind.
  That is the config override. Boot then logs one loud warning, and
  `/v1/meta` reports `auth.methods`.
- A server with no users boots **unclaimed** and runs onboarding (§5.8,
  user ruling). It never fails boot for lack of a token.

### 5.3 Forward auth (Authelia) — the pre-OIDC path

```jsonc
"server": { "auth": {
  "methods": ["proxy", "token"],
  "proxy": {
    "trustedProxies": ["10.42.0.0/16", "fd00:42::/56"], // required with "proxy"
    "secretHeader": "X-Sigrun-Proxy-Secret",          // optional; value from SIGRUN_PROXY_SECRET
    "userHeader": "Remote-User",       // defaults = Authelia's names
    "groupsHeader": "Remote-Groups",   // comma-separated
    "nameHeader": "Remote-Name",
    "emailHeader": "Remote-Email"
  }
}}
```

- Proxy headers count ONLY from a socket peer inside `trustedProxies`.
  From anyone else they are ignored and the next method runs.
- Listing `proxy` without `trustedProxies` is a boot error, never "trust
  everyone".
- **Every peer in `trustedProxies` can forge any identity, including an
  admin** (both reviews). The docs say this in those words.
- **Shared secret (user ruling 8).**
  - With `secretHeader` set, the proxy method also requires that header
    to equal `SIGRUN_PROXY_SECRET` (env only — it is a credential).
  - Comparison is constant-time.
  - The header is stripped before handlers see the request.
  - The ingress injects it (Traefik `headers.customRequestHeaders`, nginx
    `proxy_set_header`).
  - Without the header, a request from a trusted peer is not proxy-authed
    and falls through to the next method.
  - The docs recommend the secret whenever `trustedProxies` is broader
    than the ingress pods — a pod CIDR always is.
  - Boot warns when `trustedProxies` contains a prefix shorter than /24
    (IPv4) or /64 (IPv6) and no `secretHeader` is set.
- Docs:
  - dual-stack clusters list both families;
  - with `externalTrafficPolicy: Cluster`, the peer can be a node IP;
  - the proxy must OVERWRITE the identity headers on every request
    (Traefik `forwardAuth.authResponseHeaders` and nginx
    `auth_request_set` do).
- The intended homelab shape:
  - browsers come through the Authelia-protected ingress (`proxy`);
  - TUI `attach` and scripts come over the tailnet with a token (`token`).

  Hence the ordered list.

### 5.4 Tokens

- **Storage:** `<configDir>/api-tokens.json`, mode 0600. This is a new
  named config-root entry, added to `docs/extending.md`.
  - Entries are `{id, name, user, sha256, createdAt}`.
  - `user` must exist in the user directory. The token carries that
    user's rights: admin is a property of the user, not of the token.
  - Only the SHA-256 is stored. A presented token is hashed and compared
    with `timingSafeEqual`.
  - Tokens are `sgr_` + 32 random bytes in base64url.
- **Env token:** `SIGRUN_API_TOKEN` (+ `SIGRUN_API_TOKEN_USER`, default
  `sigrun`) adds one in-memory admin **service** token.
  - It is never written to disk.
  - It is not a directory user, and it does not make the server
    "claimed".
  - It works while unclaimed.
  - Resources it creates are owned by the service name. Clients render
    that as "(service)", and share pickers omit it.

  This is the automation and GitOps path.
- **CLI** (on the server host, which already implies database access):
  - `sigrun token create <name> --user <u>` prints the token once;
  - `sigrun token list`;
  - `sigrun token revoke <id>`.
- **API:** any user creates, lists, and revokes their own tokens. Admins
  may additionally list and revoke anyone's, but **never create a token
  for another user** — a token for B *is* B, which would make admin a
  content authority (glm B1).
  - `GET /v1/auth/tokens` (no secrets; `?user=` for admins);
  - `POST /v1/auth/tokens` (self only; returns the token once);
  - `DELETE /v1/auth/tokens/:id`.
- **Store semantics** (applies to `api-tokens.json`, `users.json`, and
  `invites.json`):
  - the server re-reads the file when its mtime changes, checked per
    request;
  - so a CLI revoke or user add is honored live, without a restart;
  - writes are atomic (temp file + rename).
- **Browser login without a proxy:**
  - `POST /v1/auth/login {token}` (public; the body token is the
    credential) sets `sigrun_session=<token>` with `HttpOnly;
    SameSite=Strict; Path=/`, plus `Secure` when the request is https
    (direct, or `X-Forwarded-Proto` from a trusted proxy);
  - failed logins are delayed 1 s and, after 10 failures per peer IP in
    10 minutes, answered 429 for 10 minutes (in-memory);
  - `POST /v1/auth/logout` clears it;
  - the webui prompts for a token on its first 401.

  My call: a cookie keeps the token out of `localStorage`, and the
  existing `EventSource` stream works unchanged.
- **TUI:** `tui.json` gains `token`. Env `SIGRUN_TOKEN` wins over it.
  Onboarding (§5.8) writes the token there. Workstation `run` stays
  loopback and unauthenticated.

### 5.5 Host and Origin checks (R2) — always on

- **Host.** On a loopback bind, `Host` must be `localhost`, `127.0.0.1`,
  or `[::1]` (any port) or listed in `server.auth.allowedHosts`, else 421.
  Non-loopback binds check `Host` only when `allowedHosts` is set.
- **Origin.** A non-GET/HEAD request carrying `Origin` must match the
  effective host or `server.auth.allowedOrigins`, else 403. The effective
  host is `X-Forwarded-Host` from a trusted proxy, else `Host`. Requests
  without `Origin` (curl, TUI) pass.
- No CORS plugin; cross-origin browser clients are unsupported.

### 5.6 Authorization

Admin is **configuration authority, not content authority**.

- **Admin-only routes:**
  - `PATCH /v1/settings` (it edits `extensions[]`, which is code
    execution at next boot);
  - user and invite management;
  - listing/revoking other users' tokens;
  - provider credential writes;
  - extension settings/secret writes.
- **Who is admin:**
  - a directory user with `admin: true` (the onboarding claimant is the
    first);
  - a proxy request whose groups intersect `server.auth.adminGroups`
    (per request; never written to the record);
  - the env service token;
  - every method-`none` principal.
- **Content access** — conversations, interactions, jobs, and
  extension-owned resources through §5.9 — follows ownership and sharing
  only. Admin grants no read of another user's private resources.
- **Hidden is 404.** A resource the principal cannot read is a 404 on
  every `:id` route and absent from lists, the events stream, the inbox,
  and notifications.
- **Method `none` with no `X-Sigrun-User`** is the local superuser and
  sees everything. This is the single-user loopback case.
- `/healthz` and `/readyz` are always public. `/metrics` requires a
  principal unless `server.metrics.public: true` (the chart sets `true`).
  Before claim, a non-public `/metrics` answers 403 `setup_required`,
  like every gated route.

### 5.7 Surrounding changes

- `GET /v1/auth/whoami` returns the principal. The webui shows the user,
  plus logout under the token method.
- Provider readiness moves from `/v1/auth/check` to `GET /v1/providers`,
  so `/v1/auth` is API auth only. The old path stays as a deprecated alias
  for one release.
- **Env:**
  - `SIGRUN_AUTH` (csv of `none`|`token`|`proxy`; `none` = empty list);
  - `SIGRUN_AUTH_TRUSTED_PROXIES` (csv CIDRs);
  - `SIGRUN_PROXY_SECRET`.

  Everything else lives under `server.auth` in the settings file. All of
  it is restart-required, like every `server.*` key.
- **OIDC seam:** an authenticator is `(request) => Principal | undefined
  | Promise<…>`. OIDC adds an `oidc` id (code flow + session cookie) with
  no route changes. Its claims map onto the same directory as proxy
  headers.

### 5.8 User directory and onboarding (user ruling)

**Directory.**

- Stored at `<configDir>/users.json`, mode 0600 (it holds emails). This
  is a new named config-root entry.
- Entries are `{user, name?, email?, admin, createdAt, source: "proxy" |
  "invite" | "cli"}`. `user` matches `^[a-z0-9][a-z0-9._-]*$` and is
  immutable.
- The directory is the identity source for owner stamping, share pickers
  (§5.9), and `host.users` (§9.7).

**States.** The server is **unclaimed** while the directory is empty, and
**claimed** after.

While unclaimed, the pipeline (§5.2) answers `403 {error:
"setup_required"}` on every non-public route. That includes extension
routes, even `public` ones. The env service token passes.

**Setup code.**

- Generated at each unclaimed boot (or pinned by `SIGRUN_SETUP_CODE`, for
  a k8s Secret).
- Logged once (`sigrun setup code: XXXX-XXXX`).
- Written to `<cacheDir>/setup-code` (0600):
  - the cache root is pod-local and never a backup section, so the code
    never lands in a backup;
  - `kubectl exec … cat` still retrieves it.
- Deleted at claim.
- It is the first **invite**. The claim accepts it exactly like an
  admin-issued invite code, except that it grants admin.

**Upgrades.** An existing deployment upgrades into the unclaimed state
and onboards. It never locks out: the gate precedes authentication (§5.2).
The chart README says so, and shows the commented `SIGRUN_API_TOKEN` /
`SIGRUN_PROXY_SECRET` Secret keys.

**Claim paths.** The first claimant becomes the first admin.

| arrival | flow |
|---|---|
| browser through the trusted proxy (`Remote-User` present) | The webui calls `GET /v1/onboarding` and gets `{state: "unclaimed", proxyIdentity: {user, name, email}}`. It shows a confirm screen ("Set up sigrun as Michael <email>?"). `POST /v1/onboarding/claim {}` creates the admin from the headers. **No setup code**: the trusted proxy already authenticated the person (user ruling). |
| browser, token-only deploy | The onboarding page asks for the setup code, username, name, and email. The claim creates the admin plus a token, and sets the `sigrun_session` cookie. |
| TUI `attach` to an unclaimed server | The TUI sees `setup_required` and prompts for the setup code, username, name, and email. The claim returns a token, which the TUI writes into `tui.json` (with `user` and `server`). |
| workstation `sigrun` (loopback, method `none`) | The TUI prompts for username, name, and email. No setup code: loopback is the trust. The claim writes the directory and `tui.json` `user`, and `X-Sigrun-User` carries it from then on. |

**API:**

- `GET /v1/onboarding` returns `{state, methods, codeRequired,
  proxyIdentity?}`.
- `POST /v1/onboarding/claim {code?, user?, name?, email?, issueToken?,
  tokenName?}` returns `{user, token?}`:
  - `code` is required unless the caller has a trusted proxy identity or
    the bind is loopback;
  - proxy claims take identity from the headers and ignore body identity
    fields;
  - `token` is returned when `issueToken: true`. The TUI always sends it;
    the token-only webui sends it and also receives the cookie;
  - claims are serialized on one in-process mutex, with the directory
    write atomic: one claimant wins and the rest get 409
    `already_claimed`.
- After claim:
  - a code-bearing claim works only with a valid invite (below);
  - a codeless proxy claim provisions a non-admin user (see
    auto-provisioning below).

**Later users:**

- **Proxy users** auto-provision on their first request when
  `server.auth.proxy.autoProvision` is `true` (the default).
  - The record's `admin` is always `false`; admin via groups stays
    per-request.
  - Name and email refresh from headers on each first request per
    process.
  - With `false`, an unknown proxy user gets 403 `user_not_provisioned`.
- **Invites:**
  - `POST /v1/users/invites {admin?: boolean, expiresIn?}` (admin) returns
    a one-time code, default expiry 7 days.
  - Stored hashed in `<stateDir>/invites.json` (0600) as `{id, sha256,
    admin, expiresAt, usedBy?}`.
  - Redemption runs under the claim mutex and marks `usedBy` atomically,
    so the code is single-use.
  - A new person runs `sigrun attach`, enters the code, then their
    identity. The claim returns their token.
- **Users API (admin):**
  - `GET /v1/users`;
  - `PATCH /v1/users/:user` (`name`, `email`, `admin`);
  - `DELETE /v1/users/:user?transferTo=<user>` (user ruling 9).
    - `transferTo` is required and must be another directory user.
    - The delete rewrites `owner` on every resource the departing user
      owns (conversations and jobs in core; extensions receive a
      `userDeleted {user, transferTo}` lifecycle event and transfer their
      own records).
    - It revokes their tokens and removes the record.
    - It reads no content: it is a configuration action.
- **Last admin:** demoting or deleting the last record-admin is a 409.
  Group-derived admins do not count: Authelia can revoke them at any
  moment.
- **CLI on the server host:** `sigrun user add <user> [--admin]` and
  `sigrun user list`.
  - They work while the server is down, for recovery.
  - Adding the first user this way claims the server. That is the
    intended recovery path, and the docs say so.

### 5.9 Sharing (user ruling: per-resource)

One core primitive, used by conversations and offered to extensions (a
kanban extension's personal and shared boards):

```ts
type Sharing =
  | { scope: "private" }                                   // default
  | { scope: "household"; level: "read" | "write" }       // every directory user
  | { scope: "people"; users: string[]; level: "read" | "write" };    // groups: deferred to OIDC (user ruling 10)

type Access = "none" | "read" | "write";
// accessOf(principal: Principal, { owner?, sharing? }) — owner → write; ownerless → household write; else per sharing
```

`accessOf` takes the whole principal, so adding group targets with OIDC
later is non-breaking.

**Conversations.**

- `SessionMeta` gains `sharing` (default private).
- **`owner` leaves the `PATCH …/meta` surface** (deepseek B1). Today it
  accepts any string or null (`session-meta.ts:237`), which would let a
  sharee seize ownership.
  - Owner is server-stamped only: at create, fork, import, job-run
    creation, and user-delete transfer.
  - A patch carrying `owner` is a 400.
  - Likewise `source` becomes server-only.
- **`sharing`** is patchable by the owner only (403 otherwise).
- **`name`, `pinned`, `tagged`, `archived`, `draft`** are patchable by
  `write` access.
- The webui's ⋯ menu offers private / household / people. The TUI gets
  `/share`.
- `read`: see the transcript and stream.
- `write`: also submit, answer interactions, configure, and fork. A fork
  is owned by the forker, private by default.
- **The agent acts as the conversation's owner** (tools,
  `host.identity.actingUser`, §9.7). Sharing with `write` therefore lets
  others drive the agent with the owner's identity. The share dialog says
  so, and household sharing defaults to `read`.

**Ownerless resources** (the root conversation, extension-created
resources with no owner) are household-write. The root conversation is
stamped with the claimant at onboarding, so it starts private to the
first admin.

**Extensions** get `accessOf` and the `Sharing` type through `host.access`
(§9.7). They store `owner` + `sharing` on their own records and call
`accessOf` on every read and write. The kanban extension builds its
boards on exactly this.

**Existing data:** no migration. The only conversations to date live in
temporary test DBs (user ruling).

---

## 6. W2 — Operational correctness

### 6.1 Readiness (R3)

`/readyz` = boot complete + a real storage read. Provider and memory
health leave readiness. They stay visible in `/v1/meta`, `/v1/providers`,
and `/metrics`. A degraded upstream is never a Service outage.

### 6.2 Uploads and import (R4)

- `server.maxUploadBytes`, default 64 MiB (env `SIGRUN_MAX_UPLOAD_BYTES`).
- New `PUT /v1/conversations/:id/uploads/:name` takes a raw
  `application/octet-stream` body, with route `bodyLimit` = the knob. The
  webui and TUI switch to it.
  - `:name` passes the same rule as today's body `name`: no `/` or `\`,
    not `.` or `..`, checked after percent-decoding.
  - It lands in the same `uploads/<conversationId>/` namespace.
  - It requires `write` access on the conversation.
- The base64 `POST …/uploads` stays for one release, with `bodyLimit` =
  ceil(knob × 4/3) + 4 KiB. `POST /v1/conversations/import` gets the same
  limit.
- Over the limit returns `413 {error: "too_large", maxBytes}`.

### 6.3 Workspace default (R5)

`DEFAULT_WORKSPACE_PATH` becomes `<dataDir>/workspace`. Chart and compose
set the path explicitly and are unaffected. Under §6.6 a default is never
persisted.

### 6.4 Host-module version guard (R6)

- `@earendil-works/chord` joins `HOST_RUNTIME_MODULES`.
- At load, for each extension, each host module's `package.json` is
  resolved from the extension entry's directory (what its own bare import
  gets) and compared with the host's copy:
  - `@earendil-works/pi-durable`: exact version equality, else
    **quarantine** naming both versions;
  - the others: same major, else quarantine; a minor difference warns.
- `ensureHostModuleLinks` warns when it leaves a real npm-installed copy
  whose version differs from the host's.
- Extension repos (follow-up, outside core): codemode, mcp,
  memory-markdown, and tool-search move pi-durable/pi-ai/chord to
  devDependencies + `"*"` peerDependencies (the provider plugins' shape)
  and rebuild `dist`.

### 6.5 Reserved section → quarantine (R11)

The reserved-key check moves from `boot.ts`'s post-install walk into the
loader's post-resolve validation (`resolvedFromFactory`). An offending
extension is then a **load-time** quarantine with the existing message:

- nothing is installed;
- no provider, seam host, health producer, event-bus, or worker binding
  is collected (deepseek S8 — `registry.uninstall` alone would leave
  those alive);
- boot continues.

The core-owned extensions install outside the loader and are unaffected.

### 6.6 Bootstrap writes intent, not defaults (R12)

- First boot writes only env-sourced values, plus `extensions` and
  `defaultModel` when env supplied them. Defaults are never persisted, so
  later releases' default changes reach existing installs.
- `GET /v1/settings` gains an `effective` block: the resolved server
  section with `source: "env" | "file" | "default"` per key. This
  generalizes the build spec's webui-key special case.
- This reverses "the file records reality" (user ruling 2026-10-19:
  only settings explicitly set via env land in `settings.json` on first
  boot).

### 6.7 Dead code and approvals touchpoints (R13, R14)

- **Delete the `submit` pass-through:** `ExtensionSubmit`,
  `submitBindings`, `memorySubmit`, and the submissions-route branch.
  - Precondition: sigrun-ext-memory-markdown has shipped the memory-seam
    port that drops its `submit` (memory-seam spec §T7).
  - Until then, the branch stays.
- **Delete `extensionsDir` / `SIGRUN_EXTENSIONS_DIR`.** It is parsed but
  never read. Accept it with a deprecation warning for one release, then
  make it a validation error.
- **Deprecate the named-export loader bridges** (`createMemory`, named
  `extension`):
  - for one release they load with a deprecation warning naming the
    package;
  - then they are deleted;
  - memory-markdown ships a default export first.

  The supported forms become a default-export factory or a default-export
  `Extension`.
- **Approvals touchpoints:**
  - README and `tools.ts` stop naming `sigrun-ext-approvals`;
  - `approvals-parity.test.ts` + `fixture-approvals` are renamed to what
    they test (the interaction seam's decide round-trip);
  - core keeps no approvals-specific code.
- **Rules the ask-user and warden ports rely on, each pinned by a test:**
  1. Interactions are answered only through the host/HTTP path. No core
     tool lets the model answer one.
  2. Answers record `answeredByUser` (the principal's `user`) next to
     `answeredBy`.
  3. Codemode's script-internal calls run `ToolTask` hooks as nested calls
     with `call.parent`. This is verified: pi-durable's codemode calls
     `api.executeTool`. The test catches an upgrade that opens a bypass.
- **README:** the `git:github.com/obra/superpowers` example stays until
  W5. The W5 README pass rewrites it as the skills-only example (§9.4).

### 6.8 Backup honesty (R15)

- `run-backup.ts` writes `<stateDir>/backup/last-success.json` (`{at,
  target, bytes}`) after success. The chart's CronJob already mounts the
  PVC and sets `SIGRUN_STATE_DIR`.
- `/v1/meta`:
  - `health.backup` is `"degraded"` when backup is configured and the
    marker is absent or older than `server.backup.staleAfterHours`
    (default 36);
  - a new `backup.lastSuccessAt` field reports the marker's time.
- S3 retention is a bucket lifecycle rule. The docs show one; the script
  does not prune S3.

### 6.9 Metrics (R19)

`GET /metrics` serves Prometheus text from in-process state:

- `sigrun_up`
- `sigrun_live_runs`
- `sigrun_inflight_submission_oldest_seconds` — from the event bus's
  admission clock. `SubmissionRecord` carries no timestamps, so a run
  admitted before a restart is invisible to this metric until it settles.
  That is acceptable for a wedge-while-up alarm; the upstream ask (§13)
  fixes it.
- `sigrun_tasks_live{status}` — from `harness.inspect()` (a Session-line
  read: scrape-rate only, never on a hot path)
- `sigrun_provider_ready{provider,status}`
- `sigrun_extensions{status}`
- `sigrun_backup_last_success_timestamp_seconds`
- `sigrun_job_last_run_timestamp_seconds{job,outcome}`
- `sigrun_job_next_run_timestamp_seconds{job}`

Chart changes:

- the ServiceMonitor moves from `/readyz` to `/metrics`;
- the PrometheusRule adds:
  - oldest submission > 30 min;
  - provider not ready > 15 min;
  - backup stale;
  - job failed.

### 6.10 Image (R16)

This lands after the build spec's Dockerfile changes.

- Run as the base image's `node` user (uid 1000):
  - `COPY --chown=node:node` for the app tree;
  - the chart sets `runAsNonRoot` and `fsGroup`.
- Install `git` (required by `git:` extension sources), `sqlite3`, and
  `ca-certificates`. Keep `tar`, which section backups need.
- Path-target backups can then use the sigrun image. S3 targets keep an
  awscli image.

### 6.11 Provider credential precedence (found while folding the reviews)

This is a live core bug. `authStoreCredentialStore`
(`providers/auth-bridge.ts:76-86`) returns `auth.json`'s `"default"`
entry **before** the provider's own entry, for every provider id. Any
deploy with a `"default"` key therefore hands that key to every plugin
provider (ollama, opencode, bifrost, …).

Fix (matching the README's documented meaning of `"default"`: "the
resolved default provider's key"):

- `"default"` applies only to the provider of the resolved default model:
  for it, the order stays `"default"` → own entry;
- every other provider reads only its own entry;
- the degenerate resolver (`providers/index.ts:353-359`) is already
  default-provider-only, by construction, and is unchanged;
- a regression test: a plugin provider that is not the default, holding
  its own entry plus a `"default"` entry, resolves its own; one with no
  entry of its own resolves nothing.

This ships first in W2; it does not wait for W0.

---

## 7. W3 — API shape

### 7.1 Async submit (R9)

- `POST …/submissions` returns `202 {submission}` at admission, with the
  admitted `SubmissionRecord`.
- `?waitMs=<n>` (capped at 60 000) waits up to that long for settlement,
  then returns the current record. This is for scripts.
- `GET /v1/conversations/:id/submissions/:submissionId` returns the
  record. `harness.submission(id)` returns a handle, so the route reads
  `submission.status(ctx)`.
- **Clients:**
  - the TUI is unchanged (fire-and-forget);
  - the webui composer's send guard must change. Today it serializes on
    `sending` staying true for the whole run (`Composer.tsx:589-596`).
    After this change it gates on `sending` (admission in flight) OR
    `steer.busy` from the view. While busy, a click is still a steer.
    This is a listed W3 client task.

### 7.2 Conversation list (R7)

- Summaries build from the scanned `ConversationRecord` + the
  `SessionMetaDoc` snapshot. No view reads.
- `entryCount` is removed. Verified: no production client reads it. It
  is required in `ConversationSummary` (`views.ts:128`), so the removal
  is wire-breaking; update the webui/TUI test fixtures that carry it.
- Only conversations the principal can read are listed (§5.6, §5.9).
- Each summary carries `owner`, `sharing`, and `access` (`read` |
  `write`), so clients can render shared items and disable the composer
  on read-only ones.
- Filters: `?archived=true|false` and `?mine=true` (owned by the
  caller).
- Paging is deferred (my call). With no view reads, household-scale counts
  (hundreds) cost one scan plus N doc snapshots.
- The webui's 10 s poll is deleted. §7.4 drives refreshes.

### 7.3 Delta view frames (R8; user ruling 11)

- The stream keeps `event: snapshot` (full view) on connect.
- Each later revision sends `event: delta`:

  ```jsonc
  { "entries": { "append": [/* records */], "remove": [/* ids */] },
    "docs": { "set": { "<kind>": {} }, "unset": ["<kind>"] },
    "conversation": {},  // present only when the record changed
    "steer": {}          // present only when it changed
  }
  ```

- The server diffs consecutive views per stream:
  - entries by id: committed entries are immutable, so there is no
    `replace`;
  - docs by kind, compared by reference then serialization.
- Streaming text lives in `pi.live`, so a streaming frame carries that
  one doc, whole. Delta-encoding the live doc's slot text is a follow-up,
  done only if measurements call for it.
- Both clients apply deltas through one shared reducer. It lives in the
  shared leaf, which is `@sigrun/shared` after the build spec.
- A client that loses sync reconnects and gets a fresh snapshot (today's
  reconnect contract, unchanged).
- The captured-schema fixture gains the delta shape.

### 7.4 Global events stream

`GET /v1/events` is one SSE stream per client, filtered by what the
caller can read (§5.9). Events (`event: <type>`, JSON data):

| type | data |
|---|---|
| `conversation.created` | summary |
| `conversation.changed` | `{id, …changed summary fields}` (name, archived, pinned, lastActivityAt, owner) |
| `run.admitted` | `{conversationId, submissionId}` |
| `run.settled` | `{conversationId, outcome: "answered" \| "unanswered", reason?}` |
| `interaction.pending` / `interaction.settled` | `{conversationId, callId, extension, kind, title?}` |
| `ambient.changed` | `{conversationId, extension, key}` |
| `job.changed` | job summary (§8.4) |
| `providers.changed` | `{provider, status}` |

- Sources: the event bus's commit reductions, extended with session-meta,
  interaction, and ambient doc changes; plus the job and provider
  trackers. No replay: a reconnecting client refetches what it shows.
- The webui sidebar refetches on `conversation.*`.
- The TUI's interaction and ambient polling is replaced by
  `interaction.*`/`ambient.changed` plus a refetch.
- This stream is the foundation for C2 browser notifications, a client
  feature that lands later.

### 7.5 Interactions inbox

- `GET /v1/interactions?status=pending` lists pending interactions across
  every visible conversation.
- Served from the existing session-singleton `InteractionsIndexDoc`
  (`interactions.ts:138`), which seed/answer/expire commits already
  maintain:
  - one snapshot at boot;
  - then commit-maintained (the same reductions as §7.4).

  No storage scan.
- This is how "answer the agent from my phone" works without opening each
  conversation.
- Answers still go through the per-conversation answer route.

### 7.6 Providers and credentials

- `GET /v1/providers`: per provider — readiness (today's auth-check
  derivation), model count, and owning extension. Merge collisions are
  carried in the build spec's `collisions` field.
- `POST /v1/providers/:id/refresh` runs one bounded refresh and returns
  readiness.
- `PUT /v1/providers/:id/credential {apiKey}` (admin) writes the
  provider's own `auth.json` entry, then refreshes. `DELETE` removes the
  entry.
  - The precedence fix in §6.11 is a prerequisite; otherwise a
    `"default"` entry shadows the write.
  - Writing the default model's provider's credential writes
    `"default"`, which takes precedence for that provider (§6.11).
- These are restart-free: the auth bridge resolves credentials per use.
  The builder verifies this against pi-ai's resolver. If a provider
  caches, the response says `restartRequired: true`.

### 7.7 Extension settings and secrets

These are the capture path that `docs/extending.md` promises and nothing
implements yet.

- `GET /v1/extensions`: loaded extensions, with outcome, declared seam
  kinds, workers, jobs, routes, commands, and `version` from the package
  manifest.
- `GET`/`PUT /v1/extensions/:slug/settings` (PUT is admin): the
  `settings/<slug>.json` object, stored verbatim. The response notes that
  values read at factory time apply at restart.
- `GET /v1/extensions/:slug/secrets` lists keys with `source: "stored" |
  "env"`. Values are never returned.
- `PUT /v1/extensions/:slug/secrets/:key {value}` and `DELETE` are admin
  only.
- The webui gains a raw JSON editor (settings) and a write-only key list
  (secrets) per extension. Declarative extension settings sections remain
  the separately deferred spec.

### 7.8 Files

- `GET …/files/raw?path=` serves the file with a sniffed content type.
  - It has its own cap, `server.maxFileReadBytes` (default 16 MiB): the
    agent writes workspace files, so nothing else bounds them.
  - Over the cap returns `413 file_too_large`.
  - It reads in chunks through `ExecutionEnv.openBinaryReader`, never
    `readBinaryFile`.
- The workspace is read-only through the API except the uploads
  namespace (core decision 25).

---

## 8. W4 — Jobs

### 8.1 Model

A job is a schedule plus an action, durable by construction:

- **One pi-durable task per job.** Each job is a long-lived **background**
  task of kind `sigrun.schedule` on the root conversation.
  - `background: true` excludes it from conversation aborts and idle
    waits (verified: `TaskOptions.background`).
  - The task loops `waiting(nextAt)` → `firing(fireAt)` → `waiting`,
    using `runtime.sleep(until)` (a durable wait over the harness clock).
  - Enumeration is `storage.scanTasks({kind: "sigrun.schedule"}, limit,
    cursor, ctx)`, filtered in memory to live statuses.
  - Deletion is `abortTask`.

  There is no separate job store. Terminal schedule records remain as
  tombstones; pi-durable has no task purge. That is accepted: growth is
  bounded by job churn.
- **Crash safety** (deepseek B3).
  - `firing` is a two-step phase on the task's own commits.
    1. One `runtime.commit` creates the run conversation (`tx`
       creation, with `SessionMeta` written by `ConversationInit` in the
       same commit) AND returns the next task state `{phase: "firing",
       fireAt, conversationId}`. The conversation and the record of it
       are atomic.
    2. The task submits into `conversationId` with `requestId =
       job:<id>:<fireAt>`, then commits `{phase: "waiting", nextAt}`.
  - A crash before step 1's commit re-runs step 1 (nothing was created).
  - A crash after it finds `conversationId` in state and goes straight
    to step 2, where the requestId dedups the submission.
  - Fixed-conversation actions skip step 1.
  - A kill -9 during `waiting` wakes once, at or after the deadline. This
    is the core spec's crash-battery item 7, now with a real subject.
- **Run status.** It lives in a keyed `JobStatusDoc(root, jobId)` holding
  `lastRun {at, outcome, conversationId?, error?}`.
  - Settlement is observed by an event-bus `runSettled` handler for run
    conversations carrying `meta.jobId`.
  - The schedule task never blocks on a run, so a run that waits hours on
    a human never stalls the next fire.

### 8.2 Schedules and actions

```jsonc
{
  "name": "morning-brief",
  "schedule": { "cron": "0 7 * * *", "timezone": "America/Toronto" }, // or { "every": "15m" } or { "at": "<ISO>" }
  "action": { "kind": "prompt", "prompt": "Summarize …", "model": "bifrost/glm-5.3-flash", "thinking": "low",
              "conversation": "new" },  // or a fixed conversation id
  "overlap": "skip",     // default; "queue" admits anyway (the conversation's inbox queues it)
  "catchUp": "once",     // default; "none" skips fires missed while down
  "enabled": true
}
```

- **`prompt` action.**
  - `conversation: "new"` creates a conversation per fire.
    - It is pi-durable `ownerless`, NOT task-owned, so the user can keep
      chatting in it and deleting the job never aborts it.
    - `SessionMeta`:
      - `owner` = the job's owner;
      - `sharing` = the job's `runSharing` (default private);
      - `source: "cron"`;
      - `jobId`;
      - name `<job> · <local date>`.
    - The auto-namer skips conversations whose `SessionMeta.source` is
      `"cron"`. Today it skips only task-owned ones (`boot.ts:711`), so
      this is a new rule.
  - A fixed id submits into that conversation. The action's `model` and
    `thinking` apply only to `conversation: "new"`; a fixed conversation
    keeps its own configuration.
  - `overlap: "skip"` records `skipped` when the previous run is still
    live.
- **`task` action.** `{kind: "task", task: "<registered task name>",
  input?}` creates that pi-durable task per fire, owned by the schedule
  task, so deleting the job cascades. The task must be registered by an
  installed extension (`Extension.tasks`). Otherwise the job's `state` is
  `blocked`, with the reason.
- **Timezone** defaults to `server.timezone` (default: the process TZ).
- **Cron parsing** uses `croner` (zero-dependency, TZ/DST-correct). My
  call: DST is exactly the class of bug not to hand-roll.

### 8.3 Sources

| source | where | id | mutable via API |
|---|---|---|---|
| `api` | `POST /v1/jobs` | `api:<uuid>` | yes (owner or admin) |
| `file` | settings.json `jobs[]` | `file:<name>` | no — edit the file |
| `extension` | factory result `jobs[]` | `ext:<slug>:<name>` | no |

- Boot reconciles declared jobs (file + extension) into tasks:
  - missing → create;
  - spec hash changed → abort + recreate;
  - undeclared → abort.
- `api` jobs are never touched by reconciliation.
- A declared job's `enabled` flips only at its source.
- **Ownership and visibility.** Jobs carry `owner` + `sharing` and use
  §5.9's `accessOf`.
  - `api` jobs are owned by their creator.
  - `file` jobs declare `owner` (a directory user). Without one they are
    ownerless, and therefore **household-write**, like every ownerless
    resource: any directory user can see them and run them now, and their
    run conversations are ownerless and household-write too. To keep a
    system job private, declare an `owner`.
  - `extension` jobs follow the same rule, with `owner` set by the
    extension or absent.
- A job runs as its owner: prompt runs stamp that owner, and task runs
  see it via `host.identity`. An ownerless job's runs stamp no owner.
- When a user is deleted, their jobs transfer with their other resources
  (§5.8).

### 8.4 API

- `GET /v1/jobs` returns `[{id, name, source, owner?, schedule, action,
  enabled, state, nextRun, lastRun, lastError}]`. This is spec B's pinned
  shape plus `id`, `source`, `owner`, `action`, and `enabled`. `state` is
  `waiting` | `firing` | `disabled` | `blocked`.
- `POST /v1/jobs` creates a job owned by the caller.
- `PATCH /v1/jobs/:id` and `DELETE /v1/jobs/:id`:
  - work on `api` jobs only (others return 409 `job_declared`);
  - need `write` access (the owner, or a `write` share).
- `POST /v1/jobs/:id/run` fires now and honors `overlap`. It requires
  `write` access on the job. It is also the hook for external triggers
  (Alertmanager, CI) using a token. No generic webhook endpoint exists.
- The webui gains a read-only jobs panel with run-now. The TUI gains a
  `/jobs` command listing them.
- The memory seam's idle workers stay as they are: in-process,
  best-effort, no API. Jobs are the durable, user-visible scheduler.

---

## 9. W5 — Extension integration points

Every new factory-result field follows the existing pathway:

- validated in `resolvedFromFactory` (a malformed field quarantines);
- collected with the slug identity;
- exposed on `OpenedHarness`;
- listed in `GET /v1/extensions`.

Host-bound APIs bind lazily post-open, like the interaction/ambient
seams. They are callable from tools, hooks, routes, commands, workers and
jobs, never from a factory body.

The lifecycle handler set (memory seam) gains `userDeleted {user,
transferTo}`. Extensions that own per-user records transfer them in that
handler (§5.8).

### 9.1 One documented contract type

- `sigrun` exports a types-only subpath `sigrun/extension`: one
  `SigrunExtensionResult` interface covering every field, plus
  `SigrunHost`. This follows the types-in-main-package ruling (2026-10-13);
  there is no separate contract package.
- Authors import it with `import type`, so nothing loads at runtime.
- `docs/extending.md` gains one table of every field.
- The `factory.length > 0` host gate stays (defaulted first parameters
  rely on it). The docs state the rule: the first parameter is the host,
  never a defaulted options object.

### 9.2 Extension HTTP routes

```ts
routes?: readonly {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;                       // relative; mounted at /v1/ext/<slug>/<path>
  auth: "user" | "admin" | "public";
  bodyLimit?: number;                 // default 1 MiB
  handler(request: Request, ctx: { principal?: Principal; host: SigrunHost }): Promise<Response>;
}[]
```

- The handler uses web-standard `Request`/`Response` (Node ≥ 22). No
  Fastify type crosses the contract.
- `public` routes skip authentication and are for webhooks and OAuth
  callbacks. The handler verifies its own caller (signature, `state`).
- New `server.publicUrl` (env `SIGRUN_PUBLIC_URL`) gives extensions and
  notifications an absolute base URL for redirect URIs and deep links.
- The first consumer: `sigrun-ext-mcp`'s OAuth callback moves from the
  loopback listener + stdin paste to `/v1/ext/mcp/oauth/callback`
  (follow-up in that repo). This makes OAuth usable from the webui in a
  pod.

### 9.3 Extension slash commands

```ts
commands?: readonly {
  name: string; description: string; args?: string;
  run(ctx: { conversationId: ConversationId; args: string; principal: Principal; host: SigrunHost }):
    Promise<{ notice?: string } | void>;
}[]
```

- Listed in `GET /v1/commands` with `extension: <slug>` and endpoint
  `POST /v1/conversations/:id/commands/:name {args}`. The endpoint
  requires `write` access on the conversation.
- Core command names are reserved: a colliding extension command is
  dropped with a warning. Collisions between extensions are last-wins
  with a warning, recorded in `collisions` (the provider shape).
- `notice` renders as a transient client message. Durable effects go
  through `host.conversations` (§9.5).

### 9.4 Skills from packages and a user skills dir

- **Discovery** adds two roots to the workspace's `skills/`:
  - `<configDir>/skills/` — a user-wide root, a new named config-root
    entry;
  - **package skills**, found by any of:
    - a manifest `sigrun.skills` (array of paths);
    - pi-compat `pi.skills` (the same SKILL.md format, so no warning);
    - a factory-result `skills` (array of absolute dirs).
- A package whose manifest declares skills and has NO loadable entry is a
  valid **skills-only** package: loaded, outcome `ok`, not quarantined.
  - A pi `pi.extensions` module in it is skipped with one warning. This
    makes `git:github.com/obra/superpowers` load its skills.
  - The loader distinguishes three cases. The build spec has removed the
    `index.ts` fallback, so "no entry" has these meanings:
    - "declares skills, no entry" → ok;
    - "declares an entry that does not resolve" → quarantine;
    - "declares neither" → quarantine.
- **Precedence:** workspace > user > packages (install order). A name
  collision keeps the higher root and logs.
- `load_skill` reads package/user skills from the host filesystem and
  workspace skills through the env, as today. Under a future remote
  workspace the two sources differ in location. That is intended:
  user/package skills belong to the deployment, workspace skills to the
  workspace.
- The section cap stays 4 KB, configurable as `skills.sectionMaxBytes`
  (live setting).

### 9.5 Host conversation API

`host.conversations` lets channel extensions (Discord/Telegram/Signal
bridges) and jobs drive conversations in-process without calling
sigrun's own HTTP API:

```ts
create(opts: { owner?: string; sharing?: Sharing; name?: string; source?: string }): Promise<ConversationId>;
submit(id, input: SubmissionInputPart[], opts?: { user?: string; requestId?: string; whenBusy?: WhenBusyMode }): Promise<SubmissionRecord>;
watch(id, listener: (view: ConversationViewWire) => void): Promise<() => Promise<void>>;
list(opts?: { owner?: string; archived?: boolean }): Promise<ConversationSummary[]>;
meta(id): Promise<SessionMeta>;
```

- Extensions are trusted in-process code: they may act for any user, and
  the docs say so. Mapping a channel's users to sigrun users is the
  extension's own config.
- `SessionMeta.source` widens from `"user" | "cron"` to a string.
  - It is server-stamped: `"user"` for HTTP creates and `"cron"` for job
    runs;
  - `host.conversations.create` stamps the caller's `source`, defaulting
    to the extension slug.
- `submit` runs the same path as the HTTP route: content-part resolution,
  served-model check, activity stamp.

### 9.6 Notifications

```ts
notifiers?: readonly { name: string; notify(event: NotificationEvent, ctx: { host: SigrunHost }): Promise<void> }[]
```

- **Core emits:**
  - `interaction.pending` (always);
  - `job.failed` (always);
  - `run.settled` per `notifications.runSettled`:
    - `"unwatched"` (default): only when no client stream is attached to
      the conversation — the away-from-desk case;
    - `"cron"`;
    - `"always"`;
    - `"never"`.
- **Each event carries** `{type, conversationId, user (owner), title,
  body, url?}`. `url` is built from `server.publicUrl` and omitted when
  that is unset.
- **Delivery** runs on the event bus side lane: deadline-bounded,
  best-effort, errors logged. It is never retried durably, because that is
  a notifier's own concern.
- **Extensions implement transports** (ntfy, Signal, web push). Core ships
  none.
- **Recipients.** Each event goes to the resource's owner. For
  `interaction.pending`, it also goes to every user with `write` access,
  since any of them can answer.

### 9.7 Identity and access for extensions

```ts
host.users: { list(): Promise<DirectoryUser[]>; get(user: string): Promise<DirectoryUser | undefined> };
host.access: { accessOf(principal: Principal | { user: string }, resource: { owner?: string; sharing?: Sharing }): Promise<Access> };
host.identity: { actingUser(conversationId: ConversationId): Promise<string | undefined> }; // the conversation owner
```

- An extension's tools call `host.identity.actingUser(api.conversationId)`
  to learn who the agent acts for, then `host.access.accessOf` on their
  own records.
- Extension HTTP routes get the caller's `principal` directly (§9.2).
- This is the whole sharing contract for extension resources. Core
  stores nothing for them.

---

## 10. Tests

Each item lands with its failing-first test. The load-bearing ones:

- **W1:**
  - an unclaimed server answers `setup_required` everywhere except the
    public routes, while the env token still works;
  - the pipeline order: a non-onboarding request to an unclaimed
    token-only server gets 403 `setup_required`, never 401;
  - `POST /v1/auth/login` is reachable without a credential, and failed
    attempts are delayed and then 429;
  - a trusted-proxy first claim needs no code and creates an admin from
    headers;
  - with `secretHeader` set, a trusted peer without the secret is not
    proxy-authed;
  - a token-only claim requires the setup code and returns a token when
    `issueToken`;
  - the setup code lives under the cache root, never the state root;
  - a loopback claim needs no code;
  - concurrent claims → exactly one winner (409 for the rest);
  - invite codes are single-use (concurrent redemption → one winner) and
    expire;
  - demoting the last record-admin → 409, and group admins don't count;
  - proxy auto-provisioning creates non-admins, and `autoProvision: false`
    gives 403;
  - `DELETE /v1/users/:u` without `transferTo` is a 400. With it,
    conversations and jobs transfer and extensions receive `userDeleted`;
  - an admin cannot create a token for another user (403);
  - a CLI revoke is honored by a running server without a restart;
  - the env token is not a directory user and does not claim the server;
  - explicit `methods: []` boots with the warning;
  - proxy headers from an untrusted peer are ignored, and a trusted peer
    sets owner/admin (with admin via groups);
  - `X-Sigrun-User` is ignored under token;
  - token hash comparison works and plaintext is never stored;
  - cookie login works for SSE (the e2e test pins the browser's
    same-origin `EventSource` cookie behavior);
  - Host 421 on loopback and a cross-site Origin POST 403;
  - a private conversation 404s for another user (including an admin) on
    every `:id` route, the list, events, the inbox, and notifications;
  - a household-`read` share allows the stream and rejects submit (403);
  - a `write` share allows submit and interaction answers;
  - a `write` sharee's `PATCH …/meta {owner}` is 400, `{sharing}` is 403,
    and `{name}` succeeds;
  - a fork by a sharee is owned by the sharee and private;
  - `accessOf` matrix (owner, ownerless, household, people, read vs
    write);
  - admin-only routes 403 for non-admins.
- **W2:**
  - a plugin provider with its own `auth.json` entry plus a `"default"`
    entry resolves its own (§6.11);
  - `/readyz` stays 200 with a degraded provider;
  - an 8 MB raw upload succeeds and the knob returns 413;
  - a `PUT …/uploads/%2e%2e%2fx` is a 400;
  - a fresh workstation boot with no env succeeds;
  - an extension resolving another pi-durable version is quarantined
    naming both;
  - a reserved section key quarantines at load: no provider, worker, or
    seam binding survives, and boot continues;
  - bootstrap with no env writes no server defaults;
  - a nested codemode call reaches a `beforeTool` hook with `call.parent`;
  - the backup marker drives `health.backup`;
  - the `/metrics` exposition parses.
- **W3:**
  - submit returns before settlement and `waitMs` works;
  - the webui composer still serializes sends and still steers while busy;
  - delta frames reproduce the full view (property test: fold(snapshot,
    deltas) ≡ the latest view);
  - the events stream emits per type and respects scope;
  - the inbox is rebuilt from `InteractionsIndexDoc` after a restart;
  - a credential PUT flips readiness without restart;
  - `files/raw` over `maxFileReadBytes` is a 413.
- **W4:**
  - kill -9 mid-`waiting` → exactly one fire after the deadline;
  - kill -9 after the step-1 commit of `firing` → one run conversation
    and one submission;
  - kill -9 before it → one run conversation and no orphan;
  - cron run conversations are not auto-named;
  - run-now without `write` → 403;
  - a deleted job is absent from `GET /v1/jobs` (tombstone filtered);
  - `overlap: "skip"` records `skipped`;
  - `catchUp: "once"` fires once after downtime;
  - reconciliation creates/replaces/aborts declared jobs and leaves `api`
    jobs alone;
  - a DST-boundary cron fires at the right wall-clock time.
- **W5:**
  - a public route skips auth while a user route requires it;
  - Request/Response round-trip;
  - a command collision with a core name is dropped, and invoking a
    command without `write` → 403;
  - a skills-only package loads (superpowers fixture shape), and a
    package whose declared entry does not resolve quarantines;
  - skill precedence;
  - `host.conversations.submit` stamps owner and appears in the list;
  - the `unwatched` notifier fires only with no stream attached.

The suite, typecheck, the webui/TUI suites, and e2e stay green per
workstream (AGENTS.md verification rule).

## 11. Open questions

None outstanding. Rulings 5–11 answered the draft and review questions.

## 11a. Review disposition

Reviewed by deepseek-v4.1-flash (BLOCK) and glm-5.3-flash (OK with
notes). Artifacts are in `docs/superpowers/specs/reviews/` with the
`2026-10-19-core-hardening-review-*` names. Every blocker was folded:

- **owner patchable** → §5.9;
- **pod-CIDR proxy trust** → §5.3 + ruling 8;
- **jobs crash safety** → §8.1's atomic step 1;
- **pipeline order** → §5.2;
- **group sharing** → cut, ruling 10;
- **deleted users' content** → transfer, ruling 9;
- **admin minting tokens for others** → §5.4.

Should-fixes folded:

- `files/raw` cap;
- the composer guard;
- inbox from `InteractionsIndexDoc`;
- tombstone filtering;
- auto-namer cron skip;
- run-now and command access;
- reserved-key check in the loader;
- credential precedence (§6.11, a live bug);
- the env token as a service principal;
- setup code under cache;
- the upgrade note;
- `PUT` upload validation;
- `replace` dropped from deltas;
- read-only except uploads;
- the invite store and the `issueToken` flag;
- group admins vs the last-admin rule;
- live store reloads;
- the submit-deletion precondition and the bridge deprecation release;
- loader skills-only vs broken entry;
- W0 keeping the build spec's meta behavior.

Nits folded:

- the `accessOf` signature;
- `/metrics` pre-claim;
- `url` omitted without `publicUrl`;
- the `scanTasks` arguments;
- `harness.submission` returning a handle;
- the `entryCount` fixtures;
- the metric restart caveat;
- `COPY --chown` + `tar`, with `curl` dropped;
- CLI-first-user claims;
- remote-workspace skills;
- the superpowers README timing.

**Not taken:** deferring `allowedHosts` on non-loopback binds. It is one
optional key and costs nothing when unset.

## 12. Non-goals and anti-goals

**Non-goals:**

- OIDC login (seam only, §5.7);
- workspace editing via the API (decision 25);
- OpenAPI generation (ruling 9 of the config-surfaces spec);
- cross-conversation search (a memory-extension concern);
- conversation deletion (pi-durable has no deletion API — upstream ask
  below; archive remains);
- per-conversation extension selection (C6b);
- declarative extension settings UI (its own deferred spec);
- encryption at rest for `secrets.json` / `api-tokens.json` /
  `users.json`;
- a password store (identity is proxy headers, tokens, or later OIDC —
  never a sigrun password);
- migrating existing conversations into the ownership/sharing model (test
  DBs only);
- every product extension (honcho, research, Forgejo, Discord, calendar,
  ask-user, warden).

**Anti-goals:**

- auth that silently falls open on a non-loopback bind;
- any model-callable path that answers an interaction or edits settings;
- Fastify types leaking into the extension contract;
- core growing provider, memory, or notification-transport code.

## 13. Upstream asks (pi-durable)

- Conversation deletion/purge in `Storage` and `Harness`.
- Timestamps on `SubmissionRecord` (admission/settle), so wedge metrics
  survive restart.
- The `runSettled` hook draft from the memory-seam spec (unchanged).

## Decisions ledger

**User rulings (2026-10-19):**

1. Approvals extension excluded; ask-user and warden ports replace it.
   Core keeps only seam guarantees (§6.7).
2. Bearer-token auth by default on a non-loopback bind, overridable in
   config.
3. Authelia forward-auth headers set the principal/owner before OIDC
   exists. OIDC comes later.
4. Jobs/tasks are core. Product extensions are out of scope.
5. First boot writes only settings explicitly set via env to
   `settings.json` (§6.6).
6. Resource sharing is per-resource (⋯ menu), core-provided, and usable
   by extensions such as a kanban with personal and shared boards (§5.9).
   Existing conversations need no migration.
7. First-user onboarding (§5.8):
   - a browser arriving with `Remote-User`/`Remote-Email` claims from the
     headers;
   - a TUI prompts for identity;
   - the claimant becomes the first admin.
8. Proxy trust = `trustedProxies` CIDR plus an optional shared-secret
   header (§5.3).
9. Deleting a user requires transferring their resources to another user
   (§5.8).
10. Group sharing is cut until OIDC supplies groups (§5.9).
11. Streaming uses simplified delta frames: entry append/remove plus
    changed docs (§7.3).

**My calls (check while reading):**

- cookie session for browser token login;
- SHA-256-hashed token file;
- setup code (logged + `<cacheDir>/setup-code`) gating non-proxy,
  non-loopback claims, and generalized into hashed single-use invite
  codes for later users;
- admins list/revoke but never create other users' tokens;
- the env token is a service principal outside the directory;
- `/v1/auth/login` failure delay + 429;
- proxy users auto-provision as non-admin by default;
- `users.json` in the config root, with admin as a user property (tokens
  inherit it);
- admin is configuration authority, not content authority (no admin
  read of private resources);
- the agent acts as the conversation owner, and household shares default
  to `read`;
- ownerless resources are household-write, and the root conversation is
  stamped to the claimant;
- Host/Origin checks always on, with no CORS;
- `/v1/auth/check` → `/v1/providers`;
- the readiness = storage-only rule;
- raw-body uploads, with a 64 MiB default knob;
- the exact pi-durable version guard;
- reserved-key quarantine instead of abort;
- paging deferred;
- delta frames by entry id / doc kind;
- jobs as background pi-durable tasks on the root conversation, plus a
  status doc;
- `croner` for cron;
- prompt-job conversations not task-owned (continuable, survive job
  deletion), owned by the job owner;
- `file:`/`ext:` jobs immutable via the API;
- web-standard Request/Response for routes;
- skills precedence workspace > user > package, and skills-only packages;
- the `run.settled` `unwatched` default.
