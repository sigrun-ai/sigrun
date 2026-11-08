import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineTask,
	LiveDoc,
	type Conversation,
	type ConversationId,
	type TaskId,
} from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	JobRunDoc,
	readJob,
	writeJobChange,
} from "../src/jobs/docs.js";
import { specHash } from "../src/jobs/spec.js";
import { sweepOrphanedRuns } from "../src/jobs/sweep.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { createFakeClock } from "./helpers/fake-clock.js";
import { seededIdentity } from "./helpers/identity.js";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const OLD_FIRE_AT = new Date(NOW - 10 * 60_000).toISOString();
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface TestRig {
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
	readonly conversation: Conversation;
}

async function bootRig(responses = [fauxAssistantMessage("acme answer")]): Promise<TestRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-sweep-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...responses]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ builtinExtensions: { curator: false } }),
		"utf8",
	);
	const identity = await seededIdentity(dir);
	const clock = createFakeClock(NOW);
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env: {},
		settingsDir: dir,
		now: clock.now,
		setTimer: clock.setTimer,
	});
	const conversation = await opened.harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: { model: opened.defaultModel },
	}, BACKGROUND_CONTEXT);
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, faux, conversation };
}

function jobSpec(task = "acme.test.target"): JobSpec {
	return {
		name: "acme-sweep",
		schedule: { every: "60s" },
		action: { kind: "task", task },
	};
}

async function seedJob(rig: TestRig, id: string, spec = jobSpec()): Promise<void> {
	const nowIso = new Date(NOW).toISOString();
	await rig.opened.harness.commit(async (tx) => {
		await writeJobChange(tx, id, {
			source: "api",
			spec,
			owner: "tester",
			enabled: true,
			createdAt: nowIso,
			hash: specHash(id, spec),
			state: "waiting",
		}, "tester", nowIso);
	}, BACKGROUND_CONTEXT);
}

async function seedRun(
	rig: TestRig,
	id: string,
	options: {
		readonly conversationId?: number;
		readonly taskId?: TaskId;
		readonly fireAt?: string;
	} = {},
): Promise<string> {
	const fireAt = options.fireAt ?? OLD_FIRE_AT;
	const key = `${id}:${Date.parse(fireAt)}`;
	await rig.opened.harness.commit(async (tx) => {
		await tx.doc(JobRunDoc, key, {
			jobId: id,
			version: 1,
			fireAt,
			manual: false,
			outcome: "running",
			startedAt: fireAt,
			...(options.conversationId === undefined
				? {}
				: { conversationId: options.conversationId }),
			...(options.taskId === undefined
				? {}
				: { taskId: options.taskId as unknown as number }),
		});
	}, BACKGROUND_CONTEXT);
	return key;
}

async function settleOnce(rig: TestRig): Promise<number> {
	return await sweepOrphanedRuns({
		harness: rig.opened.harness,
		storage: rig.opened.storage,
		settings: () => ({}),
		now: () => NOW,
	}, BACKGROUND_CONTEXT);
}

async function markJobOwned(rig: TestRig, id: string, conversationId: number): Promise<void> {
	await rig.opened.harness.commit(async (tx) => {
		const meta = await tx.doc(SessionMetaDoc, conversationId as ConversationId);
		meta.jobId = id;
	}, BACKGROUND_CONTEXT);
}

async function taskFixture(rig: TestRig, terminal: boolean): Promise<TaskId> {
	const name = terminal ? "acme.test.terminal" : "acme.test.live";
	const target = defineTask<Record<string, never>, { phase: "run" }, void, object>({
		name,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, context) => {
				if (terminal) {
					await runtime.commit(() => ({
						status: "terminal" as const,
						outcome: { status: "completed" as const, result: undefined },
					}), context);
					return;
				}
				await runtime.sleepUntil(NOW + 60_000, { phase: "run" }, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({
				status: "terminal" as const,
				outcome: { status: "aborted" as const },
			}), context);
		},
	});
	rig.opened.registry.install({ name, tasks: [target] });
	return await rig.opened.harness.commit(async (tx) => await tx.createTask(target, {}, {
		ownership: { kind: "conversation" },
		conversationId: rig.conversation.id,
		background: true,
	}), BACKGROUND_CONTEXT);
}

describe("the orphaned job run sweep", () => {
	test("a run whose submission is done settles succeeded", async () => {
		const rig = await bootRig();
		const id = "api:acme-done";
		await seedJob(rig, id);
		const key = `${id}:${Date.parse(OLD_FIRE_AT)}`;
		const submission = await rig.conversation.submit({
			type: "input",
			content: "acme completed before the observer ran",
			requestId: `job:${key}`,
		}, BACKGROUND_CONTEXT);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await seedRun(rig, id, { conversationId: rig.conversation.id as number });

		expect(await settleOnce(rig)).toBe(1);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "succeeded",
			settledAt: new Date(NOW).toISOString(),
		});
	});

	test("a run whose submission is unanswered settles failed with its reason", async () => {
		const rig = await bootRig();
		const id = "api:acme-unanswered";
		await seedJob(rig, id);
		const key = `${id}:${Date.parse(OLD_FIRE_AT)}`;
		const submission = await rig.conversation.submit({
			type: "input",
			content: "acme aborted before the observer ran",
			requestId: `job:${key}`,
		}, BACKGROUND_CONTEXT);
		await rig.conversation.abort(BACKGROUND_CONTEXT);
		expect(await submission.wait(BACKGROUND_CONTEXT)).toMatchObject({
			status: "unanswered",
			reason: "aborted",
		});
		await seedRun(rig, id, { conversationId: rig.conversation.id as number });

		expect(await settleOnce(rig)).toBe(1);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "failed",
			error: "aborted",
		});
	});

	test("an old running run with no submission settles orphaned", async () => {
		const rig = await bootRig();
		const id = "api:acme-no-submission";
		await seedJob(rig, id);
		const conversationId = rig.conversation.id as number;
		await markJobOwned(rig, id, conversationId);
		const key = await seedRun(rig, id, { conversationId });

		expect(await settleOnce(rig)).toBe(1);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "failed",
			error: "orphaned",
		});
		expect((await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT))?.lastRun).toMatchObject({
			outcome: "failed",
			error: "orphaned",
		});
		expect(await rig.opened.harness.snapshot(
			SessionMetaDoc,
			conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		)).toMatchObject({ jobOutcome: "failed" });
	});

	test("a run whose conversation is missing settles orphaned", async () => {
		const rig = await bootRig();
		const id = "api:acme-missing-conversation";
		await seedJob(rig, id);
		const key = await seedRun(rig, id, { conversationId: 987_654 });

		expect(await settleOnce(rig)).toBe(1);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "failed",
			error: "orphaned",
		});
	});

	test("fresh running run is left alone", async () => {
		const rig = await bootRig();
		const id = "api:acme-fresh";
		await seedJob(rig, id);
		const fireAt = new Date(NOW - 60_000).toISOString();
		const key = await seedRun(rig, id, {
			conversationId: rig.conversation.id as number,
			fireAt,
		});

		expect(await settleOnce(rig)).toBe(0);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "running",
		});
	});

	test("queued submission is left alone", async () => {
		const rig = await bootRig();
		const id = "api:acme-queued";
		await seedJob(rig, id);
		const key = await seedRun(rig, id, { conversationId: rig.conversation.id as number });
		await rig.opened.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, rig.conversation.id);
			live.run = { taskId: 999_999 as TaskId, inputs: [], turns: 0 };
		}, BACKGROUND_CONTEXT);
		await rig.conversation.submit({
			type: "input",
			content: "acme queued for a later run",
			requestId: `job:${key}`,
		}, BACKGROUND_CONTEXT);

		expect(await settleOnce(rig)).toBe(0);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "running",
		});
	});

	test("a task run whose task is terminal settles orphaned", async () => {
		const rig = await bootRig();
		const id = "api:acme-task-terminal";
		await seedJob(rig, id);
		const taskId = await taskFixture(rig, true);
		const key = await seedRun(rig, id, { taskId });
		// The ordinary task observer has already settled by the time the
		// sweep could run; retain only the sweep's outcome assertion.
		expect((await rig.opened.harness.getTask(taskId, BACKGROUND_CONTEXT))?.state.status)
			.toBe("terminal");

		expect(await settleOnce(rig)).toBe(1);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "failed",
			error: "orphaned",
		});
	});

	test("a task run whose task is live is left alone", async () => {
		const rig = await bootRig();
		const id = "api:acme-task-live";
		await seedJob(rig, id);
		const taskId = await taskFixture(rig, false);
		const key = await seedRun(rig, id, { taskId });

		expect(await settleOnce(rig)).toBe(0);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "running",
		});
	});

	test("the sweep is idempotent", async () => {
		const rig = await bootRig();
		const id = "api:acme-idempotent";
		await seedJob(rig, id);
		const key = await seedRun(rig, id, { conversationId: 987_654 });

		expect(await settleOnce(rig)).toBe(1);
		expect(await settleOnce(rig)).toBe(0);
		expect(await rig.opened.harness.snapshot(JobRunDoc, key, BACKGROUND_CONTEXT)).toMatchObject({
			outcome: "failed",
			error: "orphaned",
		});
	});
});
