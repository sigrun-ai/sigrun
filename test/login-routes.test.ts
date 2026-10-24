import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { AdmissionRefusedError } from "../src/harness/identity/users.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { LoginResolver } from "../src/server/routes/login.js";
import { createServer } from "../src/server/index.js";
import { fixtureLoginProvider, setFixtureLoginProviders } from "./fixtures/fixture-login/index.js";
import { seededIdentity, unclaimedIdentity } from "./helpers/identity.js";
import { ensureSetupCode, readSetupCode } from "../src/harness/identity/setup-code.js";

const LOGIN_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-login", "index.js"),
).href;
const cleanups: Array<() => Promise<void>> = [];

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	dir: string;
}

async function bootServer(options: {
	resolver?: LoginResolver;
	now?: () => number;
	extensionSpecifiers?: string[];
	isolationAvailable?: boolean;
	unclaimed?: boolean;
} = {}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-login-routes-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_AUTH: "token",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_PUBLIC_URL: "https://sigrun.example.invalid",
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: join(dir, "config"),
		identity: options.unclaimed === true ? await unclaimedIdentity(dir) : await seededIdentity(dir),
		extensionSpecifiers: options.extensionSpecifiers ?? [LOGIN_SPECIFIER],
		builtins: false,
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
	if (options.isolationAvailable !== undefined && !options.isolationAvailable) {
		opened.identity.users.configureAdmission({
			admit: () => { throw new AdmissionRefusedError("isolation_required", "isolation_required: unavailable in test"); },
		});
	}
	const app = await createServer(opened, config, [], {
		listenHost: "127.0.0.1",
		...(options.resolver === undefined ? {} : { loginResolver: options.resolver }),

		...(options.now === undefined ? {} : { loginNow: options.now }),
	});
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, config, dir };
}

afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function begin(app: FastifyInstance, query = "") {
	const response = await app.inject({
		method: "GET",
		url: `/v1/auth/login/login:fixture-login:fixture${query}`,
	});
	expect(response.statusCode).toBe(302);
	const location = response.headers.location;
	const cookie = response.headers["set-cookie"];
	expect(typeof location).toBe("string");
	expect(typeof cookie).toBe("string");
	return {
		state: new URL(location as string).searchParams.get("state") as string,
		cookie: (cookie as string).split(";", 1)[0],
		setCookie: cookie as string,
		location: location as string,
	};
}

describe("login provider routes", () => {
	test("providers lists only loaded, validated contributions", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			providers: [{
				provider: "login:fixture-login:fixture",
				label: "Fixture identity",
				icon: "key",
			}],
		});
	});

	test("begin redirects to the provider and sets a browser-bound state cookie", async () => {
		const { app } = await bootServer();
		const flow = await begin(app, "?return=/settings%3Fsection%3Daccounts");
		expect(flow.location).toBe("https://idp.example.invalid/authorize?state=" + flow.state);
		expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(flow.setCookie).toContain("sigrun_login_state=");
		expect(flow.setCookie).toContain("HttpOnly");
		expect(flow.setCookie).toContain("SameSite=Lax");
		expect(flow.setCookie).toContain("Path=/v1/auth/callback");
		expect(flow.setCookie).not.toContain("SameSite=Strict");
	});

	test("callback hands the verified result and persisted provider data to the resolver", async () => {
		const resolveLogin = vi.fn<LoginResolver>(async ({ flow, reply }) => {
			await reply.code(200).send({ returnTo: flow.returnTo, link: flow.link });
		});
		const { app } = await bootServer({ resolver: resolveLogin });
		const started = await begin(app, "?return=/settings%3Fsection%3Daccounts");
		const response = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ returnTo: "/settings?section=accounts" });
		expect(resolveLogin).toHaveBeenCalledOnce();
		const input = resolveLogin.mock.calls[0]?.[0];
		expect(input?.provider).toBe("login:fixture-login:fixture");
		expect(input?.result).toEqual({
			subject: "subject-123",
			profile: { username: "fixture-user", name: "Fixture User" },
			groups: ["family"],
		});
		expect(input?.flow.data.verifier).toBe("fixture-verifier");
		expect(input?.flow.callbackUrl).toBe("https://sigrun.example.invalid/v1/auth/callback/login%3Afixture-login%3Afixture");
	});

	test("state is single-use: replay redirects invalid_state without calling complete", async () => {
		const complete = vi.spyOn(fixtureLoginProvider, "complete");
		const { app } = await bootServer({ resolver: async ({ reply }) => { await reply.code(204).send(); } });
		const started = await begin(app);
		const url = `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`;
		const first = await app.inject({ method: "GET", url, headers: { cookie: started.cookie } });
		expect(first.statusCode).toBe(204);
		const replay = await app.inject({ method: "GET", url, headers: { cookie: started.cookie } });
		expect(replay.statusCode).toBe(400);
		expect(replay.headers.location).toBe("/login?error=invalid_state");
		expect(complete).toHaveBeenCalledOnce();
	});

	test("state is bound to its provider and cannot complete through another provider", async () => {
		const otherComplete = vi.fn(async () => ({ subject: "other", profile: {} }));
		setFixtureLoginProviders([
			fixtureLoginProvider,
			{ ...fixtureLoginProvider, id: "other", complete: otherComplete },
		]);
		try {
			const { app } = await bootServer();
			const started = await begin(app);
			const callback = (provider: string) => app.inject({
				method: "GET",
				url: `/v1/auth/callback/${provider}?state=${started.state}`,
				headers: { cookie: started.cookie },
			});
			const mismatch = await callback("login:fixture-login:other");
			expect(mismatch.statusCode).toBe(400);
			expect(mismatch.headers.location).toBe("/login?error=invalid_state");
			expect(otherComplete).not.toHaveBeenCalled();
			const original = await callback("login:fixture-login:fixture");
			expect(original.statusCode).toBe(400);
			expect(original.headers.location).toBe("/login?error=invalid_state");
			expect(otherComplete).not.toHaveBeenCalled();
		} finally {
			setFixtureLoginProviders([fixtureLoginProvider]);
		}
	});

	test("state presented with a different browser cookie redirects invalid_state", async () => {
		const { app } = await bootServer();
		const started = await begin(app);
		const response = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: "sigrun_login_state=another-browser" },
		});
		expect(response.statusCode).toBe(400);
		expect(response.headers.location).toBe("/login?error=invalid_state");
	});

	test("state older than 600000 ms redirects login_expired", async () => {
		let now = 1_000_000;
		const { app } = await bootServer({ now: () => now });
		const started = await begin(app);
		now += 600_001;
		const response = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		expect(response.statusCode).toBe(400);
		expect(response.headers.location).toBe("/login?error=login_expired");
	});

	test("a fresh server flow store after restart redirects login_expired", async () => {
		const { app, opened, config } = await bootServer();
		const started = await begin(app);
		const restarted = await createServer(opened, config, [], { listenHost: "127.0.0.1" });
		cleanups.push(async () => { await restarted.close(); });
		const response = await restarted.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		expect(response.statusCode).toBe(400);
		expect(response.headers.location).toBe("/login?error=login_expired");
	});

	test("an unknown identity asks for an invite, then a valid code sets a session cookie", async () => {
		const { app, opened } = await bootServer();
		const invite = await opened.identity.invites.create({ admin: false });
		const started = await begin(app, "?return=/after-login");
		const interstitial = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		expect(interstitial.statusCode).toBe(302);
		const location = new URL(interstitial.headers.location as string, "https://sigrun.example.invalid");
		expect(location.pathname).toBe("/login/code");
		expect(location.searchParams.get("reason")).toBe("invite");
		const key = location.searchParams.get("key") as string;
		expect(key).not.toBe(started.state);
		const resumed = await app.inject({
			method: "POST",
			url: "/v1/auth/login/code",
			payload: { key, code: invite.code },
		});
		expect(resumed.statusCode).toBe(302);
		expect(resumed.headers.location).toBe("/after-login");
		const cookie = resumed.headers["set-cookie"] as string;
		expect(cookie).toContain("sigrun_session=sgr_");
		expect(cookie).toContain("HttpOnly");
		const token = cookie.split(";", 1)[0]?.split("=", 2)[1] as string;
		expect(opened.identity.tokens.verify(token)).toMatchObject({
			user: "fixture-user",
			kind: "session",
			provider: "login:fixture-login:fixture",
		});
		expect(opened.identity.accounts.lookup("login:fixture-login:fixture", "subject-123")?.user).toBe("fixture-user");
		expect(opened.identity.users.get("fixture-user")?.groups?.[0]?.values).toEqual(["family"]);
		const replay = await app.inject({
			method: "POST",
			url: "/v1/auth/login/code",
			payload: { key, code: invite.code },
		});
		expect(replay.statusCode).toBe(400);
		expect(replay.headers.location).toBe("/login?error=login_expired");
	});

	test("an unclaimed setup-code claim retries a wrong code and clears the code only after success", async () => {
		const { app, opened } = await bootServer({ unclaimed: true });
		await ensureSetupCode(opened.identity.cacheDir, { SIGRUN_SETUP_CODE: "AAAA-BBBB" });
		const started = await begin(app);
		const callback = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		const location = new URL(callback.headers.location as string, "https://sigrun.example.invalid");
		expect(location.searchParams.get("reason")).toBe("setup");
		const key = location.searchParams.get("key") as string;
		const wrong = await app.inject({ method: "POST", url: "/v1/auth/login/code", payload: { key, code: "wrong" } });
		expect(wrong.statusCode).toBe(403);
		expect(wrong.headers.location).toBe("/login?error=invalid_code");
		expect(readSetupCode(opened.identity.cacheDir)).toBe("AAAA-BBBB");
		const success = await app.inject({ method: "POST", url: "/v1/auth/login/code", payload: { key, code: "AAAA-BBBB" } });
		expect(success.statusCode).toBe(302);
		expect(success.headers["set-cookie"]).toContain("sigrun_session=");
		expect(opened.identity.users.get("fixture-user")).toMatchObject({ admin: true, source: "login" });
		expect(readSetupCode(opened.identity.cacheDir)).toBeUndefined();
	});

	test("a code-resume key expires after ten more minutes", async () => {
		let now = 1_000_000;
		const { app } = await bootServer({ now: () => now });
		const started = await begin(app);
		const callback = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		const key = new URL(callback.headers.location as string, "https://sigrun.example.invalid").searchParams.get("key");
		now += 600_001;
		const expired = await app.inject({ method: "POST", url: "/v1/auth/login/code", payload: { key, code: "unused" } });
		expect(expired.statusCode).toBe(400);
		expect(expired.headers.location).toBe("/login?error=login_expired");
	});

	test("a provider auto-provision policy is enforced and creates a non-admin session", async () => {
		setFixtureLoginProviders([{ ...fixtureLoginProvider, policy: { autoProvision: true, allowedGroups: ["family"] } }]);
		try {
			const { app, opened } = await bootServer();
			const started = await begin(app);
			const response = await app.inject({
				method: "GET",
				url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
				headers: { cookie: started.cookie },
			});
			expect(response.statusCode).toBe(302);
			expect(response.headers.location).toBe("/");
			expect(opened.identity.users.get("fixture-user")).toMatchObject({ admin: false, source: "login" });
		} finally {
			setFixtureLoginProviders([fixtureLoginProvider]);
		}
	});

	test("an explicit link redirects to account settings without replacing the caller's session", async () => {
		const { app, opened } = await bootServer();
		const { token } = await opened.identity.tokens.createSession("tester", "login:fixture-login:fixture", 60_000);
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/login/login:fixture-login:fixture?link=1",
			headers: { cookie: `sigrun_session=${token}` },
		});
		const state = new URL(response.headers.location as string).searchParams.get("state");
		const stateCookie = (response.headers["set-cookie"] as string).split(";", 1)[0];
		const linked = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${state}`,
			headers: { cookie: stateCookie },
		});
		expect(linked.statusCode).toBe(302);
		expect(linked.headers.location).toBe("/settings?section=accounts");
		expect(linked.headers["set-cookie"]).toBeUndefined();
		expect(opened.identity.accounts.lookup("login:fixture-login:fixture", "subject-123")?.user).toBe("tester");
	});

	test("a second-user login without isolation redirects isolation_required and creates no link", async () => {
		const { app, opened } = await bootServer({ isolationAvailable: false });
		const invite = await opened.identity.invites.create({ admin: false });
		const started = await begin(app);
		const interstitial = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		const key = new URL(interstitial.headers.location as string, "https://sigrun.example.invalid").searchParams.get("key");
		const response = await app.inject({
			method: "POST",
			url: "/v1/auth/login/code",
			payload: { key, code: invite.code },
		});
		expect(response.statusCode).toBe(403);
		expect(response.headers.location).toBe("/login?error=isolation_required");
		expect(opened.identity.users.get("fixture-user")).toBeUndefined();
		expect(opened.identity.accounts.lookup("login:fixture-login:fixture", "subject-123")).toBeUndefined();
	});



	test("unsafe return targets become / at both begin and callback", async () => {
		const resolveLogin = vi.fn<LoginResolver>(async ({ flow, reply }) => { await reply.code(200).send(flow.returnTo); });
		const { app } = await bootServer({ resolver: resolveLogin });
		for (const unsafe of ["//evil.example.invalid", "https://evil.example.invalid", "/\\evil.example.invalid", "\\evil.example.invalid"]) {
			const started = await begin(app, `?return=${encodeURIComponent(unsafe)}`);
			const response = await app.inject({
				method: "GET",
				url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}&return=${encodeURIComponent(unsafe)}`,
				headers: { cookie: started.cookie },
			});
			expect(response.statusCode).toBe(200);
			expect(response.body).toBe("/");
		}
	});

	test("link=1 without an authenticated principal is 401", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/login/login:fixture-login:fixture?link=1",
		});
		expect(response.statusCode).toBe(401);
		expect(response.json()).toEqual({ error: "unauthenticated" });
	});

	test("link=1 resolves the session cookie itself and stores the user in the flow", async () => {
		const resolveLogin = vi.fn<LoginResolver>(async ({ reply }) => { await reply.code(204).send(); });
		const { app, opened } = await bootServer({ resolver: resolveLogin });
		const { token } = await opened.identity.tokens.createSession("tester", "login:fixture-login:fixture", 60_000);
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/login/login:fixture-login:fixture?link=1",
			headers: { cookie: `sigrun_session=${token}` },
		});
		expect(response.statusCode).toBe(302);
		const state = new URL(response.headers.location as string).searchParams.get("state");
		const cookie = (response.headers["set-cookie"] as string).split(";", 1)[0];
		await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${state}`,
			headers: { cookie },
		});
		expect(resolveLogin.mock.calls[0]?.[0].flow.link).toBe("tester");
	});

	test("a provider exception logs its message but exposes only provider_error", async () => {
		const complete = vi.spyOn(fixtureLoginProvider, "complete").mockRejectedValueOnce(new Error("sensitive provider detail"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { app } = await bootServer();
			const started = await begin(app);
			const response = await app.inject({
				method: "GET",
				url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
				headers: { cookie: started.cookie },
			});
			expect(response.statusCode).toBe(400);
			expect(response.headers.location).toBe("/login?error=provider_error");
			expect(response.body).not.toContain("sensitive provider detail");
			expect(log.mock.calls.some((call) => call.join(" ").includes("sensitive provider detail"))).toBe(true);
			expect(complete).toHaveBeenCalledOnce();
		} finally {
			complete.mockRestore();
			log.mockRestore();
		}
	});

	test("resolver failures use login_failed, not provider_error", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { app } = await bootServer({ resolver: async () => {
				throw new Error("account store unavailable");
			} });
			const started = await begin(app);
			const response = await app.inject({
				method: "GET",
				url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
				headers: { cookie: started.cookie },
			});
			expect(response.statusCode).toBe(500);
			expect(response.headers.location).toBe("/login?error=login_failed");
			expect(response.body).not.toContain("account store unavailable");
			expect(log.mock.calls.some((call) => call.join(" ").includes("resolver failed") && call.join(" ").includes("account store unavailable"))).toBe(true);
			expect(log.mock.calls.some((call) => call.join(" ").includes("complete failed"))).toBe(false);
		} finally {
			log.mockRestore();
		}
	});

	test("unknown providers are 404 with unknown_provider", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/auth/login/login:fixture-login:absent" });
		expect(response.statusCode).toBe(404);
		expect(response.headers.location).toBe("/login?error=unknown_provider");
	});

	test("a quarantined provider contributes no providers entry and no usable route", async () => {
		setFixtureLoginProviders([{ ...fixtureLoginProvider, id: "Bad Id" }]);
		try {
			const { app, opened } = await bootServer();
			expect(opened.loginProviders).toEqual([]);
			const list = await app.inject({ method: "GET", url: "/v1/auth/providers" });
			expect(list.json()).toEqual({ providers: [] });
			const beginResponse = await app.inject({ method: "GET", url: "/v1/auth/login/login:fixture-login:fixture" });
			expect(beginResponse.statusCode).toBe(404);
		} finally {
			setFixtureLoginProviders([fixtureLoginProvider]);
		}
	});

	test("POST callbacks forward query and body to complete", async () => {
		const complete = vi.spyOn(fixtureLoginProvider, "complete");
		const { app } = await bootServer({ resolver: async ({ reply }) => { await reply.code(204).send(); } });
		const started = await begin(app);
		const response = await app.inject({
			method: "POST",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie, "content-type": "application/json" },
			payload: { code: "abc" },
		});
		expect(response.statusCode).toBe(204);
		expect(complete).toHaveBeenCalledOnce();
		expect(complete.mock.calls[0]?.[1]).toMatchObject({
			query: { state: started.state },
			body: { code: "abc" },
		});
	});
});
