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

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, test } from "vitest";
import {
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
	});
});
