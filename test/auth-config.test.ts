/**
 * Task 1 (core hardening W1): the auth config surface.
 *
 * The pieces later tasks consume:
 * - `SigrunConfig.auth` (AuthConfig) + `SigrunConfig.metricsPublic`,
 *   parsed from `SIGRUN_AUTH` / `SIGRUN_AUTH_TRUSTED_PROXIES` /
 *   `SIGRUN_PROXY_SECRET` / `SIGRUN_METRICS_PUBLIC` over the file's
 *   `server.auth` / `server.metrics` sections;
 * - `effectiveMethods(auth, listenHost)` — the defaults ruling (spec
 *   §5.2): `[]` on a loopback bind, `["token"]` otherwise, an explicit
 *   value always wins;
 * - `isLoopbackHost` — the loopback test Task 3's pipeline shares.
 *
 * `proxy.secret` is env-only (a credential — the file form is REJECTED,
 * like auth.json's monopoly on key material), and
 * `resolvedServerSection` omits `auth`/`metrics` when defaulted (the
 * webui pattern: a mirrored default would read as explicit intent on
 * the next boot).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, test } from "vitest";
import {
	DEFAULT_AUTH,
	effectiveMethods,
	loadConfig,
	resolvedServerSection,
} from "../src/config.js";
import {
	SettingsStore,
	SettingsValidationError,
} from "../src/harness/settings.js";
import { isLoopbackHost } from "../src/server/auth/loopback.js";
import type { SettingsFile } from "../src/harness/settings.js";

const MODEL_ENV = { SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" };

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

/** A store over a fresh tmp dir (recorded for afterAll teardown). */
function freshStore(): { store: SettingsStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sigrun-auth-config-"));
	dirs.push(dir);
	return { store: new SettingsStore({ dir }), dir };
}

describe("effectiveMethods (the defaults ruling, spec §5.2)", () => {
	test("defaults: [] on loopback binds, [\"token\"] otherwise", () => {
		expect(effectiveMethods(DEFAULT_AUTH, "127.0.0.1")).toEqual([]);
		expect(effectiveMethods(DEFAULT_AUTH, "0.0.0.0")).toEqual(["token"]);
		expect(effectiveMethods(DEFAULT_AUTH, "::1")).toEqual([]);
		expect(effectiveMethods(DEFAULT_AUTH, "localhost")).toEqual([]);
		// Any non-loopback bind — container default and LAN addresses.
		expect(effectiveMethods(DEFAULT_AUTH, "::")).toEqual(["token"]);
		expect(effectiveMethods(DEFAULT_AUTH, "10.42.1.5")).toEqual(["token"]);
	});

	test("an explicit value always wins, including [] on a non-loopback bind", () => {
		const none = { ...DEFAULT_AUTH, methods: [] as const };
		expect(effectiveMethods(none, "0.0.0.0")).toEqual([]);
		const proxyFirst = { ...DEFAULT_AUTH, methods: ["proxy", "token"] as const };
		expect(effectiveMethods(proxyFirst, "127.0.0.1")).toEqual([
			"proxy",
			"token",
		]);
	});
});

describe("isLoopbackHost (the loopback test the pipeline shares)", () => {
	test("loopback forms", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		// The whole 127.0.0.0/8 block, not just .1.
		expect(isLoopbackHost("127.42.99.3")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		// Hostnames are case-insensitive.
		expect(isLoopbackHost("LOCALHOST")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		// The expanded spelling of ::1 (Node accepts it as a bind address).
		expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
		// Bracketed (URL-hostname form) and v4-mapped spellings.
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
	});

	test("non-loopback forms", () => {
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("10.1.2.3")).toBe(false);
		expect(isLoopbackHost("192.168.1.4")).toBe(false);
		expect(isLoopbackHost("::")).toBe(false);
		expect(isLoopbackHost("fd00:42::1")).toBe(false);
		// A hostname that merely CONTAINS "localhost".
		expect(isLoopbackHost("localhost.example.invalid")).toBe(false);
		expect(isLoopbackHost("sigrun.example.invalid")).toBe(false);
	});
});

describe("loadConfig: SIGRUN_AUTH / SIGRUN_AUTH_TRUSTED_PROXIES", () => {
	test("SIGRUN_AUTH csv parses in order; trusted proxies parse as CIDRs", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_AUTH: "proxy,token",
			SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16,fd00:42::/56",
		});
		expect(config.auth.methods).toEqual(["proxy", "token"]);
		expect(config.auth.proxy.trustedProxies).toEqual([
			"10.42.0.0/16",
			"fd00:42::/56",
		]);
	});

	test("SIGRUN_AUTH \"none\" = []; an unknown method fails loud naming the variable", () => {
		const none = loadConfig({
			...MODEL_ENV,
			SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
		});
		expect(none.auth.methods).toBeUndefined();
		const disabled = loadConfig({
			...MODEL_ENV,
			SIGRUN_AUTH: "none",
		});
		expect(disabled.auth.methods).toEqual([]);
		// "none" mixed with a method is not a list — fail loud.
		expect(() =>
			loadConfig({ ...MODEL_ENV, SIGRUN_AUTH: "none,token" }),
		).toThrow(/SIGRUN_AUTH/);
		expect(() =>
			loadConfig({ ...MODEL_ENV, SIGRUN_AUTH: "basic" }),
		).toThrow(/SIGRUN_AUTH/);
		// Empty = unset (the shell's unset-adjacent value).
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_AUTH: "" }).auth.methods,
		).toBeUndefined();
	});

	test("proxy without trustedProxies is a boot error, never \"trust everyone\"", () => {
		// From env.
		expect(() => loadConfig({ ...MODEL_ENV, SIGRUN_AUTH: "proxy" })).toThrow(
			/trustedProxies/,
		);
		// From the file.
		const file: SettingsFile = {
			server: { auth: { methods: ["proxy"] } },
		};
		expect(() => loadConfig({ ...MODEL_ENV }, file)).toThrow(
			/trustedProxies/,
		);
		// token-only needs no proxies; the derived default neither.
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_AUTH: "token" }).auth.methods,
		).toEqual(["token"]);
		expect(loadConfig({ ...MODEL_ENV }).auth.methods).toBeUndefined();
	});

	test("defaults: Authelia header names, autoProvision on, empty lists", () => {
		const config = loadConfig({ ...MODEL_ENV });
		expect(config.auth).toEqual({
			methods: undefined,
			proxy: {
				trustedProxies: [],
				userHeader: "Remote-User",
				groupsHeader: "Remote-Groups",
				nameHeader: "Remote-Name",
				emailHeader: "Remote-Email",
				autoProvision: true,
			},
			adminGroups: [],
		});
	});

	test("SIGRUN_PROXY_SECRET maps to proxy.secret (env-only credential)", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
			SIGRUN_PROXY_SECRET: "sk_proxy-secret_example",
		});
		expect(config.auth.proxy.secret).toBe("sk_proxy-secret_example");
		// The env service token (also env-only).
		const tokenized = loadConfig({
			...MODEL_ENV,
			SIGRUN_API_TOKEN: "sgr_test-token",
		});
		expect(tokenized.auth.serviceToken).toEqual({
			token: "sgr_test-token",
			user: "sigrun",
		});
		const named = loadConfig({
			...MODEL_ENV,
			SIGRUN_API_TOKEN: "sgr_test-token",
			SIGRUN_API_TOKEN_USER: "backup-job",
		});
		expect(named.auth.serviceToken?.user).toBe("backup-job");
		// Neither set: absent.
		expect(loadConfig({ ...MODEL_ENV }).auth.serviceToken).toBeUndefined();
	});

	test("the file's server.auth applies where env is absent; env wins per field", () => {
		const file: SettingsFile = {
			server: {
				auth: {
					methods: ["proxy", "token"],
					proxy: {
						trustedProxies: ["10.42.0.0/16"],
						secretHeader: "X-Sigrun-Proxy-Secret",
						userHeader: "X-User",
						autoProvision: false,
					},
					adminGroups: ["sigrun-admins"],
					allowedHosts: ["sigrun.example.invalid"],
					allowedOrigins: ["https://ui.example.invalid"],
				},
			},
		};
		const fromFile = loadConfig({ ...MODEL_ENV }, file);
		expect(fromFile.auth.methods).toEqual(["proxy", "token"]);
		expect(fromFile.auth.proxy).toEqual({
			trustedProxies: ["10.42.0.0/16"],
			secretHeader: "X-Sigrun-Proxy-Secret",
			userHeader: "X-User",
			groupsHeader: "Remote-Groups",
			nameHeader: "Remote-Name",
			emailHeader: "Remote-Email",
			autoProvision: false,
		});
		expect(fromFile.auth.adminGroups).toEqual(["sigrun-admins"]);
		expect(fromFile.auth.allowedHosts).toEqual(["sigrun.example.invalid"]);
		expect(fromFile.auth.allowedOrigins).toEqual([
			"https://ui.example.invalid",
		]);
		// Env wins per field: SIGRUN_AUTH overrides methods, the file's
		// other auth intent survives.
		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_AUTH: "token" },
			file,
		);
		expect(mixed.auth.methods).toEqual(["token"]);
		expect(mixed.auth.proxy.trustedProxies).toEqual(["10.42.0.0/16"]);
		expect(mixed.auth.adminGroups).toEqual(["sigrun-admins"]);
	});
});

describe("loadConfig: auth.sessionDays", () => {
	test("parses the file value and defaults to 30", () => {
		expect(loadConfig({ ...MODEL_ENV }).auth.sessionDays).toBe(30);
		const config = loadConfig(
			{ ...MODEL_ENV },
			{ server: { auth: { sessionDays: 7 } } },
		);
		expect(config.auth.sessionDays).toBe(7);
		expect(config.auth.sessionDays * 86_400_000).toBe(604_800_000);
	});

	test("sessionDays must be a positive integer", () => {
		for (const sessionDays of [0, -1, 1.5, "7"]) {
			const { store } = freshStore();
			expect(() => store.update({ server: { auth: { sessionDays } } })).toThrow(
				/server\.auth\.sessionDays/,
			);
		}
	});
});

describe("loadConfig: metricsPublic (SIGRUN_METRICS_PUBLIC, strict)", () => {
	test("default false; strict true/false; the file applies where env is absent", () => {
		expect(loadConfig({ ...MODEL_ENV }).metricsPublic).toBe(false);
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "true" })
				.metricsPublic,
		).toBe(true);
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "false" })
				.metricsPublic,
		).toBe(false);
		expect(() =>
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "yes" }),
		).toThrow(/SIGRUN_METRICS_PUBLIC/);
		expect(() =>
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "1" }),
		).toThrow(/SIGRUN_METRICS_PUBLIC/);
		// Empty counts as unset (the SIGRUN_WEBUI pattern).
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "" })
				.metricsPublic,
		).toBe(false);
		// File over default; env over file.
		const file: SettingsFile = { server: { metrics: { public: true } } };
		expect(loadConfig({ ...MODEL_ENV }, file).metricsPublic).toBe(true);
		expect(
			loadConfig(
				{ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "false" },
				file,
			).metricsPublic,
		).toBe(false);
	});
});

describe("settings store: server.auth validation and PATCH sub-merge", () => {
	test("a good auth section round-trips; bad shapes throw naming the field", () => {
		const { store } = freshStore();
		store.update({
			server: {
				auth: {
					methods: ["proxy", "token"],
					proxy: {
						trustedProxies: ["10.42.0.0/16", "fd00:42::/56"],
						secretHeader: "X-Sigrun-Proxy-Secret",
					},
					adminGroups: ["sigrun-admins"],
				},
				metrics: { public: true },
			},
		});
		expect(store.read().server?.auth).toEqual({
			methods: ["proxy", "token"],
			proxy: {
				trustedProxies: ["10.42.0.0/16", "fd00:42::/56"],
				secretHeader: "X-Sigrun-Proxy-Secret",
			},
			adminGroups: ["sigrun-admins"],
		});
		expect(store.read().server?.metrics).toEqual({ public: true });

		const bad: Array<[Record<string, unknown>, RegExp]> = [
			[{ server: { auth: "token" } }, /server\.auth/],
			[{ server: { auth: { method: "token" } } }, /server\.auth\.method/],
			[
				{ server: { auth: { methods: ["token", "basic"] } } },
				/server\.auth\.methods/,
			],
			[
				{ server: { auth: { methods: "token" } } },
				/server\.auth\.methods/,
			],
			[
				{ server: { auth: { proxy: { secret: "s" } } } },
				/server\.auth\.proxy\.secret/,
			],
			[
				{ server: { auth: { proxy: { autoProvision: "no" } } } },
				/server\.auth\.proxy\.autoProvision/,
			],
			[
				{ server: { auth: { proxy: { userHeader: "" } } } },
				/server\.auth\.proxy\.userHeader/,
			],
			[
				{ server: { auth: { proxy: { trustedProxies: [""] } } } },
				/server\.auth\.proxy\.trustedProxies/,
			],
			[
				{ server: { auth: { adminGroups: [42] } } },
				/server\.auth\.adminGroups/,
			],
			[
				{ server: { auth: { allowedHosts: "sigrun.example.invalid" } } },
				/server\.auth\.allowedHosts/,
			],
			[{ server: { metrics: { public: "true" } } }, /server\.metrics\.public/],
			[{ server: { metrics: { publicity: true } } }, /server\.metrics\.publicity/],
		];
		for (const [patch, pattern] of bad) {
			expect(() => store.update(patch)).toThrow(pattern);
		}
	});

	test("proxy.secret in a hand-written file fails validation naming the field", () => {
		const { store, dir } = freshStore();
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				server: { auth: { proxy: { secret: "sk_proxy-secret_example" } } },
			}),
			"utf8",
		);
		expect(() => store.read()).toThrow(SettingsValidationError);
		expect(() => store.read()).toThrow(/server\.auth\.proxy\.secret/);
	});

	test("PATCH sub-merges: auth.proxy is a third-level merge", () => {
		const { store } = freshStore();
		store.update({
			server: {
				auth: { proxy: { trustedProxies: ["10.42.0.0/16"] } },
			},
		});
		// The brief's case: a proxy-field PATCH keeps stored proxies.
		store.update({
			server: { auth: { proxy: { autoProvision: false } } },
		});
		expect(store.read().server?.auth).toEqual({
			proxy: {
				trustedProxies: ["10.42.0.0/16"],
				autoProvision: false,
			},
		});
		// A sibling auth key PATCH keeps the whole proxy section.
		store.update({ server: { auth: { adminGroups: ["sigrun-admins"] } } });
		expect(store.read().server?.auth).toEqual({
			proxy: {
				trustedProxies: ["10.42.0.0/16"],
				autoProvision: false,
			},
			adminGroups: ["sigrun-admins"],
		});
		// Null clears one sub-field at a time; the rest survive.
		store.update({ server: { auth: { proxy: { autoProvision: null } } } });
		expect(store.read().server?.auth).toEqual({
			proxy: { trustedProxies: ["10.42.0.0/16"] },
			adminGroups: ["sigrun-admins"],
		});
		// metrics sub-merges the same way (one key today, flat merge).
		store.update({ server: { metrics: { public: true } } });
		expect(store.read().server?.metrics).toEqual({ public: true });
	});
});

describe("resolvedServerSection (the bootstrap projection)", () => {
	test("a defaulted auth/metrics is omitted entirely (the webui pattern)", () => {
		const section = resolvedServerSection(loadConfig({ ...MODEL_ENV }));
		expect("auth" in section).toBe(false);
		expect("metrics" in section).toBe(false);
	});

	test("configured auth is recorded as intent; secret never lands in the file", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_AUTH: "proxy,token",
			SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16,fd00:42::/56",
			SIGRUN_PROXY_SECRET: "sk_proxy-secret_example",
			SIGRUN_METRICS_PUBLIC: "true",
		});
		const section = resolvedServerSection(config);
		expect(section.auth).toEqual({
			methods: ["proxy", "token"],
			proxy: {
				trustedProxies: ["10.42.0.0/16", "fd00:42::/56"],
			},
		});
		expect(section.metrics).toEqual({ public: true });
		// The env-only credential is never projected (no secret key).
		expect(JSON.stringify(section)).not.toContain("sk_proxy-secret_example");
	});

	test("a recorded auth section re-resolves identically (round-trip)", () => {
		const env = {
			...MODEL_ENV,
			SIGRUN_AUTH: "proxy",
			SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
		};
		const first = loadConfig(env);
		const second = loadConfig(
			{ ...MODEL_ENV },
			{ server: resolvedServerSection(first) },
		);
		expect(second.auth).toEqual(first.auth);
		expect(second.auth.methods).toEqual(["proxy"]);
		expect(second.auth.proxy.trustedProxies).toEqual(["10.42.0.0/16"]);
	});
});
