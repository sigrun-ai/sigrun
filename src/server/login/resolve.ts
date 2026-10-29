import { deriveUsername, withSuffix } from "@sigrun/shared/usernames";
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
import { hashToken } from "../../harness/identity/tokens.js";
import { withClaimLock } from "../auth/claim-lock.js";
import { SetupClaimStore } from "./setup-claim.js";

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
	readonly setupClaims: SetupClaimStore;
	readonly policy: LoginPolicy;
}

interface LoginInput {
	readonly provider: string;
	readonly result: LoginResult;
	readonly linkUser?: string;
	readonly code?: string;
}

interface Retry {
	readonly kind: "retry";
	readonly error: Error;
}

/** The first usable profile claim wins; the external subject remains exact. */
export function loginUsernameCandidate(
	profile: LoginResult["profile"],
	subject: string,
): string {
	for (const candidate of [profile.username, profile.email, subject]) {
		if (candidate === undefined) continue;
		const derived = deriveUsername(candidate);
		if (derived !== undefined) return derived;
	}
	return "user";
}

function isAddConflict(error: unknown): boolean {
	return error instanceof Error && /^user ".*" already exists$/.test(error.message);
}

function isLinkConflict(error: unknown): boolean {
	return error instanceof AccountLinkConflictError || (
		error instanceof Error && error.message.startsWith("account_link_conflict:")
	);
}

async function sessionForLinkedUser(
	input: LoginInput,
	deps: ResolveLoginDependencies,
): Promise<LoginResolution> {
	const existing = deps.accounts.lookup(input.provider, input.result.subject)!;
	if (deps.users.get(existing.user) === undefined) {
		return { kind: "refused", error: "not_allowed" };
	}
	await deps.users.setGroups(existing.user, input.provider, input.result.groups ?? []);
	return { kind: "session", user: existing.user };
}

/** Lock-free provisioning body; add/link conflicts become retry signals. */
async function provisionLogin(
	input: LoginInput,
	deps: ResolveLoginDependencies,
): Promise<LoginResolution | Retry> {
	if (deps.accounts.lookup(input.provider, input.result.subject) !== undefined) {
		return sessionForLinkedUser(input, deps);
	}

	// Admission is checked before redemption so an M1 refusal burns no invite.
	deps.users.checkAdmission();
	const base = loginUsernameCandidate(input.result.profile, input.result.subject);
	const autoProvision = deps.policy.autoProvision === true;
	const user = autoProvision
		? withSuffix(base, (name) => deps.users.get(name) !== undefined)
		: base;
	if (!autoProvision && deps.users.get(user) !== undefined) {
		return { kind: "refused", error: "not_allowed" };
	}
	const grant = autoProvision
		? { admin: false }
		: await deps.invites.redeem(input.code!, user);
	if (grant === undefined) return { kind: "refused", error: "not_allowed" };
	try {
		const record = await deps.users.add({
			user,
			...profileFields(input.result.profile),
			admin: grant.admin,
			source: "login",
		});
		try {
			await deps.accounts.link({
				provider: input.provider,
				subject: input.result.subject,
				user,
				via: "login",
			});
		} catch (error) {
			if (isLinkConflict(error)) {
				await deps.users.remove(record.user);
				return { kind: "retry", error: error as Error };
			}
			throw error;
		}
		await deps.users.setGroups(user, input.provider, input.result.groups ?? []);
		return { kind: "session", user: record.user };
	} catch (error) {
		if (isAddConflict(error)) return { kind: "retry", error: error as Error };
		throw error;
	}
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
			// A link records identity only. Groups arrive on this account's
			// next sign-in, never on a session/token-authenticated request.
			return { kind: "linked", user: input.linkUser };
		}

		const existing = deps.accounts.lookup(provider, result.subject);
		if (existing !== undefined) return sessionForLinkedUser(input, deps);

		const setupResolution = await withClaimLock(async (): Promise<LoginResolution | undefined> => {
			const validSetupCode = input.code !== undefined && setupCodeMatches(input.code, deps.setupCode());
			if (deps.users.isClaimed()) {
				// A setup code never creates a user on a claimed server. It may
				// only finish the exact claim whose subject/user/code were recorded.
				if (!validSetupCode) return undefined;
				const claim = deps.setupClaims.matches(provider, result.subject, input.code!);
				if (claim === undefined || deps.users.get(claim.user) === undefined) {
					return { kind: "refused", error: "not_allowed" };
				}
				await deps.accounts.link({ provider, subject: result.subject, user: claim.user, via: "login" });
				await deps.users.setGroups(claim.user, provider, result.groups ?? []);
				await deps.clearSetupCode();
				await deps.setupClaims.clear();
				return { kind: "session", user: claim.user };
			}
			if (!validSetupCode) return { kind: "needs_code", reason: "setup" };
			const claim = deps.setupClaims.matches(provider, result.subject, input.code!);
			const user = claim?.user ?? withSuffix(
				loginUsernameCandidate(result.profile, result.subject),
				(name) => deps.users.get(name) !== undefined,
			);
			// Persist the recovery breadcrumb before creating the user. On a
			// retry, only this exact subject may finish the claim; if the user
			// write did not happen, it is retried under the recorded name.
			await deps.setupClaims.record({
				user,
				provider,
				subject: result.subject,
				codeSha256: hashToken(input.code!),
			});
			const record = deps.users.get(user) ?? await deps.users.add({
				user,
				...profileFields(result.profile),
				admin: true,
				source: "login",
			});
			await deps.accounts.link({ provider, subject: result.subject, user, via: "login" });
			await deps.users.setGroups(user, provider, result.groups ?? []);
			await deps.clearSetupCode();
			await deps.setupClaims.clear();
			return { kind: "session", user: record.user };
		});
		if (setupResolution !== undefined) return setupResolution;

		if (deps.policy.autoProvision === true && !allowed(result, deps.policy)) {
			return { kind: "refused", error: "not_allowed" };
		}
		if (deps.policy.autoProvision !== true && input.code === undefined) {
			return { kind: "needs_code", reason: "invite" };
		}

		const provisioned = await withClaimLock(() => provisionLogin(input, deps));
		if (provisioned.kind !== "retry") return provisioned;
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

	// Conflicts from another writer retry once, only after the section returns.
	const second = await withClaimLock(() => provisionLogin(input, deps));
	if (second.kind === "retry") throw second.error;
	return second;
}
