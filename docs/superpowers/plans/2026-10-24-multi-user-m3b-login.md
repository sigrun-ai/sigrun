# M3b — Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People sign in to sigrun through an identity provider (OIDC, or OAuth 2 such as GitHub or Discord) supplied by an extension; core turns a verified external identity into a sigrun session, links it to a directory user, and stores the IdP's groups for admin and sharing decisions.

**Architecture:** Core owns the login seam (`loginProviders` on the factory result), the flow state, the callback routes, sessions (a token kind with expiry), the first-login rules, and stored groups. The bundled `@sigrun/ext-oauth` (own repo) only proves identity: it builds the authorize URL and turns a callback into `{subject, profile, groups}`. Account links are M3a's `AccountStore` (`login:<slug>:<id>` providers).

**Tech Stack:** TypeScript (NodeNext), Fastify, React (webui), vitest; ext-oauth uses an OIDC/OAuth library of the builder's choice (spec §15), recommended `oauth4webapi` (no transitive deps, PKCE + nonce + ID-token validation built in).

**Spec:** `docs/superpowers/specs/2026-10-23-sigrun-multi-user-design.md` §11 (all; §11.3 landed as M3a), §9.1 (admission rules logins obey), §16 (m6, m8).

## Global Constraints

- Never auto-link an external identity to an existing user by username or email.
- `autoProvision` defaults `false` per provider; proxy auth keeps its `true` default.
- Sessions: token-store records with `kind: "session"`, `expiresAt` = now + `server.auth.sessionDays` days (default `30`, live), `name: "login:<provider>"`; cookie `sigrun_session` exactly as `buildSessionCookie` sets it today.
- Flow state: in memory, 10 minutes, bound to the browser by an `HttpOnly; SameSite=Lax; Path=/v1/auth/callback` cookie `sigrun_login_state` (Lax, not Strict: the IdP redirect is a cross-site top-level navigation that must carry it).
- `?return=` must be a same-origin path: starts with `/`, not `//`, no scheme, no backslash; anything else becomes `/`.
- Provider ids: `login:<slug>:<id>`; the bundled extension's slug is `oauth`, so its ids read `login:oauth:<id>`.
- Groups are trusted input only from proxy headers that passed authentication and from a provider's `LoginResult`.
- Usernames: `profile.username`, else the email local part, else the subject; lowercase, every char outside `[a-z0-9._-]` → `-`, leading non-`[a-z0-9]` stripped, empty → `user`; collision → `-2`, `-3`, …
- `allowedDomains` matches only when `profile.emailVerified === true`.
- **No npm publishing** (Michael's ruling while the npm-publish automation workstream runs). Task 8 adds `@sigrun/ext-oauth` as a core dependency, which the release pipeline must then publish, so Task 8 waits for that workstream.
- Shared-file note: `src/extension.ts`, `shared/src/views.ts`, `shared/src/settings.ts`, `src/harness/builtins.ts` are also edited by in-flight branches (UI-blocks U4–U7; gateway-engine's C3 adds the `gateway` built-in). Additions are self-contained; rebase conflicts are additive.

## Review Focus

1. **A login callback replayed** (same `state` twice, or `state` from another browser) — the second use and the cross-browser use both fail with 400 `invalid_state`; no session is created. Owner: Task 4.
2. **An IdP returning a username that collides with an existing sigrun user** on first login — a new suffixed user (`alice-2`), never a link to `alice`. Owner: Task 5.
3. **An expired session cookie** — treated as no credential (401 → the login screen), and pruned on the next token write. Owner: Task 1.
4. **A group-derived admin losing the group at the IdP** — admin goes away at their next login, and host-side checks agree with the web. Owner: Task 2.
5. **A server restart mid-login** — that one login fails with a clear "start again" message; nothing else is affected. Owner: Task 4.

---

### Task 1: Sessions

**Files:**
- Modify: `src/harness/identity/tokens.ts` (`kind?`, `expiresAt?`; `createSession`; expiry in `verify`; prune on write), `src/server/routes/auth.ts` (logout revokes a session token; token list wire gains `kind`, `expiresAt`), `src/extension.ts` + `src/server/auth/principal.ts` (`Principal.method` gains `"session"`, `Principal.provider?`), `src/server/auth/pipeline.ts` (a session record resolves `method: "session"`), `src/config.ts` + `shared/src/settings.ts` (`server.auth.sessionDays`), `shared/src/views.ts` (`TokenWire.kind`, `TokenWire.expiresAt`)
- Test: `test/identity-stores.test.ts`, `test/auth-pipeline.test.ts`, `test/server-routes.test.ts`

**Interfaces:**
- Produces (`tokens.ts`): `TokenRecord` gains `readonly kind?: "api" | "session"; readonly expiresAt?: number; readonly provider?: string`; `createSession(user: string, provider: string, ttlMs: number, now = Date.now()): Promise<{ token: string; record: TokenRecord }>`; `verify(token, now = Date.now())` returns `undefined` for a record whose `expiresAt <= now`; every mutation drops records with `expiresAt <= now` before writing.
- Pipeline: a verified record with `kind: "session"` yields `{ …, method: "session", provider: record.provider }`; `kind` absent or `"api"` stays `method: "token"`.
- Logout: if the presented cookie verifies to a session record, revoke it, then clear the cookie (an API token used as the cookie is only cleared, never revoked — today's behavior).

- [ ] **Step 1: Write the failing tests:** `createSession` stores `kind`, `provider`, `expiresAt`; `verify` at `expiresAt - 1` returns the record and at `expiresAt` returns `undefined` (Review Focus 3); a write after expiry removes the expired record; the pipeline resolves a session cookie to `method: "session"` with `provider`; an expired session cookie → 401; logout with a session cookie revokes it (a second request with it → 401) and with an API-token cookie does not revoke; `GET /v1/auth/tokens` shows `kind` and `expiresAt`; `sessionDays` parses and defaults to 30.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "auth: session tokens with expiry; method session (multi-user M3b)"`

### Task 2: Stored groups; `groupAdmin` retired

**Files:**
- Modify: `src/harness/identity/users.ts` (`groups?`, `setGroups`, drop `groupAdmin` on write), `src/server/auth/pipeline.ts` (proxy writes the `proxy` source), `src/server/host-bridge.ts` (`effectiveAdminOf` reads groups), `src/server/routes/users.ts` (wire), `shared/src/views.ts` (`UserWire.groups?`; `groupAdmin` derived), `docs/extending.md` ("The users surface")
- Create: `src/harness/identity/groups.ts`
- Test: `test/identity-stores.test.ts`, `test/auth-pipeline.test.ts`, `test/host-conversations.test.ts` (the C8 tests move to groups), `test/users-api.test.ts`

**Interfaces:**
- Produces (`users.ts`): `DirectoryUser.groups?: readonly { readonly source: string; readonly values: readonly string[]; readonly updatedAt: number }[]`; `setGroups(user: string, source: string, values: readonly string[], now = Date.now()): Promise<DirectoryUser>` replaces that source's entry (no write when values are unchanged, so a busy proxy user does not rewrite the file every request). `update` no longer accepts `groupAdmin`; any record write omits a stored `groupAdmin`.
- Produces (`groups.ts`): `storedGroups(record: DirectoryUser): string[]` (the union across sources, deduplicated); `effectiveAdmin(record: DirectoryUser, adminGroups: readonly string[]): boolean` = `record.admin || storedGroups(record).some((g) => adminGroups.includes(g))`.
- Pipeline (proxy): replaces the C8 write-through with `setGroups(user, "proxy", groups)`; the request's admin is `effectiveAdmin` over the updated record. `recordAdminCount` still counts `record.admin` only.
- Wire: `UserWire.groups` = `storedGroups`; `UserWire.groupAdmin` = `effectiveAdmin(record) && !record.admin` (kept for one release so the users UI keeps rendering; the field doc says it is derived).

- [ ] **Step 1: Write the failing tests:** `setGroups` replaces one source and keeps another; no-op write when unchanged (file mtime unchanged); `effectiveAdmin` true via any source; a proxy request with the admin group, then one without → admin false at the second (Review Focus 4); host `users.get` and the request principal agree; a legacy record carrying `groupAdmin: true` but no groups is not admin after the next write; last-admin guard ignores group admins.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "auth: stored groups per source; retire groupAdmin (multi-user M3b)"`

### Task 3: Sharing to groups

**Files:**
- Modify: `shared/src/access.ts` (`Sharing.people.groups?`, `AccessPrincipal.groups?`, `accessOf`, `isSharing`), the principal → `AccessPrincipal` projections in `src/server/routes/interactions.ts`, `src/server/routes/conversations.ts`, `src/server/routes/jobs.ts`, `src/server/conversation-handler.ts`, `src/server/host-bridge.ts`, `src/server/conversation-ops.ts`
- Create: `src/server/auth/access-principal.ts`
- Test: `shared/test/access.test.ts` (or the file that owns `accessOf` tests), `test/conversation-list-meta.test.ts`

**Interfaces:**
- Produces (`shared/src/access.ts`): people scope `{ scope: "people"; users: string[]; groups?: string[]; level }`; `AccessPrincipal.groups?: readonly string[]`; rule 4/5 also matches when any principal group is in `sharing.groups`. `isSharing` accepts `groups` only as a string array.
- Produces (`access-principal.ts`): `accessPrincipalOf(principal: Principal, users: UserDirectory): AccessPrincipal` = `{user, superuser: isSuperuser(principal), groups: storedGroups(record)}`; every listed call site uses it (no inline projections left; a grep test asserts `superuser: isSuperuser(` appears only in this module).

- [ ] **Step 1: Write the failing tests:** a conversation shared `{scope: "people", users: [], groups: ["family"], level: "read"}` is readable by a user whose stored groups include `family` and hidden from one without; `isSharing` rejects `groups: "family"`; the grep guard.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "access: share to groups (multi-user M3b)"`

### Task 4: The login seam, flows, and routes

**Files:**
- Modify: `src/extension.ts` (`LoginProviderContribution`, `LoginFlow`, `LoginResult`; `SigrunExtensionResult.loginProviders?`), `src/harness/loader.ts` (validate + collect), `src/harness/boot.ts` (expose `opened.loginProviders`), `src/server/auth/pipeline.ts` (public paths), `src/server/index.ts` (register)
- Create: `src/server/login/flows.ts`, `src/server/routes/login.ts`
- Test: `test/login-routes.test.ts`, `test/loader.test.ts`, `test/fixtures/fixture-login/index.js`

**Interfaces:**
- Produces (`src/extension.ts`), verbatim from spec §11.1: `LoginProviderContribution { id: string; label: string; icon?: string; begin(flow: LoginFlow, ctx: HandlerContext): Promise<{ redirectUrl: string }>; complete(flow: LoginFlow, callback: { query: Record<string, string>; body?: unknown }, ctx: HandlerContext): Promise<LoginResult> }`; `LoginFlow { state: string; callbackUrl: string; data: Record<string, string> }` (`data` is mutable in `begin`, persisted, handed back to `complete`); `LoginResult { subject: string; profile: { username?: string; name?: string; email?: string; emailVerified?: boolean }; groups?: string[] }`.
- Loader: `id` matches `^[a-z0-9][a-z0-9._-]*$`, unique per extension, `begin`/`complete` functions; violations quarantine the extension. Collected as `{ provider: "login:<slug>:<id>", contribution }`.
- Produces (`flows.ts`): `class LoginFlows { constructor(now?: () => number); start(provider: string, opts: { returnTo: string; link?: string /* user */ }): LoginFlow & { browserKey: string }; take(state: string, browserKey: string): StoredFlow | undefined /* single use */ }`; entries expire after 600 000 ms; `state` and `browserKey` are 32 random bytes base64url.
- Routes (public in the pipeline, matched by route pattern like the existing ones): `GET /v1/auth/providers` → `{ providers: { provider, label, icon? }[] }`; `GET /v1/auth/login/:provider?return=&link=1` → 302 to `redirectUrl`, sets `sigrun_login_state`; `GET`/`POST /v1/auth/callback/:provider` → verifies state + cookie (`take`), calls `complete`, then hands `{provider, result, flow}` to Task 5's resolver. `link=1` requires an authenticated principal at begin time (the route is public, so it reads the session cookie itself through the pipeline's token resolver) and stores the user in the flow.
- Errors (rendered as a redirect to `/login?error=<code>` for browsers): `unknown_provider` (404 at begin), `invalid_state` (400), `login_expired` (state unknown because it expired or the server restarted: "This sign-in took too long or sigrun restarted. Start again."), `provider_error` (`complete` threw; its message is logged, not shown).

- [ ] **Step 1: Write the failing tests** with a fixture provider whose `begin` stores `data.verifier` and returns `https://idp.example.invalid/authorize?state=<state>`, and whose `complete` returns a fixed result: providers list; begin → 302 + cookie; callback with matching state + cookie reaches the resolver with the fixture's `data.verifier`; same state twice → `invalid_state` (Review Focus 1); state with a different cookie → `invalid_state`; state after 600 001 ms (fake clock) → `login_expired`; a fresh `LoginFlows` (restart) → `login_expired` (Review Focus 5); `return=//evil.example.invalid` → `/`; `link=1` without a principal → 401; loader quarantines a provider with id `Bad Id` and duplicate ids.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "auth: login provider seam, flow state, callback routes (multi-user M3b)"`

### Task 5: Resolving a login

**Files:**
- Create: `src/server/login/resolve.ts`, `src/server/login/usernames.ts`
- Modify: `src/server/routes/login.ts` (call the resolver; interstitial routes), `src/server/routes/onboarding.ts` (share the setup-code check), `src/harness/identity/users.ts` (`source: "login"`), `shared/src/views.ts` (`UserWire.source` gains `"login"`), `src/extension.ts` (`LoginProviderContribution.policy`)
- Test: `test/login-resolve.test.ts`, `test/login-routes.test.ts`

**Interfaces:**
- `LoginProviderContribution` gains `readonly policy?: { autoProvision?: boolean; allowedGroups?: string[]; allowedDomains?: string[] }` (the extension reads it from its own settings; core enforces it).
- Produces (`resolve.ts`): `resolveLogin(input: { provider: string; result: LoginResult; linkUser?: string; code?: string }, deps: { accounts: AccountStore; users: UserDirectory; invites: InviteStore; setupCode(): string | undefined; policy: LoginPolicy }): Promise<{ kind: "session"; user: string } | { kind: "linked"; user: string } | { kind: "needs_code"; reason: "setup" | "invite" } | { kind: "refused"; error: "not_allowed" | "account_link_conflict" | "isolation_required" | "auth_required" }>`. Order: `linkUser` set → `accounts.link(…, "login")` → `linked` (conflict → refused); existing link → `session`; unclaimed directory → setup code required (valid → create admin `source: "login"`, link, clear the setup code); claimed + `autoProvision` → filters (`allowedGroups` ∩ result groups non-empty, `allowedDomains` with verified email) → create non-admin user + link; claimed without `autoProvision` → invite code required → `invites.redeem` → create user (admin from the invite) + link. Every create goes through `UserDirectory.add`, so M1's admission guard (if merged) refuses with `isolation_required`/`auth_required`. Groups from the result are stored with `setGroups(user, provider, groups)` on every successful login.
- Produces (`usernames.ts`): `assignUsername(profile, subject, taken: (u: string) => boolean): string` per Global Constraints.
- Interstitial: `needs_code` keeps the verified result in the flow store for 10 more minutes under a new single-use key and redirects to `/login/code?key=<k>&reason=<setup|invite>`; `POST /v1/auth/login/code {key, code}` resumes `resolveLogin` with `code`.
- Success: `session` → `createSession(user, provider, sessionDays)`, cookie, 302 to `returnTo`; `linked` → 302 to `/settings?section=accounts`.

- [ ] **Step 1: Write the failing tests:** each branch of `resolveLogin` with fakes; username assignment (`"Alice Smith"` → `alice-smith`, `".x"` → `x`, `""` → `user`, collision with `alice` → `alice-2` and never a link to `alice` — Review Focus 2); `allowedDomains` with `emailVerified: false` refused; an invite with `admin: true` makes an admin; the setup-code claim clears the code; repeated login refreshes stored groups; through the routes: unknown subject on a claimed server without `autoProvision` → redirect to `/login/code?reason=invite`, then `POST /v1/auth/login/code` with a valid invite → session cookie; with M1 merged, a second-user login while isolation is unavailable → `/login?error=isolation_required` (if M1 Task 6 is not on `main` yet, move this one test to M1 Task 6 and note it there).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "auth: first-login resolution — links, setup code, invites, auto-provision, usernames (multi-user M3b)"`

### Task 6: Webui sign-in and account links

**Files:**
- Modify: `webui/src/auth/Login.tsx` (provider buttons above the token form; `error` query mapped to copy), `webui/src/auth/AuthGate.tsx`, `webui/src/api.ts` (`providers()`, `accounts()`, `removeAccount()`, `submitLoginCode()`), the settings panel (an "Account links" section: list from `/v1/auth/accounts`, a remove button, "Connect" buttons per provider that open `/v1/auth/login/<p>?link=1&return=/settings?section=accounts`)
- Create: `webui/src/auth/LoginCode.tsx` (setup / invite code interstitial)
- Test: `webui/src/auth/*.test.tsx`, e2e `e2e/login.spec.ts` against the fixture provider

**Interfaces:**
- Error copy, exact: `invalid_state` → "That sign-in link was already used or came from another browser. Start again."; `login_expired` → spec copy in Task 4; `not_allowed` → "Your account isn't allowed to use this sigrun."; `isolation_required` → "This sigrun can't add another user yet. Ask the admin."; `auth_required` → same as `isolation_required`; `account_link_conflict` → "That account is already linked to another sigrun user."; `provider_error` → "The sign-in provider returned an error. Try again."
- If U4 has merged, the Account links section is a core settings section per U4's `SettingsSectionDef`; otherwise it is a plain React section in today's settings panel, converted when U4 lands (the U4 plan's Task 4 converts every core section).

- [ ] **Step 1: Write the failing tests:** Login renders one button per provider and the token form; each error code renders its copy; LoginCode posts and redirects; Account links lists, removes, and shows Connect buttons; the e2e: fixture provider sign-in on a claimed server with `autoProvision` lands signed in as the assigned user.
- [ ] **Step 2: Run** — `npm --workspace @sigrun/webui run test` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — webui test + `npm run typecheck:webui` + `npm run build:webui` + `npm run test:e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "webui: sign in with providers, code interstitial, account links (multi-user M3b)"`

### Task 7: `@sigrun/ext-oauth` (new repo)

**Files (new repo `~/repos/sigrun-ext-oauth`):** scaffold from `~/repos/sigrun-ext-codemode` (package.json shape, tsconfigs, `scripts/check-manifest.mjs`, LICENSE, CHANGELOG, AGENTS.md, committed `dist/`); `src/index.ts` (factory), `src/config.ts`, `src/oidc.ts`, `src/oauth2.ts`, `src/presets.ts`; tests `test/config.test.ts`, `test/oidc.test.ts`, `test/oauth2.test.ts`, `test/issuer.ts` (an in-test OIDC issuer: discovery, JWKS, authorize, token endpoints on a localhost server, signing with `jose`).

**Interfaces:**
- Package `@sigrun/ext-oauth`, declared extension name `oauth` (slug `oauth`); peerDependencies `"*"` on host modules, `dependencies` only the protocol library. Repo-local git identity per the remote rule.
- Settings (`settings/oauth.json`, read through `host.stores.settings`): `{ providers: ({ id, label, icon?, kind: "oidc", issuer, clientId, scopes?, usernameClaim?, groupsClaim?, autoProvision?, allowedGroups?, allowedDomains? } | { id, label, icon?, kind: "oauth2", preset: "github" | "discord" } | { id, label, icon?, kind: "oauth2", authorizeUrl, tokenUrl, userinfoUrl, scopes?, fields: { subject, username?, name?, email?, emailVerified?, groups? }, autoProvision?, allowedGroups?, allowedDomains? })[] }`. Client secrets: extension secret `<id>.clientSecret`. Defaults: `scopes` `openid profile email`, `usernameClaim` `preferred_username`, `groupsClaim` `groups`. Malformed entry → that provider is skipped with one warning naming it; the others load. No providers → `loginProviders: []` (inert).
- OIDC: discovery from `<issuer>/.well-known/openid-configuration`; authorization code + PKCE (S256) + nonce in `flow.data`; ID-token validation (issuer, audience, nonce, signature via JWKS, expiry); `emailVerified` from `email_verified`.
- Presets: `github` (authorize `https://github.com/login/oauth/authorize`, token `https://github.com/login/oauth/access_token`, user `https://api.github.com/user`; subject = `id`, username = `login`, email = primary verified from `/user/emails`, no groups); `discord` (authorize `https://discord.com/oauth2/authorize`, token `https://discord.com/api/oauth2/token`, user `https://discord.com/api/users/@me`; subject = `id`, username = `username`, email + `verified`, no groups). PKCE where the provider supports it (Discord yes, GitHub yes).
- `policy` on each contribution from the entry's provisioning fields (Task 5's interface).
- README opens: "Sign in to sigrun with an OIDC or OAuth 2 provider. This is for logging in; MCP account connections live in the MCP extension."

- [ ] **Step 1: Write the failing tests:** config parsing (each kind, defaults, a bad entry skipped while a good one loads); OIDC begin/complete against the in-test issuer (valid; wrong nonce rejected; wrong audience rejected; expired token rejected; groups claim mapped); oauth2 explicit endpoints against a fake userinfo server with field paths; presets produce the pinned URLs (no network — assert the authorize URL and the request the token step would send, through an injectable `fetch`).
- [ ] **Step 2: Run** — `npm test` in the new repo — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck && npm run build` — Expected: PASS; `dist/` committed.
- [ ] **Step 5: Commit** in the new repo `feat: @sigrun/ext-oauth — OIDC and OAuth 2 login providers`

### Task 8: Bundle ext-oauth as a built-in

**Waits for:** the npm-publish automation workstream (adds a core dependency the release must publish) and, if still unmerged, a rebase over gateway-engine's C3 edit of the same built-ins list.

**Files:**
- Modify: `src/harness/builtins.ts` (`{ key: "oauth", specifier: "@sigrun/ext-oauth", slug: "oauth" }`), `shared/src/settings.ts` (`BuiltinExtensionsSettings.oauth?`), `src/harness/settings.ts` (validator key list), `package.json` (`"@sigrun/ext-oauth": "file:../sigrun-ext-oauth"`, plus whatever registry-mode entry the publish automation expects), `docs/extending.md`, `CHANGELOG.md`
- Test: `test/builtins.test.ts`, `test/login-routes.test.ts` (one end-to-end OIDC sign-in through the real built-in against the in-test issuer, copied from the ext-oauth repo's `test/issuer.ts`)

- [ ] **Step 1: Write the failing tests:** the built-in loads by default and is inert with no settings (`GET /v1/auth/providers` → `[]`); `builtinExtensions.oauth: false` → absent from `/v1/extensions`; a same-named configured package replaces it; with `settings/oauth.json` pointing at the in-test issuer, a full browser-shaped sign-in creates a session.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "builtins: bundle @sigrun/ext-oauth (multi-user M3b)"`

### Task 9: Docs

**Files:** `docs/extending.md` (the login seam: contract, what core does vs the provider, ids, policy fields, groups trust rule), operator docs (configuring OIDC with Authelia/Authentik/Keycloak as generic examples using `idp.example.invalid`; GitHub/Discord presets; sessions and `sessionDays`; account links; "groups refresh at the next login"), `CHANGELOG.md`.

- [ ] **Step 1: Write** the sections; examples use synthetic hosts only.
- [ ] **Step 2: Commit** `git commit -m "docs: login providers, sessions, groups (multi-user M3b)"`
