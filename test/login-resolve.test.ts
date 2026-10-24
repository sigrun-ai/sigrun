import { describe, expect, test } from "vitest";
import type { LoginResult } from "../src/extension.js";
import type { AccountStore } from "../src/harness/identity/accounts.js";
import type { InviteStore } from "../src/harness/identity/invites.js";
import {
	AdmissionRefusedError,
	type DirectoryUser,
	type UserDirectory,
} from "../src/harness/identity/users.js";
import { resolveLogin, type LoginPolicy } from "../src/server/login/resolve.js";
import { assignUsername } from "../src/server/login/usernames.js";
import { SetupClaimStore } from "../src/server/login/setup-claim.js";

const PROVIDER = "login:fixture:oidc";

class FakeDirectory {
	records: DirectoryUser[] = [];
	groups: Array<{ user: string; source: string; values: readonly string[] }> = [];
	admission?: AdmissionRefusedError;
	admissionChecks = 0;
	addBarrier?: Promise<void>;
	addCalls = 0;
	claimedObservations: boolean[] = [];

	checkAdmission(): void {
		this.admissionChecks++;
		if (this.records.length > 0 && this.admission !== undefined) throw this.admission;
	}
	isClaimed(): boolean {
		const claimed = this.records.length > 0;
		this.claimedObservations.push(claimed);
		return claimed;
	}
	list(): DirectoryUser[] { return this.records; }
	get(user: string): DirectoryUser | undefined {
		return this.records.find((record) => record.user === user);
	}
	async add(input: Omit<DirectoryUser, "createdAt">): Promise<DirectoryUser> {
		this.addCalls++;
		this.checkAdmission();
		if (this.addBarrier !== undefined) await this.addBarrier;
		if (this.get(input.user) !== undefined) throw new Error("duplicate");
		const record = { ...input, createdAt: 1 };
		this.records.push(record);
		return record;
	}
	async setGroups(user: string, source: string, values: readonly string[]): Promise<DirectoryUser> {
		this.groups = this.groups.filter((entry) => !(entry.user === user && entry.source === source));
		this.groups.push({ user, source, values: [...values] });
		return this.get(user)!;
	}
}

class FakeAccounts {
	links: Array<{ provider: string; subject: string; user: string; via: string }> = [];
	linkBarrier?: Promise<void>;
	constructor(readonly users: FakeDirectory) {}
	lookup(provider: string, subject: string) {
		return this.links.find((link) => link.provider === provider && link.subject === subject);
	}
	async link(input: { provider: string; subject: string; user: string; via: string }) {
		const existing = this.lookup(input.provider, input.subject);
		if (existing !== undefined) {
			if (existing.user !== input.user) throw new Error(`account_link_conflict: ${input.provider}`);
			return existing;
		}
		if (this.users.get(input.user) === undefined) throw new Error("unknown user");
		if (this.linkBarrier !== undefined) await this.linkBarrier;
		this.links.push(input);
		return input;
	}
}

class FakeInvites {
	used: string[] = [];
	constructor(readonly grants: Record<string, { admin: boolean }> = {}) {}
	async redeem(code: string, user: string): Promise<{ admin: boolean } | undefined> {
		if (this.used.includes(code)) return undefined;
		const grant = this.grants[code];
		if (grant === undefined) return undefined;
		this.used.push(code);
		return grant;
	}
}

interface Fixture {
	users: FakeDirectory;
	accounts: FakeAccounts;
	invites: FakeInvites;
	setup: string | undefined;
	cleared: number;
	setupClaims: SetupClaimStore;
}

function fixture(options: {
	claimed?: boolean;
	setup?: string;
	invites?: Record<string, { admin: boolean }>;
} = {}): Fixture {
	const users = new FakeDirectory();
	if (options.claimed ?? true) {
		users.records.push({ user: "owner", admin: true, source: "cli", createdAt: 1 });
	}
	const accounts = new FakeAccounts(users);
	return {
		users,
		accounts,
		invites: new FakeInvites(options.invites),
		setup: options.setup,
		cleared: 0,
		setupClaims: new SetupClaimStore(),
	};
}

function deps(f: Fixture, policy: LoginPolicy = {}) {
	return {
		accounts: f.accounts as unknown as AccountStore,
		users: f.users as unknown as UserDirectory,
		invites: f.invites as unknown as InviteStore,
		setupCode: () => f.setup,
		clearSetupCode: async () => { f.cleared++; f.setup = undefined; },
		setupClaims: f.setupClaims,
		policy,
	};
}

function result(patch: Partial<LoginResult> = {}): LoginResult {
	return {
		subject: "subject-1",
		profile: { username: "Alice Smith", name: "Alice Smith" },
		groups: ["family"],
		...patch,
	};
}

describe("assignUsername", () => {
	test("normalizes profile usernames, leading punctuation and empty candidates", () => {
		expect(assignUsername({ username: "Alice Smith" }, "subject", () => false)).toBe("alice-smith");
		expect(assignUsername({ username: ".x" }, "subject", () => false)).toBe("x");
		expect(assignUsername({}, "", () => false)).toBe("user");
		expect(assignUsername({}, "", (user) => user === "user")).toBe("user-2");
	});

	test("uses email local part then subject and suffixes every collision", () => {
		expect(assignUsername({ email: "Alice@Example.COM" }, "subject", () => false)).toBe("alice");
		expect(assignUsername({}, "Subject/123", () => false)).toBe("subject-123");
		const taken = new Set(["alice", "alice-2", "alice-3"]);
		expect(assignUsername({ username: "Alice" }, "other", (user) => taken.has(user))).toBe("alice-4");
	});
});

describe("resolveLogin", () => {
	test("an existing link creates a session and refreshes groups on every login", async () => {
		const f = fixture();
		f.accounts.links.push({ provider: PROVIDER, subject: "subject-1", user: "owner", via: "login" });
		const first = await resolveLogin({ provider: PROVIDER, result: result() }, deps(f));
		expect(first).toEqual({ kind: "session", user: "owner" });
		expect(f.users.groups).toEqual([{ user: "owner", source: PROVIDER, values: ["family"] }]);
		const second = await resolveLogin({
			provider: PROVIDER,
			result: result({ groups: ["family", "admins"] }),
		}, deps(f));
		expect(second).toEqual({ kind: "session", user: "owner" });
		expect(f.users.groups[0]?.values).toEqual(["family", "admins"]);
	});

	test("an explicit link never creates a session and refuses a conflicting holder", async () => {
		const f = fixture();
		f.users.records.push({ user: "bob", admin: false, source: "cli", createdAt: 1 });
		expect(await resolveLogin({ provider: PROVIDER, result: result(), linkUser: "bob" }, deps(f)))
			.toEqual({ kind: "linked", user: "bob" });
		expect(f.accounts.links[0]).toMatchObject({ user: "bob", via: "login" });
		expect(f.users.groups).toEqual([{ user: "bob", source: PROVIDER, values: ["family"] }]);
		expect(await resolveLogin({ provider: PROVIDER, result: result(), linkUser: "owner" }, deps(f)))
			.toEqual({ kind: "refused", error: "account_link_conflict" });
	});

	test("an unclaimed directory needs the setup code and a valid claim creates an admin and clears it", async () => {
		const f = fixture({ claimed: false, setup: "AAAA-BBBB" });
		expect(await resolveLogin({ provider: PROVIDER, result: result() }, deps(f)))
			.toEqual({ kind: "needs_code", reason: "setup" });
		expect(f.users.records).toHaveLength(0);
		expect(f.cleared).toBe(0);
		expect(await resolveLogin({ provider: PROVIDER, result: result(), code: "wrong" }, deps(f)))
			.toEqual({ kind: "needs_code", reason: "setup" });
		expect(f.cleared).toBe(0);
		expect(await resolveLogin({ provider: PROVIDER, result: result(), code: "AAAA-BBBB" }, deps(f)))
			.toEqual({ kind: "session", user: "alice-smith" });
		expect(f.users.records[0]).toMatchObject({ user: "alice-smith", admin: true, source: "login" });
		expect(f.accounts.links[0]?.user).toBe("alice-smith");
		expect(f.cleared).toBe(1);
	});

	test("auto-provision creates a non-admin and a username collision never links the existing user", async () => {
		const f = fixture();
		f.users.records.push({ user: "alice", admin: false, source: "cli", createdAt: 1 });
		const resolved = await resolveLogin({
			provider: PROVIDER,
			result: result({ profile: { username: "alice" } }),
		}, deps(f, { autoProvision: true }));
		expect(resolved).toEqual({ kind: "session", user: "alice-2" });
		expect(f.users.get("alice-2")).toMatchObject({ admin: false, source: "login" });
		expect(f.accounts.links[0]).toMatchObject({ user: "alice-2" });
		expect(f.accounts.links.some((link) => link.user === "alice")).toBe(false);
	});

	test("allowedGroups requires an intersection", async () => {
		const f = fixture();
		expect(await resolveLogin({ provider: PROVIDER, result: result({ groups: ["other"] }) }, deps(f, {
			autoProvision: true,
			allowedGroups: ["family"],
		}))).toEqual({ kind: "refused", error: "not_allowed" });
		expect(f.users.records).toHaveLength(1);
	});

	test("allowedDomains accepts only a verified matching email", async () => {
		const allowed = { autoProvision: true, allowedDomains: ["example.com"] };
		const f = fixture();
		const email = "alice@example.com";
		expect(await resolveLogin({
			provider: PROVIDER,
			result: result({ profile: { username: "alice", email, emailVerified: false } }),
		}, deps(f, allowed))).toEqual({ kind: "refused", error: "not_allowed" });
		expect(await resolveLogin({
			provider: PROVIDER,
			result: result({ profile: { username: "alice", email, emailVerified: true } }),
		}, deps(f, allowed))).toEqual({ kind: "session", user: "alice" });
	});

	test("a claimed directory without auto-provision redeems an invite and inherits its admin grant", async () => {
		const f = fixture({ invites: { "GOOD-CODE": { admin: true } } });
		expect(await resolveLogin({ provider: PROVIDER, result: result() }, deps(f)))
			.toEqual({ kind: "needs_code", reason: "invite" });
		expect(await resolveLogin({ provider: PROVIDER, result: result(), code: "BAD" }, deps(f)))
			.toEqual({ kind: "refused", error: "not_allowed" });
		expect(await resolveLogin({ provider: PROVIDER, result: result(), code: "GOOD-CODE" }, deps(f)))
			.toEqual({ kind: "session", user: "alice-smith" });
		expect(f.users.get("alice-smith")).toMatchObject({ admin: true, source: "login" });
		expect(f.invites.used).toEqual(["GOOD-CODE"]);
	});

	test("concurrent setup claims create exactly one admin under the claim lock", async () => {
		const f = fixture({ claimed: false, setup: "AAAA-BBBB" });
		let releaseAdd!: () => void;
		f.users.addBarrier = new Promise<void>((resolve) => { releaseAdd = resolve; });
		const first = resolveLogin({ provider: PROVIDER, result: result(), code: "AAAA-BBBB" }, deps(f));
		// Wait until the first claim is suspended inside add, before records
		// mutates. A second claim now queues behind withClaimLock.
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		expect(f.users.addCalls).toBe(1);
		const second = resolveLogin({
			provider: "login:fixture:other",
			result: result({ subject: "subject-2", profile: { username: "Bob" } }),
			code: "AAAA-BBBB",
		}, deps(f));
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		expect(f.users.addCalls).toBe(1);
		releaseAdd();
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.filter((outcome) => outcome.kind === "session")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.kind === "refused" && outcome.error === "not_allowed")).toHaveLength(1);
		expect(f.users.records.filter((user) => user.admin)).toHaveLength(1);
		expect(f.accounts.links).toHaveLength(1);
		// The first decision saw an empty directory; the second could not
		// decide until the first completed and therefore saw it claimed.
		// Bypassing the lock makes both observations false and yields two admins.
		expect(f.users.claimedObservations).toEqual([false, true]);
	});

	test("a failed setup link can be completed only by the recorded subject with the still-valid code", async () => {
		const f = fixture({ claimed: false, setup: "AAAA-BBBB" });
		f.accounts.linkBarrier = Promise.reject(new Error("disk unavailable"));
		await expect(resolveLogin({ provider: PROVIDER, result: result(), code: "AAAA-BBBB" }, deps(f)))
			.rejects.toThrow("disk unavailable");
		expect(f.users.records).toHaveLength(1);
		expect(f.accounts.links).toHaveLength(0);
		const other = await resolveLogin({
			provider: "login:fixture:other",
			result: result({ subject: "attacker", profile: { username: "attacker" } }),
			code: "AAAA-BBBB",
		}, deps(f));
		expect(other).toEqual({ kind: "refused", error: "not_allowed" });
		expect(f.accounts.links).toHaveLength(0);
		f.accounts.linkBarrier = undefined;
		const recovered = await resolveLogin({ provider: PROVIDER, result: result(), code: "AAAA-BBBB" }, deps(f));
		expect(recovered).toEqual({ kind: "session", user: "alice-smith" });
		expect(f.users.records).toHaveLength(1);
		expect(f.accounts.links).toEqual([{ provider: PROVIDER, subject: "subject-1", user: "alice-smith", via: "login" }]);
		expect(f.users.groups[0]?.values).toEqual(["family"]);
	});

	test("a claimed server cannot use the setup code to create another user without a claim marker", async () => {
		const f = fixture({ setup: "AAAA-BBBB" });
		const outcome = await resolveLogin({ provider: PROVIDER, result: result(), code: "AAAA-BBBB" }, deps(f));
		expect(outcome).toEqual({ kind: "refused", error: "not_allowed" });
		expect(f.users.records.map((user) => user.user)).toEqual(["owner"]);
		expect(f.accounts.links).toEqual([]);
	});

	test("an admission refusal does not burn the invite", async () => {
		const f = fixture({ invites: { "GOOD-CODE": { admin: false } } });
		f.users.admission = new AdmissionRefusedError("isolation_required", "isolation_required");
		expect(await resolveLogin({ provider: PROVIDER, result: result(), code: "GOOD-CODE" }, deps(f)))
			.toEqual({ kind: "refused", error: "isolation_required" });
		expect(f.invites.used).toEqual([]);
		expect(f.users.admissionChecks).toBe(1);
		f.users.admission = undefined;
		expect(await resolveLogin({ provider: PROVIDER, result: result(), code: "GOOD-CODE" }, deps(f)))
			.toEqual({ kind: "session", user: "alice-smith" });
	});

	for (const code of ["isolation_required", "auth_required"] as const) {
		test(`user creation maps the M1 ${code} admission refusal`, async () => {
			const f = fixture();
			f.users.admission = new AdmissionRefusedError(code, code);
			expect(await resolveLogin({ provider: PROVIDER, result: result() }, deps(f, { autoProvision: true })))
				.toEqual({ kind: "refused", error: code });
			expect(f.accounts.links).toEqual([]);
		});
	}
});
