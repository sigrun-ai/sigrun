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
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { readSetupCode } from "../src/harness/identity/index.js";
import { ensureSetupCode } from "../src/harness/identity/setup-code.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import {
	ProxyRejectReason,
	resetProxyDiagnostic,
} from "../src/server/auth/proxy-diagnostic.js";
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
	isolationAvailable?: boolean;
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
		SIGRUN_ISOLATION: "off",
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
		isolationProbe: async () => options.isolationAvailable === true
			? { available: true, abi: 6 }
			: { available: false, abi: 0, reason: "not linux" },
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

	test("a proxy-only non-loopback boot generates and logs NO setup code (C2)", async () => {
		// A proxy-only public deployment admits accounts ONLY through a
		// proxy vouch — a minted setup code would be an unvouched
		// account-creation path, so boot never creates (or logs) one.
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const { opened } = await bootServer({
				env: {
					SIGRUN_AUTH: "proxy",
					SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
				},
				listenHost: "0.0.0.0",
			});
			expect(readSetupCode(opened.identity.cacheDir)).toBeUndefined();
			expect(
				log.mock.calls.some((call) =>
					call.join(" ").includes("sigrun setup code:"),
				),
			).toBe(false);
		} finally {
			log.mockRestore();
		}
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
// the proxy-rejection diagnostic on the public onboarding path (C1)
// ---------------------------------------------------------------------------

describe("onboarding proxy-rejection diagnostics", () => {
	const PROXY_ONLY_ENV = {
		SIGRUN_AUTH: "proxy",
		SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
	};

	beforeEach(() => {
		resetProxyDiagnostic();
	});

	/** Boot a proxy-only, unclaimed server and spy the diagnostic. */
	async function bootProxyOnly() {
		const server = await bootServer({
			env: PROXY_ONLY_ENV,
			listenHost: "0.0.0.0",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		return { ...server, warn };
	}

	test("an untrusted peer warns 'untrusted proxy'", async () => {
		const { app, warn } = await bootProxyOnly();
		try {
			const response = await app.inject({
				method: "GET",
				url: "/v1/onboarding",
				remoteAddress: "10.9.9.9",
			});
			expect(response.statusCode).toBe(200);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain(
				ProxyRejectReason.UNTRUSTED,
			);
		} finally {
			warn.mockRestore();
		}
	});

	test("a trusted peer with no remote-user warns 'missing identity header'", async () => {
		const { app, warn } = await bootProxyOnly();
		try {
			await app.inject({
				method: "GET",
				url: "/v1/onboarding",
				remoteAddress: "10.42.3.4",
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain(
				ProxyRejectReason.missingHeaderReason("remote-user"),
			);
		} finally {
			warn.mockRestore();
		}
	});

	test("an EMPTY remote-user is the missing-header reason, not unusable", async () => {
		const { app, warn } = await bootProxyOnly();
		try {
			await app.inject({
				method: "GET",
				url: "/v1/onboarding",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "" },
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain(
				ProxyRejectReason.missingHeaderReason("remote-user"),
			);
		} finally {
			warn.mockRestore();
		}
	});

	test("an unrepresentable remote-user warns 'unusable identity claim'", async () => {
		const { app, warn } = await bootProxyOnly();
		try {
			await app.inject({
				method: "GET",
				url: "/v1/onboarding",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "Bad User" },
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain(
				ProxyRejectReason.UNUSABLE,
			);
		} finally {
			warn.mockRestore();
		}
	});

	test("a CLAIMED instance emits zero onboarding warns", async () => {
		const { app, opened, warn } = await bootProxyOnly();
		try {
			const code = readSetupCode(opened.identity.cacheDir);
			const claim = await app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "michael" },
				payload: { code },
			});
			expect(claim.statusCode).toBe(200);
			expect(opened.identity.users.isClaimed()).toBe(true);
			warn.mockClear();
			for (const [remoteAddress, headers] of [
				["10.9.9.9", {}],
				["10.42.3.4", {}],
				["10.42.3.4", { "remote-user": "Bad User" }],
			] as const) {
				await app.inject({
					method: "GET",
					url: "/v1/onboarding",
					remoteAddress,
					headers,
				});
			}
			expect(warn).toHaveBeenCalledTimes(0);
		} finally {
			warn.mockRestore();
		}
	});

	test("a token-only boot emits zero proxy warns", async () => {
		const { app } = await bootServer({ listenHost: "0.0.0.0" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await app.inject({
				method: "GET",
				url: "/v1/onboarding",
				remoteAddress: "10.9.9.9",
			});
			expect(warn).toHaveBeenCalledTimes(0);
		} finally {
			warn.mockRestore();
		}
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
		// The claim path now emits the shared proxy-rejection diagnostic
		// (C1); spy it so this pre-existing test stays quiet.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
		// C2: the proxy-only public claim path refuses EVERY unvouched
		// claim with the dedicated code — not the setup-code error.
		expect(missing.json()).toEqual({ error: "proxy_identity_required" });
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
		warn.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// C2: proxy-only non-loopback servers refuse account creation without a vouch
// ---------------------------------------------------------------------------

describe("proxy-only vouch rule (C2)", () => {
	const PROXY_ONLY_ENV = {
		SIGRUN_AUTH: "proxy",
		SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
	};

	beforeEach(() => {
		resetProxyDiagnostic();
	});

	/** Boot proxy-only + non-loopback with the warn spy installed. */
	async function bootPublicProxyOnly() {
		const server = await bootServer({
			env: PROXY_ONLY_ENV,
			listenHost: "0.0.0.0",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		return { ...server, warn };
	}

	test("unclaimed claim without vouch and no code → 403 proxy_identity_required", async () => {
		const { app, warn } = await bootPublicProxyOnly();
		try {
			const response = await app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				remoteAddress: "10.42.3.4",
				payload: { user: "eve" },
			});
			expect(response.statusCode).toBe(403);
			expect(response.json()).toEqual({ error: "proxy_identity_required" });
		} finally {
			warn.mockRestore();
		}
	});

	test("unclaimed claim without vouch but WITH a valid setup code → 403 proxy_identity_required", async () => {
		const { app, opened, warn } = await bootPublicProxyOnly();
		try {
			// Materialize a valid setup code directly (a proxy-only public
			// boot no longer writes one — that is the OTHER C2 assertion);
			// the point here is that even a VALID code cannot create an
			// account without a vouch on this posture.
			const code = await ensureSetupCode(opened.identity.cacheDir, {});
			const response = await app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				remoteAddress: "10.42.3.4",
				payload: { code, user: "eve" },
			});
			expect(response.statusCode).toBe(403);
			expect(response.json()).toEqual({ error: "proxy_identity_required" });
		} finally {
			warn.mockRestore();
		}
	});

	test("vouched claim (remote-user michael, peer 10.42.3.4) → 200 admin", async () => {
		const { app, warn } = await bootPublicProxyOnly();
		try {
			const response = await app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "michael" },
			});
			expect(response.statusCode).toBe(200);
			expect(response.json().user).toMatchObject({
				user: "michael",
				admin: true,
				source: "proxy",
			});
		} finally {
			warn.mockRestore();
		}
	});

	test("vouched claim from an IPv4-mapped peer (::ffff:10.42.3.4) → 200 (Review Focus 1)", async () => {
		const { app, warn } = await bootPublicProxyOnly();
		try {
			const response = await app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				remoteAddress: "::ffff:10.42.3.4",
				headers: { "remote-user": "michael" },
			});
			expect(response.statusCode).toBe(200);
			expect(response.json().user).toMatchObject({
				user: "michael",
				admin: true,
				source: "proxy",
			});
		} finally {
			warn.mockRestore();
		}
	});

	test("claimed instance, invite code + user, no vouch → 403 proxy_identity_required", async () => {
		const { app, opened, warn } = await bootPublicProxyOnly();
		try {
			const claimed = await app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				remoteAddress: "10.42.3.4",
				headers: { "remote-user": "michael" },
			});
			expect(claimed.statusCode).toBe(200);
			const { code } = await opened.identity.invites.create({ admin: false });
			const response = await app.inject({
				method: "POST",
				url: "/v1/onboarding/claim",
				remoteAddress: "10.42.3.4",
				payload: { code, user: "bob" },
			});
			expect(response.statusCode).toBe(403);
			expect(response.json()).toEqual({ error: "proxy_identity_required" });
			expect(opened.identity.users.get("bob")).toBeUndefined();
		} finally {
			warn.mockRestore();
		}
	});

	test("loopback bind proxy-only: codeRequired false; claim with user → 200 (Review Focus 5)", async () => {
		const { app } = await bootServer({
			env: PROXY_ONLY_ENV,
			listenHost: "127.0.0.1",
		});
		const state = await app.inject({ method: "GET", url: "/v1/onboarding" });
		expect(state.statusCode).toBe(200);
		expect(state.json().codeRequired).toBe(false);
		const claim = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			payload: { user: "local" },
		});
		expect(claim.statusCode).toBe(200);
		expect(claim.json().user).toMatchObject({
			user: "local",
			admin: true,
			source: "cli",
		});
	});

	test("mixed [proxy, token], unclaimed, setup code, no vouch → 200 (Review Focus 3)", async () => {
		const { app, opened } = await bootServer({
			env: { ...PROXY_ONLY_ENV, SIGRUN_AUTH: "proxy,token" },
			listenHost: "0.0.0.0",
		});
		const code = readSetupCode(opened.identity.cacheDir);
		expect(code).toBeDefined();
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			remoteAddress: "10.42.3.4",
			payload: { code, user: "founder" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().user).toMatchObject({
			user: "founder",
			admin: true,
			source: "cli",
		});
	});
});

describe("multi-user admission", () => {
	test("second user via invite -> 409 isolation_required when unavailable", async () => {
		const { app, opened } = await bootServer({ listenHost: "0.0.0.0", env: { SIGRUN_ISOLATION: "auto" } });
		const setup = readSetupCode(opened.identity.cacheDir);
		expect((await app.inject({ method: "POST", url: "/v1/onboarding/claim", payload: { code: setup, user: "alice" } })).statusCode).toBe(200);
		const { code } = await opened.identity.invites.create({ admin: false });
		const response = await app.inject({ method: "POST", url: "/v1/onboarding/claim", payload: { code, user: "bob" } });
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "isolation_required" });
		expect(opened.identity.users.get("bob")).toBeUndefined();
	});

	test("second user with SIGRUN_AUTH=none -> 409 auth_required", async () => {
		const { app, opened } = await bootServer({
			listenHost: "127.0.0.1",
			env: { SIGRUN_AUTH: "none", SIGRUN_ISOLATION: "auto" },
			isolationAvailable: true,
		});
		expect((await app.inject({ method: "POST", url: "/v1/onboarding/claim", payload: { user: "alice" } })).statusCode).toBe(200);
		const { code } = await opened.identity.invites.create({ admin: false });
		const response = await app.inject({ method: "POST", url: "/v1/onboarding/claim", payload: { code, user: "bob" } });
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "auth_required" });
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
