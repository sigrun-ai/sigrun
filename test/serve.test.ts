/**
 * Release-readiness Task 1 (serving spec §1/§2): ONE listener decision —
 * `serve()` resolves the effective host ONCE (`options.host` →
 * `SIGRUN_LISTEN_HOST` → `DEFAULT_LISTEN_HOST`) and hands that exact
 * string to `openHarness`, `createServer`, AND `app.listen`, so the bind
 * and both auth derivations can never disagree (deficiency-ledger §41).
 * After listen, the bound socket's facts are measured ONCE and retained
 * on `ServerContext.listener`; `GET /v1/meta` projects them (§46).
 *
 * The subsystem seam is observed by wrapping the REAL `openHarness` /
 * `createServer` module exports (vi.mock + importActual) and recording
 * the `listenHost` each received — the full deployed composition still
 * boots; only the arguments are witnessed. The bind itself is proven
 * over the real socket: `/v1/meta` is fetched by HTTP on the bound port.
 *
 * `measureListener`'s family derivation is unit-tested here with an
 * injected connector, so the dual-stack/single-family/inconclusive cases
 * do not depend on the developer machine's interfaces (spec §2).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	DEFAULT_LISTEN_HOST,
	LISTENER_PROBE_TIMEOUT_MS,
	measureListener,
	serve,
} from "../src/serve.js";
import type { ListenerInfo } from "@sigrun/shared/views";

// ---------------------------------------------------------------------------
// The subsystem seam: witness the listenHost each subsystem receives.
// ---------------------------------------------------------------------------

const witnessed: { harness?: string; server?: string; listen?: string } = {};

vi.mock("../src/harness/boot.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../src/harness/boot.js")>();
	return {
		...actual,
		openHarness: (
			config: unknown,
			options?: { listenHost?: string },
		): Promise<unknown> => {
			witnessed.harness = options?.listenHost;
			return actual.openHarness(
				config as Parameters<typeof actual.openHarness>[0],
				options as Parameters<typeof actual.openHarness>[1],
			);
		},
	};
});

vi.mock("../src/server/index.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../src/server/index.js")>();
	return {
		...actual,
		createServer: async (
			opened: unknown,
			config: unknown,
			bundles?: unknown,
			options?: { listenHost?: string },
		): Promise<unknown> => {
			witnessed.server = options?.listenHost;
			const app = (await actual.createServer(
				opened as Parameters<typeof actual.createServer>[0],
				config as Parameters<typeof actual.createServer>[1],
				bundles as Parameters<typeof actual.createServer>[2],
				options as Parameters<typeof actual.createServer>[3],
			)) as { listen: (arg: { host: string }) => Promise<unknown> };
			// Witness the BIND: the regression this task exists to prevent
			// (listen receiving a different host than the resolved one) is
			// invisible to the two subsystems above.
			const realListen = app.listen.bind(app);
			app.listen = (arg: { host: string }): Promise<unknown> => {
				witnessed.listen = arg.host;
				return realListen(arg);
			};
			return app;
		},
	};
});

// ---------------------------------------------------------------------------
// Boot helpers (provider-scheduler.test.ts's serve pattern).
// ---------------------------------------------------------------------------

/** Reserve an OS-ephemeral port (listen 0, read the port, close). */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("no ephemeral port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of running.splice(0)) await stop();
});

interface Served {
	readonly port: number;
	readonly meta: Record<string, unknown>;
	readonly listener: ListenerInfo;
	readonly methods: readonly string[];
}

/**
 * Boot the deployed composition in a tmpdir and fetch `/v1/meta` over the
 * REAL socket (the env service token passes the unclaimed gate). The
 * returned `listener`/`methods` are the wire projection of the retained
 * boot facts.
 */
async function bootServed(options?: {
	readonly host?: string;
	readonly env?: Record<string, string>;
	/** Pre-existing settings file content (bootstrap never overwrites it). */
	readonly settingsJson?: string;
}): Promise<Served> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-serve-listener-"));
	const port = await freePort();
	witnessed.harness = undefined;
	witnessed.server = undefined;
	witnessed.listen = undefined;
	const configDir = join(dir, "config");
	if (options?.settingsJson !== undefined) {
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "settings.json"), options.settingsJson, { mode: 0o600 });
	}
	// defaultSettingsDir() resolves SIGRUN_CONFIG_DIR from process.env
	// (the settings layer predates the serve env threading) — set it
	// process-wide for the boot, restored below.
	const previousConfigDir = process.env.SIGRUN_CONFIG_DIR;
	process.env.SIGRUN_CONFIG_DIR = configDir;
	let booted: Awaited<ReturnType<typeof serve>> | undefined;
	try {
		booted = await serve(
			{
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				OPENAI_API_KEY: "smoke-test-key-never-sent",
				SIGRUN_API_TOKEN: "sgr_test_env",
				SIGRUN_PORT: String(port),
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: join(dir, "workspace"),
				SIGRUN_DATA_DIR: join(dir, "data"),
				SIGRUN_CACHE_DIR: join(dir, "cache"),
				SIGRUN_STATE_DIR: join(dir, "state"),
				...options?.env,
			},
			options?.host === undefined ? undefined : { host: options.host },
		);
	} finally {
		if (previousConfigDir === undefined) delete process.env.SIGRUN_CONFIG_DIR;
		else process.env.SIGRUN_CONFIG_DIR = previousConfigDir;
	}
	running.push(async () => {
		await booted!.shutdownOnce();
		await rm(dir, { recursive: true, force: true });
	});
	// Fetch from an address the bind actually answers: the dual-stack
	// wildcard via v4 loopback, an IPv6 literal bracketed, a hostname via
	// the name itself (the same resolver Node's listen used).
	const host = options?.host ?? DEFAULT_LISTEN_HOST;
	const fetchHost =
		host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
	const response = await fetch(`http://${fetchHost}:${port}/v1/meta`, {
		headers: { authorization: "Bearer sgr_test_env" },
	});
	expect(response.status).toBe(200);
	const meta = (await response.json()) as Record<string, unknown>;
	return {
		port,
		meta,
		listener: meta.listener as ListenerInfo,
		methods: (meta.auth as { methods: string[] }).methods,
	};
}

/** Whether a loopback TCP connection to `host:port` succeeds (one probe). */
function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

// ---------------------------------------------------------------------------
// §1: one listener decision
// ---------------------------------------------------------------------------

describe("listener resolution (spec §1)", () => {
	test(
		"default: both subsystems and the bind receive DEFAULT_LISTEN_HOST (::)",
		async () => {
			const served = await bootServed();
			expect(witnessed.harness).toBe(DEFAULT_LISTEN_HOST);
			expect(witnessed.server).toBe(DEFAULT_LISTEN_HOST);
			expect(witnessed.listen).toBe(DEFAULT_LISTEN_HOST);
			// The bind: the fetch above reached the server over IPv4 loopback,
			// and the wire projection reports the configured wildcard — never
			// a concrete peer address.
			expect(served.listener.host).toBe(DEFAULT_LISTEN_HOST);
			expect(served.listener.port).toBe(served.port);
			// A non-loopback bind derives token auth (spec §5.2 defaults).
			expect(served.methods).toEqual(["token"]);
		},
		60_000,
	);

	test(
		"explicit options.host wins and reaches all three consumers",
		async () => {
			const served = await bootServed({ host: "127.0.0.1" });
			expect(witnessed.harness).toBe("127.0.0.1");
			expect(witnessed.server).toBe("127.0.0.1");
			expect(witnessed.listen).toBe("127.0.0.1");
			expect(served.listener).toEqual({
				host: "127.0.0.1",
				port: served.port,
				families: ["ipv4"],
			});
			// A loopback bind derives the naive method list — the SAME host
			// drove createServer's auth derivation and the actual bind.
			expect(served.methods).toEqual([]);
		},
		60_000,
	);

	test(
		"SIGRUN_LISTEN_HOST is the environment equivalent of the host option",
		async () => {
			const served = await bootServed({
				env: { SIGRUN_LISTEN_HOST: "127.0.0.1" },
			});
			expect(witnessed.harness).toBe("127.0.0.1");
			expect(witnessed.server).toBe("127.0.0.1");
			expect(witnessed.listen).toBe("127.0.0.1");
			expect(served.listener).toEqual({
				host: "127.0.0.1",
				port: served.port,
				families: ["ipv4"],
			});
			expect(served.methods).toEqual([]);
		},
		60_000,
	);

	test(
		"options.host beats SIGRUN_LISTEN_HOST",
		async () => {
			const served = await bootServed({
				host: "127.0.0.1",
				env: { SIGRUN_LISTEN_HOST: "0.0.0.0" },
			});
			expect(witnessed.harness).toBe("127.0.0.1");
			expect(witnessed.server).toBe("127.0.0.1");
			expect(witnessed.listen).toBe("127.0.0.1");
			expect(served.listener.host).toBe("127.0.0.1");
			expect(served.methods).toEqual([]);
		},
		60_000,
	);

	test(
		"an IPv6 loopback bind reports the ipv6 family",
		async () => {
			const served = await bootServed({ host: "::1" });
			expect(witnessed.listen).toBe("::1");
			expect(served.listener.host).toBe("::1");
			expect(served.listener.families).toEqual(["ipv6"]);
			expect(served.methods).toEqual([]);
		},
		60_000,
	);

	test(
		"a hostname bind reports the hostname (never a concrete peer address)",
		async () => {
			const served = await bootServed({ host: "localhost" });
			expect(witnessed.harness).toBe("localhost");
			expect(witnessed.listen).toBe("localhost");
			expect(served.listener.host).toBe("localhost");
			// Node binds ONE resolved address for a hostname listen; the
			// reported family is that socket's, whichever loopback the local
			// resolver picked.
			expect(served.listener.families.length).toBe(1);
			expect(["ipv4", "ipv6"]).toContain(served.listener.families[0]);
			expect(served.methods).toEqual([]);
		},
		60_000,
	);

	test(
		"the :: wildcard reports exactly the loopback families that connect",
		async () => {
			const served = await bootServed();
			// The server MEASURED reachability; the test re-measures the same
			// loopbacks and requires agreement (no developer-interface
			// assumption: whichever families genuinely connect are reported).
			const v4 = await canConnect("127.0.0.1", served.port);
			const v6 = await canConnect("::1", served.port);
			const expected: string[] = [];
			if (v4) expected.push("ipv4");
			if (v6) expected.push("ipv6");
			expect(served.listener.families).toEqual(expected);
			// Sanity on every supported platform: v4 loopback connects.
			expect(served.listener.families).toContain("ipv4");
		},
		60_000,
	);
});

// ---------------------------------------------------------------------------
// §2: measureListener's family derivation (injected connector — no real
// sockets, no developer-interface dependence).
// ---------------------------------------------------------------------------

describe("measureListener", () => {
	const bound = (family: string | number) => ({
		address: family === "IPv4" || family === 4 ? "127.0.0.1" : "::1",
		family,
		port: 4321,
	});

	test("a literal IPv4 host is ipv4 without probing", async () => {
		const connect = vi.fn();
		const info = await measureListener("0.0.0.0", bound("IPv4"), connect);
		expect(info).toEqual({ host: "0.0.0.0", port: 4321, families: ["ipv4"] });
		expect(connect).not.toHaveBeenCalled();
	});

	test("a literal IPv6 host is ipv6 without probing", async () => {
		const connect = vi.fn();
		const info = await measureListener("::1", bound("IPv6"), connect);
		expect(info).toEqual({ host: "::1", port: 4321, families: ["ipv6"] });
		expect(connect).not.toHaveBeenCalled();
	});

	test("a hostname bind reports the bound socket's family", async () => {
		await expect(
			measureListener("nas.example.invalid", bound("IPv4")),
		).resolves.toMatchObject({ families: ["ipv4"] });
		await expect(
			measureListener("nas.example.invalid", bound("IPv6")),
		).resolves.toMatchObject({ families: ["ipv6"] });
		// Numeric families (newer Node spellings) map too.
		await expect(
			measureListener("nas.example.invalid", bound(6)),
		).resolves.toMatchObject({ families: ["ipv6"] });
	});

	test("the :: wildcard retains only the families that connect", async () => {
		const both = async () => true;
		await expect(
			measureListener("::", bound("IPv6"), both),
		).resolves.toEqual({ host: "::", port: 4321, families: ["ipv4", "ipv6"] });
		// IPv6-only host: the v4 probe fails — a legitimate result, not an
		// error (spec §2).
		const onlyV6 = async (host: string) => host === "::1";
		await expect(
			measureListener("::", bound("IPv6"), onlyV6),
		).resolves.toMatchObject({ families: ["ipv6"] });
		const onlyV4 = async (host: string) => host === "127.0.0.1";
		await expect(
			measureListener("::", bound("IPv6"), onlyV4),
		).resolves.toMatchObject({ families: ["ipv4"] });
	});

	test("an inconclusive :: probe (neither family connects) fails loudly", async () => {
		const none = async () => false;
		await expect(
			measureListener("::", bound("IPv6"), none),
		).rejects.toThrow(/reachability|inconclusive/i);
	});
});

describe("extension resolution through serve()", () => {
	test("an env-declared extension installs and loads over an existing settings file", async () => {
		// Regression: serve() used to sync only the settings file's
		// `extensions` list, silently discarding SIGRUN_EXTENSIONS — an
		// env-declared provider never loaded. The merged config.extensions
		// (env over file) must reach syncPackages. The file PRE-EXISTS so
		// the settings bootstrap cannot paper over the env by mirroring it.
		const fixture = join(
			import.meta.dirname,
			"fixtures",
			"fixture-ext",
			"index.js",
		);
		const served = await bootServed({
			env: { SIGRUN_EXTENSIONS: fixture },
			settingsJson: '{"namingModel":false}\n',
		});
		const extensions = served.meta.extensions as { name: string; status: string }[];
		expect(extensions).toContainEqual({ name: "sigrun-fixture-ext", status: "ok" });
	});
});

test("the production loopback probe is bounded by LISTENER_PROBE_TIMEOUT_MS", () => {
	// §2 forbids a hung boot: the probe must destroy the socket and resolve
	// false on timeout. The constant is exported so the bound is part of the
	// contract, not a hidden literal; probeLoopback itself is exercised by
	// every :: resolution test above (real loopback connects).
	expect(LISTENER_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
	expect(LISTENER_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
});
