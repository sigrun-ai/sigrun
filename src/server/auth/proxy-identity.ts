/**
 * Proxy identity resolution (username-derivation D3): a trusted proxy
 * header names an external subject, not necessarily a directory key.
 * Folded subjects are linked to users; case variants of an existing key
 * adopt it, and every other new identity gets a derived, suffixed key.
 *
 * The request pipeline owns trust and diagnostics. The claim route owns
 * its lock; only the pipeline entry below acquires `withClaimLock`.
 */

import {
	deriveUsername,
	foldSubject,
	isUsernameKey,
	withSuffix,
} from "@sigrun/shared/usernames";
import {
	AccountLinkConflictError,
	type AccountStore,
} from "../../harness/identity/accounts.js";
import type { DirectoryUser, UserDirectory } from "../../harness/identity/users.js";
import { withClaimLock } from "./claim-lock.js";

export type ProxyProfile = { readonly name?: string; readonly email?: string };

export type ProxyResolution =
	| { kind: "user"; record: DirectoryUser }
	| { kind: "invalid" }
	| { kind: "not_provisioned" };

interface ProxyDeps {
	readonly users: UserDirectory;
	readonly accounts: AccountStore;
}

interface Retry {
	readonly kind: "retry";
	readonly error: Error;
}

function identityParts(header: string): { subject: string; base: string } | undefined {
	const subject = foldSubject(header);
	const base = deriveUsername(header);
	if (subject.length > 512 || base === undefined) return undefined;
	return { subject, base };
}

function linkedUser(deps: ProxyDeps, subject: string): DirectoryUser | undefined {
	const link = deps.accounts.lookup("proxy", subject);
	return link === undefined ? undefined : deps.users.get(link.user);
}

function isAddConflict(error: unknown): boolean {
	return error instanceof Error && /^user ".*" already exists$/.test(error.message);
}

/** Lock-free resolution body; conflicts become a signal for the pipeline's retry. */
async function provisionAttempt(
	deps: ProxyDeps,
	header: string,
	profile: ProxyProfile,
	opts: { provision: boolean; admin?: boolean },
): Promise<ProxyResolution | Retry> {
	const parts = identityParts(header);
	if (parts === undefined) return { kind: "invalid" };
	const linked = linkedUser(deps, parts.subject);
	if (linked !== undefined) return { kind: "user", record: linked };
	if (isUsernameKey(parts.subject)) {
		const existing = deps.users.get(parts.subject);
		if (existing !== undefined) {
			try {
				await deps.accounts.link({
					provider: "proxy",
					subject: parts.subject,
					user: existing.user,
					via: "proxy",
				});
				return { kind: "user", record: existing };
			} catch (error) {
				if (error instanceof AccountLinkConflictError) return { kind: "retry", error };
				throw error;
			}
		}
	}
	if (!opts.provision) return { kind: "not_provisioned" };
	const key = withSuffix(parts.base, (candidate) => deps.users.get(candidate) !== undefined);
	try {
		const record = await deps.users.add({
			user: key,
			...(profile.name === undefined ? {} : { name: profile.name }),
			...(profile.email === undefined ? {} : { email: profile.email }),
			admin: opts.admin ?? false,
			source: "proxy",
		});
		try {
			await deps.accounts.link({
				provider: "proxy",
				subject: parts.subject,
				user: record.user,
				via: "proxy",
			});
			return { kind: "user", record };
		} catch (error) {
			if (error instanceof AccountLinkConflictError) {
				// Never leave the user created by this attempt attached to no
				// identity when the link itself was refused.
				await deps.users.remove(record.user);
				return { kind: "retry", error };
			}
			throw error;
		}
	} catch (error) {
		if (isAddConflict(error)) return { kind: "retry", error: error as Error };
		throw error;
	}
}

/** One lookup/lock pass. A retry is observed only AFTER the lock returns. */
async function resolveOnce(
	deps: ProxyDeps,
	header: string,
	profile: ProxyProfile,
	opts: { provision: boolean },
): Promise<ProxyResolution | Retry> {
	const parts = identityParts(header);
	if (parts === undefined) return { kind: "invalid" };
	const linked = linkedUser(deps, parts.subject);
	if (linked !== undefined) return { kind: "user", record: linked };
	return await withClaimLock(() => provisionAttempt(deps, header, profile, opts));
}

/** Pipeline entry: lookup outside the lock; on a miss, provision under it. */
export async function resolveProxyUser(
	deps: ProxyDeps,
	header: string,
	profile: ProxyProfile,
	opts: { provision: boolean },
): Promise<ProxyResolution> {
	const first = await resolveOnce(deps, header, profile, opts);
	if (first.kind !== "retry") return first;
	// A second-process conflict retries resolution once, after the claim
	// section has returned. A second conflict is a real failure, not a loop.
	const second = await resolveOnce(deps, header, profile, opts);
	if (second.kind === "retry") throw second.error;
	return second;
}

/** Lock-free body. Callers MUST already hold `withClaimLock`. */
export async function provisionProxyUser(
	deps: ProxyDeps,
	header: string,
	profile: ProxyProfile,
	opts: { provision: boolean; admin?: boolean },
): Promise<ProxyResolution> {
	const result = await provisionAttempt(deps, header, profile, opts);
	if (result.kind === "retry") throw result.error;
	return result;
}

/** Read-only key computation for an already-vouched header. */
export function previewProxyUser(
	deps: ProxyDeps,
	header: string,
): { user: string; subject: string } | undefined {
	const parts = identityParts(header);
	if (parts === undefined) return undefined;
	const linked = linkedUser(deps, parts.subject);
	if (linked !== undefined) return { user: linked.user, subject: header };
	if (isUsernameKey(parts.subject) && deps.users.get(parts.subject) !== undefined) {
		return { user: parts.subject, subject: header };
	}
	return {
		user: withSuffix(parts.base, (candidate) => deps.users.get(candidate) !== undefined),
		subject: header,
	};
}
