# Provider credential precedence fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `auth.json`'s `"default"` key from being handed to every plugin provider. `"default"` applies only to the provider of the resolved default model.

**Architecture:** `authStoreCredentialStore` gains a lazily read default-provider id. `collectProviders` passes a closure over the `defaultModel` it resolves, so the bridge reads it at `read()` time: credentials are resolved after collection, never during it.

**Tech Stack:** TypeScript (NodeNext), vitest, `@earendil-works/pi-ai` `createModels`.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-core-hardening-design.md` §6.11. It is the one W2 item that ships before the build-and-webui merge: neither file below is touched by that branch.

## Global Constraints

- Key material is never logged or returned by any route (README, `auth.json` section).
- The bridge stays read-only: `modify`/`delete` keep throwing `operatorProvisionedError()`.
- Tests own their literals: synthetic provider ids (`acme`, `bifrost`), `sk-…` placeholder keys.
- Verification: `npm test` + `npm run typecheck` clean before the commit.

## Review Focus

1. **A plugin provider that IS the default** (e.g. `defaultModel: "bifrost/x"` with only a `"default"` entry) must still receive the `"default"` key. This is the README's documented meaning; Task 1's second test pins it.
2. **A plugin provider that is NOT the default, with no entry of its own**, gets `undefined`: pi-ai then skips its refresh, and readiness reports `not_configured`. Task 1's third test pins it.
3. **The degenerate env provider** keeps resolving `"default"` → own entry → `OPENAI_API_KEY` through `resolveDegenerateApiKey`, unchanged. The existing `providers.test.ts` suite is the guard; the plan does not touch that function.
4. **`list()` behavior** is unchanged (all keys in the file); only `read()` changes.
5. **No default resolved yet** (the closure returns `undefined`): `"default"` applies to nobody. `collectProviders` throws before any read can happen in that case, so this is defensive only, but the bridge must not crash.

---

### Task 1: Default-scoped `"default"` credential

**Files:**
- Modify: `src/harness/providers/auth-bridge.ts`
  - module docstring lines 1-19;
  - `authStoreCredentialStore` and its doc, lines ~63-95.
- Modify: `src/harness/providers/index.ts`
  - the `createModels` call, ~lines 244-250: pass the closure;
  - `defaultModel` is already a `let` in the same function.
- Modify: `test/provider-auth-bridge.test.ts`
  - replace the test "read falls back to the default key then the provider key";
  - update the three other `authStoreCredentialStore(store)` call sites to the new signature.
- Modify: `README.md` `auth.json` section: one sentence saying `"default"` is used only by the default model's provider.

**Interfaces:**
- Produces: `authStoreCredentialStore(auth: AuthStore, defaultProviderId: () => string | undefined): CredentialStore`.
  - `read(id)`:
    - when `id === defaultProviderId()`: `"default"` → own entry;
    - otherwise: own entry only;
    - `undefined` when nothing matches.
- Consumes: `AuthStore`, `DEFAULT_AUTH_KEY` from `src/harness/auth.ts` (unchanged).

- [ ] **Step 1: Write the failing tests** in `test/provider-auth-bridge.test.ts`. Remove the old "default key then the provider key" test and add:

```ts
test("a non-default provider reads only its own entry", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { default: { apiKey: "sk-from-default" }, acme: { apiKey: "sk-from-acme" } });
		const credentials = authStoreCredentialStore(store, () => "openai");
		expect(await credentials.read("acme")).toEqual({ type: "api_key", key: "sk-from-acme" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the default model's provider reads default first, then its own entry", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { default: { apiKey: "sk-from-default" }, bifrost: { apiKey: "sk-from-bifrost" } });
		const credentials = authStoreCredentialStore(store, () => "bifrost");
		expect(await credentials.read("bifrost")).toEqual({ type: "api_key", key: "sk-from-default" });
		writeAuth(dir, { bifrost: { apiKey: "sk-from-bifrost" } });
		expect(await credentials.read("bifrost")).toEqual({ type: "api_key", key: "sk-from-bifrost" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a non-default provider without its own entry gets nothing, even with a default entry", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeAuth(dir, { default: { apiKey: "sk-from-default" } });
		const credentials = authStoreCredentialStore(store, () => "openai");
		expect(await credentials.read("acme")).toBeUndefined();
		// No default resolved yet: "default" applies to nobody.
		expect(await authStoreCredentialStore(store, () => undefined).read("openai")).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
```

  The three surviving tests pass `() => undefined` as the second argument (none of them uses `"default"`).

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npx vitest run test/provider-auth-bridge.test.ts`
  Expected: FAIL. The first test gets `sk-from-default` instead of `sk-from-acme`; the third gets a key instead of `undefined`. (The typecheck also flags the extra argument; vitest strips types, so the assertions are what fail.)

- [ ] **Step 3: Implement** `authStoreCredentialStore(auth, defaultProviderId)` in `src/harness/providers/auth-bridge.ts`.
  - Consult `DEFAULT_AUTH_KEY` only when `providerId === defaultProviderId()`.
  - Call the closure per `read()`; never cache it.
  - Rewrite the docstrings so they state the scoping rule instead of "the same `"default"`-first order as the degenerate env provider".

- [ ] **Step 4: Wire it in `collectProviders`** (`src/harness/providers/index.ts`).
  - Call `authStoreCredentialStore(options.auth, () => defaultModel?.provider)`.
  - The arrow closes over the existing `let defaultModel`, so it sees the value assigned after the contributor loop.
  - Update the comment above `createModels` ("auth.json owns stored credentials for every contributed + degenerate provider") to say `"default"` is default-provider-only.

- [ ] **Step 5: Add an integration test** to `test/providers.test.ts`, next to the existing `auth.json` tests (reuse their `freshAuthDir` and `authPath`):

```ts
test("auth.json \"default\" reaches only the default model's provider, never other plugins", async () => {
	const { dir, store } = freshAuthDir();
	try {
		writeFileSync(authPath(dir), JSON.stringify({
			default: { apiKey: "sk-default" },
			acme: { apiKey: "sk-acme" },
		}), "utf8");
		// keyedProvider(id): createProvider({ id, name: id, models: [], auth: { apiKey: { name: "key",
		//   resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } } })
		const contributor = { name: "plugins", providers: [
			{ provider: keyedProvider("acme") },
			{ provider: keyedProvider("other") },
			{ provider: keyedProvider("third") },
		] };
		const { models } = collectProviders([contributor], { SIGRUN_DEFAULT_MODEL: "other/m" },
			createProviderMergeSink(), { auth: store });
		expect((await models.getAuth("acme"))?.auth).toMatchObject({ apiKey: "sk-acme" });
		expect((await models.getAuth("other"))?.auth).toMatchObject({ apiKey: "sk-default" });
		expect(await models.getAuth("third")).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
```

  `keyedProvider` is a small helper in the test file, built as the comment shows.

  The existing test "auth.json \"default\" key wins over the provider's own entry (ruling order)" is unchanged: it exercises the degenerate (default) provider, for which the order is preserved.

- [ ] **Step 6: Run the targeted tests**

  Run: `npx vitest run test/provider-auth-bridge.test.ts test/providers.test.ts test/provider-plugins-e2e.test.ts test/auth-check-readiness.test.ts`
  Expected: PASS.

- [ ] **Step 7: Full verification**

  Run: `npm test && npm run typecheck`
  Expected: all files pass; `tsc --noEmit` prints nothing.

- [ ] **Step 8: README sentence + commit.** In the `auth.json` section, after the JSON example, add: "`"default"` is used only by the provider of the resolved default model; every other provider reads its own entry."

```bash
git add src/harness/providers/auth-bridge.ts src/harness/providers/index.ts \
  test/provider-auth-bridge.test.ts test/providers.test.ts README.md
git commit -m "providers: scope auth.json \"default\" to the default model's provider (no cross-provider key leak)"
```
