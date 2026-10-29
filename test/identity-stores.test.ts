/**
 * Identity stores (core hardening W1 Task 2): the user directory, API
 * tokens, invites, and the setup code — the on-disk identity surfaces
 * spec §5.4/§5.8 pin.
 *
 - every file is mode 0600, written atomically (temp + rename), and
   re-read when its mtime changes — a second store instance on the same
   path (or the CLI, another process) is honored live;
 - tokens are `sgr_` + base64url(32 random bytes), stored as SHA-256
   hex only, compared with `timingSafeEqual`;
 - invites are single-use and hashed; an expired redeem returns
   undefined, and a redeemed row KEEPS its `usedBy` past expiry (Review
   Focus 4: never re-openable, never cleared);
 - the setup code is `XXXX-XXXX` from the 32-char unambiguous alphabet,
   pinnable via `SIGRUN_SETUP_CODE`, under `<cacheDir>/setup-code`.
 *
 * Tests own their literals: tmp dirs, `alice`/`bob` users, `sgr_test…`
 * token spellings, `example.invalid` emails.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
	AccountLinkConflictError,
	AccountStore,
	InviteStore,
	type InviteRecord,
	TokenStore,
	UserDirectory,
	clearSetupCode,
	ensureSetupCode,
	generateToken,
	hashToken,
	openIdentityStores,
	readSetupCode,
	type IdentityStores,
} from "../src/harness/identity/index.js";
import { effectiveAdmin, storedGroups } from "../src/harness/identity/groups.js";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

/** A fresh tmp dir (recorded for afterAll teardown). */
function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `sigrun-identity-${prefix}-`));
	dirs.push(dir);
	return dir;
}

/** One admin directory user, the shape later tasks seed with. */
function aliceUser(admin = true) {
	return {
		user: "alice",
		name: "Alice Liddell",
		email: "alice@example.invalid",
		admin,
		source: "invite" as const,
	};
}

describe("UserDirectory", () => {
	test("add then get round-trips", async () => {
		const users = new UserDirectory(join(tmpDir("roundtrip"), "users.json"));
		const added = await users.add(aliceUser());
		expect(added.user).toBe("alice");
		expect(added.admin).toBe(true);
		expect(added.source).toBe("invite");
		expect(typeof added.createdAt).toBe("number");
		expect(users.get("alice")).toEqual(added);
		expect(users.list()).toEqual([added]);
		expect(users.get("bob")).toBeUndefined();
	});

	test("add rejects an invalid username", async () => {
		const users = new UserDirectory(join(tmpDir("badname"), "users.json"));
		await expect(users.add({ ...aliceUser(), user: "Alice" })).rejects.toThrow(
			/username/,
		);
		await expect(users.add({ ...aliceUser(), user: "-alice" })).rejects.toThrow(
			/username/,
		);
		expect(users.list()).toEqual([]);
	});

	test("add rejects a duplicate user", async () => {
		const users = new UserDirectory(join(tmpDir("dup"), "users.json"));
		await users.add(aliceUser());
		await expect(users.add({ ...aliceUser(), source: "cli" })).rejects.toThrow(
			/alice/,
		);
	});

	test("add rejects a new username key over 128 characters", async () => {
		const users = new UserDirectory(join(tmpDir("long-new-key"), "users.json"));
		await expect(
			users.add({ ...aliceUser(), user: "a".repeat(129) }),
		).rejects.toThrow(/username/);
		expect(users.list()).toEqual([]);
	});

	test("a legacy username key over 128 characters still loads", () => {
		const path = join(tmpDir("legacy-long-key"), "users.json");
		const legacy = {
			user: "a".repeat(150),
			name: "Legacy Long Key",
			admin: false,
			source: "cli" as const,
			createdAt: 1,
		};
		writeFileSync(path, JSON.stringify([legacy]));
		const users = new UserDirectory(path);
		expect(users.get(legacy.user)).toEqual(legacy);
	});

	test("isClaimed is false until the first add", async () => {
		const users = new UserDirectory(join(tmpDir("claimed"), "users.json"));
		expect(users.isClaimed()).toBe(false);
		await users.add({ user: "alice", admin: false, source: "cli" });
		expect(users.isClaimed()).toBe(true);
	});

	test("store files are written mode 0600", async () => {
		const dir = tmpDir("modes");
		const users = new UserDirectory(join(dir, "users.json"));
		await users.add({ user: "alice", admin: true, source: "cli" });
		const tokens = new TokenStore(join(dir, "api-tokens.json"));
		await tokens.create("laptop", "alice");
		const invites = new InviteStore(join(dir, "invites.json"));
		await invites.create({ admin: true });
		for (const name of ["users.json", "api-tokens.json", "invites.json"]) {
			expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
		}
	});

	test("removeWithGrant reads the current recipient grants and removes the source in one mutation", async () => {
		const users = new UserDirectory(join(tmpDir("remove-with-grant"), "users.json"));
		await users.add(aliceUser());
		await users.add({ user: "bob", admin: false, source: "cli" });
		const concurrent = users.update("bob", {
			grants: [{ path: "/existing", access: "ro" }],
		});
		const removal = users.removeWithGrant("alice", "bob", {
			path: "/inherited",
			access: "rw",
			inheritedFrom: "alice",
		});
		await Promise.all([concurrent, removal]);
		expect(users.get("alice")).toBeUndefined();
		expect(users.get("bob")?.grants).toEqual([
			{ path: "/existing", access: "ro" },
			{ path: "/inherited", access: "rw", inheritedFrom: "alice" },
		]);
	});

	test("a second store instance on the same path sees the first's write", async () => {
		const path = join(tmpDir("cross"), "users.json");
		const first = new UserDirectory(path);
		const second = new UserDirectory(path);
		await first.add(aliceUser());
		expect(second.get("alice")?.admin).toBe(true);
		await second.add({ user: "bob", admin: false, source: "proxy" });
		expect(first.get("bob")?.source).toBe("proxy");
	});
});

describe("stored groups", () => {
	test("setGroups replaces one source and keeps another", async () => {
		const users = new UserDirectory(join(tmpDir("group-sources"), "users.json"));
		await users.add({ user: "alice", admin: false, source: "proxy" });
		await users.setGroups("alice", "proxy", ["users", "admins"], 100);
		await users.setGroups("alice", "login:oauth:acme", ["family"], 200);
		const updated = await users.setGroups("alice", "proxy", ["users"], 300);
		expect(updated.groups).toEqual([
			{ source: "proxy", values: ["users"], updatedAt: 300 },
			{ source: "login:oauth:acme", values: ["family"], updatedAt: 200 },
		]);
		expect(users.get("alice")).toEqual(updated);
	});

	test("setGroups with unchanged values does not write the file", async () => {
		const path = join(tmpDir("group-noop"), "users.json");
		const users = new UserDirectory(path);
		await users.add({ user: "alice", admin: false, source: "proxy" });
		await users.setGroups("alice", "proxy", ["users", "admins"], 100);
		const before = statSync(path).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		const updated = await users.setGroups("alice", "proxy", ["users", "admins"], 200);
		expect(statSync(path).mtimeMs).toBe(before);
		expect(updated.groups).toEqual([
			{ source: "proxy", values: ["users", "admins"], updatedAt: 100 },
		]);
	});

	test("storedGroups is the deduplicated union and effectiveAdmin accepts any source", async () => {
		const users = new UserDirectory(join(tmpDir("effective-admin"), "users.json"));
		await users.add({ user: "alice", admin: false, source: "proxy" });
		await users.setGroups("alice", "proxy", ["users", "family"], 100);
		const record = await users.setGroups("alice", "login:oauth:acme", ["family", "admins"], 200);
		expect(storedGroups(record)).toEqual(["users", "family", "admins"]);
		expect(effectiveAdmin(record, ["admins"])).toBe(true);
		expect(effectiveAdmin(record, ["other"])).toBe(false);
		expect(effectiveAdmin({ ...record, admin: true }, [])).toBe(true);
	});

	test("a legacy groupAdmin grant is dropped and grants nothing after the next write", async () => {
		const path = join(tmpDir("legacy-group-admin"), "users.json");
		writeFileSync(path, JSON.stringify([{
			user: "alice",
			admin: false,
			groupAdmin: true,
			createdAt: 1,
			source: "proxy",
		}]));
		const users = new UserDirectory(path);
		const updated = await users.update("alice", { name: "Alice" });
		expect(effectiveAdmin(updated, ["admins"])).toBe(false);
		expect(updated).not.toHaveProperty("groupAdmin");
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
		expect(raw[0]).not.toHaveProperty("groupAdmin");
		const viaGroups = await users.setGroups("alice", "proxy", []);
		expect(viaGroups).not.toHaveProperty("groupAdmin");
	});
});

describe("TokenStore", () => {
	test("generateToken is sgr_ + 43 base64url characters", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const token = generateToken();
			expect(token).toMatch(/^sgr_[A-Za-z0-9_-]{43}$/);
			seen.add(token);
		}
		// Random, not a constant: 20 draws of a 256-bit value never collide.
		expect(seen.size).toBe(20);
	});

	test("verify returns the record; wrong or empty tokens do not", async () => {
		const tokens = new TokenStore(join(tmpDir("verify"), "api-tokens.json"));
		const { record, token } = await tokens.create("laptop", "alice");
		expect(tokens.verify(token)).toEqual(record);
		expect(tokens.verify("sgr_wrong")).toBeUndefined();
		expect(tokens.verify("")).toBeUndefined();
	});

	test("the file contains hashes, never token plaintext", async () => {
		const path = join(tmpDir("hashed"), "api-tokens.json");
		const tokens = new TokenStore(path);
		const { record, token } = await tokens.create("laptop", "alice");
		const file = readFileSync(path, "utf8");
		expect(file).not.toContain(token);
		expect(file).toContain(record.sha256);
		expect(record.sha256).toBe(hashToken(token));
	});

	test("createSession stores kind, provider, and expiresAt", async () => {
		const tokens = new TokenStore(join(tmpDir("session"), "api-tokens.json"));
		const now = 1_700_000_000_000;
		const { record, token } = await tokens.createSession(
			"alice",
			"login:oauth:acme",
			60_000,
			now,
		);
		expect(record).toMatchObject({
			name: "login:login:oauth:acme",
			user: "alice",
			kind: "session",
			provider: "login:oauth:acme",
			createdAt: now,
			expiresAt: now + 60_000,
		});
		expect(tokens.verify(token, now)).toEqual(record);
	});

	test("verify rejects a session at expiresAt, not one millisecond before", async () => {
		const tokens = new TokenStore(join(tmpDir("expiry"), "api-tokens.json"));
		const now = 1_700_000_000_000;
		const { record, token } = await tokens.createSession(
			"alice",
			"login:oauth:acme",
			60_000,
			now,
		);
		expect(tokens.verify(token, record.expiresAt! - 1)).toEqual(record);
		expect(tokens.verify(token, record.expiresAt!)).toBeUndefined();
	});

	test("every mutation prunes expired records before writing", async () => {
		const now = 1_700_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const createStore = new TokenStore(join(tmpDir("prune-create"), "api-tokens.json"));
			await createStore.createSession("alice", "login:oauth:acme", 1, now);
			clock.mockReturnValue(now + 1);
			await createStore.create("laptop", "alice");
			expect(createStore.list().map((record) => record.name)).toEqual(["laptop"]);

			clock.mockReturnValue(now);
			const sessionStore = new TokenStore(join(tmpDir("prune-session"), "api-tokens.json"));
			await sessionStore.createSession("alice", "login:oauth:acme", 1, now);
			clock.mockReturnValue(now + 1);
			await sessionStore.createSession("bob", "login:oauth:acme", 60_000, now + 1);
			expect(sessionStore.list().map((record) => record.user)).toEqual(["bob"]);

			clock.mockReturnValue(now);
			const revokeStore = new TokenStore(join(tmpDir("prune-revoke"), "api-tokens.json"));
			await revokeStore.createSession("alice", "login:oauth:acme", 1, now);
			const live = await revokeStore.create("laptop", "alice");
			clock.mockReturnValue(now + 1);
			await revokeStore.revoke(live.record.id);
			expect(revokeStore.list()).toEqual([]);

			clock.mockReturnValue(now);
			const allStore = new TokenStore(join(tmpDir("prune-all"), "api-tokens.json"));
			await allStore.createSession("alice", "login:oauth:acme", 1, now);
			await allStore.create("laptop", "alice");
			clock.mockReturnValue(now + 1);
			expect(await allStore.revokeAllFor("alice")).toBe(1);
			expect(allStore.list()).toEqual([]);
		} finally {
			vi.restoreAllMocks();
		}
	});

	test("revokeAllFor removes only that user's tokens", async () => {
		const tokens = new TokenStore(join(tmpDir("revoke"), "api-tokens.json"));
		await tokens.create("a1", "alice");
		await tokens.create("a2", "alice");
		const bobToken = await tokens.create("b1", "bob");
		expect(await tokens.revokeAllFor("alice")).toBe(2);
		expect(tokens.list().map((record) => record.user)).toEqual(["bob"]);
		expect(tokens.list("bob")).toHaveLength(1);
		expect(tokens.verify(bobToken.token)).toEqual(bobToken.record);
	});
});

describe("InviteStore", () => {
	test("peek validates without consuming the invite", async () => {
		const path = join(tmpDir("peek"), "invites.json");
		const invites = new InviteStore(path);
		const { code } = await invites.create({ admin: true });
		expect(await invites.peek(code)).toEqual({ admin: true });
		expect(await invites.peek(code)).toEqual({ admin: true });
		expect(JSON.parse(readFileSync(path, "utf8"))[0].usedBy).toBeUndefined();
		expect(await invites.redeem(code, "alice")).toEqual({ admin: true });
		expect(await invites.peek(code)).toBeUndefined();
	});

	test("peek rejects expired and unknown codes without writing", async () => {
		const path = join(tmpDir("peek-expired"), "invites.json");
		const invites = new InviteStore(path);
		const { code } = await invites.create({ admin: false, expiresInMs: 1_000 });
		expect(await invites.peek(code, Date.now() + 2_000)).toBeUndefined();
		expect(await invites.peek("ZZZZ-ZZZZ")).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8"))[0].usedBy).toBeUndefined();
	});

	test("a code redeems once; a second redeem is undefined", async () => {
		const invites = new InviteStore(join(tmpDir("once"), "invites.json"));
		const { code } = await invites.create({ admin: true });
		expect(await invites.redeem(code, "alice")).toEqual({ admin: true });
		expect(await invites.redeem(code, "bob")).toBeUndefined();
	});

	test("an expired invite redeems to undefined; a used row stays used", async () => {
		const path = join(tmpDir("expired"), "invites.json");
		const invites = new InviteStore(path);
		const later = Date.now() + 60_000;
		// Unused but expired → undefined.
		const expired = await invites.create({ admin: false, expiresInMs: 1_000 });
		expect(await invites.redeem(expired.code, "alice", later)).toBeUndefined();
		// Review Focus 4: redeemed-then-expired STAYS used — never
		// re-openable, and the row keeps its usedBy.
		const used = await invites.create({ admin: false, expiresInMs: 1_000 });
		expect(await invites.redeem(used.code, "alice", Date.now())).toEqual({
			admin: false,
		});
		expect(await invites.redeem(used.code, "bob", later)).toBeUndefined();
		const rows = JSON.parse(readFileSync(path, "utf8")) as InviteRecord[];
		const usedRow = rows.find((row) => row.sha256 === hashToken(used.code));
		expect(usedRow?.usedBy).toBe("alice");
	});

	test("two concurrent redeems of one code yield exactly one success", async () => {
		const invites = new InviteStore(join(tmpDir("race"), "invites.json"));
		const { code } = await invites.create({ admin: false });
		const results = await Promise.all([
			invites.redeem(code, "alice"),
			invites.redeem(code, "bob"),
		]);
		expect(results.filter((result) => result !== undefined)).toHaveLength(1);
	});
});

describe("setup code", () => {
	test("SIGRUN_SETUP_CODE pins the code and is written 0600", async () => {
		const dir = tmpDir("pinned");
		const code = await ensureSetupCode(dir, { SIGRUN_SETUP_CODE: "ABCD-EFGH" });
		expect(code).toBe("ABCD-EFGH");
		const path = join(dir, "setup-code");
		expect(readFileSync(path, "utf8").trim()).toBe("ABCD-EFGH");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readSetupCode(dir)).toBe("ABCD-EFGH");
	});

	test("without the env var the code matches the unambiguous alphabet", async () => {
		const code = await ensureSetupCode(tmpDir("generated"), {});
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
	});

	test("clearSetupCode removes the file (idempotently)", async () => {
		const dir = tmpDir("clear");
		await ensureSetupCode(dir, {});
		expect(readSetupCode(dir)).toBeDefined();
		await clearSetupCode(dir);
		expect(readSetupCode(dir)).toBeUndefined();
		expect(existsSync(join(dir, "setup-code"))).toBe(false);
		await clearSetupCode(dir);
	});
});

/**
 * One `AccountStore` over a fresh tmp dir whose directory holds
 * `alice` and `bob` (the plan's seeding shape).
 */
async function accountStore(prefix: string): Promise<{
	accounts: AccountStore;
	users: UserDirectory;
	path: string;
}> {
	const dir = tmpDir(prefix);
	const path = join(dir, "accounts.json");
	const users = new UserDirectory(join(dir, "users.json"));
	await users.add({ user: "alice", admin: true, source: "cli" });
	await users.add({ user: "bob", admin: false, source: "cli" });
	return { accounts: new AccountStore(path, users), users, path };
}

describe("AccountStore", () => {
	test("link then lookup round-trips", async () => {
		const { accounts } = await accountStore("link-roundtrip");
		const linked = await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "pairing",
		});
		expect(linked).toMatchObject({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "pairing",
		});
		expect(typeof linked.linkedAt).toBe("number");
		expect(accounts.lookup("chat:telegram", "12345")).toEqual(linked);
		expect(accounts.lookup("chat:telegram", "999")).toBeUndefined();
	});

	test("subjects are opaque strings", async () => {
		const { accounts } = await accountStore("link-subjects");
		await accounts.link({
			provider: "chat:signal",
			subject: "+15551234567",
			user: "alice",
			via: "self",
		});
		await accounts.link({
			provider: "login:oauth:acme",
			subject: "u@x.example",
			user: "bob",
			via: "login",
		});
		expect(accounts.lookup("chat:signal", "+15551234567")?.user).toBe("alice");
		expect(accounts.lookup("login:oauth:acme", "u@x.example")?.user).toBe("bob");
	});

	test("a proxy account link round-trips", async () => {
		const { accounts, users } = await accountStore("link-proxy");
		await users.add({ user: "mike_example.com", admin: false, source: "proxy" });
		const linked = await accounts.link({
			provider: "proxy",
			subject: "mike@example.com",
			user: "mike_example.com",
			via: "proxy",
		});
		expect(linked).toMatchObject({
			provider: "proxy",
			subject: "mike@example.com",
			user: "mike_example.com",
			via: "proxy",
		});
		expect(accounts.lookup("proxy", "mike@example.com")).toEqual(linked);
	});

	test("proxy provider ids do not accept a qualifier or suffix", async () => {
		const { accounts } = await accountStore("link-proxy-validation");
		for (const provider of ["proxy:x", "proxyx"]) {
			await expect(
				accounts.link({
					provider,
					subject: "mike@example.com",
					user: "alice",
					via: "proxy",
				}),
			).rejects.toThrow(`invalid_provider: ${provider}`);
		}
	});

	test("re-link to the same user is a no-op", async () => {
		const { accounts } = await accountStore("link-noop");
		const first = await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "pairing",
		});
		const second = await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "self",
		});
		expect(second.linkedAt).toBe(first.linkedAt);
		expect(second.via).toBe("pairing");
		expect(accounts.listForUser("alice")).toHaveLength(1);
	});

	test("link to another user is refused", async () => {
		const { accounts } = await accountStore("link-conflict");
		await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "pairing",
		});
		const rejection = accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "bob",
			via: "self",
		});
		await expect(rejection).rejects.toBeInstanceOf(AccountLinkConflictError);
		await expect(rejection).rejects.toThrow(
			"account_link_conflict: chat:telegram is linked to another user",
		);
		// The conflict message never names the current holder.
		await expect(rejection).rejects.not.toThrow("alice");
		expect(accounts.lookup("chat:telegram", "12345")?.user).toBe("alice");
	});

	test("concurrent conflicting links: exactly one wins", async () => {
		const { accounts, path } = await accountStore("link-race");
		const results = await Promise.allSettled([
			accounts.link({
				provider: "chat:telegram",
				subject: "12345",
				user: "alice",
				via: "self",
			}),
			accounts.link({
				provider: "chat:telegram",
				subject: "12345",
				user: "bob",
				via: "self",
			}),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.reason).toBeInstanceOf(AccountLinkConflictError);
		const rows = JSON.parse(readFileSync(path, "utf8")) as unknown[];
		expect(rows).toHaveLength(1);
	});

	test("validation", async () => {
		const { accounts } = await accountStore("link-validation");
		await expect(
			accounts.link({
				provider: "chat:telegram",
				subject: "1",
				user: "ghost",
				via: "self",
			}),
		).rejects.toThrow('unknown user "ghost"');
		for (const provider of ["telegram", "chat:", "Chat:x"]) {
			await expect(
				accounts.link({
					provider,
					subject: "1",
					user: "alice",
					via: "self",
				}),
			).rejects.toThrow(`invalid_provider: ${provider}`);
		}
		await expect(
			accounts.link({
				provider: "chat:telegram",
				subject: "",
				user: "alice",
				via: "self",
			}),
		).rejects.toThrow("invalid_subject");
		await expect(
			accounts.link({
				provider: "chat:telegram",
				subject: "x".repeat(513),
				user: "alice",
				via: "self",
			}),
		).rejects.toThrow("invalid_subject");
		// A login provider id is the same shape, with the slug in the middle.
		const login = await accounts.link({
			provider: "login:oauth:authelia",
			subject: "sub-1",
			user: "alice",
			via: "login",
		});
		expect(login.provider).toBe("login:oauth:authelia");
	});

	test("unlink", async () => {
		const { accounts } = await accountStore("link-unlink");
		await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "self",
		});
		expect(await accounts.unlink("chat:telegram", "12345")).toBe(true);
		expect(accounts.lookup("chat:telegram", "12345")).toBeUndefined();
		expect(await accounts.unlink("chat:telegram", "12345")).toBe(false);
	});

	test("removeUser removes exactly that user's links", async () => {
		const { accounts } = await accountStore("link-remove-user");
		await accounts.link({
			provider: "chat:telegram",
			subject: "a1",
			user: "alice",
			via: "self",
		});
		await accounts.link({
			provider: "login:oauth:acme",
			subject: "a2",
			user: "alice",
			via: "login",
		});
		await accounts.link({
			provider: "chat:telegram",
			subject: "b1",
			user: "bob",
			via: "self",
		});
		expect(await accounts.removeUser("alice")).toBe(2);
		expect(accounts.listForUser("alice")).toEqual([]);
		expect(accounts.listForUser("bob")).toHaveLength(1);
	});

	test("list and listForUser keep insertion order", async () => {
		const { accounts } = await accountStore("link-order");
		await accounts.link({
			provider: "chat:telegram",
			subject: "1",
			user: "alice",
			via: "self",
		});
		await accounts.link({
			provider: "chat:discord",
			subject: "2",
			user: "bob",
			via: "self",
		});
		await accounts.link({
			provider: "login:oauth:acme",
			subject: "3",
			user: "alice",
			via: "login",
		});
		expect(accounts.list().map((link) => link.subject)).toEqual(["1", "2", "3"]);
		expect(accounts.listForUser("alice").map((link) => link.subject)).toEqual([
			"1",
			"3",
		]);
	});

	test("file is mode 0600 after the first link", async () => {
		const { accounts, path } = await accountStore("link-mode");
		await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "self",
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("a second instance sees writes", async () => {
		const { accounts, users, path } = await accountStore("link-second-instance");
		await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "self",
		});
		const other = new AccountStore(path, users);
		expect(other.lookup("chat:telegram", "12345")?.user).toBe("alice");
	});

	test("malformed file fails loud", async () => {
		const { accounts, path } = await accountStore("link-malformed");
		writeFileSync(path, "{");
		expect(() => accounts.lookup("chat:telegram", "12345")).toThrow(path);
	});

	test("a failed write never leaves a link being served that is not on disk", async () => {
		// The store mutates the cached record array before the write and
		// re-reads from disk afterwards. If a write fails (a read-only PVC,
		// a full disk) and the cache entry survives, the process keeps
		// authorizing a sender the file does not hold — so a REVOCATION that
		// failed would silently not stick. The failure must be surfaced AND
		// the cache dropped.
		const { accounts, path } = await accountStore("link-failed-write");
		await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "self",
		});
		// Make the containing directory read-only: creating the temp file
		// fails, so the write fails while READS keep working — the exact
		// shape of a read-only PVC.
		const directory = dirname(path);
		chmodSync(directory, 0o500);
		try {
			await expect(
				accounts.unlink("chat:telegram", "12345"),
			).rejects.toThrow();
		} finally {
			chmodSync(directory, 0o700);
		}
		// The disk still holds the link (the write failed), so the
		// in-memory view must agree with the FILE, not with the failed
		// mutation.
		expect(accounts.lookup("chat:telegram", "12345")?.user).toBe("alice");
	});

	test("via is validated", async () => {
		const { accounts } = await accountStore("link-via");
		await expect(
			accounts.link({
				provider: "chat:telegram",
				subject: "12345",
				user: "alice",
				via: "carrier-pigeon" as never,
			}),
		).rejects.toThrow("invalid_via: carrier-pigeon");
	});

	test("unlinkAuthorized authorizes inside the mutation, against the live record", async () => {
		const { accounts } = await accountStore("link-unlink-authorized");
		await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "self",
		});
		// A non-admin naming themselves may remove their own link.
		expect(
			await accounts.unlinkAuthorized("chat:telegram", "12345", {
				user: "alice",
				admin: false,
			}),
		).toBe("removed");
		// Absent → "absent", never a silent success.
		expect(
			await accounts.unlinkAuthorized("chat:telegram", "12345", {
				user: "alice",
				admin: false,
			}),
		).toBe("absent");
		// Another user's link → "forbidden", and the link survives.
		await accounts.link({
			provider: "chat:telegram",
			subject: "67890",
			user: "bob",
			via: "self",
		});
		expect(
			await accounts.unlinkAuthorized("chat:telegram", "67890", {
				user: "alice",
				admin: false,
			}),
		).toBe("forbidden");
		expect(accounts.lookup("chat:telegram", "67890")?.user).toBe("bob");
		// An admin may remove anyone's.
		expect(
			await accounts.unlinkAuthorized("chat:telegram", "67890", {
				user: "alice",
				admin: true,
			}),
		).toBe("removed");
		expect(accounts.lookup("chat:telegram", "67890")).toBeUndefined();
		// A userless, non-admin principal is refused, exactly as
		// DELETE /v1/auth/tokens/:id refuses one: own-or-admin only.
		await accounts.link({
			provider: "chat:telegram",
			subject: "11111",
			user: "bob",
			via: "self",
		});
		expect(
			await accounts.unlinkAuthorized("chat:telegram", "11111", {
				admin: false,
			}),
		).toBe("forbidden");
		expect(accounts.lookup("chat:telegram", "11111")?.user).toBe("bob");
	});
});

describe("openIdentityStores", () => {
	test("builds the stores over the resolved roots", () => {
		const dir = tmpDir("roots");
		const identity: IdentityStores = openIdentityStores({
			configDir: join(dir, "config"),
			dataDir: join(dir, "data"),
			cacheDir: join(dir, "cache"),
			stateDir: join(dir, "state"),
		});
		expect(identity.cacheDir).toBe(join(dir, "cache"));
		expect(identity.users.get("alice")).toBeUndefined();
		expect(identity.tokens.list()).toEqual([]);
		expect(identity.accounts.list()).toEqual([]);
	});

	test("identity.accounts writes <configDir>/accounts.json", async () => {
		const dir = tmpDir("roots-accounts");
		const configDir = join(dir, "config");
		// `openIdentityStores` is I/O-free by design (boot ensures the roots);
		// the first write needs the directory to exist.
		mkdirSync(configDir, { recursive: true });
		const identity = openIdentityStores({
			configDir,
			dataDir: join(dir, "data"),
			cacheDir: join(dir, "cache"),
			stateDir: join(dir, "state"),
		});
		expect(identity.accounts).toBeInstanceOf(AccountStore);
		await identity.users.add({ user: "alice", admin: true, source: "cli" });
		await identity.accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "self",
		});
		expect(existsSync(join(configDir, "accounts.json"))).toBe(true);
	});
});
