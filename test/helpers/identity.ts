/**
 * Test identity seeding (core hardening W1 Task 3): the unclaimed gate
 * (pipeline stage 4) applies under EVERY auth method, so every
 * in-process boot helper needs a CLAIMED directory. `seededIdentity`
 * builds the {@link IdentityStores} bundle over a tmp dir with one
 * admin directory user (default `"tester"`) already written — the boot
 * options seam (`OpenHarnessOptions.identity`) then wins over
 * `openIdentityStores(roots)`.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	AccountStore,
	InviteStore,
	TokenStore,
	UserDirectory,
	type IdentityStores,
} from "../../src/harness/identity/index.js";

/**
 * The unclaimed counterpart (core hardening W1 Task 6): the same store
 * bundle with an EMPTY directory — the setup-gate posture, hermetically
 * rooted in the tmp dir. Never omit the injection seam for this posture:
 * `openIdentityStores` falls back to the host's real config root, which
 * may carry a claimed directory from local runs.
 */
export async function unclaimedIdentity(
	dir: string,
): Promise<IdentityStores> {
	const stateDir = join(dir, "state");
	const cacheDir = join(dir, "cache");
	await mkdir(stateDir, { recursive: true });
	await mkdir(cacheDir, { recursive: true });
	const users = new UserDirectory(join(dir, "users.json"));
	return {
		users: new UserDirectory(join(dir, "users.json")),
		tokens: new TokenStore(join(dir, "api-tokens.json")),
		accounts: new AccountStore(
			join(dir, "accounts.json"),
			users,
		),
		invites: new InviteStore(join(stateDir, "invites.json")),
		cacheDir,
	};
}

/**
 * Open the four identity stores over `dir` with one claimed admin user.
 * Layout mirrors `openIdentityStores`: users/tokens at the config root,
 * invites under `state/`, `cache/` the setup code's home.
 */
export async function seededIdentity(
	dir: string,
	user = "tester",
): Promise<IdentityStores> {
	const bundle = await unclaimedIdentity(dir);
	// Idempotent: multi-phase tests (restart against the SAME config root)
	// re-seed — the directory survived on disk, so the second seed is a
	// no-op when the user already exists.
	if (bundle.users.get(user) === undefined) {
		await bundle.users.add({
			user,
			name: "Test User",
			admin: true,
			source: "cli",
		});
	}
	return bundle;
}
