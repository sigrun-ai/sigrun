# M3a — Core Account Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core owns one table linking external identities (chat senders now, login subjects later) to directory users, exposed to extensions as `host.accounts` and to users as `/v1/auth/accounts`, so the gateway engine builds its `IdentityStore` on it instead of its own `identities.json`.

**Architecture:** A new `AccountStore` in `src/harness/identity/` follows the existing identity-store discipline (`json-store.ts`: mtime-reloading sync reads, `MutationQueue`-serialized atomic 0600 writes) over `<configDir>/accounts.json`, and joins the `IdentityStores` bundle. `SigrunHost` gains `accounts`, delegated by the seam host to the host bridge like `users`. `DELETE /v1/users/:user` removes the departing user's links. Two auth routes let a user list and remove their own links, mirroring `/v1/auth/tokens` (admins may act on anyone's).

**Tech Stack:** TypeScript (NodeNext), Fastify, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-sigrun-multi-user-design.md` §11.3 (account links), §11.7 (gateway handover), §10.6 step 1 (deletion). This is the slice of M3 that the gateway engine's Task 3 waits on; the rest of M3 (login seam, sessions, `@sigrun/ext-oauth`, groups) is a later plan.

## Global Constraints

- File: `<configDir>/accounts.json`, mode `0600`, a JSON array of records; store semantics exactly as `users.json` (`readRecords`/`writeJson`/`MutationQueue` from `src/harness/identity/json-store.ts`).
- Record: `{provider, subject, user, linkedAt, via}`; `via` is `"login" | "self" | "pairing" | "admin"`.
- Provider ids: `login:<slug>:<id>` and `chat:<channel>`; validated against `^(login|chat):[a-z0-9][a-z0-9._:-]*$`.
- `subject`: any non-empty string up to 512 characters (Telegram/Discord numeric ids, Signal `+E.164`, email-shaped subjects all pass).
- `user` must exist in the directory at link time.
- One link per `(provider, subject)`. Re-linking to the same user is a no-op returning the existing record; linking to a different user is refused (the caller unlinks first). Never auto-replace.
- Host-surface errors follow the `commands.run` precedent (message-prefixed, `docs/extending.md`): `unknown user "<user>"`, `invalid_provider: <provider>`, `invalid_subject`, `account_link_conflict: <provider> is linked to another user`. The conflict message never names the other user.
- `host.accounts` is in-process core code: the single write path. Extensions never touch `accounts.json` directly.
- Shared-file note: `src/extension.ts` and `shared/src/views.ts` are also edited by the in-flight UI-blocks U1–U3 branches. Additions here are self-contained blocks; rebase conflicts are additive.

## Review Focus

1. **Two concurrent `link` calls for one `(provider, subject)` naming different users** — exactly one wins, the other is refused with the conflict error; the file holds one record. Owner: Task 1.
2. **A second `AccountStore` instance (the CLI or another process) on the same file** sees the first one's writes on its next read, with no restart. Owner: Task 1.
3. **A malformed `accounts.json`** fails loud naming the path, never resets to empty (a silent reset would unlink every chat account). Owner: Task 1.
4. **Deleting a user with `transferTo`** removes the deleted user's links and leaves `transferTo`'s and everyone else's untouched; links never transfer. Owner: Task 2.
5. **An extension calling `host.accounts` before the server bound its bridge** waits rather than throwing, like every other bridged host member. Owner: Task 2.

---

### Task 1: `AccountStore` and the identity bundle

**Files:**
- Create: `src/harness/identity/accounts.ts`
- Modify: `src/harness/identity/index.ts` (export, bundle field, `ACCOUNTS_FILE`, `openIdentityStores`)
- Modify: `test/helpers/identity.ts` (both bundle builders gain `accounts`)
- Test: `test/identity-stores.test.ts` (new `describe("AccountStore")`, plus the `openIdentityStores` case)

**Interfaces:**
- Consumes: `UserDirectory` (`get(user)`), `readRecords`, `writeJson`, `MutationQueue` from `json-store.ts`.
- Produces (`src/harness/identity/accounts.ts`):
  - `type AccountLinkVia = "login" | "self" | "pairing" | "admin"`
  - `interface AccountLink { readonly provider: string; readonly subject: string; readonly user: string; readonly linkedAt: number; readonly via: AccountLinkVia }`
  - `class AccountLinkConflictError extends Error { readonly provider: string; readonly subject: string }` — message `account_link_conflict: <provider> is linked to another user`
  - `class AccountStore { constructor(path: string, users: UserDirectory); list(): AccountLink[]; lookup(provider: string, subject: string): AccountLink | undefined; listForUser(user: string): AccountLink[]; link(input: { provider: string; subject: string; user: string; via: AccountLinkVia }): Promise<AccountLink>; unlink(provider: string, subject: string): Promise<boolean>; removeUser(user: string): Promise<number> }`
- Produces (`src/harness/identity/index.ts`): `IdentityStores.accounts: AccountStore`; `openIdentityStores` builds it at `<configDir>/accounts.json` with the bundle's `UserDirectory`.

- [ ] **Step 1: Write the failing tests** in `test/identity-stores.test.ts`, each over a fresh tmp dir with a `UserDirectory` holding `alice` and `bob`:
  - `link then lookup round-trips`: `link({provider: "chat:telegram", subject: "12345", user: "alice", via: "pairing"})` → returned record and `lookup("chat:telegram", "12345")` both equal `{provider, subject, user: "alice", via: "pairing"}` with a numeric `linkedAt`.
  - `subjects are opaque strings`: `"+15551234567"` and `"u@x.example"` link and look up.
  - `re-link to the same user is a no-op`: second identical `link` resolves to a record with the FIRST `linkedAt`; `listForUser("alice")` has length 1.
  - `link to another user is refused`: after alice's link, `link({... same provider/subject, user: "bob"})` rejects with `AccountLinkConflictError`, message `account_link_conflict: chat:telegram is linked to another user`, and the message does not contain `"alice"`; lookup still yields alice.
  - `concurrent conflicting links: exactly one wins`: `Promise.allSettled` of alice's and bob's link for one `(provider, subject)` → one fulfilled, one rejected `AccountLinkConflictError`; the file parses to exactly one record.
  - `validation`: unknown user `"ghost"` rejects `unknown user "ghost"`; provider `"telegram"` and `"chat:"` and `"Chat:x"` reject `invalid_provider: <provider>`; subject `""` and a 513-char subject reject `invalid_subject`; provider `"login:oauth:authelia"` is accepted.
  - `unlink`: returns `true` and the link is gone; unlinking an absent link returns `false`.
  - `removeUser`: with alice holding two links and bob one, `removeUser("alice")` resolves `2`, bob's link remains.
  - `listForUser` returns insertion order; `list()` returns every record in insertion order.
  - `file is mode 0600` after the first link (`statSync(path).mode & 0o777` === `0o600`).
  - `a second instance sees writes`: `new AccountStore(samePath, users).lookup(...)` after a link through the first instance returns the record.
  - `malformed file fails loud`: write `"{"` to the path → `lookup` throws an error whose message contains the path.
  - In `describe("openIdentityStores")`: `identity.accounts` is an `AccountStore` whose first link creates `<configDir>/accounts.json`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/identity-stores.test.ts`
Expected: FAIL — `AccountStore` is not exported.

- [ ] **Step 3: Implement `AccountStore`** in `src/harness/identity/accounts.ts` per the Interfaces block. Validation runs inside the mutation (`MutationQueue.run`) so the existence check and the conflict check see the same file state as the write. `lookup`/`listForUser` are synchronous reads like `UserDirectory.get`. The module header states why links live in core (one table for chat and login identities, shared with the gateway) and why conflicts are refused rather than replaced (a re-link to a different user is an account takeover path).

- [ ] **Step 4: Wire the bundle**: `ACCOUNTS_FILE = "accounts.json"` in `src/harness/identity/index.ts`; `IdentityStores` gains `readonly accounts: AccountStore` (doc: `<configDir>/accounts.json`, external-identity links); `openIdentityStores` constructs it over the same `UserDirectory` instance it returns; the module header's file list gains the line. In `test/helpers/identity.ts`, both builders add `accounts: new AccountStore(join(dir, "accounts.json"), users)` over the builder's own `users` instance.

- [ ] **Step 5: Run the suite and typecheck**

Run: `npx vitest run test/identity-stores.test.ts && npm test && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/harness/identity/accounts.ts src/harness/identity/index.ts test/helpers/identity.ts test/identity-stores.test.ts
git commit -m "feat(identity): core account-link store (multi-user M3a)"
```

### Task 2: `host.accounts`, deletion, and docs

**Files:**
- Modify: `shared/src/views.ts` (add `AccountLinkWire` beside `UserWire`)
- Modify: `src/extension.ts` (`SigrunHost.accounts`, import of the wire type)
- Modify: `src/harness/seam-host.ts` (`accounts` delegating to the bridge, beside `users`)
- Modify: `src/server/host-bridge.ts` (`HostBridge.accounts` + implementation over `opened.identity.accounts`)
- Modify: `src/server/routes/users.ts` (`DELETE /v1/users/:user`: remove links after token revocation)
- Modify: `docs/extending.md` (config-root entries list gains `accounts.json`; new "The accounts surface" section after "The users surface")
- Test: `test/host-conversations.test.ts` (in `describe("host identity, users, and access")`), `test/users-api.test.ts` (in `describe("DELETE /v1/users/:user")`)

**Interfaces:**
- Consumes: Task 1's `AccountStore`, `AccountLinkConflictError`, `AccountLinkVia`.
- Produces (`shared/src/views.ts`): `interface AccountLinkWire { readonly provider: string; readonly subject: string; readonly user: string; readonly linkedAt: number; readonly via: "login" | "self" | "pairing" | "admin" }`.
- Produces (`src/extension.ts`, on `SigrunHost`):

```ts
/** External identities linked to directory users (multi-user §11.3): the one table for chat senders and login subjects. */
readonly accounts: {
	lookup(provider: string, subject: string): Promise<AccountLinkWire | undefined>;
	link(provider: string, subject: string, user: string, via: AccountLinkWire["via"]): Promise<AccountLinkWire>;
	unlink(provider: string, subject: string): Promise<boolean>;
	listForUser(user: string): Promise<readonly AccountLinkWire[]>;
};
```

  Errors are the Global Constraints messages; `AccountLinkConflictError` crosses the host as an `Error` with that message (extensions match on the `account_link_conflict:` prefix, as they do on `command_not_found:`).

- [ ] **Step 1: Write the failing tests**
  - `test/host-conversations.test.ts`, new test `host accounts link, look up, list, and unlink through the bridge`: on the existing `bootServer()` + `channelHost(opened)` shape, `host.accounts.link("chat:loop", "s-1", "alice", "self")` resolves a record with `user: "alice"`; `lookup("chat:loop", "s-1")` returns it; `lookup("chat:loop", "nobody")` resolves `undefined`; `listForUser("alice")` has length 1; `link("chat:loop", "s-1", "tester", "pairing")` rejects with a message starting `account_link_conflict:`; `link("chat:loop", "s-2", "ghost", "self")` rejects `unknown user "ghost"`; `unlink("chat:loop", "s-1")` resolves `true`.
  - Same file, `host accounts waits for the bridge`: on `bootOpened()` (harness opened, no server yet), start `channelHost(opened).accounts.lookup("chat:loop", "s-1")` and record whether it settled after `await new Promise((r) => setTimeout(r, 20))` (expect not settled); then `createServer(boot.opened, boot.config)` (push its `close` to `cleanups`) and await the promise: it resolves `undefined`. This is the existing factory-body lazy-bind test's shape (`host.conversations ... settles once the server exists`) applied to `accounts`.
  - `test/users-api.test.ts`, in the DELETE describe, `deleting a user removes their account links and no one else's`: seed links for the deleted user (two providers) and for the `transferTo` user (one) through `opened.identity.accounts`; after `DELETE /v1/users/<deleted>?transferTo=<other>` → 204, `listForUser(deleted)` is empty and `listForUser(other)` still has its one link (none transferred).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/host-conversations.test.ts test/users-api.test.ts`
Expected: FAIL — `host.accounts` is undefined; links survive deletion.

- [ ] **Step 3: Add `AccountLinkWire`** to `shared/src/views.ts` and `SigrunHost.accounts` to `src/extension.ts` per the Interfaces block.

- [ ] **Step 4: Implement the bridge and seam delegation.** `HostBridge` gains `readonly accounts: SigrunHost["accounts"]`; `createHostBridge` implements it over `opened.identity.accounts`, mapping records to `AccountLinkWire` (the record shape already matches; copy the five fields). The seam host's `accounts` delegates each method through `(await hostBridge()).accounts`, exactly like `users`, and its member doc cites §11.3.

- [ ] **Step 5: Remove links on deletion.** In `DELETE /v1/users/:user`, call `await identity.accounts.removeUser(user)` immediately after `identity.tokens.revokeAllFor(user)` and before `identity.users.remove(user)`. Extend the route's header comment's step list (ownership rewrite → token revocation → link removal → record removal → `userDeleted`).

- [ ] **Step 6: Document.** In `docs/extending.md`: the config-root entries sentence lists `accounts.json` with `users.json`/`api-tokens.json` (mode 0600, sigrun-owned — external-identity links). New section "The accounts surface" after "The users surface": what a link is; provider id forms (`chat:<channel>`, `login:<slug>:<id>`); one link per `(provider, subject)`, same-user re-link is a no-op, different-user link is refused with `account_link_conflict:` (unlink first); errors; deletion removes a user's links and never transfers them; extensions never write the file directly.

- [ ] **Step 7: Run the suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add shared/src/views.ts src/extension.ts src/harness/seam-host.ts src/server/host-bridge.ts src/server/routes/users.ts docs/extending.md test/host-conversations.test.ts test/users-api.test.ts
git commit -m "feat(host): host.accounts and link removal on user delete (multi-user M3a)"
```

### Task 3: `/v1/auth/accounts` — list and remove links

Without this, a chat account linked to the wrong user can only be freed by deleting that user: the gateway's self-link refuses a conflicting link (Global Constraints), so the escape hatch must exist before the engine ships.

**Files:**
- Modify: `shared/src/views.ts` (add `AccountsResponse` beside `AccountLinkWire`)
- Modify: `src/server/routes/auth.ts` (two routes after the token routes)
- Modify: `docs/extending.md` (the accounts section names the routes)
- Test: `test/users-api.test.ts` (new `describe("/v1/auth/accounts")`)

**Interfaces:**
- Consumes: Task 1's `AccountStore` (`list`, `listForUser`, `lookup`, `unlink`); Task 2's `AccountLinkWire`.
- Produces (`shared/src/views.ts`): `interface AccountsResponse { readonly accounts: readonly AccountLinkWire[] }`.
- Produces (routes), mirroring `/v1/auth/tokens` exactly in who-may-see-what:
  - `GET /v1/auth/accounts[?user=<u>]` → `200 AccountsResponse`. No query: the caller's links (`listForUser(principal.user)`); a principal with no user (naive superuser, service token) gets `list()`, the same "whole store for the userless single operator" rule the tokens list uses. `?user=` other than the caller's own name requires admin, else `403 {error: "forbidden"}`.
  - `DELETE /v1/auth/accounts?provider=<p>&subject=<s>` → `204`. Missing/empty `provider` or `subject`: `400 {error: "invalid_query"}`; no such link: `404 {error: "unknown_account"}`; a link owned by another user when the caller is not admin: `403 {error: "forbidden"}`. Query parameters (not path segments) because providers contain `:` and subjects may contain `/`, `+`, `@`.

- [ ] **Step 1: Write the failing tests** in `test/users-api.test.ts`, on the file's existing boot with alice (admin) and bob (non-admin) tokens, links seeded through `opened.identity.accounts`:
  - bob's `GET /v1/auth/accounts` returns only bob's links; alice's `GET ?user=bob` returns bob's; bob's `GET ?user=alice` → 403 `forbidden`; bob's `GET ?user=bob` returns his own.
  - bob's `DELETE ?provider=chat:loop&subject=%2B15551234567` on his own link → 204 and the link is gone (the encoded `+` round-trips).
  - bob's DELETE of alice's link → 403 and the link remains; alice's DELETE of bob's link → 204.
  - DELETE of an absent link → 404 `unknown_account`; DELETE without `subject` → 400 `invalid_query`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/users-api.test.ts`
Expected: FAIL — 404 for the unregistered routes.

- [ ] **Step 3: Implement the two routes** in `src/server/routes/auth.ts` per the Interfaces block, and `AccountsResponse` in `shared/src/views.ts`. The routes reuse Task 2's record-to-wire mapping (export it from wherever Task 2 put it rather than writing a second one).

- [ ] **Step 4: Document** the routes in the `docs/extending.md` accounts section (one line each: who may list, who may remove).

- [ ] **Step 5: Run the suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add shared/src/views.ts src/server/routes/auth.ts docs/extending.md test/users-api.test.ts
git commit -m "feat(auth): list and remove account links (multi-user M3a)"
```

## After this plan

Merge to `main`, then notify the gateway-engine session that its revised Task 3 (`IdentityStore` on `host.accounts`, homes in `homes.json`) can start.
