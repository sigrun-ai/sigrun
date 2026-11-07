/**
 * Blocked-task visibility (D5): the admin API.
 *
 * `GET /v1/admin/tasks?state=blocked` lists blocked tasks from
 * `harness.inspect()` (id, kind, reason, conversationId, owner/extension
 * where known — owner is the conversation's SessionMeta.owner).
 * Admin-only (403 forbidden for non-admins).
 *
 * pi-durable 1.5.0 removed `task_parked`/`retryTask`, and with them the
 * `POST /v1/admin/tasks/:id/retry` route and its tests; the replacement
 * recovery surface is Task 4's `POST /v1/jobs/:id/resume` (covered by
 * test/jobs-restart-limit.test.ts + test/jobs-api.test.ts). The
 * park-era crash-loop rig (`bootParkedRig`) is deleted — its successor
 * lives in jobs-restart-limit.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineTask,
} from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { createFakeClock } from "./helpers/fake-clock.js";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A short real-time beat for async settling. */
async function beat(ms = 25): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds (fail-loud bound, real time). */
async function until<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	description: string,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (predicate(value)) return value;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${description}`);
		}
		await beat();
	}
}

/**
 * A non-parked blocked fixture: a schedule-kind task whose only phase
 * sleeps durably until far in the future. A SLEEPING record has no live
 * invocation, so once its definition is unregistered (and the sleep is
 * DUE — the listing test's fake clock) the scheduler's blocked reason
 * is `missing_task`.
 */
function sleepingScheduleTask() {
	return defineTask<{ jobId: string; hash: string }, { phase: "sleep" }, void, object>({
		name: "sigrun.schedule",
		version: 1,
		initial: () => ({ phase: "sleep" }),
		phases: {
			sleep: async (_task, runtime, context) => {
				await runtime.sleepUntil(Date.now() + 3_600_000, { phase: "sleep" }, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal" as const,
					outcome: { status: "aborted" as const, reason: "test cleanup" },
				}),
				context,
			);
		},
	});
}

/** A token-method boot with a non-admin user alongside the admin seed. */
async function bootTokenServer(): Promise<{
	app: FastifyInstance;
	plebToken: string;
	adminToken: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-admin-tasks-auth-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
	});
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
		isolationProbe: async () => ({
			available: true,
			abi: 6,
			helper: "/usr/local/lib/sigrun/sigrun-sandbox",
		}),
	});
	const app = await createServer(opened, config, [], {
		env: {},
		listenHost: "127.0.0.1",
	});
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	await opened.identity.users.add({ user: "pleb", admin: false, source: "cli" });
	const { token: plebToken } = await opened.identity.tokens.create("pleb-cli", "pleb");
	const { token: adminToken } = await opened.identity.tokens.create("tester-cli", "tester");
	return { app, plebToken, adminToken };
}

describe("admin task API auth", () => {
	test("a non-admin token gets 403 on the list", async () => {
		const { app, plebToken } = await bootTokenServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/admin/tasks?state=blocked",
			headers: { authorization: `Bearer ${plebToken}` },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
	});

});

describe("GET /v1/admin/tasks?state=blocked", () => {
	test("a non-blocked state filter gets 400 invalid_field", async () => {
		const { app, adminToken } = await bootTokenServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/admin/tasks?state=running",
			headers: { authorization: `Bearer ${adminToken}` },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_field", field: "state" });
	});

	test(
		"200 with the row shape {id, kind, reason, conversationId, owner?, extension?}",
		{ timeout: 60_000 },
		async () => {
			// The missing_task fixture: a sleeping task whose definition is
			// unregistered once its sleep is DUE — the scheduler blocks it
			// missing_task. The fake clock makes the sleep due without a
			// real-time wait (the park-era rig's exact mechanism).
			const dir = await mkdtemp(join(tmpdir(), "sigrun-admin-tasks-200-"));
			const faux = fauxProvider({
				provider: "faux",
				models: [{ id: "m", contextWindow: 128_000 }],
			});
			faux.setResponses([fauxAssistantMessage("ok")]);
			const config = loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_AUTH: "token",
				SIGRUN_WORKSPACE_PATH: dir,
			});
			const identity = await seededIdentity(dir);
			const clock = createFakeClock(Date.now());
			const opened = await openHarness(config, {
				identity,
				extensions: [
					{
						name: "ext-faux",
						providers: [{ provider: faux.provider }],
					} satisfies ProviderContributor,
				],
				env: {},
				settingsDir: dir,
				now: clock.now,
				setTimer: clock.setTimer,
			});
			// Install the sleeping fixture under a test extension name (the
			// row's optional extension column resolves through the registry
			// while installed), create the task, and let it sleep.
			opened.registry.uninstall({ name: "sigrun.jobs" });
			opened.registry.install({ name: "sigrun.test.sleep", tasks: [sleepingScheduleTask()] });
			const app = await createServer(opened, config, [], {
				env: {},
				listenHost: "127.0.0.1",
			});
			cleanups.push(async () => {
				await app.close();
				await opened.harness.close(BACKGROUND_CONTEXT);
				await rm(dir, { recursive: true, force: true });
			});
			const { token: adminToken } = await opened.identity.tokens.create("tester-cli", "tester");
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const taskId = await opened.harness.commit(
				async (tx) =>
					await tx.createTask(
						sleepingScheduleTask(),
						{ jobId: "api:missing-job", hash: "missing-fixture" },
						{
							ownership: { kind: "conversation" },
							conversationId: root.id,
							background: true,
						},
					),
				BACKGROUND_CONTEXT,
			);
			await until(
				async () => await opened.harness.getTask(taskId, BACKGROUND_CONTEXT),
				(task) => task?.state.status === "sleeping",
				"the sleeping fixture to sleep",
			);
			// Make the sleep DUE without firing its timer (set, not advance):
			// only a DUE, uninvoked record falls through to the registry fit
			// (blocked: missing_task).
			const sleeping = await opened.harness.getTask(taskId, BACKGROUND_CONTEXT);
			if (sleeping?.state.status !== "sleeping") throw new Error("fixture: task not sleeping");
			clock.set(sleeping.state.until + 1_000);
			// Unregister the definition: the due task's blocked reason becomes
			// missing_task (the registry no longer holds its kind).
			opened.registry.uninstall({ name: "sigrun.test.sleep" });
			await until(
				async () =>
					(await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
						(candidate) => String(candidate.record.id) === String(taskId),
					)?.state,
				(state) => state?.kind === "blocked" && state.reason === "missing_task",
				"the task to block missing_task",
			);
			const response = await app.inject({
				method: "GET",
				url: "/v1/admin/tasks?state=blocked",
				headers: { authorization: `Bearer ${adminToken}` },
			});
			expect(response.statusCode).toBe(200);
			const tasks = response.json().tasks;
			expect(Array.isArray(tasks)).toBe(true);
			const row = tasks.find(
				(candidate: { id: number }) => String(candidate.id) === String(taskId),
			);
			expect(row).toBeDefined();
			expect(typeof row.id).toBe("number");
			expect(row.kind).toBe("sigrun.schedule");
			expect(row.reason).toBe("missing_task");
			expect(typeof row.conversationId).toBe("number");
			// Owner comes from the root conversation's SessionMeta when set
			// (none here); the extension column resolves through the
			// installed registry — the fixture was uninstalled above, so
			// both optional halves are omitted.
			expect(row.owner).toBeUndefined();
			expect(row.extension).toBeUndefined();
		},
	);
});
