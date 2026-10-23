/**
 * Gateway C2: the `gateway` engine field, lifecycle, and health.
 *
 * The loader validates a factory-result `gateway` object (four functions)
 * and enforces the ONE-engine rule (first loaded wins; a later declarer
 * quarantines naming the first slug — the channel-collision pattern).
 * `startGateway(opened)` builds the `GatewayEngineContext` from the boot's
 * channel bindings, wraps `engine.health()` (throw → "degraded", logged
 * once), and latches degraded when `start` rejects (`started` still
 * resolves — a failed engine never wedges boot or shutdown). The meta
 * route surfaces `health.gateway` only when an engine loaded; the
 * extensions inventory marks channel-contributing rows `inert: "no
 * gateway"` when none did.
 *
 * Boot patterns: `host-conversations.test.ts` (faux provider + token
 * auth + seeded identity + fixture via file URL) for the server cases;
 * `loader-channels.test.ts` for the loader-only quarantine cases.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { startGateway, type GatewayHandle } from "../src/server/gateway.js";
import { seededIdentity } from "./helpers/identity.js";

/** The engine fixture (records start/stopIntake/stop + ctx; flippable health). */
const ENGINE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-gateway-engine", "index.js"),
).href;

/** The twin fixture (declares another `gateway`; the one-engine rule). */
const TWIN_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-gateway-engine-twin", "index.js"),
).href;

/** The adapter fixture (Task 2's contributor-only channel, id "loop"). */
const ADAPTER_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel-adapter", "index.js"),
).href;

/**
 * The per-boot call-log registry (globalThis-stash, the fixture-channel
 * pattern): one entry per factory call — the fixture pushes a fresh array
 * per boot, so every boot reads its OWN log, never a shared one.
 */
type FixtureLog = {
	readonly type: "start" | "stopIntake" | "stop" | "runSettled";
	readonly channels?: { extension: string; id: string }[];
	readonly signal?: AbortSignal;
}[];

function gatewayLogs(): FixtureLog[] {
	return (globalThis as { __fixtureGatewayLogs?: FixtureLog[] })
		.__fixtureGatewayLogs ?? [];
}

/**
 * The log entry for ONE boot: `before` is the registry length captured
 * BEFORE `openHarness` ran, so this returns exactly the entry that boot's
 * factory call pushed (an empty log when the boot loaded no engine — the
 * adapter-only case never imports the fixture).
 */
function bootLog(before: number): FixtureLog {
	return gatewayLogs()[before] ?? [];
}

/** One booted test server (the host-conversations shape). */
interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly gateway: GatewayHandle;
	readonly config: SigrunConfig;
	readonly faux: FauxProviderHandle;
	readonly aliceToken: string;
	readonly dir: string;
	/** THIS boot's fixture-engine log (empty when no engine loaded). */
	readonly log: FixtureLog;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot the harness + server with the given fixture specifiers and a
 * started gateway handle (the serve composition's shape: the handle is
 * created BEFORE `createServer` — threaded through the `gateway` option
 * so the meta route reaches it — and started after the server exists).
 * `beforeGateway` runs after `openHarness` and before the handle is
 * created — the Review-Focus-1 seam (a doctored engine's rejection/throw
 * is observed by the handle the SERVER serves, not a side handle).
 */
async function bootServer(
	specifiers: readonly string[],
	beforeGateway?: (opened: OpenedHarness) => void,
): Promise<TestServer> {
	// Snapshot the registry BEFORE the boot: the fixture's factory call
	// (inside openHarness) pushes this boot's log at this index.
	const logsBefore = gatewayLogs().length;
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gateway-engine-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("gateway answer")]);
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir);
	await identity.users.add({ user: "alice", admin: true, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		builtins: false,
		extensionSpecifiers: specifiers,
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	// serve.ts's shape: the handle exists before the server, so the meta
	// route's ServerContext can carry it from construction.
	beforeGateway?.(opened);
	const gateway = startGateway(opened);
	const app = await createServer(opened, config, [], {
		gateway,
		env: { SIGRUN_CONFIG_DIR: configDir },
	});
	cleanups.push(async () => {
		await app.close();
		await gateway.stop();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return {
		app,
		opened,
		gateway,
		config,
		faux,
		aliceToken,
		dir,
		// THE boot's own log (the fixture pushed it during openHarness).
		log: bootLog(logsBefore),
	};
}

/** One authenticated GET; asserts 200 and returns the parsed body. */
async function getJson(
	app: FastifyInstance,
	url: string,
	token: string,
): Promise<Record<string, unknown>> {
	const response = await app.inject({
		method: "GET",
		url,
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	return response.json() as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Loader: the engine field + the one-engine rule
// ---------------------------------------------------------------------------

describe("the loader's gateway pathway", () => {
	test("one engine loads; startGateway starts it once with the slug-attributed channels", { timeout: 30_000 }, async () => {
		const server = await bootServer([ENGINE_SPECIFIER, ADAPTER_SPECIFIER]);
		await server.gateway.started;
		const log = server.log;
		expect(log.filter((entry) => entry.type === "start")).toHaveLength(1);
		const start = log.find((entry) => entry.type === "start");
		expect(start?.channels).toEqual([
			{ extension: "fixture-channel-adapter", id: "loop" },
		]);
		expect(start?.signal).toBeInstanceOf(AbortSignal);
	});

	test("a second engine quarantines naming the first slug (one-engine rule)", { timeout: 30_000 }, async () => {
		const server = await bootServer([ENGINE_SPECIFIER, TWIN_SPECIFIER]);
		const outcomes = server.opened.extensionOutcomes;
		expect(outcomes[0]).toMatchObject({
			name: "fixture-gateway-engine",
			status: "ok",
		});
		expect(outcomes[1]?.status).toBe("quarantined");
		expect(outcomes[1]?.error).toBe(
			'gateway engine already declared by "fixture-gateway-engine"',
		);
		// The FIRST engine still binds (first-loaded-wins).
		const engine = server.opened.gatewayEngine?.engine;
		expect(engine).toBeDefined();
	});

	test("a gateway result also carrying the health field quarantines", async () => {
		// The loader-channels pattern: the rule is resolveExtension's contract,
		// exercised on an in-memory factory result.
		const { resolveExtension } = await import("../src/harness/loader.js");
		await expect(
			resolveExtension({
				default: () => ({
					extension: { name: "engine-with-health" },
					gateway: {
						start: async () => {},
						stopIntake: async () => {},
						stop: async () => {},
						health: () => "ok",
					},
					health: () => "ok",
				}),
			}),
		).rejects.toThrow(
			"a gateway engine reports health through gateway.health(), not the health field",
		);
	});

	test("a gateway object missing a member function quarantines", async () => {
		const { resolveExtension } = await import("../src/harness/loader.js");
		await expect(
			resolveExtension({
				default: () => ({
					extension: { name: "engine-missing-stop" },
					gateway: {
						start: async () => {},
						stopIntake: async () => {},
						health: () => "ok",
					},
				}),
			}),
		).rejects.toThrow(/gateway.*stop is not a function|stop.*not a function/);
	});
});

// ---------------------------------------------------------------------------
// Meta health: the handle's wrapped health
// ---------------------------------------------------------------------------

describe("GET /v1/meta health.gateway", () => {
	test("reports ok, then degraded after the engine flips", { timeout: 30_000 }, async () => {
		const server = await bootServer([ENGINE_SPECIFIER]);
		await server.gateway.started;
		const first = (await getJson(server.app, "/v1/meta", server.aliceToken)) as {
			health: { gateway?: string };
		};
		expect(first.health.gateway).toBe("ok");
		(
			globalThis as { __fixtureGatewayHealth?: "ok" | "degraded" }
		).__fixtureGatewayHealth = "degraded";
		try {
			const second = (await getJson(server.app, "/v1/meta", server.aliceToken)) as {
				health: { gateway?: string };
			};
			expect(second.health.gateway).toBe("degraded");
		} finally {
			delete (globalThis as { __fixtureGatewayHealth?: string }).__fixtureGatewayHealth;
		}
	});

	test("an engine whose health() throws → meta 200, health.gateway degraded, logged once", { timeout: 30_000 }, async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			let calls = 0;
			const server = await bootServer([ENGINE_SPECIFIER], (opened) => {
				const engine = opened.gatewayEngine?.engine;
				if (engine === undefined) throw new Error("engine not loaded");
				// The fixture's health reads the global; REPLACE the retained
				// engine's health so every subsequent call throws (the same
				// object startGateway wraps).
				engine.health = () => {
					calls++;
					throw new Error("engine health exploded");
				};
			});
			await server.gateway.started;
			const first = (await getJson(server.app, "/v1/meta", server.aliceToken)) as {
				health: { gateway?: string };
			};
			expect(first.health.gateway).toBe("degraded");
			const second = (await getJson(server.app, "/v1/meta", server.aliceToken)) as {
				health: { gateway?: string };
			};
			expect(second.health.gateway).toBe("degraded");
			// The throw logged ONCE per process, not per call.
			expect(calls).toBe(2);
			const logged = errorSpy.mock.calls.filter(([head]) =>
				String(head).includes("gateway: engine health failed"),
			);
			expect(logged).toHaveLength(1);
		} finally {
			errorSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	test("an engine whose start() rejects → started resolves, one console.error, degraded until restart", { timeout: 30_000 }, async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const server = await bootServer([ENGINE_SPECIFIER], (opened) => {
				const engine = opened.gatewayEngine?.engine;
				if (engine === undefined) throw new Error("engine not loaded");
				engine.start = async () => {
					throw new Error("engine start exploded");
				};
			});
			// started RESOLVES (never rejects) — a failed engine must not wedge
			// boot or the shutdown path.
			await expect(server.gateway.started).resolves.toBeUndefined();
			const failures = errorSpy.mock.calls.filter(
				([head]) => String(head) === "gateway: engine start failed",
			);
			expect(failures).toHaveLength(1);
			expect(server.gateway.health()).toBe("degraded");
			const meta = (await getJson(server.app, "/v1/meta", server.aliceToken)) as {
				health: { gateway?: string };
			};
			// The route reads the SAME handle (threaded through ServerContext):
			// degraded until restart.
			expect(meta.health.gateway).toBe("degraded");
		} finally {
			errorSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Handle idempotency: the double-stop guard
// ---------------------------------------------------------------------------

describe("GatewayHandle.stop idempotency", () => {
	test("a double stop runs engine.stop() exactly once (later calls join)", { timeout: 30_000 }, async () => {
		const server = await bootServer([ENGINE_SPECIFIER]);
		await server.gateway.started;
		// Two racing calls + one later call — all join the ONE stop. Reads
		// filter by type on this boot's OWN log (no shared-log clearing).
		await Promise.all([server.gateway.stop(), server.gateway.stop()]);
		await server.gateway.stop();
		expect(server.log.filter((entry) => entry.type === "stop")).toHaveLength(1);
	});

	test("stop without start never runs engine.start (the lazy-started + shutdown edge)", { timeout: 30_000 }, async () => {
		const server = await bootServer([ENGINE_SPECIFIER]);
		// Deliberately NEVER read `started` — then stop. The engine contract
		// tolerates this (documented on the interface); the handle must not
		// start the engine just to stop it.
		await server.gateway.stop();
		expect(server.log.some((entry) => entry.type === "start")).toBe(false);
		expect(server.log.filter((entry) => entry.type === "stop")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// No engine: omitted health, inert adapters, the boot warning
// ---------------------------------------------------------------------------

describe("no engine loaded", () => {
	test("no health.gateway field; the adapter's row is inert; one boot warning", { timeout: 30_000 }, async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const server = await bootServer([ADAPTER_SPECIFIER]);
			expect(server.opened.gatewayEngine).toBeUndefined();
			const meta = await getJson(server.app, "/v1/meta", server.aliceToken);
			expect((meta.health as Record<string, unknown>).gateway).toBeUndefined();
			const rows = (
				(await getJson(server.app, "/v1/extensions", server.aliceToken)) as {
					extensions: { name: string; inert?: string }[];
				}
			).extensions;
			const adapterRow = rows.find(
				(row) => row.name === "fixture-channel-adapter",
			);
			expect(adapterRow?.inert).toBe("no gateway");
			const warnings = warnSpy.mock.calls
				.map((args) => String(args[0]))
				.filter((line) => line === "channels contributed but no gateway engine is loaded");
			expect(warnings).toHaveLength(1);
			// The no-engine handle still resolves its lifecycle (the shutdown
			// path never branches on engine presence).
			await server.gateway.started;
			await server.gateway.stopIntake();
			await server.gateway.stop();
			expect(server.gateway.health()).toBe("ok");
		} finally {
			warnSpy.mockRestore();
		}
	});
});
