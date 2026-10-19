# W1 — Identity and access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open-API hole: token and forward-auth authentication, Host/Origin checks, first-user onboarding, a user directory with invites, admin as configuration-only authority, and per-resource sharing for conversations.

**Architecture:**
- One `onRequest` pipeline (`src/server/auth/pipeline.ts`) runs the spec's fixed six stages and sets `request.principal`.
- File-backed identity stores (`src/harness/identity/`) hold users, tokens, and invites. The pipeline and the CLI share them, and the stores reload on mtime change.
- Content access is one pure function, `accessOf` in `@sigrun/shared/access`. W0's `loadConversation` pre-handler and the list route enforce it.

**Tech Stack:** TypeScript (NodeNext), Fastify 5 (`app.inject({ remoteAddress })` in tests), `node:crypto` (`randomBytes`, `createHash`, `timingSafeEqual`), `node:net` `BlockList` for CIDR matching, `node:readline/promises` for CLI prompts, vitest, React (webui).

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` §5 (all subsections), plus the §10 W1 tests and rulings 2, 3, 6–10.

**Depends on:** W0 merged (`src/server/routes/*`, `ServerContext`, `loadConversation`).

## Global Constraints

- **Pipeline order, fixed:**
  1. Host/Origin;
  2. public routes;
  3. env service token;
  4. unclaimed gate;
  5. authenticate;
  6. authorize.
- **Responses:**
  - `401 {error:"unauthenticated"}`;
  - `403 {error:"setup_required"}`;
  - `403 {error:"forbidden"}` for an admin-only or write-on-read route;
  - `421` for a bad Host;
  - `403 {error:"origin_mismatch"}` for a bad Origin;
  - `429 {error:"rate_limited"}`;
  - a hidden resource is `404 conversation_not_found` (never 403).
- **Default methods:**
  - `[]` when the listen host is loopback (`127.0.0.0/8`, `::1`, `localhost`);
  - `["token"]` otherwise;
  - an explicit value always wins;
  - an explicit `[]` on a non-loopback bind logs ONE line: `sigrun: WARNING authentication disabled on a non-loopback bind (server.auth.methods = [])`.
- **Files (mode 0600, atomic via `writeFileAtomic` from `src/harness/stores.ts`):**
  - `<configDir>/users.json`;
  - `<configDir>/api-tokens.json`;
  - `<stateDir>/invites.json`;
  - `<cacheDir>/setup-code`.

  Stores reload when the file's mtime changes, checked per access.
- **Tokens:**
  - `sgr_` + base64url(32 random bytes);
  - stored as SHA-256 hex;
  - compared with `timingSafeEqual` on equal-length digests.
- **Setup code:** `XXXX-XXXX` from the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; `SIGRUN_SETUP_CODE` pins it.
- **Invites:** default expiry 7 days (604 800 000 ms); single-use.
- **Username rule:** `^[a-z0-9][a-z0-9._-]*$`.
- **Login limit:**
  - each failed `POST /v1/auth/login` waits 1 000 ms before answering;
  - 10 failures per peer IP within 10 minutes → 429 for 10 minutes;
  - kept in memory.
- **Proxy defaults:** header names `Remote-User` / `Remote-Groups` (comma-separated) / `Remote-Name` / `Remote-Email`; `autoProvision: true`.
- **Proxy-range warning:** boot warns when a `trustedProxies` entry is shorter than /24 (IPv4) or /64 (IPv6) and no `secretHeader` is set.
- **Admin:**
  - the record's `admin` OR proxy groups ∩ `adminGroups` (per request, never persisted);
  - the env token is admin;
  - method `none` is admin.

  Admin never grants content access.
- **Env service token:** its principal is `{user: SIGRUN_API_TOKEN_USER ?? "sigrun", admin: true, service: true, method: "token"}`. It is NOT a directory user and does not claim the server. **For content access it is a superuser** (my call, recorded here: it is the operator's root credential, needed for automation such as run-now on any job).
- **Tests own their literals:** `example.invalid` hosts, `acme`/`alice`/`bob` users, `sk-`/`sgr_test…` placeholders.
- **Verification:** per task `npm test` + `npm run typecheck`; plus `npm run typecheck:webui` + webui tests (`npm --workspace @sigrun/webui test`) in Task 8; plus the TUI suite (`npm --workspace @sigrun/tui test`) in Task 7.

## Review Focus

1. **IPv4-mapped IPv6 peers.** Behind dual-stack Node, a v4 proxy can arrive as `::ffff:10.42.1.5`. `trustedProxies: ["10.42.0.0/16"]` must match it. `ipAllowed()` normalizes mapped addresses before `BlockList.check`. Test in Task 3.
2. **The proxy secret header leaking to handlers or logs.** It is stripped from `request.headers` in the pipeline. The test asserts a handler-visible copy is absent.
3. **Fork inherits `sharing` and `owner`.** The SessionMeta doc copies with `fork: "current"`, so the fork route must reset `sharing` to private and set `owner` to the forker (or delete it under a user-less `none` principal). Test in Task 5.
4. **Clock-skewed invites.** Expiry compares `Date.now()` against a stored epoch-ms `expiresAt`. A redeemed-then-expired invite stays used; it is never "re-openable". Test in Task 2.
5. **CLI and server writing `users.json` concurrently.** Both use atomic temp+rename writes. Read-modify-write races last-writer-wins, which is accepted at household scale. The mtime reload must not serve a half-written file: rename is atomic. Task 2's store test writes from a second store instance and asserts the first sees it.

---

### Task 1: Auth config surface

**Files:**
- Modify: `shared/src/settings.ts`. `ServerSettings` gains:
  ```ts
  readonly auth?: {
    readonly methods?: readonly ("token" | "proxy")[];
    readonly proxy?: { readonly trustedProxies?: readonly string[]; readonly secretHeader?: string;
      readonly userHeader?: string; readonly groupsHeader?: string; readonly nameHeader?: string;
      readonly emailHeader?: string; readonly autoProvision?: boolean };
    readonly adminGroups?: readonly string[];
    readonly allowedHosts?: readonly string[];
    readonly allowedOrigins?: readonly string[];
  };
  readonly metrics?: { readonly public?: boolean };
  ```
- Modify: `src/harness/settings.ts`:
  - `validateServer` accepts `auth` and `metrics`, with nested `checkKeys` for `server.auth.`, `server.auth.proxy.`, `server.metrics.`;
  - `update()` gains second-level sub-merges for `auth` (with `auth.proxy` a third-level merge) and `metrics`, mirroring the `webui` branch at `settings.ts:~776`.
- Modify: `src/config.ts`:
  - new `AuthConfig` on `SigrunConfig` (`auth: AuthConfig`, `metricsPublic: boolean`);
  - env parsing `SIGRUN_AUTH`, `SIGRUN_AUTH_TRUSTED_PROXIES`, `SIGRUN_PROXY_SECRET`;
  - `resolvedServerSection` omits `auth`/`metrics` when defaulted (the `webui` pattern).
- Create: `src/server/auth/loopback.ts`, holding `isLoopbackHost(host: string): boolean`.
- Test: `test/auth-config.test.ts` (new).

**Interfaces:**
- Produces:
  ```ts
  export interface AuthConfig {
    methods: readonly ("token" | "proxy")[] | undefined; // undefined = derive from listen host
    proxy: { trustedProxies: readonly string[]; secretHeader?: string; secret?: string;
      userHeader: string; groupsHeader: string; nameHeader: string; emailHeader: string; autoProvision: boolean };
    adminGroups: readonly string[];
    allowedHosts?: readonly string[];
    allowedOrigins?: readonly string[];
    serviceToken?: { token: string; user: string }; // SIGRUN_API_TOKEN (+ SIGRUN_API_TOKEN_USER, default "sigrun"); env-only
  }
  export function effectiveMethods(auth: AuthConfig, listenHost: string): readonly ("token" | "proxy")[];
  ```
- `SigrunConfig.metricsPublic: boolean` comes from file `server.metrics.public`, or env `SIGRUN_METRICS_PUBLIC`, parsed strictly as `true`/`false` (the `SIGRUN_WEBUI` pattern). Default `false`.
- `SIGRUN_AUTH` parses:
  - csv of `token`/`proxy`;
  - `none` alone = `[]`;
  - empty = unset;
  - anything else fails loud naming the value (the `parseCompactionEnabled` pattern).
- `SIGRUN_PROXY_SECRET` → `proxy.secret`. It is env-only; `validateServer` rejects a `secret` key in the file.

- [ ] **Step 1: Write failing tests** in `test/auth-config.test.ts`:
  - `effectiveMethods(defaults, "127.0.0.1")` → `[]`; `"0.0.0.0"` → `["token"]`; `"::1"` → `[]`;
  - explicit `methods: []` on `"0.0.0.0"` → `[]`;
  - `loadConfig({SIGRUN_AUTH: "proxy,token", SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16,fd00:42::/56", …})`: `auth.methods` equals `["proxy","token"]` and `trustedProxies` both CIDRs;
  - `SIGRUN_AUTH: "none"` → `[]`; `SIGRUN_AUTH: "basic"` throws `/SIGRUN_AUTH/`;
  - `methods` containing `"proxy"` with empty `trustedProxies` throws `/trustedProxies/`;
  - settings `PATCH {server:{auth:{proxy:{autoProvision:false}}}}` keeps a previously stored `trustedProxies`;
  - a file `server.auth.proxy.secret` key fails validation with field `server.auth.proxy.secret`;
  - `resolvedServerSection(loadConfig(minimalEnv))` has no `auth` key.
- [ ] **Step 2: Run** `npx vitest run test/auth-config.test.ts`. Expected: FAIL (`effectiveMethods` not exported; unknown key `auth`).
- [ ] **Step 3: Implement** the types, parsing, validation, sub-merge, and `isLoopbackHost`. Defaults are the Global Constraints values.
- [ ] **Step 4: Run** `npx vitest run test/auth-config.test.ts test/settings.test.ts test/config.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "auth: server.auth config surface (methods, proxy, admin groups, hosts) + env parsing"`.

### Task 2: Identity stores

**Files:**
- Create: `src/harness/identity/users.ts`, `tokens.ts`, `invites.ts`, `setup-code.ts`, `json-store.ts` (the shared mtime-reloading JSON file helper), and `index.ts`.
- Modify: `src/harness/boot.ts`. Construct `IdentityStores` from the resolved roots and expose them as `OpenedHarness.identity`.
- Modify: `docs/extending.md`. The "config root's other top-level entries" bullet names `users.json` and `api-tokens.json`.
- Test: `test/identity-stores.test.ts` (new).

**Interfaces:**
- Produces:
  ```ts
  // users.ts
  export interface DirectoryUser { readonly user: string; readonly name?: string; readonly email?: string;
    readonly admin: boolean; readonly createdAt: number; readonly source: "proxy" | "invite" | "cli" }
  export class UserDirectory { constructor(path: string);
    list(): DirectoryUser[]; get(user: string): DirectoryUser | undefined; isClaimed(): boolean;
    add(user: Omit<DirectoryUser, "createdAt">): Promise<DirectoryUser>;        // throws on duplicate / bad username
    update(user: string, patch: { name?: string; email?: string; admin?: boolean }): Promise<DirectoryUser>;
    remove(user: string): Promise<void>; recordAdminCount(): number }
  // tokens.ts
  export interface TokenRecord { readonly id: string; readonly name: string; readonly user: string;
    readonly sha256: string; readonly createdAt: number }
  export function generateToken(): string;            // "sgr_" + base64url(32)
  export function hashToken(token: string): string;   // sha256 hex
  export class TokenStore { constructor(path: string);
    create(name: string, user: string): Promise<{ record: TokenRecord; token: string }>;
    list(user?: string): TokenRecord[]; revoke(id: string): Promise<boolean>;
    revokeAllFor(user: string): Promise<number>; verify(token: string): TokenRecord | undefined }
  // invites.ts
  export interface InviteRecord { readonly id: string; readonly sha256: string; readonly admin: boolean;
    readonly expiresAt: number; readonly usedBy?: string }
  export class InviteStore { constructor(path: string);
    create(opts: { admin: boolean; expiresInMs?: number }): Promise<{ id: string; code: string }>;
    redeem(code: string, user: string, now?: number): Promise<{ admin: boolean } | undefined> }
  // setup-code.ts
  export function ensureSetupCode(cacheDir: string, env: Env): Promise<string>; // pins SIGRUN_SETUP_CODE
  export function readSetupCode(cacheDir: string): string | undefined;
  export function clearSetupCode(cacheDir: string): Promise<void>;
  // index.ts
  export interface IdentityStores { readonly users: UserDirectory; readonly tokens: TokenStore;
    readonly invites: InviteStore; readonly cacheDir: string }
  export function openIdentityStores(roots: StoreRoots): IdentityStores;
  ```
- The setup code is NOT an `InviteStore` row: it is compared directly. "The first invite" is a behavioral equivalence (it admits one admin claim).

- [ ] **Step 1: Write failing tests** in `test/identity-stores.test.ts` (tmp dirs only):
  - `add` then `get` round-trips;
  - `add({user:"Alice"…})` throws `/username/`;
  - a duplicate add throws;
  - `isClaimed()` is false until the first add;
  - file mode is `0o600` (`statSync(path).mode & 0o777`);
  - a second `UserDirectory` on the same path sees an add made by the first (mtime reload);
  - `generateToken()` matches `/^sgr_[A-Za-z0-9_-]{43}$/`;
  - `verify(token)` returns the record, while `verify("sgr_wrong")` and `verify("")` return `undefined`;
  - the file contains no token plaintext (`readFileSync` does not include the token);
  - `revokeAllFor("alice")` removes only alice's;
  - invite redeem works once; a second redeem → `undefined`;
  - an invite redeemed at `now > expiresAt` → `undefined`;
  - two concurrent `redeem` calls of one code → exactly one success (`Promise.all`; the store serializes on an internal promise chain);
  - `ensureSetupCode` with `SIGRUN_SETUP_CODE=ABCD-EFGH` returns it and writes `<cacheDir>/setup-code` mode 0600;
  - without the env var, the returned code matches `/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/`;
  - `clearSetupCode` removes the file.
- [ ] **Step 2: Run** `npx vitest run test/identity-stores.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the stores per the interfaces.
  - `json-store.ts` exposes `readJson<T>(path, fallback)` with an `(mtimeMs,size)` cache, and `writeJson(path, value)` via `writeFileAtomic(path, json, 0o600)`.
  - Every mutating method chains on one per-store promise so concurrent calls serialize.
- [ ] **Step 4: Wire** `openIdentityStores(roots)` in `openHarness` (after `ensureStoreRoots`) as `OpenedHarness.identity`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 6: Commit** `git commit -m "identity: users/tokens/invites/setup-code stores (0600, atomic, mtime reload)"`.

### Task 3: Request pipeline, principal, login/logout/whoami

**Files:**
- Create:
  - `src/server/auth/principal.ts`;
  - `src/server/auth/ip.ts`;
  - `src/server/auth/pipeline.ts`;
  - `src/server/auth/login-limiter.ts`;
  - `src/server/routes/auth.ts`.
- Modify:
  - `src/server/context.ts`: the augmentation replaces `sigrunUser` with `principal: Principal`, and `ServerContext` gains `listenHost: string` and `methods: readonly ("token"|"proxy")[]`;
  - `src/server/index.ts`: `createServer(opened, config, bundles, options?: { listenHost?: string })`, defaulting to `"0.0.0.0"`. It registers `registerAuthPipeline` FIRST, replacing the naive `X-Sigrun-User` hook;
  - `src/serve.ts`: pass `{ listenHost: host }`;
  - `src/server/helpers.ts`: `stampSessionOwner(conversation, principal.user)`;
  - every route reading `request.sigrunUser`.
- Modify: `shared/src/views.ts`, adding `WhoamiResponse`.
- Test: `test/auth-pipeline.test.ts` (new). `test/auth-hook.test.ts` stays valid under `methods: []`.

**Interfaces:**
- Produces:
  ```ts
  export interface Principal { readonly user: string | undefined; readonly name?: string; readonly email?: string;
    readonly admin: boolean; readonly service: boolean; readonly method: "none" | "token" | "proxy" }
  export function isSuperuser(p: Principal): boolean; // (method "none" && user === undefined) || service
  export function ipAllowed(address: string | undefined, cidrs: readonly string[]): boolean; // net.BlockList; strips ::ffff:
  export function registerAuthPipeline(app: FastifyInstance, ctx: ServerContext): void;
  export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext): void;
  export interface WhoamiResponse { readonly user?: string; readonly name?: string; readonly email?: string;
    readonly admin: boolean; readonly service: boolean; readonly method: "none" | "token" | "proxy" }
  ```
- **Stage 1:**
  - Host: on a loopback `listenHost`, the `Host` hostname (port stripped) must be `localhost` | `127.0.0.1` | `[::1]` | in `allowedHosts`, else 421. Non-loopback binds check only when `allowedHosts` is set.
  - Origin: a non-GET/HEAD with `Origin` must match the effective host (`X-Forwarded-Host` from a trusted peer, else `Host`) or `allowedOrigins`, else 403 `origin_mismatch`.
- **Stage 2 — public:**
  - `GET`/`HEAD` outside `/v1/` other than `/metrics`;
  - `/healthz` and `/readyz`;
  - `/v1/onboarding*`;
  - `POST /v1/auth/login` and `POST /v1/auth/logout`;
  - `/metrics` when `config.metricsPublic`.
- **Stage 3:** a `Bearer` value equal (constant-time) to `config.auth.serviceToken.token` → the service principal; skips stage 4.
- **Stage 4:** `!identity.users.isClaimed()` → 403 `setup_required`.
- **Stage 5, in `ctx.methods` order:**
  - **`proxy`:** `ipAllowed(socket.remoteAddress, trustedProxies)` AND (when `secretHeader` is set) a constant-time match against `proxy.secret` AND a non-empty user header.
    - The secret header is deleted from `request.headers`.
    - A directory miss + `autoProvision` → `users.add({…, admin:false, source:"proxy"})`. A miss with `autoProvision: false` → 403 `user_not_provisioned`.
    - `admin = record.admin || (groups ∩ adminGroups ≠ ∅)`.
  - **`token`:** Bearer or cookie `sigrun_session` → `tokens.verify`; the user must exist, else 401.
  - **Empty list:** principal `{user: trimmed X-Sigrun-User || undefined, admin:true, service:false, method:"none"}`.
- **Routes:**
  - `POST /v1/auth/login {token}`:
    - valid → 200 `{user}` + `Set-Cookie: sigrun_session=<token>; HttpOnly; SameSite=Strict; Path=/` (`; Secure` when https directly or `X-Forwarded-Proto: https` from a trusted peer);
    - invalid → wait 1 000 ms → 401;
    - the limiter's 429 is checked first.
  - `POST /v1/auth/logout` → `Max-Age=0` cookie, 204.
  - `GET /v1/auth/whoami` → `WhoamiResponse`.

- [ ] **Step 1: Write failing tests** in `test/auth-pipeline.test.ts`. Pre-seed `users.json` with `UserDirectory` before boot (claimed); use `app.inject({ remoteAddress })`. Cases:
  - **token:**
    - `methods:["token"]`, no credential → 401;
    - a created token → 200;
    - an unknown token → 401;
  - **login:**
    - `POST /v1/auth/login` → `set-cookie` has `sigrun_session=`, `HttpOnly`, `SameSite=Strict`;
    - the cookie authenticates `/v1/auth/whoami`;
  - **limiter:**
    - 10 bad logins from `192.0.2.9`, then the 11th → 429 (fake timers);
    - another IP → not limited;
  - **proxy** (`trustedProxies ["10.42.0.0/16"]`, `adminGroups ["admins"]`):
    - peer `10.42.3.4` + `Remote-User: alice` + `Remote-Groups: users,admins` → whoami `{user:"alice", admin:true, method:"proxy"}`, and `users.json` alice has `admin:false`;
    - peer `203.0.113.7` → 401;
    - peer `::ffff:10.42.3.4` → proxy-authed;
  - **secret header** (`X-Sigrun-Proxy-Secret` + `SIGRUN_PROXY_SECRET=s3cret`):
    - without the header → 401;
    - with it → 200;
    - a test `preHandler` spy sees no `x-sigrun-proxy-secret`;
  - `autoProvision:false` + an unknown user → 403 `user_not_provisioned`;
  - `X-Sigrun-User: bob` + alice's token → whoami `alice`;
  - **Host** (`listenHost "127.0.0.1"`, `methods []`):
    - `Host: evil.example.invalid` → 421;
    - `Host: localhost:3000` → 200;
  - **Origin:**
    - `POST /v1/conversations` with `Origin: https://evil.example.invalid` → 403 `origin_mismatch`;
    - no Origin → 201;
  - **unclaimed + `SIGRUN_API_TOKEN=sgr_test_env`:**
    - that bearer → 200;
    - none → 403 `setup_required` (never 401 — the pipeline order);
  - **claimed token server:** `GET /` and `/healthz` answer without credentials.
- [ ] **Step 2: Run** `npx vitest run test/auth-pipeline.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The non-loopback-`[]` and broad-CIDR warnings log once, in `createServer`.
  - **Keeping the existing suites green:** the unclaimed gate applies under every method (the workstation onboarding ruling), so an empty directory 403s every existing test.
    - Add `OpenHarnessOptions.identity?: IdentityStores`, an injection seam that wins over `openIdentityStores(roots)`.
    - Add a test helper `test/helpers/identity.ts` exporting `seededIdentity(dir: string, user = "tester"): IdentityStores` (one admin directory user in a tmp dir).
    - Every in-process boot helper (`bootServer` and peers; `grep -rln "openHarness(" test`) passes `identity: seededIdentity(tmp)` plus `SIGRUN_AUTH: "none"` in its env. Both lines are behavior-preserving: naive identity, claimed.
    - Spawned-process tests (`deploy-entry`, `smoke`, the battery drivers) set `SIGRUN_API_TOKEN=sgr_test_env` and send it as a Bearer. The service token passes the unclaimed gate. They already isolate `SIGRUN_CONFIG_DIR`; check each driver.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "auth: request pipeline (host/origin, env token, setup gate, proxy+token), login/logout/whoami"`.

### Task 4: Onboarding, users, invites, tokens API, transfer-on-delete

**Files:**
- Create:
  - `src/server/routes/onboarding.ts`;
  - `src/server/routes/users.ts`;
  - `src/server/auth/claim-lock.ts` (one module promise chain shared by claims and invite redemption);
  - `src/server/ownership.ts`.
- Modify:
  - `src/server/routes/auth.ts`: the token routes;
  - `src/harness/boot.ts`: when unclaimed, `ensureSetupCode(roots.cacheDir, env)` + log `sigrun setup code: <code>` once;
  - `src/harness/event-bus.ts`: the `userDeleted` lifecycle event `{user, transferTo}`, fanned out directly (like `harnessShutdown`, not commit-derived), plus `ExtensionEventHandlers.userDeleted` and `EventBus.emitUserDeleted(payload, ctx)`;
  - `src/harness/loader.ts`: `"userDeleted"` joins `LIFECYCLE_FIELDS`;
  - `shared/src/views.ts`: `OnboardingState`, `ClaimResponse`, `UserWire`, `InviteResponse`, `TokenWire`, `TokenCreateResponse`.
- Test: `test/onboarding.test.ts`, `test/users-api.test.ts` (new); fixture `test/fixtures/fixture-user-events` (records `userDeleted` payloads in memory, exposing them via a factory-returned getter like `fixture-memory-events`).

**Interfaces:**
- **`GET /v1/onboarding`** → `{state:"unclaimed"|"claimed", methods, codeRequired, proxyIdentity?:{user,name?,email?}}`. `codeRequired` is false on a loopback bind or with a trusted proxy identity.
- **`POST /v1/onboarding/claim {code?, user?, name?, email?, issueToken?, tokenName?}`** → `200 {user: UserWire, token?}`, under `claim-lock`.
  - **Unclaimed** with (loopback | proxy identity | `code === readSetupCode(cacheDir)`):
    - `users.add({admin:true, source})`;
    - `clearSetupCode`;
    - set the root conversation's `SessionMeta.owner` to the claimant.
  - **Claimed:**
    - with an invite `code` → `invites.redeem` → add a user with the invite's `admin`;
    - a claimed proxy identity with no code → like auto-provision.
  - **Failures:** a bad code → 403 `invalid_code`; claimed with nothing valid → 409 `already_claimed`.
  - Proxy claims ignore body identity.
  - `issueToken:true` → `tokens.create(tokenName ?? "onboarding", user)`, and also sets the cookie.
- **Users (admin):**
  - `GET /v1/users`;
  - `PATCH /v1/users/:user {name?,email?,admin?}`, where demoting the last record-admin → 409 `last_admin`;
  - `DELETE /v1/users/:user?transferTo=`:
    - missing, unknown, or self → 400 `invalid_transfer`;
    - last record-admin → 409;
    - otherwise `transferOwnership(ctx, from, to)` → `tokens.revokeAllFor` → `users.remove` → `eventBus.emitUserDeleted`.
- **Invites (admin):** `POST /v1/users/invites {admin?, expiresInMs?}` → `{id, code, expiresAt}`.
- **Tokens:**
  - `GET /v1/auth/tokens[?user=]`: `?user` is admin-only;
  - `POST /v1/auth/tokens {name}`: a `user` field → 403 `forbidden` (self only);
  - `DELETE /v1/auth/tokens/:id`: own, or any for an admin.
- **Ownership:**
  ```ts
  export type OwnershipParticipant = (from: string, to: string) => Promise<void>;
  export function registerOwnershipParticipant(ctx: ServerContext, p: OwnershipParticipant): void;
  export function transferOwnership(ctx: ServerContext, from: string, to: string): Promise<void>;
  // core participant: scanConversations → SessionMeta snapshot → one commit per owner===from hit
  // (W4 registers the jobs participant)
  ```

- [ ] **Step 1: Write failing tests.**
  - `onboarding`:
    - an unclaimed boot writes `<cacheDir>/setup-code` and not `<stateDir>/setup-code`;
    - `GET /v1/onboarding` (no credential) → unclaimed, with `codeRequired:true` on `0.0.0.0`;
    - a wrong code → 403;
    - the right code + `issueToken` → 200 with a token; then claimed, the file gone, and a second claim → 409;
    - two concurrent correct claims → exactly one 200;
    - a proxy claim with no code → admin;
    - a loopback claim with no code → 200;
    - the root conversation's owner equals the claimant.
  - `users-api`:
    - non-admin `GET /v1/users` → 403;
    - an invite redeems once;
    - demoting the only admin → 409;
    - a proxy-group admin does not count toward the last admin;
    - `DELETE` without `transferTo` → 400;
    - with it → bob's conversation owner becomes alice, bob's token → 401, and the fixture records `{user:"bob", transferTo:"alice"}`;
    - an admin `POST /v1/auth/tokens {name, user:"bob"}` → 403;
    - a self create → 201;
    - an admin revoke of bob's → 204;
    - a second `TokenStore` instance revoking a token → the server's next request with it → 401.
- [ ] **Step 2: Run** `npx vitest run test/onboarding.test.ts test/users-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "auth: onboarding claim, invites, users API with transfer-on-delete, self-only tokens"`.

### Task 5: Sharing and content access

**Files:**
- Create: `shared/src/access.ts` + `shared/package.json` `exports["./access"]`.
- Modify:
  - `shared/src/session-meta.ts`:
    - `SessionMeta.sharing?: Sharing`;
    - `source` widens to `string`;
    - `SessionMetaPatch` drops `owner` and `source` and adds `sharing?: Sharing | null`.
  - `src/server/session-meta.ts`:
    - the validator turns `owner`/`source` into `{error:"invalid_field", field}`;
    - `sharing` is validated via `isSharing`;
    - apply sets/clears `sharing`.
  - `src/server/conversation-handler.ts`: `loadConversation(ctx, need: "read"|"write")`. It snapshots SessionMeta and computes `accessOf`:
    - `"none"` → 404 `conversation_not_found`;
    - `"read"` on a write route → 403 `forbidden`.
  - Every `:id` route: GETs (view, stream, interactions, ambient, export, meta, files, files/content) are `"read"`; the rest are `"write"`.
  - `PATCH …/meta`: `sharing` additionally requires owner or superuser → 403.
  - `src/server/routes/conversations.ts`:
    - the list filters on `accessOf !== "none"` and adds `sharing`/`access`;
    - fork sets `owner = principal.user` (deleting it when undefined) and deletes `sharing`;
    - create/import stamp `principal.user`.
  - `src/server/routes/interactions.ts` + `src/harness/interactions.ts` `applyAnswer(…, answeredByUser?)` + `shared/src/interactions.ts`: `answeredByUser?: string`.
  - `shared/src/views.ts`: `ConversationSummary` gains `sharing?` and `access: "read"|"write"`.
- Test: `test/sharing.test.ts` (new); update `test/session-meta.test.ts`.

**Interfaces:**
- Produces, in `shared/src/access.ts`:
  ```ts
  export type Sharing = { readonly scope: "private" }
    | { readonly scope: "household"; readonly level: "read" | "write" }
    | { readonly scope: "people"; readonly users: readonly string[]; readonly level: "read" | "write" };
  export type Access = "none" | "read" | "write";
  export interface AccessPrincipal { readonly user?: string; readonly superuser?: boolean }
  export function accessOf(p: AccessPrincipal, r: { readonly owner?: string; readonly sharing?: Sharing }): Access;
  export function isSharing(value: unknown): value is Sharing;
  ```
- **Rule order:**
  1. superuser → write;
  2. no owner → write;
  3. user === owner → write;
  4. household with a defined user → level;
  5. people including the user → level;
  6. otherwise none.
- The server passes `{user: principal.user, superuser: isSuperuser(principal)}`.

- [ ] **Step 1: Write failing tests.**
  - A `test.each` matrix for `accessOf` covering:
    - owner;
    - ownerless;
    - private-other;
    - household read and write;
    - people in and out;
    - superuser;
    - user-less non-superuser.
  - `test/sharing.test.ts` (token method; users bob, carol(admin), dave):
    - bob's private conversation → carol-admin `GET …/:id` 404, and it is absent from carol's list;
    - bob shares household-read → dave `GET …/stream` 200 and `POST …/submissions` 403, with list `access:"read"`;
    - bob shares people `["dave"]` write → dave submit 202, and dave's interaction answer stores `answeredByUser:"dave"` (seed via `fixture-seam`);
    - dave `PATCH …/meta`:
      - `{sharing}` → 403;
      - `{owner:"dave"}` → 400 `invalid_field`;
      - `{name:"x"}` → 200;
    - dave forks → the fork has `owner:"dave"` and no `sharing`.
- [ ] **Step 2: Run** `npx vitest run test/sharing.test.ts test/session-meta.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/shared run build`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "access: per-resource sharing, owner/source server-only, hidden-is-404, answeredByUser"`.

### Task 6: `/v1/providers`, meta auth block, docs

**Files:**
- Modify: `src/server/routes/providers.ts`:
  - `GET /v1/providers` → `{providers: AuthCheckProvider[]}`, the auth/check derivation moved into a shared function;
  - `GET /v1/auth/check` serves the same body + a `Deprecation: true` header.
- Modify: `src/server/routes/meta.ts` + `shared/src/views.ts`: `MetaResponse.auth: {methods, claimed}` and `ProvidersResponse`.
- Modify:
  - `README.md`: an "Authentication" section — the defaults, the override, proxy + `secretHeader` with the sentence "every peer in `trustedProxies` can forge any identity, including an admin", tokens, onboarding, sharing; the API sketch lists the new routes;
  - `charts/sigrun/values.yaml`: comments with the commented `SIGRUN_API_TOKEN` / `SIGRUN_PROXY_SECRET` keys and the upgrade note "an existing deployment upgrades into onboarding (the setup code is in the pod log and `/cache/setup-code`)";
  - `docker/.env.example`: the same keys, commented.
- Test: `test/server-meta-health.test.ts` (`auth.methods`, `auth.claimed`); `test/auth-check-readiness.test.ts` (`/v1/providers` and `/v1/auth/check` bodies are equal, and the alias carries `deprecation: true`).

- [ ] **Step 1: Write the failing assertions** above.
- [ ] **Step 2: Run** `npx vitest run test/server-meta-health.test.ts test/auth-check-readiness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement + docs.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && helm lint charts/sigrun`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "providers: /v1/providers (auth/check alias), meta auth block, auth docs + chart upgrade note"`.

### Task 7: CLI identity commands, onboarding prompt, TUI token

**Files:**
- Modify: `src/cli.ts`.
  - **`parseArgs`** grows subcommands:
    - `token create <name> --user <u>`;
    - `token list`;
    - `token revoke <id>`;
    - `user add <user> [--admin] [--name <n>] [--email <e>]`;
    - `user list`.

    `ParsedArgs.command` widens to include `"token" | "user"`.
  - **The identity commands** operate on the stores directly via `openIdentityStores(resolveStoreRoots(env))` — no server needed; they work while it is down.
  - **`attach`/`run`, before `launchTui`:**
    - `GET <server>/v1/onboarding`;
    - when `state === "unclaimed"` (or `setup_required` arrives later), prompt via `node:readline/promises` on the real TTY: setup code (skipped when `!codeRequired`), username, name, email;
    - then `POST /v1/onboarding/claim {…, issueToken:true}`;
    - write `tui.json` `{user, server, token}` (merge, 0600);
    - pass the token to the child as env `SIGRUN_TOKEN` — never argv.
  - **`run` (loopback):** same flow with no code; there is no token to store, but `user` is written.
  - **`TuiFile`** gains `token?: string`; `loadTuiFile` validates it as a string.
- Modify:
  - `tui/src/api.ts`: `SigrunClientOptions.token?: string` → an `authorization: Bearer <token>` header on every request;
  - `tui/src/sse.ts`: the same header;
  - `tui/src/launch.ts`: read `SIGRUN_TOKEN`. A standalone `sigrun-tui` hitting 403 `setup_required` exits 1 with `sigrun-tui: server is not set up — run \`sigrun attach\` to onboard`.
- Test: `test/cli.test.ts` (token/user subcommands with a tmp `SIGRUN_CONFIG_DIR`/`SIGRUN_STATE_DIR`; the onboarding flow with an injected fetch + scripted readline answers; `tui.json` gains the token at mode 0600; the spawn env carries `SIGRUN_TOKEN`); `tui/test/api.test.ts` (the authorization header present iff a token is given).

- [ ] **Step 1: Write failing tests.**
  - `sigrun user add alice --admin` creates the directory entry;
  - `sigrun token create laptop --user alice` prints one line matching `/^sgr_/`, and `token list` shows `laptop` without the secret;
  - `token revoke <id>` removes it;
  - the onboarding flow with fetch stubs answering `unclaimed`/`codeRequired:true`, and answers `ABCD-EFGH`, `alice`, `Alice`, `alice@example.invalid` → the claim body matches, `tui.json` has the token, and the spawn deps receive `env.SIGRUN_TOKEN`.
- [ ] **Step 2: Run** `npx vitest run test/cli.test.ts` + `npm --workspace @sigrun/tui test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `CliDeps` gains an injectable `prompt(question: string, opts?: { secret?: boolean }): Promise<string>` and `fetch` for tests.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm --workspace @sigrun/tui test && npm --workspace @sigrun/tui run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `git commit -m "cli: token/user commands, onboarding prompt for attach/run, TUI bearer token via SIGRUN_TOKEN"`.

### Task 8: Webui login, onboarding, identity, share menu

**Files:**
- Create:
  - `webui/src/auth/AuthGate.tsx` (wraps `App`; on boot `GET /v1/onboarding` → onboarding screen when unclaimed; on a 401 from any call → token login screen);
  - `webui/src/auth/Onboarding.tsx`;
  - `webui/src/auth/Login.tsx`;
  - `webui/src/sessions/ShareMenu.tsx`.
- Modify:
  - `webui/src/api.ts`: an `ApiError` class carrying `status` + `error` (today's rejections lose the status); `getOnboarding`, `claim`, `login`, `logout`, `whoami`, `patchConversationMeta({sharing})`;
  - `webui/src/main.tsx`: render `<AuthGate>`;
  - `webui/src/layout/Rail.tsx`: shows the `whoami` user + a logout action when `method === "token"`;
  - `webui/src/sessions/SessionList.tsx`: the ⋯ menu gains "Share…" (owner only), opening `ShareMenu` (private / household read|write / people + level). `write` levels show the warning "Others can ask the agent to act as you." Household defaults to `read`.
  - `webui/src/composer/Composer.tsx`: disabled with "Read-only (shared with you)" when the active summary's `access === "read"`.
- Test: `webui/src/auth/AuthGate.test.tsx` (unclaimed → onboarding; with `proxyIdentity` → a confirm screen that posts `{}`; 401 → login posts `{token}` then re-fetches); `ShareMenu.test.tsx` (patch payloads per choice; warning text on write); a Composer read-only test.

- [ ] **Step 1: Write the failing tests** above.
- [ ] **Step 2: Run** `npm --workspace @sigrun/webui test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The onboarding screen fields are setup code (only when `codeRequired`), username, name, and email.
  - Without a proxy identity the claim sends `issueToken: true, tokenName: "webui"`. The server sets the `sigrun_session` cookie for that token (Task 4), and the webui discards the returned token.
  - A proxy claim sends `{}`.
- [ ] **Step 4: Run** `npm --workspace @sigrun/webui test && npm run typecheck:webui && npm run build:webui && npm run test:e2e`. Expected: green. The e2e harness boots with `SIGRUN_AUTH=none`, plus ONE new e2e test that boots token-only, onboards with the setup code, and confirms the SSE stream renders (pins the browser's same-origin `EventSource` cookie behavior — spec §10).
- [ ] **Step 5: Commit** `git commit -m "webui: auth gate (onboarding, token login), identity in rail, share menu, read-only composer"`.
