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
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { LoginResolver } from "../src/server/routes/login.js";
import { createServer } from "../src/server/index.js";
import { fixtureLoginProvider, setFixtureLoginProviders } from "./fixtures/fixture-login/index.js";
import { seededIdentity } from "./helpers/identity.js";

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
		identity: await seededIdentity(dir),
		extensionSpecifiers: options.extensionSpecifiers ?? [LOGIN_SPECIFIER],
		builtins: false,
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
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

	test("a verified callback without Task 5's resolver answers 501", async () => {
		const { app } = await bootServer();
		const started = await begin(app);
		const response = await app.inject({
			method: "GET",
			url: `/v1/auth/callback/login:fixture-login:fixture?state=${started.state}`,
			headers: { cookie: started.cookie },
		});
		expect(response.statusCode).toBe(501);
		expect(response.json()).toEqual({ error: "not_implemented" });
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
