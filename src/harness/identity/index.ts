/**
 * The identity stores bundle (core hardening W1 Task 2): the directory,
 * tokens, invites, and the setup code, opened over the resolved store
 * roots — the object `openHarness` exposes as `OpenedHarness.identity`
 * and the auth pipeline/routes consume.
 *
 - `<configDir>/users.json` — the user directory (0600; holds emails);
 - `<configDir>/api-tokens.json` — the token digests (0600);
 - `<stateDir>/invites.json` — the invite digests (0600);
 - `<cacheDir>` — the setup code's home (pod-local, never backed up).
 *
 All four files: atomic writes (temp + rename), mtime-reload reads per
 access (the CLI is a second writer), serialized mutations per store.
 */

import { join } from "node:path";
import type { StoreRoots } from "../stores.js";
import { UserDirectory, type DirectoryUser } from "./users.js";
import {
	TokenStore,
	type TokenRecord,
	generateToken,
	hashToken,
} from "./tokens.js";
import {
	InviteStore,
	type InviteRecord,
	DEFAULT_INVITE_EXPIRY_MS,
} from "./invites.js";
import {
	ensureSetupCode,
	readSetupCode,
	clearSetupCode,
	generateCode,
	setupCodePath,
	CODE_ALPHABET,
} from "./setup-code.js";

export {
	UserDirectory,
	type DirectoryUser,
	TokenStore,
	type TokenRecord,
	generateToken,
	hashToken,
	InviteStore,
	type InviteRecord,
	DEFAULT_INVITE_EXPIRY_MS,
	ensureSetupCode,
	readSetupCode,
	clearSetupCode,
	generateCode,
	setupCodePath,
	CODE_ALPHABET,
};

/** The file names each store owns under its root. */
const USERS_FILE = "users.json";
const TOKENS_FILE = "api-tokens.json";
const INVITES_FILE = "invites.json";

/** The boot-opened identity surfaces (spec §5.4/§5.8). */
export interface IdentityStores {
	/** The user directory at `<configDir>/users.json`. */
	readonly users: UserDirectory;
	/** The token store at `<configDir>/api-tokens.json`. */
	readonly tokens: TokenStore;
	/** The invite store at `<stateDir>/invites.json`. */
	readonly invites: InviteStore;
	/**
	 * The cache root — the setup code's home (`<cacheDir>/setup-code`).
	 * Carried so onboarding needs nothing but this bundle.
	 */
	readonly cacheDir: string;
}

/**
 * Open the identity stores over resolved roots (cheap — no I/O; every
 * file is created lazily by its first write). Called by boot after
 * `ensureStoreRoots`, and by tests directly over tmp dirs.
 */
export function openIdentityStores(roots: StoreRoots): IdentityStores {
	return {
		users: new UserDirectory(join(roots.configDir, USERS_FILE)),
		tokens: new TokenStore(join(roots.configDir, TOKENS_FILE)),
		invites: new InviteStore(join(roots.stateDir, INVITES_FILE)),
		cacheDir: roots.cacheDir,
	};
}
