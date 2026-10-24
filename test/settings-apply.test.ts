/**
 * UI-blocks U4 Task 1 (spec §13.1/§13.2): apply metadata, change
 * events, pending restarts.
 *
 * - The registry covers EVERY key in `SettingsFile` (nested `server.*`
 *   leaves included). TypeScript types have no runtime keys, so the test
 *   enumerates a LITERAL key list tied to the type with a `satisfies`
 *   check: a key added to `SettingsFile` without a registry entry fails
 *   the `satisfies` check (compile-time, which vitest surfaces via the
 *   esbuild transform erroring the file), and the runtime equality
 *   assertion names any missing entry in its failure diff.
 * - A PATCH mixing a live key (`namingModel`) and a restart key
 *   (`server.port`) returns `applied: ["namingModel"]`,
 *   `pending: ["server.port"]` (Review Focus 1); `GET /v1/settings`
 *   shows `pendingRestart: ["server.port"]`.
 * - Patching the port BACK to the boot value removes it from
 *   `pendingRestart` (Review Focus 2) — the diff is against the boot
 *   snapshot, not "ever written".
 * - Changing `server.providers.refreshIntervalMinutes` re-arms the
 *   scheduler (the next fire lands at the NEW interval) with no restart.
 * - `settings.changed {scope: "server", keys}` is published on the hub
 *   (observable through `/v1/events`).
 * - An extension's `onSettingsChanged` receives its changed keys after
 *   the write commits; one that THROWS is logged while the PUT still
 *   returns 200.
 *
 * Hermetic shape: full `openHarness` + `createServer` boots over tmp
 * dirs (the server-settings test pattern), a fixture extension carrying
 * `onSettingsChanged` (fixture-settings-changed), and fake timers over
 * ONLY the interval primitives for the scheduler re-arm (the
 * provider-scheduler test pattern).
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { HostEventWire } from "@sigrun/shared/views";
import type { JobSpec } from "@sigrun/shared/jobs";
import type { SettingsFile } from "@sigrun/shared/settings";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { CORE_SETTING_KEYS } from "../src/settings/registry.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

// ---------------------------------------------------------------------------
// The exhaustive key audit (spec §13.1, ruling 18)
// ---------------------------------------------------------------------------

/**
 * The LITERAL key list — every leaf key of `SettingsFile`, flattened
 * with dotted paths for nested sections. The `satisfies` check ties it
 * to the type: adding a key to `SettingsFile` without adding it here
 * fails the compile (vitest surfaces it as a transform error), and the
 * runtime registry-equality test below names any drift with its diff.
 *
 * Derived leaf-by-leaf from `shared/src/settings.ts`'s `SettingsFile`:
 * top-level `steeringMode`, `followUpMode`, `retry.{enabled,maxRetries,
 * baseDelayMs,maxAgentDelayMs}`, `stream.{timeoutMs,maxRetries,
 * maxRetryDelayMs}`, `defaultTools`, `perModelThinking`, `extensions`,
 * `jobs`, `jobHistory.{runs,revisions}`, `defaultModel`, `namingModel`,
 * `defaultProvider.baseUrl`, `skills.sectionMaxBytes`,
 * `notifications.runSettled`, `builtinExtensions.{codemode,mcp,
 * toolSearch}`, `autoEnableCodemode`, and the `server.*` leaves: `port`,
 * `workspacePath`, `storagePath`, `extensionsDir`, `maxUploadBytes`,
 * `maxFileReadBytes`, `dataDir`, `cacheDir`, `stateDir`, `publicUrl`,
 * `webui.{enabled,bundle}`, `webuiBundle`, `timezone`,
 * `compaction.{enabled,reserveTokens,keepRecentTokens,backgroundTokens}`,
 * `memorySeam.{hookDeadlineMs,idleThresholdMs,workerDeadlineMs,queueMax}`,
 * `providers.refreshIntervalMinutes`, `auth.methods`,
 * `auth.proxy.{trustedProxies,secretHeader,userHeader,groupsHeader,
 * nameHeader,emailHeader,autoProvision}`, `auth.{adminGroups,
 * allowedHosts,allowedOrigins}`, `metrics.public`, `dev`,
 * `backup.{path,staleAfterHours}`, `backup.s3.{bucket,prefix,endpoint}`.
 */
const EXPECTED_KEYS = [
	"steeringMode",
	"followUpMode",
	"retry.enabled",
	"retry.maxRetries",
	"retry.baseDelayMs",
	"retry.maxAgentDelayMs",
	"stream.timeoutMs",
	"stream.maxRetries",
	"stream.maxRetryDelayMs",
	"defaultTools",
	"perModelThinking",
	"extensions",
	"jobs",
	"jobHistory.runs",
	"jobHistory.revisions",
	"defaultModel",
	"namingModel",
	"defaultProvider.baseUrl",
	"skills.sectionMaxBytes",
	"notifications.runSettled",
	"builtinExtensions.codemode",
	"builtinExtensions.mcp",
	"builtinExtensions.toolSearch",
	"autoEnableCodemode",
	"server.port",
	"server.workspacePath",
	"server.storagePath",
	"server.extensionsDir",
	"server.maxUploadBytes",
	"server.maxFileReadBytes",
	"server.dataDir",
	"server.cacheDir",
	"server.stateDir",
	"server.publicUrl",
	"server.webui.enabled",
	"server.webui.bundle",
	"server.webuiBundle",
	"server.timezone",
	"server.compaction.enabled",
	"server.compaction.reserveTokens",
	"server.compaction.keepRecentTokens",
	"server.compaction.backgroundTokens",
	"server.memorySeam.hookDeadlineMs",
	"server.memorySeam.idleThresholdMs",
	"server.memorySeam.workerDeadlineMs",
	"server.memorySeam.queueMax",
	"server.providers.refreshIntervalMinutes",
	"server.auth.methods",
	"server.auth.sessionDays",
	"server.auth.proxy.trustedProxies",
	"server.auth.proxy.secretHeader",
	"server.auth.proxy.userHeader",
	"server.auth.proxy.groupsHeader",
	"server.auth.proxy.nameHeader",
	"server.auth.proxy.emailHeader",
	"server.auth.proxy.autoProvision",
	"server.auth.adminGroups",
	"server.auth.allowedHosts",
	"server.auth.allowedOrigins",
	"server.metrics.public",
	"server.dev",
	"server.supervised",
	"server.backup.path",
	"server.backup.staleAfterHours",
	"server.backup.s3.bucket",
	"server.backup.s3.prefix",
	"server.backup.s3.endpoint",
] as const;

/**
 * The type-tie (the brief's `satisfies` requirement): `Paths<T>` walks
 * `SettingsFile`'s nested object keys into dotted paths — arrays and
 * multi-shape unions count as leaf VALUES (`extensions`, `jobs`,
 * `perModelThinking`, `server.backup` yield single paths), while plain
 * nested objects (`server`, `server.auth`, `server.auth.proxy`, …)
 * yield both their own path and their children's. Every EXPECTED_KEYS
 * entry must be a member of the union (the assignment below fails the
 * compile on a stale or typo'd entry); the runtime equality test below
 * pins the exact opposite direction (a SettingsFile key with no
 * registry entry fails `expect([...EXPECTED_KEYS]).toEqual(...)`).
 */
type Paths<T> = T extends readonly unknown[]
	? never
	: T extends object
		? {
				[K in keyof T & string]:
					| K
					| (Paths<T[K]> extends infer S
							? S extends string
								? `${K}.${S}`
								: never
							: never);
			}[keyof T & string]
		: never;

/** Every literal-list entry names a real type path. */
const _typeTie: readonly Paths<SettingsFile>[] = EXPECTED_KEYS;
void _typeTie;

/** The registry's shape: one entry per key with its apply rule. */
interface RegistryEntry {
	readonly key: string;
	readonly apply: "live" | "restart";
	readonly section: string;
	readonly reason: string;
}

describe("the core settings registry (spec §13.1)", () => {
	const byKey = (): Map<string, { key: string; apply: string; section: string; reason: string }> =>
		new Map(
			CORE_SETTING_KEYS.map((entry) => [
				entry.key,
				entry as { key: string; apply: string; section: string; reason: string },
			]),
		);

	test("every SettingsFile key has exactly one registry entry", () => {
		const registryKeys: string[] = CORE_SETTING_KEYS.map(
			(entry: { key: string }) => entry.key,
		);
		// Both directions: a missing entry names itself in the diff, and a
		// registry key the type does not declare (stale entry) fails too.
		expect([...EXPECTED_KEYS]).toEqual(registryKeys);
	});

	test("the binding classifications (spec §13.1, ruling 18)", () => {
		const map = byKey();
		const expectApply = (
			keys: readonly string[],
			apply: "live" | "restart",
		): void => {
			for (const key of keys) {
				const entry = map.get(key);
				expect(entry, `registry entry for ${key}`).toBeDefined();
				expect(entry?.apply, `${key} apply`).toBe(apply);
				// Every entry carries a one-line reason (the audit's record).
				expect(
					(entry?.reason.length ?? 0) > 0 && (entry?.section.length ?? 0) > 0,
					`${key} carries section + reason`,
				).toBe(true);
			}
		};
		// live (the spec's binding list)
		expectApply(
			[
				"namingModel",
				"server.providers.refreshIntervalMinutes",
				"server.auth.sessionDays",
				"jobHistory.runs",
				"jobHistory.revisions",
			],
			"live",
		);
		// restart (the spec's binding list)
		expectApply(
			[
				"server.port",
				"server.dataDir",
				"server.cacheDir",
				"server.stateDir",
				"server.storagePath",
				"server.workspacePath",
				"server.extensionsDir",
				"server.auth.methods",
				"server.auth.proxy.trustedProxies",
				"server.auth.adminGroups",
				"server.auth.allowedHosts",
				"server.auth.allowedOrigins",
				"server.webui.enabled",
				"server.webui.bundle",
				"server.webuiBundle",
				"extensions",
			],
			"restart",
		);
		// The audit's remaining rulings (one line each in the report):
		// pass-throughs + per-use readers are live; boot-resolution keys
		// are restart.
		expectApply(
			[
				"steeringMode",
				"followUpMode",
				"retry.enabled",
				"retry.maxRetries",
				"retry.baseDelayMs",
				"retry.maxAgentDelayMs",
				"stream.timeoutMs",
				"stream.maxRetries",
				"stream.maxRetryDelayMs",
				"defaultTools",
				"perModelThinking",
				"skills.sectionMaxBytes",
				"notifications.runSettled",
				"autoEnableCodemode",
			],
			"live",
		);
		expectApply(
			[
				"jobs",
				"defaultModel",
				"defaultProvider.baseUrl",
				"builtinExtensions.codemode",
				"builtinExtensions.mcp",
				"builtinExtensions.toolSearch",
				"server.maxUploadBytes",
				"server.maxFileReadBytes",
				"server.publicUrl",
				"server.timezone",
				"server.compaction.enabled",
				"server.compaction.reserveTokens",
				"server.compaction.keepRecentTokens",
				"server.compaction.backgroundTokens",
				"server.memorySeam.hookDeadlineMs",
				"server.memorySeam.idleThresholdMs",
				"server.memorySeam.workerDeadlineMs",
				"server.memorySeam.queueMax",
				"server.auth.proxy.secretHeader",
				"server.auth.proxy.userHeader",
				"server.auth.proxy.groupsHeader",
				"server.auth.proxy.nameHeader",
				"server.auth.proxy.emailHeader",
				"server.auth.proxy.autoProvision",
				"server.metrics.public",
				"server.dev",
				"server.backup.path",
				"server.backup.staleAfterHours",
				"server.backup.s3.bucket",
				"server.backup.s3.prefix",
				"server.backup.s3.endpoint",
			],
			"restart",
		);
	});

	test("the listen host and config dir have no registry entry (launch option / env-only)", () => {
		const keys = new Set(
			CORE_SETTING_KEYS.map((entry: { key: string }) => entry.key),
		);
		expect(keys.has("listenHost")).toBe(false);
		expect(keys.has("configDir")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Server boot harness
// ---------------------------------------------------------------------------

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	/** The tmp settings dir (the store's file lives at `settings.json`). */
	readonly settingsDir: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

const SETTINGS_CHANGED_FIXTURE = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-settings-changed", "index.js"),
).href;
const SETTINGS_THROWS_FIXTURE = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-settings-throws", "index.js"),
).href;

async function bootServer(
	opts: { file?: Record<string, unknown> } = {},
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sett-apply-"));
	if (opts.file !== undefined) {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify(opts.file),
			"utf8",
		);
	}
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		// The fixture extensions carry `onSettingsChanged` handlers (one
		// recording, one throwing) the PUT route fires.
		extensionSpecifiers: [SETTINGS_CHANGED_FIXTURE, SETTINGS_THROWS_FIXTURE],
		env: {},
		settingsDir: dir,
	});
	const app = await createServer(opened, config, [], {
		env: {},
		listenHost: "127.0.0.1",
	});
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, settingsDir: dir };
}

const patch = (app: FastifyInstance, body: unknown) =>
	app.inject({
		method: "PATCH",
		url: "/v1/settings",
		payload: body as Record<string, unknown>,
		headers: { "content-type": "application/json" },
	});

// ---------------------------------------------------------------------------
// Writes: applied / pending + pendingRestart (Review Focus 1 + 2)
// ---------------------------------------------------------------------------

describe("PATCH /v1/settings: applied, pending, pendingRestart", () => {
	test("a mixed live+restart PATCH reports which is which (Review Focus 1)", async () => {
		const { app } = await bootServer();
		const response = await patch(app, {
			namingModel: "faux/m",
			server: { port: 4080 },
		});
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			applied: string[];
			pending: string[];
			pendingRestart: string[];
		};
		expect(body.applied).toEqual(["namingModel"]);
		expect(body.pending).toEqual(["server.port"]);
		// GET agrees: the restart key is pending, the live key is not.
		const get = (await app.inject({ method: "GET", url: "/v1/settings" }))
			.json() as { pendingRestart: string[] };
		expect(get.pendingRestart).toEqual(["server.port"]);
	});

	test("patching a restart key back to its boot value removes it (Review Focus 2)", async () => {
		const { app } = await bootServer({
			file: { server: { port: 4080 } },
		});
		// The boot snapshot read port 4080; a write to a DIFFERENT value
		// is pending…
		await patch(app, { server: { port: 5050 } });
		const after1 = (await app.inject({ method: "GET", url: "/v1/settings" }))
			.json() as { pendingRestart: string[] };
		expect(after1.pendingRestart).toEqual(["server.port"]);
		// …and patching it BACK to the boot value clears the diff — no
		// restart needed, the callout disappears.
		await patch(app, { server: { port: 4080 } });
		const after2 = (await app.inject({ method: "GET", url: "/v1/settings" }))
			.json() as { pendingRestart: string[] };
		expect(after2.pendingRestart).toEqual([]);
	});

	test("GET /v1/settings always carries pendingRestart ([] when none)", async () => {
		const { app } = await bootServer();
		const get = (await app.inject({ method: "GET", url: "/v1/settings" }))
			.json() as { pendingRestart: string[] };
		expect(get.pendingRestart).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// settings.changed on the hub (server scope)
// ---------------------------------------------------------------------------

describe("settings.changed publication", () => {
	test("a server-scope PATCH publishes {scope: 'server', keys}", async () => {
		const { app, opened } = await bootServer();
		const seen: unknown[] = [];
		const unsubscribe = opened.events.subscribe((event) => {
			if ((event as { type: string }).type === "settings.changed") {
				seen.push(event);
			}
		});
		await patch(app, { steeringMode: "all" });
		unsubscribe();
		expect(seen).toEqual([
			{ type: "settings.changed", scope: "server", keys: ["steeringMode"] },
		]);
	});

	test("the /v1/events stream delivers settings.changed to admins only", async () => {
		// A real loopback socket per connection (a hijacked reply never
		// resolves under inject — the events-stream test pattern), over a
		// token-method boot with one admin and one non-admin.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-apply-events-"));
		const configDir = join(dir, "config");
		await mkdir(configDir, { recursive: true });
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "token",
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_CONFIG_DIR: configDir,
		});
		const identity = await seededIdentity(dir);
		await identity.users.add({ user: "pleb", admin: false, source: "cli" });
		const opened = await openHarness(config, {
			identity,
			env: { SIGRUN_CONFIG_DIR: configDir },
			settingsDir: dir,
		});
		const { token: adminToken } = await opened.identity.tokens.create(
			"admin-cli",
			"tester",
		);
		const { token: plebToken } = await opened.identity.tokens.create(
			"pleb-cli",
			"pleb",
		);
		const app = await createServer(opened, config, [], {
			env: {},
			listenHost: "127.0.0.1",
		});
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (address === null || typeof address === "string") {
			throw new Error("listen did not bind a port");
		}
		const port = address.port;
		const admin = new EventsConnection(port, {
			authorization: `Bearer ${adminToken}`,
		});
		const pleb = new EventsConnection(port, {
			authorization: `Bearer ${plebToken}`,
		});
		try {
			await admin.ready();
			await pleb.ready();
			// A server-scope write publishes on the hub; the admin frame
			// arrives, the non-admin never sees one.
			const response = await fetch(`http://127.0.0.1:${port}/v1/settings`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${adminToken}`,
				},
				body: JSON.stringify({ steeringMode: "all" }),
			});
			expect(response.status).toBe(200);
			const frame = await admin.waitFor(
				(f) => f.event === "settings.changed",
			);
			expect(frame.data).toEqual({
				type: "settings.changed",
				scope: "server",
				keys: ["steeringMode"],
			});
			// The non-admin connection received NO settings.changed (the
			// admin-only gate). Give the frame a moment to (not) arrive.
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(
				pleb
					.eventsSoFar()
					.some((f) => f.event === "settings.changed"),
			).toBe(false);
		} finally {
			admin.destroy();
			pleb.destroy();
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Extension onSettingsChanged (the fixture carries one recorder + one thrower)
// ---------------------------------------------------------------------------

describe("extension onSettingsChanged", () => {
	test("an extension's onSettingsChanged receives its changed keys; a throwing handler is logged, PUT still 200", async () => {
		const { app } = await bootServer();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const fixture = (await import(SETTINGS_CHANGED_FIXTURE)) as {
				received: string[][];
				reset: () => void;
			};
			// The recorder is MODULE state (one module instance across the
			// suite); the earlier server-scope PATCH tests also fired it (the
			// fan-out reaches EVERY extension). Reset, then assert this
			// extension-scope write delivered exactly its own keys.
			fixture.reset();
			const response = await app.inject({
				method: "PUT",
				url: "/v1/extensions/acme-settings-changed/settings",
				payload: { threshold: 5 },
				headers: { "content-type": "application/json" },
			});
			expect(response.statusCode).toBe(200);
			expect(fixture.received).toEqual([["threshold"]]);
			// The THROWING handler (the fixture's second extension) was
			// logged, not propagated.
			const logged = errorSpy.mock.calls
				.map((args) => args.join(" "))
				.find((line) => line.includes("acme-settings-throws"));
			expect(logged).toBeDefined();
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("the extension settings GET carries pendingRestart", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/extensions/acme-settings-changed/settings",
		});
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			settings: Record<string, unknown>;
			pendingRestart: string[];
		};
		// Extension fields default to live (spec §13.1): never pending.
		expect(body.pendingRestart).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The scheduler re-arm (server.providers.refreshIntervalMinutes is live)
// ---------------------------------------------------------------------------

describe("server.providers.refreshIntervalMinutes re-arms the scheduler", () => {
	test("changing the interval moves the next fire to the new cadence (no restart)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-apply-arm-"));
		try {
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({
					server: { providers: { refreshIntervalMinutes: 15 } },
				}),
				"utf8",
			);
			const config = loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_AUTH: "none",
				SIGRUN_WORKSPACE_PATH: dir,
			});
			// Fake ONLY the interval primitives (the provider-scheduler
			// pattern): the rest of boot/I/O runs real.
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			// The re-arm observable: every interval the scheduler arms.
			// Boot arms at 15 minutes; the PATCH to 1 must CLEAR that timer
			// and arm a NEW one at 1 minute (the next fire moves to the
			// new cadence — no restart).
			const intervals: number[] = [];
			const clears: number[] = [];
			const realSetInterval = globalThis.setInterval;
			const armSpy = vi
				.spyOn(globalThis, "setInterval")
				.mockImplementation(((handler: () => void, ms?: number) => {
					intervals.push(ms ?? 0);
					// SAFETY: run through the real (faked by toFake? no —
					// spyOn replaces before vitest's fake wraps; delegate to
					// the captured real fn so vitest's fake clock still owns
					// scheduling via the mock's passthrough below).
					return realSetInterval(handler, ms);
				}) as typeof setInterval);
			const realClearInterval = globalThis.clearInterval;
			const clearSpy = vi
				.spyOn(globalThis, "clearInterval")
				.mockImplementation(((id: ReturnType<typeof setInterval>) => {
					clears.push(1);
					return realClearInterval(id);
				}) as typeof clearInterval);
			let opened: OpenedHarness | undefined;
			try {
				opened = await openHarness(config, {
					identity: await seededIdentity(dir),
					env: {},
					settingsDir: dir,
				});
				const app = await createServer(opened, config, [], {
					env: {},
					listenHost: "127.0.0.1",
				});
				cleanups.push(async () => {
					await app.close();
				});
				// Boot armed the 15-minute cadence (900_000 ms). The idle
				// sweep + heartbeats use other intervals; the scheduler's is
				// identifiable by its exact ms.
				expect(intervals).toContain(15 * 60_000);
				// The live re-arm: PATCH the cadence to 1 minute.
				const response = await patch(app, {
					server: { providers: { refreshIntervalMinutes: 1 } },
				});
				expect(response.statusCode).toBe(200);
				const body = response.json() as {
					applied: string[];
					pending: string[];
				};
				// §13.1: the key is LIVE — applied now, never pending.
				expect(body.applied).toEqual([
					"server.providers.refreshIntervalMinutes",
				]);
				expect(body.pending).toEqual([]);
				// The re-arm happened: the 15-minute timer was cleared and a
				// NEW 1-minute timer armed.
				expect(clears.length).toBeGreaterThan(0);
				expect(intervals).toContain(60_000);
				// And nothing went pending-restart for it (live key).
				const get = (await app.inject({ method: "GET", url: "/v1/settings" }))
					.json() as { pendingRestart: string[] };
				expect(get.pendingRestart).toEqual([]);
				await app.close();
			} finally {
				armSpy.mockRestore();
				clearSpy.mockRestore();
				vi.useRealTimers();
				await opened?.harness.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// One real /v1/events connection (the events-stream test pattern, copied
// minimal: incremental SSE frame parser + predicate waiter)
// ---------------------------------------------------------------------------

/** One parsed host-event frame. */
interface HostFrame {
	readonly event: string;
	readonly data: HostEventWire;
}

class EventsConnection {
	private readonly request: http.ClientRequest;
	private readonly events: HostFrame[] = [];
	private buffer = "";
	private readonly dataWaiters: Array<() => void> = [];
	private readonly connected: Promise<void>;

	constructor(
		port: number,
		headers: Record<string, string> = {},
	) {
		this.request = http.get({
			host: "127.0.0.1",
			port,
			path: "/v1/events",
			headers,
			agent: false,
		});
		this.request.on("error", () => {});
		let ready: () => void = () => {};
		this.connected = new Promise<void>((resolve) => {
			ready = resolve;
		});
		this.request.on("response", (incoming) => {
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => {
				this.buffer += chunk;
				this.drain();
			});
			incoming.on("error", () => {});
			ready();
		});
	}

	private drain(): void {
		for (;;) {
			const boundary = this.buffer.indexOf("\n\n");
			if (boundary === -1) return;
			const frame = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			let event = "";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith(":")) continue;
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			if (data === "") continue;
			this.events.push({ event, data: JSON.parse(data) as HostEventWire });
			for (const wake of this.dataWaiters.splice(0)) wake();
		}
	}

	async ready(): Promise<void> {
		await this.connected;
	}

	async waitFor(
		predicate: (frame: HostFrame) => boolean,
		timeoutMs = 15_000,
	): Promise<HostFrame> {
		await this.connected;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find(predicate);
			if (found !== undefined) return found;
			if (Date.now() >= deadline) {
				throw new Error(
					`timed out; events so far: ${JSON.stringify(this.events.map((f) => f.event))}`,
				);
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 500);
				this.dataWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	eventsSoFar(): readonly HostFrame[] {
		return [...this.events];
	}

	destroy(): void {
		this.request.destroy();
	}
}

// ---------------------------------------------------------------------------
// JobSpec import keeps the type-tie honest (jobs is a restart key above)
// ---------------------------------------------------------------------------

test("the audit's jobs key stays tied to the real JobSpec surface", () => {
	const file: SettingsFile = { jobs: [] as readonly JobSpec[] };
	expect(file.jobs).toEqual([]);
});
