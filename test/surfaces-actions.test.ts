/**
 * UI-blocks U3 Task 3: the actions route machinery — `unknown_action`
 * (400), the access gate BEFORE the handler runs (read → 403, none →
 * 404, spy not called), actionId dedup (one handler call per actionId
 * per instance in the 10-minute window, the duplicate returns the
 * FIRST result), rate limiting (20/s per principal per surface, burst
 * 40 → 429), the 10 s timeout (a sleeping handler answers
 * `{ok:false, error:{message:"timed out"}}` at 10 s), and the §6.3
 * move-accept rules (accept WITH update.ops → `{ok, rev, ops}` with
 * the ops logged for sharedData; accept WITHOUT ops → `{ok, rev}` and
 * nothing recorded; navigate and toast pass through).
 *
 * The fixture extension's seam (`actionCalls`, `sleepMs`,
 * `actionResults`, `accessOverrides`) drives the handler behavior;
 * the loader imports the fixture by the same file URL this test
 * imports, so the mutations are visible to the loaded extension.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	accessOverrides,
	actionCalls,
	actionResults,
	resetSurfaceFixture,
	sleepMs,
} from "./fixtures/fixture-surfaces/index.js";

const SURFACES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-surfaces", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
	readonly bobToken: string;
}

let booted: Promise<TestServer> | undefined;
function server(): Promise<TestServer> {
	booted ??= bootServer().then((s) => {
		// The rate limiter is a per-server singleton; disable it once at
		// boot. The two rate-limit tests re-enable it explicitly and use
		// their own surface ids, so no cross-test state leaks.
		s.app.surfaces.setRateLimitDisabled(true);
		return s;
	});
	return booted;
}

/** Boot one hermetic token-method server with the surfaces fixture and two users. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-surfaces-actions-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
	});
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	if (identity.users.get("bob") === undefined) {
		await identity.users.add({
			user: "bob",
			name: "Bob Acme",
			admin: false,
			source: "cli",
		});
	}
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [SURFACES_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const { token: bobToken } = await opened.identity.tokens.create(
		"bob-cli",
		"bob",
	);
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, aliceToken, bobToken };
}

interface CallResult {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

async function call(
	app: FastifyInstance,
	options: {
		readonly method: "GET" | "POST";
		readonly url: string;
		readonly token: string;
		readonly payload?: unknown;
	},
): Promise<CallResult> {
	const response = await app.inject({
		method: options.method,
		url: options.url,
		headers: { authorization: `Bearer ${options.token}` },
		...(options.payload === undefined
			? {}
			: { payload: options.payload as Record<string, unknown> }),
	});
	return {
		status: response.statusCode,
		body: response.json() as Record<string, unknown>,
	};
}

/** Post one action to the board with a fresh actionId. */
async function postAction(
	app: FastifyInstance,
	token: string,
	action: string,
	options?: {
		readonly payload?: unknown;
		readonly actionId?: string;
		readonly params?: unknown;
		readonly surface?: string;
	},
): Promise<CallResult> {
	return await call(app, {
		method: "POST",
		url: options?.surface ?? "/v1/ext/fixture-surfaces/surfaces/board/actions",
		token,
		payload: {
			action,
			...(options?.payload === undefined ? {} : { payload: options.payload }),
			...(options?.actionId === undefined
				? {}
				: { actionId: options.actionId }),
			...(options?.params === undefined ? {} : { params: options.params }),
		},
	});
}

beforeEach(() => {
	resetSurfaceFixture();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the actions route (U3 Task 3)", () => {
	test("an action name not in actions → 400 unknown_action", async () => {
		const { app, aliceToken } = await server();
		const result = await postAction(app, aliceToken, "no-such-action");
		expect(result.status).toBe(400);
		expect(result.body).toEqual({ error: "unknown_action" });
	});

	test("read access → 403 and the handler never runs", async () => {
		const { app, aliceToken } = await server();
		accessOverrides.set("alice", "read");
		// Advance the Date clock past the 60 s access-cache TTL so the
		// gate re-renders and sees the new grant (another test's earlier
		// render may hold a cached verdict at the frozen time).
		vi.setSystemTime(new Date("2026-10-22T00:05:00Z"));
		const result = await postAction(app, aliceToken, "move", {
			payload: { itemId: "c1" },
			params: { board: "acme-read-gate" },
		});
		expect(result.status).toBe(403);
		expect(actionCalls).toHaveLength(0);
	});

	test("none access → 404 surface_not_found and the handler never runs", async () => {
		const { app, aliceToken } = await server();
		accessOverrides.set("alice", "none");
		vi.setSystemTime(new Date("2026-10-22T00:05:00Z"));
		const result = await postAction(app, aliceToken, "move", {
			payload: { itemId: "c1" },
			params: { board: "acme-none-gate" },
		});
		expect(result.status).toBe(404);
		expect(result.body).toEqual({ error: "surface_not_found" });
		expect(actionCalls).toHaveLength(0);
	});

	test("dedup: two posts with one actionId call the handler once and return identical bodies", async () => {
		const { app, aliceToken } = await server();
		const actionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const first = await postAction(app, aliceToken, "move", {
			payload: { itemId: "c1" },
			actionId,
			params: { board: "acme-dedup" },
		});
		expect(first.status).toBe(200);
		expect(first.body.ok).toBe(true);
		const second = await postAction(app, aliceToken, "move", {
			payload: { itemId: "c2" },
			actionId,
			params: { board: "acme-dedup" },
		});
		expect(second.status).toBe(200);
		expect(second.body).toEqual(first.body);
		const moves = actionCalls.filter(
			(entry) => entry.action === "move" && entry.key !== "",
		);
		expect(moves).toHaveLength(1);
	});

	test("dedup windows per instance: the same actionId on a different params instance runs the handler again", async () => {
		const { app, aliceToken } = await server();
		const actionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const first = await postAction(app, aliceToken, "move", {
			actionId,
			params: { board: "acme-one" },
		});
		expect(first.status).toBe(200);
		const second = await postAction(app, aliceToken, "move", {
			actionId,
			params: { board: "acme-two" },
		});
		expect(second.status).toBe(200);
		expect(actionCalls.filter((entry) => entry.action === "move")).toHaveLength(
			2,
		);
	});

	test("rate limit: 41 actions in one second from one principal → the 41st is 429", async () => {
		const { app, aliceToken } = await server();
		app.surfaces.setRateLimitDisabled(false);
		const params = { board: "acme-rate" };
		try {
		// Warm the access cache once (the gate re-renders on a miss; the
		// burst must be counted on ACTIONS, not renders).
		const warm = await postAction(app, aliceToken, "move", { params });
		expect(warm.status).toBe(200);
		let lastStatus = 0;
		for (let i = 0; i < 41; i += 1) {
			const result = await postAction(app, aliceToken, "move", {
				params,
				actionId: `rate-${i}`,
			});
			lastStatus = result.status;
		}
		expect(lastStatus).toBe(429);
		} finally {
			app.surfaces.setRateLimitDisabled(true);
		}
	});

	test("timeout: a handler sleeping 11 s answers timed out at 10 s", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const { app, aliceToken } = await server();
		sleepMs.move = 11_000;
		const pending = postAction(app, aliceToken, "move", {
			params: { board: "acme-timeout" },
		});
		// Let the handler start, then advance past the 10 s timeout.
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(10_001);
		const result = await pending;
		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			ok: false,
			error: { message: "timed out" },
		});
	});

	test("accept WITH update.ops → {ok:true, rev, ops}; sharedData logs the ops", async () => {
		const { app, aliceToken } = await server();
		const params = { board: "acme-accept-ops" };
		actionResults.move = {
			ok: true,
			update: { ops: [{ op: "move", path: "/cards", from: 0, to: 1 }] },
		};
		const result = await postAction(app, aliceToken, "move", { params });
		expect(result.status).toBe(200);
		expect(result.body.ok).toBe(true);
		expect(result.body.rev).toBe(1);
		expect(result.body.ops).toEqual([
			{ op: "move", path: "/cards", from: 0, to: 1 },
		]);
		// The ops are in the sharedData log: a since=0 fetch returns them.
		const data = await call(app, {
			method: "GET",
			url: `/v1/ext/fixture-surfaces/surfaces/board/data?params=${encodeURIComponent(JSON.stringify(params))}&since=0`,
			token: aliceToken,
		});
		expect(data.status).toBe(200);
		expect(data.body.rev).toBe(1);
		expect(data.body.ops).toEqual([
			{ op: "move", path: "/cards", from: 0, to: 1 },
		]);
	});

	test("accept WITHOUT ops → {ok:true, rev} and no ops recorded (extension surfaces own their data, §6.3)", async () => {
		const { app, aliceToken } = await server();
		const params = { board: "acme-accept-noops" };
		actionResults.acceptNoOps = { ok: true };
		const result = await postAction(app, aliceToken, "acceptNoOps", {
			params,
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ ok: true, rev: 1 });
		// No ops recorded: the since window is empty at rev 1.
		const data = await call(app, {
			method: "GET",
			url: `/v1/ext/fixture-surfaces/surfaces/board/data?params=${encodeURIComponent(JSON.stringify(params))}&since=0`,
			token: aliceToken,
		});
		expect(data.status).toBe(200);
		expect(data.body.rev).toBe(1);
		expect(data.body.ops ?? []).toEqual([]);
	});

	test("navigate and toast pass through on an accept", async () => {
		const { app, aliceToken } = await server();
		actionResults.go = {
			ok: true,
			navigate: { type: "navigate", target: { settings: "interface" } },
			toast: "moved",
		};
		const result = await postAction(app, aliceToken, "go", {
			params: { board: "acme-navigate" },
		});
		expect(result.status).toBe(200);
		expect(result.body.ok).toBe(true);
		expect(result.body.navigate).toEqual({
			type: "navigate",
			target: { settings: "interface" },
		});
		expect(result.body.toast).toBe("moved");
	});

	test("a throwing instanceKey answers 500 surface_failed and the extension stays loaded", async () => {
		const { app, aliceToken } = await server();
		// The panel fixture has no instanceKey of its own; force the throw
		// via a params shape the DEFAULT key cannot take? No — the deferred
		// minor is def.instanceKey throwing. The fixture has none; install
		// one on the loaded def through the opened bindings.
		const binding = (
			await server()
		).opened.extensionSurfaces.find(
			(entry) => entry.extension === "fixture-surfaces",
		);
		const def = binding?.defs.find((entry) => entry.id === "board");
		if (def === undefined) throw new Error("fixture def missing");
		const original = def.instanceKey;
		def.instanceKey = (): string => {
			throw new Error("acme instanceKey boom");
		};
		try {
			const result = await postAction(app, aliceToken, "move", {
				params: { board: "acme-throw" },
			});
			expect(result.status).toBe(500);
			expect(result.body.error).toBe("surface_failed");
			// The extension stays loaded: the render route still answers.
			const render = await call(app, {
				method: "GET",
				url: "/v1/ext/fixture-surfaces/surfaces/stats",
				token: aliceToken,
			});
			expect(render.status).toBe(200);
		} finally {
			def.instanceKey = original;
		}
	});

	test("a reject passes through unchanged (no rev)", async () => {
		const { app, aliceToken } = await server();
		actionResults.move = { ok: false, error: { message: "acme says no" } };
		const result = await postAction(app, aliceToken, "move", {
			params: { board: "acme-reject" },
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ ok: false, error: { message: "acme says no" } });
	});

	test("a second principal's actions rate-limit independently", async () => {
		const { app, aliceToken, bobToken } = await server();
		const params = { board: "acme-rate-two" };
		// The warm POST runs BEFORE the limiter is re-enabled: the
		// earlier 429 test's per-server buckets still hold spent tokens
		// (no bucket reset seam — the shared server is the constraint).
		const warm = await postAction(app, aliceToken, "move", { params });
		expect(warm.status).toBe(200);
		app.surfaces.setRateLimitDisabled(false);
		try {
		for (let i = 0; i < 40; i += 1) {
			await postAction(app, aliceToken, "move", { params, actionId: `a-${i}` });
		}
		// Alice is exhausted; bob still has a full bucket on the same surface.
		const aliceNext = await postAction(app, aliceToken, "move", {
			params,
			actionId: "a-40",
		});
		expect(aliceNext.status).toBe(429);
		const bobNext = await postAction(app, bobToken, "move", {
			params,
			actionId: "b-0",
		});
		expect(bobNext.status).toBe(200);
		} finally {
			app.surfaces.setRateLimitDisabled(true);
		}
	});
});
