/**
 * The users + invites + tokens API (core hardening W1 Task 4, spec
 * §5.8): the admin gates, invite single-use redemption, the last-admin
 * guard (record admins only — group admins never count), transfer-on-
 * delete (conversation owner rewrite, token revocation, the userDeleted
 * lifecycle event), and the self-only token-creation rule.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()`;
 * identity pre-seeded claimed via {@link seededIdentity}. The
 * fixture-user-events extension loads through the loader so its
 * `userDeleted` handler registers on the boot event bus — the module's
 * records are read by importing the SAME file:// URL the loader used.
 */

import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { TokenStore } from "../src/harness/identity/index.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture-user-events entry, imported by specifier (contract: factory + userDeleted). */
const USER_EVENTS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-user-events", "index.js"),
).href;

/** The fixture module's exports (deletions record + reset). */
type FixtureModule = {
	readonly deletions: readonly { user: string; transferTo: string }[];
	readonly resetDeletions: () => void;
};

/** Import the fixture module by the SAME URL the loader imported — one instance. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(USER_EVENTS_SPECIFIER)) as unknown as FixtureModule;
}

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	dir: string;
}

/**
 * Boot one hermetic CLAIMED server: `tester` is the seeded admin; tests
 * add alice (admin) and bob (non-admin) plus their tokens as needed.
 */
async function bootServer(options: {
	env?: Record<string, string | undefined>;
	file?: { auth?: Record<string, unknown> };
	seed?: "admin-only" | "alice-and-bob";
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-users-api-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_AUTH: "token",
		...options.env,
	};
	const config = loadConfig(env, {
		server: options.file ?? {},
	} as Parameters<typeof loadConfig>[1]);
	const identity = await seededIdentity(dir);
	if (options.seed !== "admin-only") {
		await identity.users.add({
			user: "alice",
			name: "Alice",
			admin: true,
			source: "cli",
		});
		await identity.users.add({
			user: "bob",
			admin: false,
			source: "cli",
		});
	}
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
		identity,
		extensionSpecifiers: [USER_EVENTS_SPECIFIER],
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
	const app = await createServer(opened, config, [], {
		listenHost: "0.0.0.0",
	});
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, dir };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function mint(
	opened: OpenedHarness,
	user: string,
	name = "test",
): Promise<string> {
	const { token } = await opened.identity.tokens.create(name, user);
	return token;
}

// ---------------------------------------------------------------------------
// GET /v1/users
// ---------------------------------------------------------------------------

describe("GET /v1/users", () => {
	test("non-admin → 403 forbidden", async () => {
		const { app, opened } = await bootServer({});
		const bobToken = await mint(opened, "bob");
		const response = await app.inject({
			method: "GET",
			url: "/v1/users",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
	});

	test("admin → the directory", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "alice");
		const response = await app.inject({
			method: "GET",
			url: "/v1/users",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.statusCode).toBe(200);
		const users = response.json().users as { user: string; admin: boolean }[];
		expect(users.map((user) => user.user).sort()).toEqual([
			"alice",
			"bob",
			"tester",
		]);
	});
});

// ---------------------------------------------------------------------------
// invites
// ---------------------------------------------------------------------------

describe("invites", () => {
	test("an invite redeems once", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "alice");
		const invite = await app.inject({
			method: "POST",
			url: "/v1/users/invites",
			headers: { authorization: `Bearer ${token}` },
			payload: { admin: false },
		});
		expect(invite.statusCode).toBe(201);
		const { code, id, expiresAt } = invite.json() as {
			code: string;
			id: string;
			expiresAt: number;
		};
		expect(id).toBeDefined();
		expect(typeof code).toBe("string");
		expect(expiresAt).toBeGreaterThan(Date.now());
		// The redemption claim (unauthenticated — a new person holds nothing).
		const first = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: { code, user: "carol", name: "Carol" },
		});
		expect(first.statusCode).toBe(200);
		expect(first.json().user).toMatchObject({
			user: "carol",
			admin: false,
			source: "invite",
		});
		// Single-use: the same code admits no one else.
		const second = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: { code, user: "dave" },
		});
		expect(second.statusCode).toBe(403);
		expect(second.json()).toEqual({ error: "invalid_code" });
	});

	test("non-admin POST /v1/users/invites → 403", async () => {
		const { app, opened } = await bootServer({});
		const bobToken = await mint(opened, "bob");
		const response = await app.inject({
			method: "POST",
			url: "/v1/users/invites",
			headers: { authorization: `Bearer ${bobToken}` },
			payload: {},
		});
		expect(response.statusCode).toBe(403);
	});
});

// ---------------------------------------------------------------------------
// PATCH /v1/users/:user — the last-admin guard
// ---------------------------------------------------------------------------

describe("PATCH /v1/users/:user", () => {
	test("demoting the only record-admin → 409 last_admin", async () => {
		const { app, opened } = await bootServer({ seed: "admin-only" });
		const token = await mint(opened, "tester");
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/users/tester",
			headers: { authorization: `Bearer ${token}` },
			payload: { admin: false },
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "last_admin" });
	});

	test("demoting the only record-admin still 409s when a group-derived admin exists (gateway C8)", async () => {
		// The gateway C8 write-through shape: bob carries the persisted
		// admins-group grant — effective admin on the host surface, but NOT
		// a record admin. The guard keeps counting stored `admin` only:
		// a group admin existing must not allow demoting the last one.
		const { app, opened } = await bootServer({ seed: "admin-only" });
		await opened.identity.users.add({
			user: "bob",
			admin: false,
			groupAdmin: true,
			source: "proxy",
		});
		const token = await mint(opened, "tester");
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/users/tester",
			headers: { authorization: `Bearer ${token}` },
			payload: { admin: false },
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "last_admin" });
	});

	test("a name patch lands", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "alice");
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/users/bob",
			headers: { authorization: `Bearer ${token}` },
			payload: { name: "Robert" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ user: "bob", name: "Robert" });
	});
});

// ---------------------------------------------------------------------------
// DELETE /v1/users/:user — transfer-on-delete
// ---------------------------------------------------------------------------

describe("DELETE /v1/users/:user", () => {
	test("without transferTo → 400 invalid_transfer", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "alice");
		const response = await app.inject({
			method: "DELETE",
			url: "/v1/users/bob",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_transfer" });
	});

	test("unknown transferTo → 400; self transferTo → 400", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "alice");
		const unknown = await app.inject({
			method: "DELETE",
			url: "/v1/users/bob?transferTo=nobody",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(unknown.statusCode).toBe(400);
		expect(unknown.json()).toEqual({ error: "invalid_transfer" });
		const self = await app.inject({
			method: "DELETE",
			url: "/v1/users/bob?transferTo=bob",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(self.statusCode).toBe(400);
	});

	test("with transferTo → owner rewrite, token dead, userDeleted recorded", async () => {
		const fixture = await fixtureModule();
		fixture.resetDeletions();
		const { app, opened } = await bootServer({});
		const adminToken = await mint(opened, "alice");
		const bobToken = await mint(opened, "bob", "bob-laptop");
		// A conversation owned by bob.
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(created.statusCode).toBe(201);
		const conversationId = (created.json() as { id: number }).id;
		// The delete.
		const deleted = await app.inject({
			method: "DELETE",
			url: "/v1/users/bob?transferTo=alice",
			headers: { authorization: `Bearer ${adminToken}` },
		});
		expect(deleted.statusCode).toBe(204);
		// The conversation's owner is alice now.
		const listing = await app.inject({
			method: "GET",
			url: "/v1/conversations",
			headers: { authorization: `Bearer ${adminToken}` },
		});
		expect(listing.statusCode).toBe(200);
		const row = (listing.json().conversations as { id: number; owner?: string }[]).find(
			(entry) => entry.id === conversationId,
		);
		expect(row?.owner).toBe("alice");
		// Bob's token is dead (record removed → verify fails).
		const whoami = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(whoami.statusCode).toBe(401);
		// The record is gone.
		expect(opened.identity.users.get("bob")).toBeUndefined();
		// The fixture's userDeleted handler recorded the payload.
		expect(fixture.deletions).toContainEqual({
			user: "bob",
			transferTo: "alice",
		});
	});

	test("deleting a user removes their account links and no one else's", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "alice");
		// Bob holds two links (two providers); alice holds one. Links
		// never transfer (multi-user §10.6 step 1).
		await opened.identity.accounts.link({
			provider: "chat:loop",
			subject: "bob-chat",
			user: "bob",
			via: "self",
		});
		await opened.identity.accounts.link({
			provider: "login:oauth:acme",
			subject: "bob-sub",
			user: "bob",
			via: "login",
		});
		await opened.identity.accounts.link({
			provider: "chat:loop",
			subject: "alice-chat",
			user: "alice",
			via: "self",
		});
		const deleted = await app.inject({
			method: "DELETE",
			url: "/v1/users/bob?transferTo=alice",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(deleted.statusCode).toBe(204);
		expect(opened.identity.accounts.listForUser("bob")).toEqual([]);
		expect(opened.identity.accounts.listForUser("alice")).toHaveLength(1);
		expect(
			opened.identity.accounts.lookup("chat:loop", "bob-chat"),
		).toBeUndefined();
	});

	test("deleting the last record-admin → 409 (a group admin does not count)", async () => {
		// tester is the ONLY record admin; the caller's admin comes from a
		// proxy GROUP — which never counts toward the last-admin guard.
		const { app, opened } = await bootServer({
			env: {
				SIGRUN_AUTH: "proxy",
				SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
			},
			file: { auth: { adminGroups: ["admins"], proxy: { secretHeader: "x-sigrun-proxy-secret" } } },
			seed: "admin-only",
		});
		await opened.identity.users.add({
			user: "bob",
			admin: false,
			source: "cli",
		});
		const response = await app.inject({
			method: "DELETE",
			url: "/v1/users/tester?transferTo=bob",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "ops", "remote-groups": "admins" },
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "last_admin" });
	});
});

// ---------------------------------------------------------------------------
// accounts API
// ---------------------------------------------------------------------------

describe("/v1/auth/accounts", () => {
	/** Seed one link per entry over the boot's store. */
	async function seed(
		opened: OpenedHarness,
		links: Array<{ provider: string; subject: string; user: string }>,
	): Promise<void> {
		for (const link of links) {
			await opened.identity.accounts.link({ ...link, via: "self" });
		}
	}

	test("lists the caller's links; an admin may name another user", async () => {
		const { app, opened } = await bootServer({});
		const aliceToken = await mint(opened, "alice");
		const bobToken = await mint(opened, "bob");
		await seed(opened, [
			{ provider: "chat:loop", subject: "bob-1", user: "bob" },
			{ provider: "chat:loop", subject: "alice-1", user: "alice" },
		]);
		// Bob's own list: only his.
		const bobOwn = await app.inject({
			method: "GET",
			url: "/v1/auth/accounts",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(bobOwn.statusCode).toBe(200);
		expect(
			(bobOwn.json() as { accounts: { subject: string }[] }).accounts.map(
				(link) => link.subject,
			),
		).toEqual(["bob-1"]);
		// An admin's window into bob's links.
		const adminView = await app.inject({
			method: "GET",
			url: "/v1/auth/accounts?user=bob",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(adminView.statusCode).toBe(200);
		expect(
			(adminView.json() as { accounts: { subject: string }[] }).accounts.map(
				(link) => link.subject,
			),
		).toEqual(["bob-1"]);
		// A non-admin naming someone else is refused before the store is read.
		const refused = await app.inject({
			method: "GET",
			url: "/v1/auth/accounts?user=alice",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toEqual({ error: "forbidden" });
		// A non-admin naming THEMSELVES is fine (the same payload as no query).
		const bobNamed = await app.inject({
			method: "GET",
			url: "/v1/auth/accounts?user=bob",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(bobNamed.statusCode).toBe(200);
		expect(
			(bobNamed.json() as { accounts: { subject: string }[] }).accounts.map(
				(link) => link.subject,
			),
		).toEqual(["bob-1"]);
	});

	test("a user removes their own link; the encoded subject round-trips", async () => {
		const { app, opened } = await bootServer({});
		const bobToken = await mint(opened, "bob");
		await seed(opened, [
			{ provider: "chat:signal", subject: "+15551234567", user: "bob" },
		]);
		const removed = await app.inject({
			method: "DELETE",
			url: "/v1/auth/accounts?provider=chat:signal&subject=%2B15551234567",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(removed.statusCode).toBe(204);
		expect(opened.identity.accounts.listForUser("bob")).toEqual([]);
	});

	test("another user's link is refused for a non-admin; an admin may remove it", async () => {
		const { app, opened } = await bootServer({});
		const aliceToken = await mint(opened, "alice");
		const bobToken = await mint(opened, "bob");
		await seed(opened, [
			{ provider: "chat:loop", subject: "alice-1", user: "alice" },
		]);
		const refused = await app.inject({
			method: "DELETE",
			url: "/v1/auth/accounts?provider=chat:loop&subject=alice-1",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(refused.statusCode).toBe(403);
		expect(opened.identity.accounts.listForUser("alice")).toHaveLength(1);
		const byAdmin = await app.inject({
			method: "DELETE",
			url: "/v1/auth/accounts?provider=chat:loop&subject=alice-1",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(byAdmin.statusCode).toBe(204);
		expect(opened.identity.accounts.listForUser("alice")).toEqual([]);
	});

	test("an absent link → 404 unknown_account; a missing subject → 400 invalid_query", async () => {
		const { app, opened } = await bootServer({});
		const bobToken = await mint(opened, "bob");
		const absent = await app.inject({
			method: "DELETE",
			url: "/v1/auth/accounts?provider=chat:loop&subject=nobody",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(absent.statusCode).toBe(404);
		expect(absent.json()).toEqual({ error: "unknown_account" });
		const missing = await app.inject({
			method: "DELETE",
			url: "/v1/auth/accounts?provider=chat:loop",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(missing.statusCode).toBe(400);
		expect(missing.json()).toEqual({ error: "invalid_query" });
	});
});

describe("tokens API", () => {
	test("an admin POST /v1/auth/tokens with a user field → 403 forbidden", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "alice");
		const response = await app.inject({
			method: "POST",
			url: "/v1/auth/tokens",
			headers: { authorization: `Bearer ${token}` },
			payload: { name: "for-bob", user: "bob" },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
	});

	test("a self create → 201 with the secret once", async () => {
		const { app, opened } = await bootServer({});
		const token = await mint(opened, "bob", "bob-first");
		const response = await app.inject({
			method: "POST",
			url: "/v1/auth/tokens",
			headers: { authorization: `Bearer ${token}` },
			payload: { name: "bob-second" },
		});
		expect(response.statusCode).toBe(201);
		const body = response.json();
		expect(body.token.startsWith("sgr_")).toBe(true);
		expect(body.record).toMatchObject({ name: "bob-second", user: "bob" });
		expect(body.record.sha256).toBeUndefined();
		// The minted token authenticates as bob.
		const whoami = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${body.token}` },
		});
		expect(whoami.json().user).toBe("bob");
	});

	test("GET /v1/auth/tokens serves own; ?user= is admin-only", async () => {
		const { app, opened } = await bootServer({});
		const bobToken = await mint(opened, "bob", "bob-listed");
		const aliceToken = await mint(opened, "alice", "alice-listed");
		const own = await app.inject({
			method: "GET",
			url: "/v1/auth/tokens",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(own.statusCode).toBe(200);
		const ownTokens = own.json().tokens as { name: string; user: string }[];
		expect(ownTokens.every((entry) => entry.user === "bob")).toBe(true);
		expect(ownTokens.some((entry) => entry.name === "bob-listed")).toBe(true);
		// A non-admin may not list another's.
		const forbidden = await app.inject({
			method: "GET",
			url: "/v1/auth/tokens?user=alice",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(forbidden.statusCode).toBe(403);
		// An admin may.
		const asAdmin = await app.inject({
			method: "GET",
			url: "/v1/auth/tokens?user=bob",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(asAdmin.statusCode).toBe(200);
		expect(
			(asAdmin.json().tokens as { user: string }[]).every(
				(entry) => entry.user === "bob",
			),
		).toBe(true);
	});

	test("an admin revoke of bob's token → 204; a stranger's revoke → 403", async () => {
		const { app, opened } = await bootServer({});
		const aliceToken = await mint(opened, "alice");
		const { record } = await opened.identity.tokens.create(
			"bob-revocable",
			"bob",
		);
		const revoked = await app.inject({
			method: "DELETE",
			url: `/v1/auth/tokens/${record.id}`,
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(revoked.statusCode).toBe(204);
		// Bob cannot revoke alice's.
		const bobToken = await mint(opened, "bob", "bob-revoker");
		const { record: aliceRecord } = await opened.identity.tokens.create(
			"alice-target",
			"alice",
		);
		const denied = await app.inject({
			method: "DELETE",
			url: `/v1/auth/tokens/${aliceRecord.id}`,
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(denied.statusCode).toBe(403);
	});

	test("a second TokenStore instance revoking a token → the server's next request with it → 401", async () => {
		const { app, opened, dir } = await bootServer({});
		const token = await mint(opened, "bob", "bob-external");
		const first = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(first.statusCode).toBe(200);
		// The CLI is a second writer over the same file: a fresh store
		// instance sees and revokes what the server minted (mtime reload).
		// The path mirrors seededIdentity's layout (api-tokens.json at the
		// seed root) — the store's own `path` field is private.
		const external = new TokenStore(join(dir, "api-tokens.json"));
		const record = external.list().find((entry) => entry.name === "bob-external");
		expect(record).toBeDefined();
		expect(await external.revoke(record!.id)).toBe(true);
		const second = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(second.statusCode).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// Multi-user M1 Task 3 — workspace, grants, and OS-account mapping
// ---------------------------------------------------------------------------

describe("PATCH /v1/users/:user — grants", () => {
	test("admin PATCH stores realpaths for workspace/grants and accepts osUser", async () => {
		const { app, opened, dir } = await bootServer({});
		const token = await mint(opened, "alice");
		const grant = join(dir, "grant-target");
		const link = join(dir, "grant-link");
		await mkdir(grant);
		await symlink(grant, link, "dir");
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/users/bob",
			headers: { authorization: `Bearer ${token}` },
			payload: {
				workspace: link,
				grants: [{ path: link, access: "rw" }],
				osUser: "bob",
			},
		});
		expect(response.statusCode).toBe(200);
		const stored = await realpath(grant);
		expect(response.json()).toMatchObject({
			workspace: stored,
			grants: [{ path: stored, access: "rw" }],
			osUser: "bob",
		});
		expect(opened.identity.users.get("bob")).toMatchObject({
			workspace: stored,
			grants: [{ path: stored, access: "rw" }],
			osUser: "bob",
		});
	});

	test("invalid workspace and grant paths → 400 invalid_grant with the exact reason", async () => {
		const { app, opened, dir } = await bootServer({});
		const token = await mint(opened, "alice");
		const workspace = await app.inject({
			method: "PATCH",
			url: "/v1/users/bob",
			headers: { authorization: `Bearer ${token}` },
			payload: { workspace: join(dir, "config") },
		});
		expect(workspace.statusCode).toBe(400);
		expect(workspace.json()).toEqual({
			error: "invalid_grant",
			path: join(dir, "config"),
			reason: "path is or contains configDir",
		});
		const grant = await app.inject({
			method: "PATCH",
			url: "/v1/users/bob",
			headers: { authorization: `Bearer ${token}` },
			payload: { grants: [{ path: "relative", access: "rw" }] },
		});
		expect(grant.statusCode).toBe(400);
		expect(grant.json()).toEqual({
			error: "invalid_grant",
			path: "relative",
			reason: "path must be absolute",
		});
	});

	test("non-admin PATCH → 403", async () => {
		const { app, opened, dir } = await bootServer({});
		const token = await mint(opened, "bob");
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/users/bob",
			headers: { authorization: `Bearer ${token}` },
			payload: { workspace: dir },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
	});

	test("whoami exposes only the caller's own workspace and grants", async () => {
		const { app, opened, dir } = await bootServer({});
		const own = join(dir, "own-workspace");
		await mkdir(own);
		await opened.identity.users.update("bob", {
			workspace: own,
			grants: [{ path: own, access: "ro" }],
		});
		await opened.identity.users.update("alice", {
			workspace: dir,
			grants: [{ path: dir, access: "rw" }],
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${await mint(opened, "bob")}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			user: "bob",
			workspace: own,
			grants: [{ path: own, access: "ro" }],
		});
	});
});
