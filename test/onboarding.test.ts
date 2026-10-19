/**
 * The onboarding routes (core hardening W1 Task 4, spec §5.8): the
 * unclaimed state, the setup code's lifecycle, and the claim paths
 * (token-only code claim, proxy-identity claim, loopback claim) — the
 * claim mutex, the root-owner stamp, and the already-claimed failures.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()`
 * (see auth-hook.test.ts). Every boot here is UNCLAIMED (no identity
 * seed) — boot's `ensureSetupCode` writes the code under the tmp cache
 * root, and the tests read it through the exported `readSetupCode`.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { readSetupCode } from "../src/harness/identity/index.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	dir: string;
}

/**
 * Boot one hermetic UNCLAIMED server. The cache and state roots are
 * pinned under the tmp dir so the boot-time setup-code write and the
 * invites store never touch a real home.
 */
async function bootServer(options: {
	env?: Record<string, string | undefined>;
	file?: { auth?: Record<string, unknown> };
	listenHost?: string;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-onboarding-"));
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
		...options.env,
	};
	const config = loadConfig(env, {
		server: options.file ?? {},
	} as Parameters<typeof loadConfig>[1]);
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
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
	return { app, opened, dir };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

// ---------------------------------------------------------------------------
// unclaimed boot: the setup code file
// ---------------------------------------------------------------------------

describe("unclaimed boot", () => {
	test("writes <cacheDir>/setup-code and NOT <stateDir>/setup-code", async () => {
		const { dir } = await bootServer({});
		expect(existsSync(join(dir, "cache", "setup-code"))).toBe(true);
		expect(existsSync(join(dir, "state", "setup-code"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/onboarding
// ---------------------------------------------------------------------------

describe("GET /v1/onboarding", () => {
	test("no credential, 0.0.0.0 bind → unclaimed, codeRequired true", async () => {
		const { app } = await bootServer({ listenHost: "0.0.0.0" });
		const response = await app.inject({ method: "GET", url: "/v1/onboarding" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			state: "unclaimed",
			methods: ["token"],
			codeRequired: true,
		});
	});

	test("a trusted proxy identity → codeRequired false + proxyIdentity", async () => {
		const { app } = await bootServer({
			env: {
				SIGRUN_AUTH: "proxy",
				SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
			},
			listenHost: "0.0.0.0",
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/onboarding",
			remoteAddress: "10.42.3.4",
			headers: {
				"remote-user": "michael",
				"remote-name": "Michael",
				"remote-email": "michael@example.invalid",
			},
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			state: "unclaimed",
			methods: ["proxy"],
			codeRequired: false,
			proxyIdentity: {
				user: "michael",
				name: "Michael",
				email: "michael@example.invalid",
			},
		});
	});
});

// ---------------------------------------------------------------------------
// POST /v1/onboarding/claim
// ---------------------------------------------------------------------------

describe("POST /v1/onboarding/claim", () => {
	test("a wrong code → 403 invalid_code", async () => {
		const { app } = await bootServer({ listenHost: "0.0.0.0" });
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: { code: "ZZZZ-ZZZZ", user: "eve" },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "invalid_code" });
	});

	test("the right code + issueToken → 200 with a token + cookie; claimed; file gone; second claim → 409", async () => {
		const { app, opened } = await bootServer({ listenHost: "0.0.0.0" });
		const code = readSetupCode(opened.identity.cacheDir);
		expect(code).toBeDefined();
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: {
				code,
				user: "founder",
				name: "Founder",
				email: "founder@example.invalid",
				issueToken: true,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.user).toMatchObject({
			user: "founder",
			name: "Founder",
			email: "founder@example.invalid",
			admin: true,
		});
		expect(typeof body.token).toBe("string");
		expect(body.token.startsWith("sgr_")).toBe(true);
		const cookie = response.headers["set-cookie"];
		const cookieLine = Array.isArray(cookie) ? cookie[0] : cookie;
		expect(cookieLine).toContain("sigrun_session=");
		// The token authenticates immediately (the minted credential works).
		const whoami = await app.inject({
			method: "GET",
			url: "/v1/auth/whoami",
			headers: { authorization: `Bearer ${body.token}` },
		});
		expect(whoami.statusCode).toBe(200);
		expect(whoami.json().user).toBe("founder");
		// Claimed, and the code file is gone.
		const state = await app.inject({ method: "GET", url: "/v1/onboarding" });
		expect(state.json().state).toBe("claimed");
		expect(existsSync(join(opened.identity.cacheDir, "setup-code"))).toBe(false);
		const second = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: { user: "second" },
		});
		expect(second.statusCode).toBe(409);
		expect(second.json()).toEqual({ error: "already_claimed" });
	});

	test("two concurrent correct claims → exactly one 200", async () => {
		const { app, opened } = await bootServer({ listenHost: "0.0.0.0" });
		const code = readSetupCode(opened.identity.cacheDir);
		const claims = await Promise.all([
			app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				payload: { code, user: "winner" },
			}),
			app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				payload: { code, user: "runner" },
			}),
		]);
		const statuses = claims.map((claim) => claim.statusCode).sort();
		expect(statuses).toEqual([200, 409]);
		const winner = claims.find((claim) => claim.statusCode === 200);
		expect(winner?.json().user.user).toBe("winner");
	});

	test("a proxy claim with no code → admin, identity from headers", async () => {
		const { app } = await bootServer({
			env: {
				SIGRUN_AUTH: "proxy",
				SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
			},
			listenHost: "0.0.0.0",
		});
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			remoteAddress: "10.42.3.4",
			headers: {
				"remote-user": "michael",
				"remote-name": "Michael",
				"remote-email": "michael@example.invalid",
				// Body identity fields are IGNORED on proxy claims.
				"x-sigrun-user": "spoof",
			},
			payload: { user: "spoof", name: "Spoofed" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().user).toMatchObject({
			user: "michael",
			name: "Michael",
			admin: true,
			source: "proxy",
		});
		// No token requested → none minted, no cookie.
		expect(response.json().token).toBeUndefined();
	});

	test("a loopback claim with no code → 200", async () => {
		const { app } = await bootServer({ listenHost: "127.0.0.1" });
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: { user: "local", name: "Local User" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().user).toMatchObject({
			user: "local",
			admin: true,
			source: "cli",
		});
	});

	test("a configured proxy secret is required on the public claim path too", async () => {
		const { app } = await bootServer({
			env: {
				SIGRUN_AUTH: "proxy",
				SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
				SIGRUN_PROXY_SECRET: "s3cret",
			},
			file: { auth: { proxy: { secretHeader: "x-sigrun-proxy-secret" } } },
			listenHost: "0.0.0.0",
		});
		// A trusted peer WITHOUT the secret is not a proxy identity here —
		// the pipeline never runs on public paths, so the claim route owns
		// the same secret discipline (an in-CIDR attacker cannot self-mint
		// the first admin).
		const missing = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "michael" },
			payload: { user: "spoof" },
		});
		expect(missing.statusCode).toBe(403);
		expect(missing.json()).toEqual({ error: "invalid_code" });
		// With the secret, the header identity claims admin.
		const present = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			remoteAddress: "10.42.3.4",
			headers: {
				"remote-user": "michael",
				"x-sigrun-proxy-secret": "s3cret",
			},
			payload: { user: "spoof" },
		});
		expect(present.statusCode).toBe(200);
		expect(present.json().user).toMatchObject({ user: "michael", admin: true });
	});
});

// ---------------------------------------------------------------------------
// the root conversation's owner
// ---------------------------------------------------------------------------

describe("root conversation ownership", () => {
	test("the root conversation's owner equals the claimant", async () => {
		const { app, opened } = await bootServer({ listenHost: "127.0.0.1" });
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: { user: "root-owner" },
		});
		expect(response.statusCode).toBe(200);
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.owner).toBe("root-owner");
	});
});
