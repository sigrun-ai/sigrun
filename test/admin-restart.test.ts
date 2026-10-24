/**
 * UI-blocks U4 Task 2 (spec §13.3): the admin restart route and the
 * supervised posture.
 *
 * `POST /v1/admin/restart` (admin-only): graceful shutdown then exit 0
 * — offered ONLY when the server knows something will start it again
 * (`server.supervised`: env `SIGRUN_SUPERVISED` over the file's
 * `server.supervised`, default false). The Helm chart and docker
 * compose set the env (they restart the container); the Dockerfile
 * deliberately does NOT (a bare `docker run` would stay down).
 *
 * Non-admin → 403; unsupervised → 409 `not_supervised` (nothing runs);
 * supervised admin → 202 `{restarting: true}` and the restart callback
 * fires on a later tick (the response flushes before the drain begins).
 * `/v1/meta` reports the posture (`supervised`).
 *
 * Review Focus 4 (the durability guarantee): a run in flight at restart
 * has its submission DURABLE before the process exits, so a fresh
 * harness on the same database resumes it — the restart path runs the
 * same graceful shutdown the signal path runs.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { startGateway } from "../src/server/gateway.js";
import { createServer } from "../src/server/index.js";
import { createShutdown } from "../src/server/shutdown.js";
import { seededIdentity } from "./helpers/identity.js";
import type { SettingsFile } from "@sigrun/shared/settings";

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly restartCalls: number;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot a harness + server with a STUBBED restart callback (the route
 * must never call `process.exit` in tests — the seam is injected, and
 * the deploy entry owns the real exit). `env` entries join the boot env
 * (and therefore `loadConfig` — SIGRUN_SUPERVISED resolves there).
 */
async function bootServer(
	env: Record<string, string> = {},
	opts: { onRestart?: () => Promise<void> | void } = {},
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-admin-restart-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const bootEnv = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		...env,
	};
	const config = loadConfig(bootEnv);
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		settingsDir: dir,
	});
	const server: TestServer = {
		app: undefined as unknown as FastifyInstance,
		opened,
		dir,
		restartCalls: 0,
	};
	const app = await createServer(opened, config, [], {
		env: bootEnv,
		listenHost: "127.0.0.1",
		onRestart: async () => {
			(server as { restartCalls: number }).restartCalls += 1;
			await opts.onRestart?.();
		},
	});
	(server as { app: FastifyInstance }).app = app;
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return server;
}

/** A token-method boot with a non-admin user (`pleb`) alongside the
 *  admin seed (`tester`) — the 403 gate needs a real principal. */
async function bootTokenServer(): Promise<{
	app: FastifyInstance;
	plebToken: string;
	adminToken: string;
}> {
	const { app, opened } = await bootServer({ SIGRUN_AUTH: "token" });
	await opened.identity.users.add({
		user: "pleb",
		admin: false,
		source: "cli",
	});
	const { token: plebToken } = await opened.identity.tokens.create(
		"pleb-cli",
		"pleb",
	);
	const { token: adminToken } = await opened.identity.tokens.create(
		"tester-cli",
		"tester",
	);
	return { app, plebToken, adminToken };
}

/** Flush the deferred restart task (the route schedules it post-reply). */
async function flushRestart(): Promise<void> {
	for (let i = 0; i < 20; i += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("POST /v1/admin/restart", () => {
	test("a non-admin token gets 403 and no restart runs", async () => {
		const { app, plebToken } = await bootTokenServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/admin/restart",
			headers: { authorization: `Bearer ${plebToken}` },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
	});

	test("an unsupervised admin gets 409 not_supervised and no restart runs", async () => {
		const server = await bootServer();
		const response = await server.app.inject({
			method: "POST",
			url: "/v1/admin/restart",
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "not_supervised" });
		await flushRestart();
		expect(server.restartCalls).toBe(0);
	});

	test("a supervised admin gets 202 and the restart callback runs after the reply", async () => {
		const server = await bootServer({ SIGRUN_SUPERVISED: "1" });
		const response = await server.app.inject({
			method: "POST",
			url: "/v1/admin/restart",
		});
		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({ restarting: true });
		// Deferred: the response must have been answered BEFORE the drain
		// begins (a synchronous drain would never let the 202 out).
		await flushRestart();
		expect(server.restartCalls).toBe(1);
	});

	test("a supervised non-admin still gets 403 (the gates stack: auth first)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-admin-gate-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const bootEnv = {
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "token",
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_SUPERVISED: "1",
		};
		const config = loadConfig(bootEnv);
		const opened = await openHarness(config, {
			identity: await seededIdentity(dir),
			extensions: [
				{
					name: "ext-faux",
					providers: [{ provider: faux.provider }],
				} satisfies ProviderContributor,
			],
			env: {},
			settingsDir: dir,
		});
		let restartCalls = 0;
		const app = await createServer(opened, config, [], {
			env: bootEnv,
			listenHost: "127.0.0.1",
			onRestart: () => {
				restartCalls += 1;
			},
		});
		cleanups.push(async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		});
		await opened.identity.users.add({
			user: "pleb",
			admin: false,
			source: "cli",
		});
		const { token: plebToken } = await opened.identity.tokens.create(
			"pleb-cli",
			"pleb",
		);
		const response = await app.inject({
			method: "POST",
			url: "/v1/admin/restart",
			headers: { authorization: `Bearer ${plebToken}` },
		});
		expect(response.statusCode).toBe(403);
		await flushRestart();
		expect(restartCalls).toBe(0);
	});

	test("the file's server.supervised also enables the route (env over file, default false)", () => {
		const bootEnv = {
			SIGRUN_DEFAULT_MODEL: "faux/m",
		};
		const file: SettingsFile = { server: { supervised: true } };
		const config = loadConfig(bootEnv, file);
		expect(config.supervised).toBe(true);
		// Env wins over the file: SIGRUN_SUPERVISED=false pins it off.
		const configOff = loadConfig(
			{ ...bootEnv, SIGRUN_SUPERVISED: "false" },
			file,
		);
		expect(configOff.supervised).toBe(false);
		// The default is OFF (a bare process has no restart policy).
		expect(loadConfig(bootEnv).supervised).toBe(false);
	});

	test("SIGRUN_SUPERVISED is strict — an unrecognized value fails loud", () => {
		expect(() =>
			loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_SUPERVISED: "yes",
			}),
		).toThrowError(/SIGRUN_SUPERVISED/);
	});

	test("a supervised restart without a wired callback throws (never a silent no-op)", async () => {
		// Boot the harness directly (the bootServer helper always wires
		// the seam; this test is about a hand-built server that forgot
		// it) and build the app WITHOUT onRestart.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-admin-noseam-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const bootEnv = {
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_SUPERVISED: "1",
		};
		const config = loadConfig(bootEnv);
		const opened = await openHarness(config, {
			identity: await seededIdentity(dir),
			extensions: [
				{
					name: "ext-faux",
					providers: [{ provider: faux.provider }],
				} satisfies ProviderContributor,
			],
			env: {},
			settingsDir: dir,
		});
		cleanups.push(async () => {
			await opened.harness.close(BACKGROUND_CONTEXT);
		});
		const bare = await createServer(opened, config, [], {
			env: bootEnv,
			listenHost: "127.0.0.1",
		});
		cleanups.push(() => bare.close());
		const response = await bare.inject({
			method: "POST",
			url: "/v1/admin/restart",
		});
		// Loud: the boot-composition error surfaces as a 500, and nothing
		// was scheduled (the route throws before setImmediate).
		expect(response.statusCode).toBe(500);
		expect(
			(response.json() as { message?: string }).message ?? "",
		).toContain("no restart callback wired");
	});
});

describe("GET /v1/meta supervised", () => {
	test("reports supervised: false by default", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(200);
		expect((response.json() as { supervised: boolean }).supervised).toBe(
			false,
		);
	});

	test("reports supervised: true when SIGRUN_SUPERVISED=1", async () => {
		const { app } = await bootServer({ SIGRUN_SUPERVISED: "1" });
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect((response.json() as { supervised: boolean }).supervised).toBe(
			true,
		);
	});
});

describe("restart durability (Review Focus 4)", () => {
	test("a run in flight at restart has its submission durable; a fresh harness resumes it", { timeout: 30_000 }, async () => {
		// The streaming run: the faux provider emits tokens slowly (4/s),
		// so the run is still in flight when the restart callback's
		// graceful shutdown runs. `process.exit` is STUBBED — the fresh
		// harness below stands in for the restarted process.
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
			tokensPerSecond: 4,
		});
		faux.setResponses([
			fauxAssistantMessage(
				"a long slow answer that keeps the run streaming through the restart",
			),
		]);
		const dir = await mkdtemp(join(tmpdir(), "sigrun-admin-durable-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const dbPath = join(dir, "sigrun.db");
		const bootEnv = {
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: dbPath,
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_SUPERVISED: "1",
		};
		const config = loadConfig(bootEnv);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const opened = await openHarness(config, {
			identity: await seededIdentity(dir),
			extensions: [contributor],
			env: {},
			settingsDir: dir,
			// The durability contract this test pins: shutdown does NOT
			// wait out the streaming run — it cuts at the durable boundary
			// so the fresh process resumes it. The default 10 s live-run
			// wait would outlast the test's macro-task flush budget.
			eventBus: { shutdownSettleWaitMs: 50 },
		});
		// The restart callback runs the REAL ordered shutdown — the
		// serve composition's `createShutdown` over this app+harness
		// (SSE end, app drain, gateway intake close, the event-bus
		// sequence, refresh stop, harness close) — not a hand-rolled
		// two-step close (the route defers it past the 202 reply).
		const gateway = startGateway(opened);
		let shutdown: (() => Promise<void>) | undefined;
		const exitStub = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		// The restart task's promise, so the durability leg can await the
		// graceful shutdown instead of relying on a macrotask flush count.
		let resolveRestart: () => void = () => {};
		const restartTask = new Promise<void>((resolve) => {
			resolveRestart = resolve;
		});
		const app = await createServer(opened, config, [], {
			env: bootEnv,
			listenHost: "127.0.0.1",
			onRestart: async () => {
				await shutdown?.();
				resolveRestart();
			},
		});
		try {
			// The run: a real submission through the HTTP surface so the
			// admission is exactly the deploy path's.
			const submission = await app.inject({
				method: "POST",
				url: "/v1/conversations/1/submissions",
				payload: { input: "stream through the restart" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);
			// Restart mid-stream: 202, then the deferred graceful shutdown
			// drains the run to a durable boundary and "exits".
			shutdown = async () => {
				const ordered = createShutdown({
					endStreams: () => app.sse.endAll(),
					closeApp: () => app.close(),
					gateway,
					eventBusShutdown: () =>
						opened.eventBus.shutdownSequence(BACKGROUND_CONTEXT),
					stopProviderRefresh: async () => {
						opened.stopProviderRefresh();
						await opened.bootRefresh.catch(() => {});
					},
					closeHarness: () => opened.harness.close(BACKGROUND_CONTEXT),
				});
				await ordered();
				exitStub(0);
			};
			const restart = await app.inject({
				method: "POST",
				url: "/v1/admin/restart",
			});
			expect(restart.statusCode).toBe(202);
			// The shutdown's live-run settle wait is real-time (default 10 s;
			// pinned to 50 ms at this boot) — flushRestart's macrotask budget
			// cannot cover it, so await the restart task itself before the
			// exit assertion. The route defers the graceful shutdown past
			// the 202; restartTask resolves when exitStub(0) has run.
			await restartTask;
			expect(exitStub).toHaveBeenCalledWith(0);
			// The fresh harness on the SAME database: resume picks the run
			// up — the submission survives the restart and the answer lands.
			// A SECOND response is queued: the first run's generation was
			// cut mid-stream at the durable boundary (the shutdown's
			// settle wait is far shorter than the 17 s stream), so the
			// faux queue is empty — the resumed run needs an answer to
			// emit. (The real-world analog: the model re-generates on
			// resume.)
			faux.setResponses([
				fauxAssistantMessage(
					"a long slow answer that keeps the run streaming through the restart",
				),
			]);
			const reopened = await openHarness(config, {
				identity: await seededIdentity(dir),
				extensions: [contributor],
				env: {},
				settingsDir: dir,
			});
			cleanups.push(async () => {
				await reopened.harness.close(BACKGROUND_CONTEXT);
			});
			const conversationId = 1 as ConversationId;
			const conversation = await reopened.harness.conversation(
				conversationId,
				BACKGROUND_CONTEXT,
			);
			expect(conversation).toBeDefined();
			// The durability assertion: scan the conversation's durable
			// entries — the pre-restart admission's user input is stored
			// (the submission survives the exit; the resume assertion
			// below covers the reply).
			const entries = await reopened.storage.scanEntries(
				{ conversationId, order: "ascending" },
				200,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const text = JSON.stringify(entries.items);
			expect(text).toContain("stream through the restart");
			// The RESUME half of the guarantee: the reopened harness's
			// conversation view carries a post-restart ASSISTANT entry —
			// the durable submission was picked back up and answered, not
			// merely stored. The view polls briefly: the resumed run's
			// answer commits asynchronously after the harness opens.
			const handle = await reopened.harness.conversation(
				conversationId,
				BACKGROUND_CONTEXT,
			);
			expect(handle).toBeDefined();
			if (handle === undefined) {
				throw new Error("reopened harness lost the conversation");
			}
			const answerDeadline = Date.now() + 15_000;
			let answered = false;
			while (Date.now() < answerDeadline) {
				const state = await handle.viewState(BACKGROUND_CONTEXT);
				const viewText = state.value.entries
					.map((e) => JSON.stringify(e))
					.join("\n");
				await state.dispose();
				if (
					viewText.includes(
						"a long slow answer that keeps the run streaming through the restart",
					)
				) {
					answered = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(answered).toBe(true);
		} finally {
			exitStub.mockRestore();
		}
	});
});
