/**
 * pi-durable 1.4.0 parked-task recovery (D5 / Task B6): the admin API.
 *
 * `GET /v1/admin/tasks?state=blocked` lists blocked tasks from
 * `harness.inspect()` (id, kind, reason, conversationId, owner/extension
 * where known — owner is the conversation's SessionMeta.owner).
 * `POST /v1/admin/tasks/:id/retry` checks inspect() FIRST (pi-durable's
 * `retryTask` rejects an unknown id but silently no-ops on a task that
 * isn't parked): 404 unknown_task, 409 not_parked unless blocked with
 * reason restart_limit, else retryTask → 204 and the task runs again.
 * Both endpoints are admin-only (403 forbidden for non-admins).
 *
 * The park fixture is B5's abandoned-harness crash-loop simulation
 * lifted to the openHarness level (B5 review guidance): a schedule-kind
 * task whose phase waits on a never-resolving promise leaves its record
 * `running` on every abandoned boot; each reopen counts one restart;
 * the fifth reopen parks it DURING open (and the boot's applyParkedJobs
 * patches the job record). The retry then re-runs the same waiting
 * phase — observable as the task leaving `blocked`.
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
	type TaskId,
} from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { JobDoc, readJob, type JobRecord } from "../src/jobs/docs.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { createServer } from "../src/server/index.js";
import { createFakeClock, type FakeClock } from "./helpers/fake-clock.js";
import { seededIdentity } from "./helpers/identity.js";
import type { IdentityStores } from "../src/harness/identity/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const EVERY_MINUTE: JobSpec = {
	name: "park-fixture",
	schedule: { every: "60s" },
	action: { kind: "prompt", prompt: "unused", conversation: "new" },
};

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
 * The park-fixture task: a schedule-KIND task (so the boot's
 * applyParkedJobs patches the owning job) whose only phase never
 * resolves — every abandoned boot leaves the record `running`.
 * Installed as the replacement core jobs extension (same extension name
 * and task kind), so the list route resolves its owner as `sigrun.jobs`.
 */
function waitingScheduleTask() {
	return defineTask<{ jobId: string; hash: string }, { phase: "wait" }, void, object>({
		name: "sigrun.schedule",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			// Never resolves on its own (each abandoned boot leaves the
			// record `running`); the runtime signal ends the invocation so a
			// CLEAN close/abort in test teardown can join it. Abandoned
			// boots never signal — the crash-loop simulation is intact.
			wait: async (_task, runtime) =>
				await new Promise<void>((resolve) => {
					if (runtime.signal.aborted) return resolve();
					runtime.signal.addEventListener("abort", () => resolve(), { once: true });
				}),
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

const TEST_JOBS_EXTENSION = { name: "sigrun.jobs", tasks: [waitingScheduleTask()] };

/**
 * A non-parked blocked fixture: a schedule-kind task whose only phase
 * sleeps durably until far in the future. A SLEEPING record has no live
 * invocation, so once its definition is unregistered the scheduler's
 * blocked reason is `missing_task` (a restart-PARKED record would keep
 * `restart_limit` — pi-durable checks the park before the registry fit,
 * which is why this case cannot reuse the parked task).
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

interface ParkRig {
	readonly dir: string;
	readonly config: SigrunConfig;
	readonly identity: IdentityStores;
	readonly contributor: ProviderContributor;
	readonly clock: FakeClock;
	opened: OpenedHarness;
	app: FastifyInstance;
	/** The parked schedule task's id (set once the first boot created it). */
	taskId: TaskId<void>;
}

/**
 * Boot a real openHarness + server over `rig`'s storage. The waiting
 * schedule task is installed into the live registry AFTER boot (the
 * scheduler reads registry snapshots dynamically, so the definition is
 * present before the task is created — and removable for the
 * missing_task case).
 */
async function boot(rig: ParkRig): Promise<void> {
	const opened = await openHarness(rig.config, {
		identity: rig.identity,
		extensions: [rig.contributor],
		env: {},
		settingsDir: rig.dir,
		// The fake harness clock (BOTH seams — jobs-task's rig pattern):
		// the missing_task case must make a sleeping task DUE without a
		// real-time wait, and only an injected clock can do that.
		now: rig.clock.now,
		setTimer: rig.clock.setTimer,
	});
	rig.opened = opened;
	// Replace the core jobs extension's `sigrun.schedule` definition with
	// the waiting fixture: the task KIND stays `sigrun.schedule` (so the
	// boot's applyParkedJobs patches the owning job), but the phase never
	// resolves — the crash-loop simulation. The uninstall-by-name drops
	// the core definition; the fixture re-installs the same extension name
	// and task kind with the waiting phase.
	opened.registry.uninstall({ name: "sigrun.jobs" });
	opened.registry.install(TEST_JOBS_EXTENSION);
	rig.app = await createServer(opened, rig.config, [], {
		env: {},
		listenHost: "127.0.0.1",
	});
}

/** Abandon a boot WITHOUT closing the harness: the waiting phase's
 *  never-resolving promise leaves the task record `running`, which is
 *  what counts a restart on the next open. The HTTP app is closed (its
 *  SSE/interval resources are process-local). */
async function abandon(rig: ParkRig): Promise<void> {
	await rig.app.close();
	// Deliberately no harness.close() — the crash-loop simulation.
}

async function closeRig(rig: ParkRig): Promise<void> {
	await rig.app.close();
	await rig.opened.harness.close(BACKGROUND_CONTEXT);
	await rm(rig.dir, { recursive: true, force: true });
}

/**
 * Build the parked state through real openHarness boots: the first
 * boot creates the job + task (job state `waiting` — the pre-patch
 * causality pin), four abandoned reopens, and the final boot parks it
 * (restart_limit) with the job record patched to blocked by the boot's
 * applyParkedJobs.
 */
async function bootParkedRig(): Promise<ParkRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-admin-tasks-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const rig = {
		dir,
		clock: createFakeClock(Date.now()),
		config: loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
		}),
		identity: await seededIdentity(dir),
		contributor: {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		} satisfies ProviderContributor,
	} as unknown as ParkRig;
	cleanups.push(() => closeRig(rig));

	await boot(rig);
	const root = await rig.opened.harness.root(BACKGROUND_CONTEXT);
	const record: JobRecord = {
		source: "api",
		spec: EVERY_MINUTE,
		owner: "tester",
		enabled: true,
		createdAt: "2026-10-28T00:00:00.000Z",
		hash: "park-fixture",
		state: "waiting",
		version: 1,
		updatedAt: "2026-10-28T00:00:00.000Z",
	};
	await rig.opened.harness.commit(async (tx) => {
		await tx.doc(JobDoc, "api:parked-job", record);
	}, BACKGROUND_CONTEXT);
	// The input carries the record's hash: the boot reconcile treats a
	// hash-mismatched (or hashless) live task as stale and aborts it,
	// which would fault the fixture instead of parking it.
	rig.taskId = await rig.opened.harness.commit(
		async (tx) =>
			await tx.createTask(
				waitingScheduleTask(),
				{ jobId: "api:parked-job", hash: "park-fixture" },
				{
					ownership: { kind: "conversation" },
					conversationId: root.id,
					background: true,
				},
			),
		BACKGROUND_CONTEXT,
	);
	// The pre-patch state pin: before any park the job shows waiting.
	expect(await readJob(rig.opened.harness, "api:parked-job", BACKGROUND_CONTEXT)).toMatchObject({
		state: "waiting",
	});
	await until(
		async () => await rig.opened.harness.getTask(rig.taskId, BACKGROUND_CONTEXT),
		(task) => task?.state.status === "running",
		"the first task invocation to run",
	);

	// Four abandoned reopens: restart counts 1..4 run again.
	for (let open = 2; open <= 5; open += 1) {
		await abandon(rig);
		await boot(rig);
		await until(
			async () => await rig.opened.harness.getTask(rig.taskId, BACKGROUND_CONTEXT),
			(task) => task?.state.status === "running",
			`open ${open} to run the task`,
		);
	}
	// The sixth open (creation + five reopens) reaches restart limit 5:
	// the task parks DURING Harness.open, and the boot's applyParkedJobs
	// patches the job record before openHarness returns.
	await abandon(rig);
	await boot(rig);
	const inspection = await rig.opened.harness.inspect(BACKGROUND_CONTEXT);
	const parked = inspection.tasks.find(
		(candidate) => String(candidate.record.id) === String(rig.taskId),
	);
	expect(parked?.state).toMatchObject({ kind: "blocked", reason: "restart_limit" });
	return rig;
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

	test("a non-admin token gets 403 on retry", async () => {
		const { app, plebToken } = await bootTokenServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/admin/tasks/1/retry",
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

	test("lists the parked task with its kind, reason, conversation and owner, and the job shows blocked", { timeout: 30_000 }, async () => {
		const rig = await bootParkedRig();
		// The owner seam: stamp the root conversation's SessionMeta with an
		// owner (the auth hook does this at create in a real deploy).
		const root = await rig.opened.harness.root(BACKGROUND_CONTEXT);
		await root.commit(async (tx) => {
			const draft = await tx.doc(SessionMetaDoc, root.id);
			draft.owner = "tester";
		}, BACKGROUND_CONTEXT);

		const response = await rig.app.inject({
			method: "GET",
			url: "/v1/admin/tasks?state=blocked",
		});
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			tasks: Array<{
				id: number;
				kind: string;
				reason: string;
				conversationId: number;
				owner?: string;
				extension?: string;
			}>;
		};
		const parked = body.tasks.find((task) => String(task.id) === String(rig.taskId));
		expect(parked).toMatchObject({
			kind: "sigrun.schedule",
			reason: "restart_limit",
			conversationId: Number(root.id),
			owner: "tester",
			extension: "sigrun.jobs",
		});
		// The openHarness-level park path (B5 review): the SAME boot that
		// parked the task patched the job record through applyParkedJobs.
		expect(await readJob(rig.opened.harness, "api:parked-job", BACKGROUND_CONTEXT)).toMatchObject({
			state: "blocked",
			reason: "restart_limit",
		});
	});
});

describe("POST /v1/admin/tasks/:id/retry", () => {
	test("a parked task retries: 204 and it runs again (running)", { timeout: 30_000 }, async () => {
		const rig = await bootParkedRig();
		const response = await rig.app.inject({
			method: "POST",
			url: `/v1/admin/tasks/${String(rig.taskId)}/retry`,
		});
		expect(response.statusCode).toBe(204);
		// The retried task is RE-INVOKED, not merely unparked: its durable
		// status reaches running (the fixture phase then waits on the
		// runtime signal, so this state is deterministic).
		await until(
			async () => await rig.opened.harness.getTask(rig.taskId, BACKGROUND_CONTEXT),
			(task) => task?.state.status === "running",
			"the retried task to run again",
		);
	});

	test("an unknown id gets 404 unknown_task", { timeout: 30_000 }, async () => {
		const rig = await bootParkedRig();
		const response = await rig.app.inject({
			method: "POST",
			url: "/v1/admin/tasks/99999/retry",
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "unknown_task" });
	});

	test("a task blocked with a reason other than restart_limit gets 409 not_parked", { timeout: 30_000 }, async () => {
		const rig = await bootParkedRig();
		// Swap the waiting definition for the sleeping one and create a
		// fresh task: it sleeps durably (no live invocation).
		rig.opened.registry.uninstall(TEST_JOBS_EXTENSION);
		rig.opened.registry.install({ name: "sigrun.test.sleep", tasks: [sleepingScheduleTask()] });
		const root = await rig.opened.harness.root(BACKGROUND_CONTEXT);
		const sleepingId = await rig.opened.harness.commit(
			async (tx) =>
				await tx.createTask(
					sleepingScheduleTask(),
					{ jobId: "api:parked-job", hash: "park-fixture" },
					{
						ownership: { kind: "conversation" },
						conversationId: root.id,
						background: true,
					},
				),
			BACKGROUND_CONTEXT,
		);
		await until(
			async () => await rig.opened.harness.getTask(sleepingId, BACKGROUND_CONTEXT),
			(task) => task?.state.status === "sleeping",
			"the fresh task to sleep",
		);
		// Make the sleep DUE without firing its timer (set, not advance): the
		// scheduler's inspect shows a not-yet-due sleep as `sleeping` even
		// with no definition; only a DUE, uninvoked, unparked record falls
		// through to the registry fit (blocked: missing_task).
		const sleeping = await rig.opened.harness.getTask(sleepingId, BACKGROUND_CONTEXT);
		if (sleeping?.state.status !== "sleeping") throw new Error("fixture: task not sleeping");
		rig.clock.set(sleeping.state.until + 1_000);
		// Unregister the definition: the due task's blocked reason becomes
		// missing_task (the registry no longer holds its kind).
		rig.opened.registry.uninstall({ name: "sigrun.test.sleep" });
		await until(
			async () => await rig.opened.harness.inspect(BACKGROUND_CONTEXT),
			(inspection) => {
				const task = inspection.tasks.find(
					(candidate) => String(candidate.record.id) === String(sleepingId),
				);
				return task?.state.kind === "blocked" && task.state.reason === "missing_task";
			},
			"the task's blocked reason to become missing_task",
		);
		const response = await rig.app.inject({
			method: "POST",
			url: `/v1/admin/tasks/${String(sleepingId)}/retry`,
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "not_parked" });
	});

	test("a live (non-blocked) task gets 409 not_parked", { timeout: 30_000 }, async () => {
		const rig = await bootParkedRig();
		// A second, healthy task: created on this boot, running its
		// (never-resolving) phase — inspect shows it `running`.
		const root = await rig.opened.harness.root(BACKGROUND_CONTEXT);
		const liveId = await rig.opened.harness.commit(
			async (tx) =>
				await tx.createTask(
					waitingScheduleTask(),
					{ jobId: "api:parked-job", hash: "park-fixture" },
					{
						ownership: { kind: "conversation" },
						conversationId: root.id,
						background: true,
					},
				),
			BACKGROUND_CONTEXT,
		);
		await until(
			async () => await rig.opened.harness.getTask(liveId, BACKGROUND_CONTEXT),
			(task) => task?.state.status === "running",
			"the live task to run",
		);
		const response = await rig.app.inject({
			method: "POST",
			url: `/v1/admin/tasks/${String(liveId)}/retry`,
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "not_parked" });
	});
});
