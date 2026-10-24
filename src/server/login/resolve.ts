import type { LoginProviderContribution, LoginResult } from "../../extension.js";
import {
	AccountLinkConflictError,
	type AccountStore,
} from "../../harness/identity/accounts.js";
import type { InviteStore } from "../../harness/identity/invites.js";
import {
	AdmissionRefusedError,
	type UserDirectory,
} from "../../harness/identity/users.js";
import { setupCodeMatches } from "../../harness/identity/setup-code-check.js";
import { assignUsername } from "./usernames.js";

export type LoginPolicy = NonNullable<LoginProviderContribution["policy"]>;

export type LoginResolution =
	| { kind: "session"; user: string }
	| { kind: "linked"; user: string }
	| { kind: "needs_code"; reason: "setup" | "invite" }
	| {
		kind: "refused";
		error: "not_allowed" | "account_link_conflict" | "isolation_required" | "auth_required";
	};

export interface ResolveLoginDependencies {
	readonly accounts: AccountStore;
	readonly users: UserDirectory;
	readonly invites: InviteStore;
	readonly setupCode: () => string | undefined;
	readonly clearSetupCode: () => Promise<void>;
	readonly policy: LoginPolicy;
}

function allowed(result: LoginResult, policy: LoginPolicy): boolean {
	if (
		policy.allowedGroups !== undefined &&
		!policy.allowedGroups.some((group) => result.groups?.includes(group) === true)
	) return false;
	if (policy.allowedDomains !== undefined) {
		if (result.profile.emailVerified !== true) return false;
		const email = result.profile.email;
		const domain = email?.slice(email.lastIndexOf("@") + 1).toLowerCase();
		if (
			email === undefined ||
			email.lastIndexOf("@") <= 0 ||
			!policy.allowedDomains.some((allowedDomain) => allowedDomain.toLowerCase() === domain)
		) return false;
	}
	return true;
}

function profileFields(profile: LoginResult["profile"]) {
	return {
		...(profile.name === undefined ? {} : { name: profile.name }),
		...(profile.email === undefined ? {} : { email: profile.email }),
	};
}

/** Resolve one verified external identity without ever inferring an existing-user link. */
export async function resolveLogin(
	input: {
		provider: string;
		result: LoginResult;
		linkUser?: string;
		code?: string;
	},
	deps: ResolveLoginDependencies,
): Promise<LoginResolution> {
	const { provider, result } = input;
	try {
		if (input.linkUser !== undefined) {
			await deps.accounts.link({
				provider,
				subject: result.subject,
				user: input.linkUser,
				via: "login",
			});
			await deps.users.setGroups(input.linkUser, provider, result.groups ?? []);
			return { kind: "linked", user: input.linkUser };
		}

		const existing = deps.accounts.lookup(provider, result.subject);
		if (existing !== undefined) {
			if (deps.users.get(existing.user) === undefined) {
				return { kind: "refused", error: "not_allowed" };
			}
			await deps.users.setGroups(existing.user, provider, result.groups ?? []);
			return { kind: "session", user: existing.user };
		}

		if (!deps.users.isClaimed()) {
			if (input.code === undefined || !setupCodeMatches(input.code, deps.setupCode())) {
				return { kind: "needs_code", reason: "setup" };
			}
			const user = assignUsername(result.profile, result.subject, (name) => deps.users.get(name) !== undefined);
			const record = await deps.users.add({
				user,
				...profileFields(result.profile),
				admin: true,
				source: "login",
			});
			await deps.accounts.link({ provider, subject: result.subject, user, via: "login" });
			await deps.users.setGroups(user, provider, result.groups ?? []);
			// Only a complete, successful claim consumes the setup credential.
			await deps.clearSetupCode();
			return { kind: "session", user: record.user };
		}

		if (deps.policy.autoProvision === true && !allowed(result, deps.policy)) {
			return { kind: "refused", error: "not_allowed" };
		}
		if (deps.policy.autoProvision !== true && input.code === undefined) {
			return { kind: "needs_code", reason: "invite" };
		}

		// The invite is redeemed only after the new username is known, and
		// never against an existing user. A refused invite creates nothing.
		const user = assignUsername(result.profile, result.subject, (name) => deps.users.get(name) !== undefined);
		const grant = deps.policy.autoProvision === true
			? { admin: false }
			: await deps.invites.redeem(input.code!, user);
		if (grant === undefined) return { kind: "refused", error: "not_allowed" };
		const record = await deps.users.add({
			user,
			...profileFields(result.profile),
			admin: grant.admin,
			source: "login",
		});
		await deps.accounts.link({ provider, subject: result.subject, user, via: "login" });
		await deps.users.setGroups(user, provider, result.groups ?? []);
		return { kind: "session", user: record.user };
	} catch (error) {
		if (error instanceof AccountLinkConflictError || (
			error instanceof Error && error.message.startsWith("account_link_conflict:")
		)) return { kind: "refused", error: "account_link_conflict" };
		if (error instanceof AdmissionRefusedError) return { kind: "refused", error: error.code };
		if (error instanceof Error && error.message.startsWith("isolation_required:")) {
			return { kind: "refused", error: "isolation_required" };
		}
		if (error instanceof Error && error.message.startsWith("auth_required:")) {
			return { kind: "refused", error: "auth_required" };
		}
		throw error;
	}
}
