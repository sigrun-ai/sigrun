/**
 * The request pipeline + auth routes (core hardening W1 Task 3).
 *
 * Covers the six stages in `src/server/auth/pipeline.ts` (Host/Origin
 * checks → public paths → env service token → the unclaimed
 * `setup_required` gate → proxy/token method resolution → principal on
 * the request) and the three routes in `src/server/routes/auth.ts`
 * (login with the per-IP limiter, logout, whoami).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()`
 * (see auth-hook.test.ts). Identity is pre-seeded claimed via the
 * {@link seededIdentity} boot seam; the unclaimed tests boot WITHOUT
 * the seed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import {
	ProxyRejectReason,
	resetProxyDiagnostic,
} from "../src/server/auth/proxy-diagnostic.js";
import { setOwnHostAddressesForTests } from "../src/server/auth/own-host.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { sessionTtlMs } from "../src/server/routes/auth.js";
import { stat } from "node:fs/promises";
import { seededIdentity } from "./helpers/identity.js";

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	dir: string;
}

/**
 * Boot one hermetic server. `env` rides loadConfig (SIGRUN_* knobs);
 * `file` is the settings-file `server` section (auth proxy fields,
 * admin groups, allowed hosts/origins). Identity seeds claimed unless
 * `claimed: false`.
 */
async function bootServer(options: {
	env?: Record<string, string | undefined>;
	file?: { auth?: Record<string, unknown> };
	claimed?: boolean;
	listenHost?: string;
	fakeTimers?: boolean;
	webuiBundle?: string;
	extensionSpecifiers?: string[];
	isolationAvailable?: boolean;
	/** Seed the claimed directory under this user instead of "tester". */
	seedUser?: string;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-pipeline-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig(
		{
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_CONFIG_DIR: join(dir, "config"),
			...(options.webuiBundle === undefined
				? {}
				: { SIGRUN_WEBUI_BUNDLE: options.webuiBundle }),
			...options.env,
		},
		{ server: options.file ?? {} } as Parameters<typeof loadConfig>[1],
	);
	const claimed = options.claimed !== false;
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: join(dir, "config"),
		...(claimed ? { identity: await seededIdentity(dir, options.seedUser) } : {}),
		...(options.extensionSpecifiers === undefined
			? {}
			: { extensionSpecifiers: options.extensionSpecifiers }),
		isolationProbe: async () => options.isolationAvailable === false
			? { available: false, abi: 0, reason: "not linux" }
			: { available: true, abi: 6 },
	});
	const app = await createServer(opened, config, [], {
		listenHost: options.listenHost ?? "127.0.0.1",
	});
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, config, dir };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function mintToken(
	opened: OpenedHarness,
	user: string,
	name = "test",
): Promise<string> {
	const { token } = await opened.identity.tokens.create(name, user);
	return token;
}

// ---------------------------------------------------------------------------
// token method
// ---------------------------------------------------------------------------

describe("token method", () => {
	test("no credential → 401", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(401);
		// The wire code is pinned (spec §5.2 / the plan's Global
		// Constraints): 401 carries `unauthenticated`, verbatim.
		expect(response.json()).toEqual({ error: "unauthenticated" });
	});

	test("a created token → 200", async () => {
		const { app, opened } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		const token = await mintToken(opened, "tester");
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			user: "tester",
			admin: true,
			method: "token",
		});
	});

	test("a session cookie resolves method session with its provider", async () => {
		const { app, opened } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		const { token } = await opened.identity.tokens.createSession(
			"tester",
			"login:oauth:acme",
			60_000,
		);
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { cookie: `sigrun_session=${token}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			user: "tester",
			method: "session",
			provider: "login:oauth:acme",
		});
	});

	test("token and session principals derive admin from stored groups without rewriting the directory", async () => {
		const { app, opened, dir } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
			file: { auth: { adminGroups: ["admins"] } },
		});
		await opened.identity.users.add({
			user: "alice",
			admin: false,
			groups: [{ source: "proxy", values: ["users", "admins"], updatedAt: 1 }],
			source: "proxy",
		});
		await opened.identity.users.add({ user: "bob", admin: false, source: "cli" });
		const aliceToken = await mintToken(opened, "alice");
		const bobToken = await mintToken(opened, "bob");
		const session = await opened.identity.tokens.createSession(
			"alice",
			"login:oauth:acme",
			60_000,
		);
		const usersPath = join(dir, "users.json");
		const before = (await stat(usersPath)).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));

		const tokenAdmin = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(tokenAdmin.statusCode).toBe(200);
		expect(tokenAdmin.json()).toMatchObject({ user: "alice", admin: true, method: "token" });
		const usersRoute = await app.inject({
			method: "GET",
			url: "/v1/users",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(usersRoute.statusCode).toBe(200);

		const sessionAdmin = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { cookie: `sigrun_session=${session.token}` },
		});
		expect(sessionAdmin.statusCode).toBe(200);
		expect(sessionAdmin.json()).toMatchObject({
			user: "alice",
			admin: true,
			method: "session",
			provider: "login:oauth:acme",
		});
		const plainToken = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${bobToken}` },
		});
		expect(plainToken.statusCode).toBe(200);
		expect(plainToken.json()).toMatchObject({ user: "bob", admin: false, method: "token" });
		expect((await stat(usersPath)).mtimeMs).toBe(before);
	});

	test("an expired session cookie → 401", async () => {
		const { app, opened } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		const now = Date.now();
		const { token } = await opened.identity.tokens.createSession(
			"tester",
			"login:oauth:acme",
			60_000,
			now,
		);
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { cookie: `sigrun_session=${token}` },
		});
		expect(response.statusCode).toBe(200);
		// Time travel through the store's injected clock: at expiresAt the
		// credential is unknown, exactly like a revoked session.
		vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
		try {
			const expired = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				headers: { cookie: `sigrun_session=${token}` },
			});
			expect(expired.statusCode).toBe(401);
		} finally {
			vi.restoreAllMocks();
		}
	});

	test("an unknown token → 401", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: "Bearer sgr_bogus" },
		});
		expect(response.statusCode).toBe(401);
	});
});

test("sessionTtlMs reads sessionDays live and defaults to 30 days", async () => {
	const { opened, config } = await bootServer({
		env: { SIGRUN_AUTH: "token" },
	});
	const ctx = { opened, config } as Parameters<typeof sessionTtlMs>[0];
	expect(sessionTtlMs(ctx)).toBe(30 * 86_400_000);
	opened.settings.update({ server: { auth: { sessionDays: 2 } } });
	expect(sessionTtlMs(ctx)).toBe(2 * 86_400_000);
});

// ---------------------------------------------------------------------------
// login / logout / whoami
// ---------------------------------------------------------------------------

describe("POST /v1/auth/login", () => {
	test("valid token → 200 + sigrun_session cookie (HttpOnly, SameSite=Strict); cookie auths whoami", async () => {
		const { app, opened } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		const token = await mintToken(opened, "tester");
		const response = await app.inject({
			method: "POST",
			url: "/v1/auth/login",
			payload: { token },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ user: "tester" });
		const cookie = response.headers["set-cookie"];
		expect(cookie).toBeDefined();
		const cookieLine = Array.isArray(cookie) ? cookie[0] : cookie;
		expect(cookieLine).toContain("sigrun_session=");
		expect(cookieLine).toContain("HttpOnly");
		expect(cookieLine).toContain("SameSite=Strict");
		expect(cookieLine).toContain("Max-Age=2592000");

		const whoami = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { cookie: `sigrun_session=${token}` },
		});
		expect(whoami.statusCode).toBe(200);
		expect(whoami.json()).toMatchObject({ user: "tester", method: "token" });
	});

	test("POST /v1/auth/logout → 204 + Max-Age=0 cookie", async () => {
		const { app } = await bootServer({ env: { SIGRUN_AUTH: "token" } });
		const response = await app.inject({
			method: "POST",
			url: "/v1/auth/logout",
		});
		expect(response.statusCode).toBe(204);
		const cookie = response.headers["set-cookie"];
		const cookieLine = Array.isArray(cookie) ? cookie[0] : cookie;
		expect(cookieLine).toContain("sigrun_session=");
		expect(cookieLine).toContain("Max-Age=0");
	});

	test("a session can mint an API token that survives session revocation", async () => {
		const { app, opened } = await bootServer({ env: { SIGRUN_AUTH: "token" } });
		const session = await opened.identity.tokens.createSession(
			"tester",
			"login:oauth:acme",
			60_000,
		);
		const cookie = `sigrun_session=${session.token}`;
		const minted = await app.inject({
			method: "POST",
			url: "/v1/auth/tokens",
			headers: { cookie },
			payload: { name: "tui" },
		});
		expect(minted.statusCode).toBe(201);
		const apiToken = minted.json().token as string;
		const logout = await app.inject({
			method: "POST",
			url: "/v1/auth/logout",
			headers: { cookie },
		});
		expect(logout.statusCode).toBe(204);
		const revokedSession = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { cookie },
		});
		expect(revokedSession.statusCode).toBe(401);
		const independentToken = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${apiToken}` },
		});
		expect(independentToken.statusCode).toBe(200);
		expect(independentToken.json()).toMatchObject({ user: "tester", method: "token" });
	});

	test("logout revokes a session cookie; logout only clears an API-token cookie", async () => {
		const { app, opened } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		const session = await opened.identity.tokens.createSession(
			"tester",
			"login:oauth:acme",
			60_000,
		);
		const logout = await app.inject({
			method: "POST",
			url: "/v1/auth/logout",
			headers: { cookie: `sigrun_session=${session.token}` },
		});
		expect(logout.statusCode).toBe(204);
		expect(opened.identity.tokens.verify(session.token)).toBeUndefined();
		const second = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { cookie: `sigrun_session=${session.token}` },
		});
		expect(second.statusCode).toBe(401);

		const apiToken = await mintToken(opened, "tester");
		const clearOnly = await app.inject({
			method: "POST",
			url: "/v1/auth/logout",
			headers: { cookie: `sigrun_session=${apiToken}` },
		});
		expect(clearOnly.statusCode).toBe(204);
		expect(opened.identity.tokens.verify(apiToken)).toBeDefined();
		const stillValid = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { cookie: `sigrun_session=${apiToken}` },
		});
		expect(stillValid.statusCode).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// login limiter
// ---------------------------------------------------------------------------

describe("login limiter", () => {
	test("10 bad logins from one IP, the 11th → 429; another IP not limited", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		// Fake timers engage AFTER boot — pi-durable's harness waits on
		// real timers internally during open, and a pre-boot freeze never
		// lets it settle.
		// Fake only the timer functions — faking Date would freeze the
		// harness's activity clock and wedge shutdown against pi-durable's
		// in-flight join (the provider-scheduler suite's pattern).
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
		const attempt = async (ip: string) => {
			const pending = app.inject({
				method: "POST",
				url: "/v1/auth/login",
				remoteAddress: ip,
				payload: { token: "sgr_wrong" },
			});
			// A failed login delays 1 000 ms — let the request reach the
			// handler (the tick-0 advance), then ride the clock through
			// its wait.
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_100);
			return await pending;
		};
		for (let i = 0; i < 10; i += 1) {
			const response = await attempt("192.0.2.9");
			expect(response.statusCode).toBe(401);
		}
		// The 11th is refused BEFORE the wait.
		const eleventh = await app.inject({
			method: "POST",
			url: "/v1/auth/login",
			remoteAddress: "192.0.2.9",
			payload: { token: "sgr_wrong" },
		});
		expect(eleventh.statusCode).toBe(429);
		// A different IP is its own bucket.
		const elsewhere = await attempt("198.51.100.2");
		expect(elsewhere.statusCode).toBe(401);
		} finally {
			vi.useRealTimers();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// proxy method
// ---------------------------------------------------------------------------

const PROXY_ENV = {
	SIGRUN_AUTH: "proxy",
	SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
};
const PROXY_FILE = { auth: { adminGroups: ["admins"], proxy: { secretHeader: "x-sigrun-proxy-secret" } } };

describe("proxy method", () => {
	test("trusted peer + Remote-User/Remote-Groups → whoami alice, admin via groups, directory record NOT admin", async () => {
		const { app, opened } = await bootServer({
			env: PROXY_ENV,
			file: PROXY_FILE,
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: {
				"remote-user": "alice",
				"remote-groups": "users,admins",
			},
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			user: "alice",
			admin: true,
			method: "proxy",
		});
		// Auto-provisioned with admin:false — the proxy groups are stored
		// while the STORED `admin` flag stays false.
		expect(opened.identity.users.get("alice")).toMatchObject({
			user: "alice",
			admin: false,
			groups: [{ source: "proxy", values: ["users", "admins"] }],
			source: "proxy",
		});
	});

	test("untrusted peer → 401", async () => {
		const { app } = await bootServer({ env: PROXY_ENV, file: PROXY_FILE });
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "203.0.113.7",
			headers: { "remote-user": "alice" },
		});
		expect(response.statusCode).toBe(401);
	});

	test("v4-mapped v6 peer address authenticates", async () => {
		const { app } = await bootServer({ env: PROXY_ENV, file: PROXY_FILE });
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "::ffff:10.42.3.4",
			headers: { "remote-user": "alice" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().user).toBe("alice");
	});
});

// ---------------------------------------------------------------------------
// proxy secret header
// ---------------------------------------------------------------------------

describe("proxy secret header", () => {
	const SECRET_ENV = {
		...PROXY_ENV,
		SIGRUN_PROXY_SECRET: "s3cret",
	};
	const SECRET_FILE = {
		auth: { ...PROXY_FILE.auth, proxy: { secretHeader: "X-Sigrun-Proxy-Secret" } },
	};

	test("without the header → 401; with it → 200", async () => {
		const { app } = await bootServer({ env: SECRET_ENV, file: SECRET_FILE });
		const missing = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "alice" },
		});
		expect(missing.statusCode).toBe(401);
		const present = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "alice", "x-sigrun-proxy-secret": "s3cret" },
		});
		expect(present.statusCode).toBe(200);
	});

	test("a route handler never sees the secret header", async () => {
		const { app } = await bootServer({ env: SECRET_ENV, file: SECRET_FILE });
		let observed: unknown = "unset";
		app.addHook("preHandler", async (request) => {
			observed = request.headers["x-sigrun-proxy-secret"];
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "alice", "x-sigrun-proxy-secret": "s3cret" },
		});
		expect(response.statusCode).toBe(200);
		expect(observed).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// autoProvision
// ---------------------------------------------------------------------------

describe("proxy autoProvision", () => {
	test("autoProvision:false + an unknown user → 403 user_not_provisioned", async () => {
		const { app } = await bootServer({
			env: PROXY_ENV,
			file: { auth: { ...PROXY_FILE.auth, proxy: { autoProvision: false } } },
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "mallory" },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toMatchObject({ error: "user_not_provisioned" });
	});
});

test("second user via proxy auto-provision -> 403 isolation_required when unavailable", async () => {
	const { app, opened } = await bootServer({ env: { ...PROXY_ENV, SIGRUN_ISOLATION: "auto" }, file: PROXY_FILE, isolationAvailable: false });
	const response = await app.inject({
		method: "GET",
		url: "/v1/auth/whoami",
		remoteAddress: "10.42.3.4",
		headers: { "remote-user": "bob", "x-sigrun-proxy-secret": "s3cret" },
	});
	expect(response.statusCode).toBe(403);
	expect(response.json()).toEqual({ error: "isolation_required" });
	expect(opened.identity.users.get("bob")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// gateway C8 — proxy group-admin write-through
// ---------------------------------------------------------------------------

describe("proxy group write-through", () => {
	test("auto-provision carries the computed group admin; a later group-less request clears it", async () => {
		const { app, opened } = await bootServer({
			env: PROXY_ENV,
			file: PROXY_FILE,
		});
		const setGroupsSpy = vi.spyOn(opened.identity.users, "setGroups");
		const first = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob", "remote-groups": "users,admins" },
		});
		expect(first.statusCode).toBe(200);
		expect(first.json()).toMatchObject({
			user: "bob",
			admin: true,
			method: "proxy",
		});
		// The record is the only place host-side checks (chat commands,
		// no request headers) can read the grant — so the write-through
		// lands it on the directory, while the STORED admin stays false.
		// Provision writes the proxy source, while the STORED admin stays false.
		expect(setGroupsSpy).toHaveBeenCalledTimes(1);
		expect(opened.identity.users.get("bob")).toMatchObject({
			user: "bob",
			admin: false,
			groups: [{ source: "proxy", values: ["users", "admins"] }],
			source: "proxy",
		});

		const later = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob", "remote-groups": "users" },
		});
		expect(later.statusCode).toBe(200);
		expect(later.json()).toMatchObject({ user: "bob", admin: false });
		// Group exit replaces the stored proxy source at the next request.
		expect(opened.identity.users.get("bob")).toMatchObject({
			admin: false,
			groups: [{ source: "proxy", values: ["users"] }],
		});
		expect(setGroupsSpy).toHaveBeenCalledTimes(2);
		expect(setGroupsSpy).toHaveBeenLastCalledWith("bob", "proxy", ["users"]);
	});

	test("write-through only on change: two identical requests → ONE update", async () => {
		const { app, opened, dir } = await bootServer({
			env: PROXY_ENV,
			file: PROXY_FILE,
		});
		await opened.identity.users.add({
			user: "bob",
			admin: false,
			source: "cli",
		});
		const usersPath = join(dir, "users.json");
		for (const attempt of [1, 2]) {
			const response = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "bob", "remote-groups": "admins" },
			});
			expect(response.statusCode, `attempt ${attempt}`).toBe(200);
		}
		// The steady state must not rewrite the directory per request.
		const before = (await stat(usersPath)).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob", "remote-groups": "admins" },
		});
		expect((await stat(usersPath)).mtimeMs).toBe(before);
	});

	test("adminGroups: [] — C8 inactive: nothing is written, a stored grant is not cleared", async () => {
		const { app, opened } = await bootServer({
			env: PROXY_ENV,
			file: { auth: { ...PROXY_FILE.auth, adminGroups: [] } },
		});
		await opened.identity.users.add({
			user: "bob",
			admin: false,
			groups: [{ source: "login:oauth:acme", values: ["admins"], updatedAt: 1 }],
			source: "cli",
		});
		const setGroupsSpy = vi.spyOn(opened.identity.users, "setGroups");
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob", "remote-groups": "admins" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ user: "bob", admin: false });
		// With no configured admin groups the proxy grants nothing; stored
		// groups from other sources remain, but do not grant admin here.
		expect(setGroupsSpy).toHaveBeenCalledWith("bob", "proxy", ["admins"]);
		expect(opened.identity.users.get("bob")).toMatchObject({
			groups: [
				{ source: "login:oauth:acme", values: ["admins"] },
				{ source: "proxy", values: ["admins"] },
			],
		});
	});

	test("/v1/users keeps admin = the stored flag and derives groupAdmin from stored groups", async () => {
		const { app } = await bootServer({
			env: PROXY_ENV,
			file: PROXY_FILE,
		});
		const login = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob", "remote-groups": "admins" },
		});
		expect(login.statusCode).toBe(200);
		// The group admin passes the route's admin gate (effective admin),
		// but the wire row keeps the STORED flag for the users-admin UI's
		// toggle and carries the raw group flag alongside.
		const list = await app.inject({
			method: "GET",
			url: "/v1/users",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob", "remote-groups": "admins" },
		});
		expect(list.statusCode).toBe(200);
		const rows = list.json().users as {
			user: string;
			admin: boolean;
			groupAdmin?: boolean;
		}[];
		const bob = rows.find((row) => row.user === "bob");
		expect(bob).toMatchObject({ admin: false, groupAdmin: true, groups: ["admins"] });
	});
});

// ---------------------------------------------------------------------------
// C5: an own-host peer needs the shared secret or an exact trust entry
// ---------------------------------------------------------------------------

describe("own-host proxy peers (C5)", () => {
	beforeEach(() => {
		resetProxyDiagnostic();
		setOwnHostAddressesForTests(["10.42.9.9"]);
	});

	afterEach(() => {
		setOwnHostAddressesForTests(undefined);
	});

	test("an own-host peer trusted only through a range, without a secret → 401 + OWN_HOST warn", async () => {
		const { app } = await bootServer({
			env: { ...PROXY_ENV, SIGRUN_ISOLATION: "off" },
			// Seed the claimed directory AS alice: a second add under proxy
			// without secretHeader would hit the multi-user admission guard.
			seedUser: "alice",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const peer of ["10.42.9.9", "::ffff:10.42.9.9"]) {
				resetProxyDiagnostic();
				warn.mockClear();
				const response = await app.inject({
					method: "GET",
					url: "/v1/auth/whoami",
					remoteAddress: peer,
					headers: { "remote-user": "alice" },
				});
				expect(response.statusCode, `peer ${peer}`).toBe(401);
				expect(warn, `peer ${peer}`).toHaveBeenCalledTimes(1);
				expect(warn.mock.calls[0]!.join(" ")).toContain(
					ProxyRejectReason.OWN_HOST,
				);
			}
			// A remote peer inside the same range is unaffected.
			const remote = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "alice" },
			});
			expect(remote.statusCode).toBe(200);
		} finally {
			warn.mockRestore();
		}
	});

	test("an own-host peer WITH the shared secret configured: correct secret → 200, absent → 401 shared-secret reason", async () => {
		const { app } = await bootServer({
			env: { ...PROXY_ENV, SIGRUN_PROXY_SECRET: "s3cret", SIGRUN_ISOLATION: "off" },
			file: PROXY_FILE,
			seedUser: "alice",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const missing = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.9.9",
				headers: { "remote-user": "alice" },
			});
			expect(missing.statusCode).toBe(401);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain(
				ProxyRejectReason.secretReason("x-sigrun-proxy-secret"),
			);
			const present = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.9.9",
				headers: {
					"remote-user": "alice",
					"x-sigrun-proxy-secret": "s3cret",
				},
			});
			expect(present.statusCode).toBe(200);
		} finally {
			warn.mockRestore();
		}
	});

	test("loopback trusted via 127.0.0.0/8 without a secret → 401; via exact 127.0.0.1/32 → 200 + the boot warning", async () => {
		const { app } = await bootServer({
			env: {
				SIGRUN_AUTH: "proxy",
				SIGRUN_AUTH_TRUSTED_PROXIES: "127.0.0.0/8",
				SIGRUN_ISOLATION: "off",
			},
			seedUser: "alice",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const response = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "127.0.0.1",
				headers: { "remote-user": "alice" },
			});
			expect(response.statusCode).toBe(401);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain(
				ProxyRejectReason.OWN_HOST,
			);
		} finally {
			warn.mockRestore();
		}

		// The exact-listing escape hatch: no secret, but the address is
		// trusted verbatim — and the boot warned about that posture.
		const exactWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const exact = await bootServer({
				env: {
					SIGRUN_AUTH: "proxy",
					SIGRUN_AUTH_TRUSTED_PROXIES: "127.0.0.1/32",
					SIGRUN_ISOLATION: "off",
				},
				seedUser: "alice",
			});
			expect(
				exactWarn.mock.calls.some((call) =>
					call
						.join(" ")
						.includes(
							"trusting local address 127.0.0.1/32 without a shared secret lets any local process impersonate users; set server.auth.proxy.secretHeader",
						),
				),
			).toBe(true);
			const response = await exact.app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "127.0.0.1",
				headers: { "remote-user": "alice" },
			});
			expect(response.statusCode).toBe(200);
		} finally {
			exactWarn.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// bearer identity wins over the X-Sigrun-User hint
// ---------------------------------------------------------------------------

describe("verified identity wins over the header hint", () => {
	test("X-Sigrun-User: bob + alice's token → whoami alice", async () => {
		const { app, opened } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
		});
		await opened.identity.users.add({
			user: "alice",
			admin: false,
			source: "cli",
		});
		const token = await mintToken(opened, "alice");
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${token}`, "x-sigrun-user": "bob" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().user).toBe("alice");
	});
});

// ---------------------------------------------------------------------------
// Host + Origin checks
// ---------------------------------------------------------------------------

describe("Host check", () => {
	test("loopback bind: Host evil.example.invalid → 421", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "none" },
			listenHost: "127.0.0.1",
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { host: "evil.example.invalid" },
		});
		expect(response.statusCode).toBe(421);
	});

	test("loopback bind: Host localhost:3000 → 200", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "none" },
			listenHost: "127.0.0.1",
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { host: "localhost:3000" },
		});
		expect(response.statusCode).toBe(200);
	});
});

describe("Origin check", () => {
	test("POST /v1/conversations with Origin evil → 403 origin_mismatch; no Origin → 201", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "none" },
			listenHost: "127.0.0.1",
		});
		const mismatched = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: { origin: "https://evil.example.invalid" },
		});
		expect(mismatched.statusCode).toBe(403);
		expect(mismatched.json()).toMatchObject({ error: "origin_mismatch" });
		const absent = await app.inject({ method: "POST", url: "/v1/conversations" });
		expect(absent.statusCode).toBe(201);
	});
});

// ---------------------------------------------------------------------------
// unclaimed gate + env service token
// ---------------------------------------------------------------------------

describe("unclaimed gate + service token", () => {
	test("no bearer → 403 setup_required (never 401 — the pipeline order)", async () => {
		const { app } = await bootServer({
			claimed: false,
			env: { SIGRUN_API_TOKEN: "sgr_test_env" },
			listenHost: "0.0.0.0",
		});
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(403);
		expect(response.json()).toMatchObject({ error: "setup_required" });
	});

	test("the env service-token bearer → 200 service principal, skips the gate", async () => {
		const { app } = await bootServer({
			claimed: false,
			env: { SIGRUN_API_TOKEN: "sgr_test_env" },
			listenHost: "0.0.0.0",
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: "Bearer sgr_test_env" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			user: "sigrun",
			service: true,
			method: "token",
		});
	});

	test("GET / and /healthz answer without credentials on a claimed token server", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token", SIGRUN_WEBUI: "false" },
		});
		const root = await app.inject({ method: "GET", url: "/" });
		// No webui bundle in a bare checkout: not a 401/403 — the pipeline
		// answered (a mounted bundle would serve 200).
		expect(root.statusCode).not.toBe(401);
		expect(root.statusCode).not.toBe(403);
		const healthz = await app.inject({ method: "GET", url: "/healthz" });
		expect(healthz.statusCode).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// encoded paths — the public surface is decided from the MATCHED ROUTE
// ---------------------------------------------------------------------------

/** The hand-written webui bundle fixture (the server-static pattern). */
const WEBUI_FIXTURE = join(import.meta.dirname, "fixtures", "webui-dist");

/** The fixture-routes extension entry (the extension-routes pattern). */
const ROUTES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-routes", "index.js"),
).href;

/**
 * Every encoded/dotted spelling of an authenticated `/v1` GET surface.
 * Fastify decodes the path BEFORE routing (`%76` = `v`, `%73` = `s`), so
 * the raw-URL prefix check in `isPublicPath` misread these as the browser
 * surface. Every one must answer 401 `unauthenticated` with no credential.
 */
const ENCODED_API_PATHS = [
	"/%761/settings",
	"/%761/extensions",
	"/%761/providers",
	"/%761/meta",
	"/%761/interactions",
	"/%761/users",
	"/%761/jobs",
	"/%761/conversations",
	"/%761/auth/whoami",
	"/v1/%73ettings",
	"/./v1/settings",
] as const;

describe("encoded paths", () => {
	test("encoded /v1 spellings without a credential → 401 unauthenticated", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token", SIGRUN_WEBUI: "false" },
		});
		for (const url of ENCODED_API_PATHS) {
			const response = await app.inject({ method: "GET", url });
			expect(
				response.statusCode,
				`status for ${url}`,
			).toBe(401);
			expect(response.json(), `body for ${url}`).toEqual({
				error: "unauthenticated",
			});
		}
	});

	test("GET /%761/nope is the SPA (or a 404), never API data or a 500", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
			webuiBundle: WEBUI_FIXTURE,
		});
		const response = await app.inject({ method: "GET", url: "/%761/nope" });
		expect(response.statusCode).not.toBe(500);
		expect(response.statusCode).not.toBe(401);
		const type = String(response.headers["content-type"] ?? "");
		if (response.statusCode === 200) {
			expect(type).toContain("text/html");
		} else {
			expect(response.statusCode).toBe(404);
		}
		// Never an API payload: no settings `effective` body leaks.
		expect(response.body).not.toContain("effective");
	});

	test("the browser surface stays public", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
			webuiBundle: WEBUI_FIXTURE,
		});
		const root = await app.inject({ method: "GET", url: "/" });
		expect(root.statusCode).toBe(200);
		expect(String(root.headers["content-type"])).toContain("text/html");
		const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
		expect(asset.statusCode).toBe(200);
		const spa = await app.inject({ method: "GET", url: "/some/spa/route" });
		expect(spa.statusCode).toBe(200);
		expect(String(spa.headers["content-type"])).toContain("text/html");
		const healthz = await app.inject({ method: "GET", url: "/healthz" });
		expect(healthz.statusCode).toBe(200);
		const readyz = await app.inject({ method: "GET", url: "/readyz" });
		expect(readyz.statusCode).toBe(200);
	});

	test("the static wildcard's matched-route pattern is exactly `/*`", async () => {
		// The pipeline's rule 5 matches this string LITERALLY — pin it so
		// a fastify-static upgrade that changes the pattern fails HERE
		// (loudly), not as every browser request 401ing.
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token" },
			webuiBundle: WEBUI_FIXTURE,
		});
		const patterns = new Set<string>();
		app.addHook("preHandler", async (request) => {
			patterns.add(String(request.routeOptions?.url));
		});
		for (const url of ["/", "/assets/app.js"]) {
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode).toBe(200);
		}
		expect([...patterns]).toContain("/*");
	});

	test("POST /v1/auth/login and GET /v1/onboarding stay public", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token", SIGRUN_WEBUI: "false" },
		});
		const login = await app.inject({
			method: "POST",
			url: "/v1/auth/login",
			payload: { token: "sgr_wrong" },
		});
		// 401 = the handler answered (the limiter's bad-token path); the
		// pipeline let the unauthenticated POST through.
		expect(login.statusCode).toBe(401);
		const onboarding = await app.inject({ method: "GET", url: "/v1/onboarding" });
		expect(onboarding.statusCode).toBe(200);
	});

	test("an encoded extension route declared auth:user → 401; auth:public stays reachable", async () => {
		const { app } = await bootServer({
			env: { SIGRUN_AUTH: "token", SIGRUN_WEBUI: "false" },
			extensionSpecifiers: [ROUTES_SPECIFIER],
		});
		const user = await app.inject({
			method: "GET",
			url: "/%761/ext/fixture-routes/ping",
		});
		expect(user.statusCode).toBe(401);
		expect(user.json()).toEqual({ error: "unauthenticated" });
		// The plain spelling of the same route: identical answer (a
		// regression here would mean the pipeline diverged per spelling).
		const plain = await app.inject({
			method: "GET",
			url: "/v1/ext/fixture-routes/ping",
		});
		expect(plain.statusCode).toBe(401);
		// A declared-public route under the encoded prefix still skips
		// stage 5 (webhooks verify their own caller).
		const hook = await app.inject({
			method: "POST",
			url: "/%761/ext/fixture-routes/hook",
			headers: { "content-type": "text/plain" },
			payload: "x",
		});
		expect(hook.statusCode).toBe(200);
		expect(hook.body).toBe("x");
	});
});

// ---------------------------------------------------------------------------
// proxy-auth rejection diagnostics (release-readiness Task 1, spec §3)
// ---------------------------------------------------------------------------

describe("proxy-auth rejection diagnostics", () => {
	beforeEach(() => {
		// The shared diagnostic's per-reason 60 s throttle is module state
		// (proxy-trust C1): reset it so each test sees every first emission.
		resetProxyDiagnostic();
	});

	const SECRET_ENV = {
		...PROXY_ENV,
		SIGRUN_PROXY_SECRET: "s3cret",
	};
	const SECRET_FILE = {
		auth: {
			...PROXY_FILE.auth,
			proxy: { secretHeader: "x-sigrun-proxy-secret" },
		},
	};
	// Values that must NEVER appear in the log line (spec §3's hygiene
	// rule): tokens, cookies, identity-header VALUES, query strings, and
	// the full URL. Header NAMES are spec-legal (the reason names the
	// configured header that was missing/wrong); only VALUES are banned,
	// so this list deliberately contains no header names — a name needle
	// could never fail while the configured name is logged.
	const SENSITIVE = [
		"s3cret",
		"alice",
		"sk-token-value",
		"session=abc",
		"/v1/auth/whoami?x=1",
		"x=1",
		"wr0ng",
		"INVALID_USER!",
	];

	test("a proxy-only deployment logs exactly one warn for a rejected credential-bearing request", async () => {
		// SIGRUN_AUTH: "proxy" — NO token method exists, so a Bearer on an
		// untrusted peer is a proxy-method 401, not a token failure: the
		// diagnostic MUST fire (spec §3 exempts token-auth failures only).
		const { app } = await bootServer({ env: SECRET_ENV, file: SECRET_FILE });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const untrustedBearer = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "203.0.113.7",
				headers: { authorization: "Bearer sk-token-value" },
			});
			expect(untrustedBearer.statusCode).toBe(401);
			expect(warn).toHaveBeenCalledTimes(1);
			const line = warn.mock.calls[0]!.join(" ");
			expect(line).toContain("203.0.113.7");
			expect(line).toContain("untrusted proxy");
			// The presented credential's VALUE never logs.
			expect(line).not.toContain("sk-token-value");
		} finally {
			warn.mockRestore();
		}
	});

	test("each rejection shape logs exactly ONE sanitized warn naming the peer", async () => {
		const { app } = await bootServer({ env: SECRET_ENV, file: SECRET_FILE });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// 1. Untrusted proxy peer (carrying every sensitive value — no
			// credential headers: a presented Bearer would mark the request
			// as token-attempting and suppress the diagnostic).
			const untrusted = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami?x=1",
				remoteAddress: "203.0.113.7",
				headers: {
					"remote-user": "alice",
					"x-sigrun-proxy-secret": "s3cret",
				},
			});
			expect(untrusted.statusCode).toBe(401);
			// 2. Trusted peer, missing the shared secret.
			const missingSecret = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "alice" },
			});
			expect(missingSecret.statusCode).toBe(401);
			// 3. Trusted peer, wrong shared secret.
			const wrongSecret = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "alice", "x-sigrun-proxy-secret": "wr0ng" },
			});
			expect(wrongSecret.statusCode).toBe(401);
			// 4. Trusted peer + secret, missing identity header.
			const missingIdentity = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { "x-sigrun-proxy-secret": "s3cret" },
			});
			expect(missingIdentity.statusCode).toBe(401);
			// 5. Trusted peer + secret, an identity claim the directory can
			// never represent → 403 invalid_username, logged with a
			// value-free reason.
			const invalidUsername = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: {
					"remote-user": "INVALID_USER!",
					"x-sigrun-proxy-secret": "s3cret",
				},
			});
			expect(invalidUsername.statusCode).toBe(403);

			// The diagnostic now throttles per reason (proxy-trust C1):
			// rejections 2 and 3 share the missing/wrong-secret reason, so
			// the second is suppressed — FIVE rejections, FOUR lines.
			expect(warn).toHaveBeenCalledTimes(4);
			const lines = warn.mock.calls.map((call) => call.join(" "));
			expect(lines[0]).toContain("203.0.113.7");
			expect(lines[0]).toContain("untrusted proxy");
			expect(lines[1]).toContain("10.42.3.4");
			expect(lines[1]).toContain("shared secret");
			expect(lines[2]).toContain("10.42.3.4");
			expect(lines[2]).toContain("identity header");
			expect(lines[3]).toContain("10.42.3.4");
			expect(lines[3]).toContain("unusable identity claim");
			for (const line of lines) {
				// The request method and the RESOLVED route template.
				expect(line).toContain("GET");
				expect(line).toContain("/v1/auth/whoami");
				for (const forbidden of SENSITIVE) {
					expect(line).not.toContain(forbidden);
				}
			}
		} finally {
			warn.mockRestore();
		}
	});

	test("no warn on token-auth failures or successful proxy authentication", async () => {
		const { app, opened } = await bootServer({
			// Both methods configured: the token leg's failure must stay
			// silent even when the proxy method never ran for it.
			env: { ...SECRET_ENV, SIGRUN_AUTH: "token,proxy" },
			file: SECRET_FILE,
		});
		// The token leg's user: added BEFORE the spy installs (the store
		// write warns when a second user is added while the sandbox is
		// unavailable — that boot-posture warning is not this diagnostic).
		// The admin flag keeps the multi-user admission guard satisfied
		// without touching group-derived admin machinery.
		await opened.identity.users.add({
			user: "carol",
			admin: true,
			source: "cli",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// A trusted proxy peer presenting ONLY a bad Bearer: the token
			// method's failure — never proxy diagnostics.
			const badToken = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { authorization: "Bearer sk-not-a-token" },
			});
			expect(badToken.statusCode).toBe(401);
			// A valid token with NO proxy headers: proxy misses identity, the
			// token authenticates — the request succeeded, nothing to log.
			const token = await mintToken(opened, "carol");
			const goodToken = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(goodToken.statusCode).toBe(200);
			// A successful proxy authentication.
			const proxied = await app.inject({
				method: "GET",
				url: "/v1/auth/whoami",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "alice", "x-sigrun-proxy-secret": "s3cret" },
			});
			expect(proxied.statusCode).toBe(200);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
