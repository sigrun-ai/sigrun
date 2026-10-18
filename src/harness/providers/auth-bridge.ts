/**
 * The auth.json → pi-ai credential bridge (provider plugins Task 2).
 *
 * pi-ai's `Models` resolves auth through a `CredentialStore` (stored
 * credentials own the provider; ambient env is consulted only when nothing
 * is stored) plus an `AuthContext` (ambient `env`/`fileExists` access).
 * Sigrun's credentials are operator-provisioned through auth.json (the
 * 2026-10-13 config-surface ruling), so the bridge is READ-ONLY: reads
 * project the file into `api_key` credentials using the same `"default"`
 * -first order as the degenerate env provider's
 * {@link resolveDegenerateApiKey}, and every write path refuses loudly
 * rather than pretending the harness owns credential lifecycle.
 *
 * The `CredentialStore`/`AuthContext`/credential shapes below are
 * structural re-declarations of pi-ai's, narrowed to the `api_key` subset
 * this bridge produces (sigrun stores no OAuth credentials). The narrowed
 * shapes stay assignable to pi-ai's full interfaces at the `createModels`
 * call site in `collectProviders`.
 */

import { AuthStore, DEFAULT_AUTH_KEY } from "../auth.js";

/** pi-ai `ApiKeyCredential` (structural) — the only kind sigrun stores. */
export interface ApiKeyCredential {
	readonly type: "api_key";
	readonly key?: string;
}

/** pi-ai `Credential` (structural), narrowed to the api_key variant. */
export type Credential = ApiKeyCredential;

/** pi-ai `CredentialInfo` (structural): non-secret listing metadata. */
export interface CredentialInfo {
	readonly providerId: string;
	readonly type: Credential["type"];
}

/** pi-ai `CredentialStore` (structural): one credential per provider id. */
export interface CredentialStore {
	read(providerId: string): Promise<Credential | undefined>;
	list(): Promise<readonly CredentialInfo[]>;
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined>;
	delete(providerId: string): Promise<void>;
}

/**
 * pi-ai `AuthContext` (structural): ambient access for auth resolution.
 * Injectable so the harness (and tests) resolve env/file lookups off the
 * operator-provided environment, never `process.env` directly.
 */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/** Whether a file exists; supports a leading `~` (pi-ai contract). */
	fileExists(path: string): Promise<boolean>;
}

/** The refusal every write attempt gets: auth.json is operator-owned. */
export function operatorProvisionedError(): Error {
	return new Error("sigrun credentials are operator-provisioned; edit auth.json");
}

/**
 * Adapt an {@link AuthStore} into a pi-ai `CredentialStore`.
 *
 * `read(providerId)` returns `{type:"api_key", key}` from auth.json —
 * the `"default"` entry first, then the provider's own entry (the same
 * order as the degenerate env provider) — or `undefined` when neither
 * exists. `list()` maps the file's provider keys. `modify`/`delete` throw:
 * credentials are operator-provisioned.
 */
export function authStoreCredentialStore(auth: AuthStore): CredentialStore {
	return {
		read: async (providerId) => {
			const file = auth.read();
			const fromDefault = file[DEFAULT_AUTH_KEY]?.apiKey;
			if (fromDefault !== undefined) {
				return { type: "api_key", key: fromDefault };
			}
			const fromProvider = file[providerId]?.apiKey;
			if (fromProvider !== undefined) {
				return { type: "api_key", key: fromProvider };
			}
			return undefined;
		},
		list: async () =>
			Object.keys(auth.read()).map(
				(providerId): CredentialInfo => ({ providerId, type: "api_key" }),
			),
		modify: async () => {
			throw operatorProvisionedError();
		},
		delete: async () => {
			throw operatorProvisionedError();
		},
	};
}
