/**
 * Task 5 (provider plugins): the interval refresh scheduler.
 *
 * Core-owned refresh policy 2: after the T4 boot refresh populates the
 * catalogs, ONE host-owned `setInterval` re-runs `models.refresh()` (no
 * provider filter — every dynamic provider) on a cadence so a roster
 * change upstream lands without a restart, well inside the refresh-on-miss
 * fallback (T4). The cadence resolves at boot from
 * `server.providers.refreshIntervalMinutes` (settings file) under
 * `SIGRUN_PROVIDER_REFRESH_MINUTES` (env), default 15; `0` disables the
 * scheduler outright (no timer).
 *
 * Contract pins:
 * - the timer is `unref()`ed — a bare boot never holds the process open;
 * - `stop()` clears it, and the deploy shutdown path calls `stop()`
 *   BEFORE the harness closes (alongside the ordered shutdown), where the
 *   never-rejecting T4 boot-refresh promise also joins if still in flight;
 * - a failed tick (per-provider errors in the refresh result, or an
 *   unexpected throw) logs ONCE per outage on the transition into
 *   failure — consecutive failures stay silent; a successful tick resets
 *   the state so the NEXT outage warns again. One warn per episode, not
 *   one per tick.
 *
 * Hermetic shape: unit tests drive a real dynamic faux provider through
 * `collectProviders` under fake timers (only `setInterval`/
 * `clearInterval` are faked, so the rest of the boot/I/O machinery runs
 * real); the serve-level tests boot the DEPLOYED composition
 * (`src/serve.ts`) over a fixture extension package whose `fetchModels`
 * counts into a file, and read the counter across shutdown.
 *
 * Timer-advance note: every cadence advance steps PAST the boundary
 * (`interval + 1`), because the sinon fake clock does not fire a timer
 * due at EXACTLY the advance target when other intervals interleave — a
 * testing artifact only; real Node interval semantics are unaffected.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Model, Models } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { serve } from "../src/serve.js";
import { SettingsStore } from "../src/harness/settings.js";
import {
	collectProviders,
	createProviderMergeSink,
	type ProviderContributor,
} from "../src/harness/providers/index.js";
import { startProviderRefresh } from "../src/harness/providers/scheduler.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A dynamic faux provider whose `fetchModels` counts calls — the unit
 * tests' tick signal (no boot refresh runs through `collectProviders`,
 * so call 1 is the first interval tick).
 */
function countingFaux(): {
	contributor: ProviderContributor;
	calls: () => number;
} {
	const core = createFauxCore({
		provider: "acme",
		api: "faux",
		models: [{ id: "m1", contextWindow: 128_000 }],
	});
	let calls = 0;
	const clone = (modelId: string): Model<string> => ({
		...core.models[0]!,
		id: modelId,
		name: modelId,
	});
	const provider = createProvider({
		id: "acme",
		auth: {
			apiKey: {
				name: "Fixture",
				resolve: async () => ({ auth: {} }),
			},
		},
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
		fetchModels: async () => {
			calls++;
			return core.models.map((model) => clone(model.id));
		},
	});
	return {
		contributor: {
			name: "ext-acme",
			providers: [
				{
					provider,
					defaultModel: { provider: "acme", modelId: "m1" },
				},
			],
		},
		calls: () => calls,
	};
}

/** The serve fixture's entry (a provider-only counting contributor). */
const SERVE_FIXTURE = join(
	import.meta.dirname,
	"fixtures",
	"fixture-scheduler",
	"index.js",
);

/** The serve fixture's counter file size = its fetch count. */
function fetchCount(counter: string): number {
	try {
		return readFileSync(counter, "utf8").length;
	} catch {
		return 0;
	}
}

/** Flush the real macrotask/I/O machinery until `predicate` holds. */
async function until(
	predicate: () => boolean,
	rounds = 400,
): Promise<void> {
	// Real 5ms sleeps (setTimeout is NOT faked — only intervals are):
	// threadpool I/O (sqlite, fs) needs wall time, not just macrotask turns.
	for (let round = 0; round < rounds && !predicate(); round++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

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

/**
 * Fake ONLY the interval primitives: everything else (fastify boot,
 * sqlite, fs, setImmediate) keeps the real machinery, so a full
 * `serve()` boot runs unchanged while the scheduler's cadence is
 * advanced deterministically.
 */
function fakeIntervals(): void {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
}

// ---------------------------------------------------------------------------
// The scheduler unit
// ---------------------------------------------------------------------------

describe("startProviderRefresh", () => {
	test("the interval re-refreshes on cadence (fake timers)", async () => {
		const fixture = countingFaux();
		const { models } = collectProviders(
			[fixture.contributor],
			{},
			createProviderMergeSink(),
		);
		fakeIntervals();
		try {
			const handle = startProviderRefresh(models, { intervalMinutes: 15 });
			// setInterval semantics: no immediate tick — the T4 boot refresh
			// owns time zero; the first interval tick lands one cadence in.
			expect(fixture.calls()).toBe(0);
			await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
			expect(fixture.calls()).toBe(1);
			await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
			expect(fixture.calls()).toBe(2);
			handle.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	test("interval 0 disables the scheduler", async () => {
		const fixture = countingFaux();
		const { models } = collectProviders(
			[fixture.contributor],
			{},
			createProviderMergeSink(),
		);
		fakeIntervals();
		try {
			const handle = startProviderRefresh(models, { intervalMinutes: 0 });
			// Ten days of cadence: no timer exists, nothing ever fetches.
			await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60_000);
			expect(fixture.calls()).toBe(0);
			handle.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	test("stop() clears the timer (no further ticks after it)", async () => {
		const fixture = countingFaux();
		const { models } = collectProviders(
			[fixture.contributor],
			{},
			createProviderMergeSink(),
		);
		fakeIntervals();
		try {
			const handle = startProviderRefresh(models, { intervalMinutes: 15 });
			await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
			expect(fixture.calls()).toBe(1);
			handle.stop();
			await vi.advanceTimersByTimeAsync(3 * 15 * 60_000);
			expect(fixture.calls()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the timer is unrefed (does not hold the process)", () => {
		const models = {
			refresh: async () => ({ aborted: false, errors: new Map() }),
		} as unknown as Models;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		try {
			const handle = startProviderRefresh(models, { intervalMinutes: 15 });
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			const timer = setIntervalSpy.mock.results[0]!
				.value as ReturnType<typeof setInterval>;
			expect(timer.hasRef()).toBe(false);
			handle.stop();
		} finally {
			setIntervalSpy.mockRestore();
		}
	});

	test("a failed tick logs once on the transition, not every tick", async () => {
		// One outage episode (two failing ticks), a recovery, then a new
		// outage: ONE warn per transition into failure.
		const down = new Error("gateway unreachable");
		const results = [
			{ aborted: false, errors: new Map([["acme", down]]) },
			{ aborted: false, errors: new Map([["acme", down]]) },
			{ aborted: false, errors: new Map<string, Error>() },
			{ aborted: false, errors: new Map([["acme", down]]) },
		];
		let call = 0;
		const models = {
			refresh: async () =>
				results[Math.min(call++, results.length - 1)]!,
		} as unknown as Models;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fakeIntervals();
		try {
			const handle = startProviderRefresh(models, { intervalMinutes: 1 });
			await vi.advanceTimersByTimeAsync(60_000 + 1); // fail → warn once
			await vi.advanceTimersByTimeAsync(60_000); // fail again → suppressed
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain(
				"gateway unreachable",
			);
			await vi.advanceTimersByTimeAsync(60_000); // recovery → silent
			expect(warn).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(60_000 + 1); // new outage → warn
			expect(warn).toHaveBeenCalledTimes(2);
			handle.stop();
		} finally {
			vi.useRealTimers();
			warn.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// The settings layer
// ---------------------------------------------------------------------------

describe("settings: server.providers.refreshIntervalMinutes", () => {
	const MODEL_ENV = { SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" };

	test("default 15, file value respected, env override wins", () => {
		expect(
			loadConfig({ ...MODEL_ENV }).providers.refreshIntervalMinutes,
		).toBe(15);
		const fromFile = loadConfig(
			{ ...MODEL_ENV },
			{ server: { providers: { refreshIntervalMinutes: 5 } } },
		);
		expect(fromFile.providers.refreshIntervalMinutes).toBe(5);
		const fromEnv = loadConfig(
			{ ...MODEL_ENV, SIGRUN_PROVIDER_REFRESH_MINUTES: "2" },
			{ server: { providers: { refreshIntervalMinutes: 5 } } },
		);
		expect(fromEnv.providers.refreshIntervalMinutes).toBe(2);
		// 0 is the designed disable (not a parse error); anything else
		// non-integer or negative fails loud naming the variable.
		expect(
			loadConfig({
				...MODEL_ENV,
				SIGRUN_PROVIDER_REFRESH_MINUTES: "0",
			}).providers.refreshIntervalMinutes,
		).toBe(0);
		for (const bad of ["abc", "-1", "1.5"]) {
			expect(() =>
				loadConfig({ ...MODEL_ENV, SIGRUN_PROVIDER_REFRESH_MINUTES: bad }),
			).toThrow(/SIGRUN_PROVIDER_REFRESH_MINUTES/);
		}
	});

	test("SettingsStore update() sub-merges server.providers and validates", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-sched-settings-"));
		try {
			const store = new SettingsStore({ dir });
			store.update({
				server: { port: 4080, providers: { refreshIntervalMinutes: 30 } },
			});
			expect(
				store.read().server?.providers?.refreshIntervalMinutes,
			).toBe(30);
			// A providers PATCH leaves the rest of the server section alone.
			store.update({ server: { providers: { refreshIntervalMinutes: 45 } } });
			expect(store.read().server?.port).toBe(4080);
			expect(
				store.read().server?.providers?.refreshIntervalMinutes,
			).toBe(45);
			// A null sub-field clears just the knob (the section survives).
			store.update({ server: { providers: { refreshIntervalMinutes: null } } });
			expect(store.read().server?.providers).toBeUndefined();
			expect(store.read().server?.port).toBe(4080);
			// Bad shapes throw naming the field.
			const bad: Array<[Record<string, unknown>, RegExp]> = [
				[
					{ server: { providers: { refreshIntervalMinutes: -1 } } },
					/server\.providers\.refreshIntervalMinutes/,
				],
				[
					{ server: { providers: { refreshIntervalMinutes: "30" } } },
					/server\.providers\.refreshIntervalMinutes/,
				],
				[
					{ server: { providers: { refreshIntervalMinutes: 1.5 } } },
					/server\.providers\.refreshIntervalMinutes/,
				],
				[
					{ server: { providers: { unknownKnob: 1 } } },
					/server\.providers\.unknownKnob/,
				],
				[{ server: { providers: "fast" } }, /server\.providers/],
			];
			for (const [patch, pattern] of bad) {
				expect(() => store.update(patch)).toThrow(pattern);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// The deployed boot (serve): start on boot, stop on shutdown
// ---------------------------------------------------------------------------

describe("serve wiring", () => {
	/**
	 * Boot the deployed composition over the counting fixture: a pre-
	 * written settings.json (config dir under `dir`) declaring the fixture
	 * extension and `server.providers.refreshIntervalMinutes: 1`, env knobs
	 * for a hermetic port/storage, and the counter file wired through
	 * `SIGRUN_SCHEDULER_COUNTER`. Fake timers cover ONLY the interval
	 * primitives (installed before `serve` so the scheduler's timer lands
	 * on the fake clock).
	 */
	async function bootServed(
		dir: string,
		env: Record<string, string>,
	): Promise<ReturnType<typeof serve>> {
		const configDir = join(dir, "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "settings.json"),
			`${JSON.stringify(
				{
					extensions: [SERVE_FIXTURE],
					server: { providers: { refreshIntervalMinutes: 1 } },
				},
				null,
				"\t",
			)}\n`,
		);
		const port = await freePort();
		return await serve({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_PORT: String(port),
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: join(dir, "workspace"),
			SIGRUN_DATA_DIR: join(dir, "data"),
			SIGRUN_CACHE_DIR: join(dir, "cache"),
			SIGRUN_STATE_DIR: join(dir, "state"),
			...env,
		});
	}

	/** Set/restore the process.env seams the serve path/fixture read. */
	function withProcessEnv(
		overrides: Record<string, string>,
		run: () => Promise<void>,
	): Promise<void> {
		const before = Object.fromEntries(
			Object.keys(overrides).map((key) => [key, process.env[key]]),
		);
		for (const [key, value] of Object.entries(overrides)) {
			process.env[key] = value;
		}
		const restore = (): void => {
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		};
		return run().then(restore, (error: unknown) => {
			restore();
			throw error;
		});
	}

	test("shutdown stops the scheduler: post-shutdown no further ticks", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-sched-serve-"));
		const counter = join(dir, "count.log");
		let booted: Awaited<ReturnType<typeof serve>> | undefined;
		await withProcessEnv(
			{
				SIGRUN_CONFIG_DIR: join(dir, "config"),
				SIGRUN_SCHEDULER_COUNTER: counter,
			},
			async () => {
				fakeIntervals();
				try {
					booted = await bootServed(dir, {});
					// The T4 boot refresh lands at counter 1; flush it through
					// the REAL macrotask machinery (only intervals are faked).
					await until(() => fetchCount(counter) >= 1);
					expect(fetchCount(counter)).toBe(1);
					// The file's cadence (1 minute) ticks the fixture provider. Each
					// step: advance PAST the boundary (the fake clock does not fire a
					// timer due at exactly the advance target — a sinon artifact;
					// real Node interval semantics are unaffected), then flush the
					// REAL async fetch chain (threadpool I/O for the models store
					// settles after the fake advance resolves), then assert the
					// count moved by EXACTLY one — one step, one tick.
					await vi.advanceTimersByTimeAsync(60_000 + 1);
					await until(() => fetchCount(counter) >= 2);
					expect(fetchCount(counter)).toBe(2);
					await vi.advanceTimersByTimeAsync(60_000 + 1);
					await until(() => fetchCount(counter) >= 3);
					expect(fetchCount(counter)).toBe(3);
					// The deploy stop path: shutdown calls stop() BEFORE the
					// harness closes — and no further ticks arrive after it.
					await booted.shutdownOnce();
					await vi.advanceTimersByTimeAsync(5 * 60_000);
					await new Promise((resolve) => setTimeout(resolve, 25));
					expect(fetchCount(counter)).toBe(3);
				} finally {
					vi.useRealTimers();
					await booted?.shutdownOnce().catch(() => {});
				}
			},
		);
		await rm(dir, { recursive: true, force: true });
	});

	test("SIGRUN_PROVIDER_REFRESH_MINUTES=0 boots with no scheduler (env wins over the file)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-sched-off-"));
		const counter = join(dir, "count.log");
		let booted: Awaited<ReturnType<typeof serve>> | undefined;
		await withProcessEnv(
			{
				SIGRUN_CONFIG_DIR: join(dir, "config"),
				SIGRUN_SCHEDULER_COUNTER: counter,
			},
			async () => {
				fakeIntervals();
				try {
					booted = await bootServed(dir, {
						SIGRUN_PROVIDER_REFRESH_MINUTES: "0",
					});
					// The boot refresh still ran (T4 is unconditional); the
					// scheduler did not start at all — however much fake time
					// passes, the fetch count never moves past the boot's 1.
					await until(() => fetchCount(counter) >= 1);
					await vi.advanceTimersByTimeAsync(5 * 60_000);
					expect(fetchCount(counter)).toBe(1);
				} finally {
					vi.useRealTimers();
					await booted?.shutdownOnce().catch(() => {});
				}
			},
		);
		await rm(dir, { recursive: true, force: true });
	});
});
