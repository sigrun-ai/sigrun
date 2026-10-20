/**
 * Jobs Task 2 battery driver (plan Task 2, battery scenarios a/b/c):
 * kill -9 across the fire path of a `conversation:"new"` prompt job —
 * restart → EXACTLY ONE run conversation and ONE submission per slot.
 *
 * Marker protocol (see test/battery/lib.ts + drivers/lib.ts):
 * - setup: boot, seed the job record, create the schedule task with the
 *   job's fireAt FAR IN THE FUTURE so the task parks at its `waiting`
 *   checkpoint, then print `WAITING` (kill point a). `setup-created`
 *   creates the task with firstAt overdue and prints
 *   `CONVERSATION_CREATED:<id>` the instant the run record's
 *   conversationId is durable (the run record is written ATOMICALLY
 *   inside the run conversation's creating commit — the init callback).
 *   `setup-before` creates NO task (kill point c: the verify pass creates
 *   it after the restart).
 * - verify: reopen the same storage, resume, drive the fire (for
 *   `setup-before`, create the task first), and assert: exactly one run
 *   conversation (`SessionMeta.source:"cron"` + `jobId`), exactly one
 *   submission with requestId `job:<jobId>:<fireAt>`, exactly one run
 *   record for the fire key, and the job record's `lastRun` matching.
 *
 * The fire instant rides the scenario file (`fireAt`), so the setup and
 * verify passes agree on the fire key — determinism across processes.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import { specHash } from "../../../src/jobs/spec.js";
import { createScheduleTask } from "../../../src/jobs/task.js";
import { JobDoc, JobRunDoc, writeJobChange } from "../../../src/jobs/docs.js";
import { SessionMetaDoc } from "../../../src/server/session-meta.js";
import {
	bootScenarioHarness,
	marker,
	verifyFailed,
	verified,
} from "./lib.js";

/** The battery job: an every-minute prompt job, conversation "new". */
const JOB_ID = "api:battery-job";
const SPEC = {
	name: "battery-tick",
	schedule: { every: "60s" },
	action: { kind: "prompt", prompt: "say tick", conversation: "new" },
} as const;

interface JobScenario {
	readonly jobId: string;
	/** The slot the setup pass pinned (the fire key's `<fireAt>`). */
	readonly fireAt: number;
	readonly hash: string;
	readonly taskId?: string | number;
}

async function readJobState(dir: string): Promise<JobScenario> {
	return JSON.parse(
		await readFile(join(dir, "job-scenario.json"), "utf8"),
	) as JobScenario;
}

async function writeJobState(dir: string, state: JobScenario): Promise<void> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(join(dir, "job-scenario.json"), JSON.stringify(state));
}

/** The deps every pass builds over its own opened harness (real clock). */
function depsOf(opened: Awaited<ReturnType<typeof bootScenarioHarness>>) {
	return {
		harness: opened.harness,
		models: opened.models,
		defaultModel: opened.defaultModel as ModelRef,
		now: () => Date.now(),
		defaultTz: "UTC",
	};
}

async function main(): Promise<never> {
	const mode = process.argv[2];
	const dir = process.argv[3];
	if (
		dir === undefined ||
		(mode !== "setup-waiting" &&
			mode !== "setup-created" &&
			mode !== "setup-before" &&
			mode !== "verify")
	) {
		process.stderr.write(
			"usage: tsx job-fire.ts <setup-waiting|setup-created|setup-before|verify> <dir>\n",
		);
		process.exit(2);
	}

	if (mode === "verify") {
		const state = await readJobState(dir);
		const fireKey = `${state.jobId}:${state.fireAt}`;
		const opened = await bootScenarioHarness(dir, [
			fauxAssistantMessage("tick"),
		]);
		const deps = depsOf(opened);
		opened.registry.install({
			name: "sigrun.jobs",
			tasks: [createScheduleTask(deps)],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: deps.defaultModel },
		});
		// setup-before killed before the task existed: create it now, with
		// the pinned fireAt overdue so the resumed task fires once.
		if (state.taskId === undefined) {
			await opened.harness.commit(
				async (tx) =>
					await tx.createTask(
						createScheduleTask(deps),
						{ jobId: state.jobId, hash: state.hash, firstAt: state.fireAt },
						{
							ownership: { kind: "conversation" },
							conversationId: root.id,
							background: true,
						},
					),
				BACKGROUND_CONTEXT,
			);
		}
		// The reopened scheduler resumes the task; it re-enters firing (or
		// waiting with an overdue nextAt) and fires. Wait for the run
		// record to appear AND the fire's submission to settle, bounded.
		const deadline = Date.now() + 45_000;
		interface JobRunValue {
			jobId: string;
			version: number;
			fireAt: string;
			manual: boolean;
			conversationId?: number;
			outcome: string;
		}
		let run: JobRunValue | undefined;
		for (;;) {
			run = (await opened.harness.snapshot(
				JobRunDoc,
				fireKey,
				BACKGROUND_CONTEXT,
			)) as JobRunValue | undefined;
			if (run !== undefined && run.conversationId !== undefined) {
				// The run conversation exists; wait for the fire's submission
				// to settle (the run record's outcome moves at settle — Task
				// 3's observer — but the battery's assertion is the
				// conversation/submission, so settle the submission).
				const submissions = await opened.storage.scanSubmissions(
					{ conversationId: run.conversationId as never },
					50,
					undefined,
					BACKGROUND_CONTEXT,
				);
				const matched = submissions.items.filter(
					(s) => s.requestId === `job:${fireKey}`,
				);
				if (matched.length === 1 && matched[0]!.status === "done") break;
			}
			if (Date.now() > deadline) {
				return verifyFailed(
					`the run record for ${fireKey} never landed/settled (run=${JSON.stringify(run)})`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (run === undefined) return verifyFailed("run record absent after fire");
		if (run.jobId !== JOB_ID) return verifyFailed(`jobId ${run.jobId}`);
		if (run.manual) return verifyFailed("manual fire leaked");
		if (run.conversationId === undefined) {
			return verifyFailed("no run conversation was created");
		}
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			run.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		if (meta?.source !== "cron") {
			return verifyFailed(`run conversation source=${String(meta?.source)}`);
		}
		if ((meta as Record<string, unknown> | undefined)?.jobId !== JOB_ID) {
			return verifyFailed("run conversation jobId missing");
		}
		const submissions = await opened.storage.scanSubmissions(
			{ conversationId: run.conversationId as never },
			50,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const matched = submissions.items.filter(
			(s) => s.requestId === `job:${fireKey}`,
		);
		if (matched.length !== 1) {
			return verifyFailed(
				`expected exactly one submission with requestId job:${fireKey}, found ${matched.length}`,
			);
		}
		if (matched[0]!.status !== "done") {
			return verifyFailed(`the fire's submission is ${matched[0]!.status}`);
		}
		const record = (await opened.harness.snapshot(
			JobDoc,
			JOB_ID,
			BACKGROUND_CONTEXT,
		)) as { lastRun?: { conversationId?: number } } | undefined;
		if (record?.lastRun?.conversationId !== run.conversationId) {
			return verifyFailed("the job record's lastRun does not match the run");
		}
		await opened.harness.close(BACKGROUND_CONTEXT);
		return verified({
			outcome: run.outcome,
			conversationId: run.conversationId,
			requestId: matched[0]!.requestId,
			submissions: matched.length,
		});
	}

	// ---- setup passes -----------------------------------------------------
	const opened = await bootScenarioHarness(dir, [
		fauxAssistantMessage("tick"),
	]);
	const deps = depsOf(opened);
	opened.registry.install({
		name: "sigrun.jobs",
		tasks: [createScheduleTask(deps)],
	});
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: deps.defaultModel },
	});
	const hash = specHash(JOB_ID, SPEC as never);
	const nowIso = new Date().toISOString();
	await opened.harness.commit(async (tx) => {
		await writeJobChange(
			tx,
			JOB_ID,
			{
				source: "api",
				spec: SPEC as never,
				owner: "tester",
				enabled: true,
				createdAt: nowIso,
				hash,
				state: "waiting",
			},
			"tester",
			nowIso,
		);
	}, BACKGROUND_CONTEXT);

	if (mode === "setup-before") {
		// Kill point (c): NO task created — the kill lands before any fire
		// machinery exists. The verify pass creates the task itself. The
		// scenario file (the pinned fireAt) must be durable BEFORE READY:
		// the test kills right after READY and the verify pass reads it.
		await writeJobState(dir, {
			jobId: JOB_ID,
			fireAt: Date.now() - 1_000,
			hash,
		});
		marker("READY");
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	marker("READY");

	if (mode === "setup-waiting") {
		// Kill point (a): the task parks at its `waiting` checkpoint with
		// nextAt FAR in the future (the kill lands during the durable
		// sleep); the verify pass resumes and fires exactly once.
		const fireAt = Date.now() - 1_000; // overdue: the resumed task fires
		const taskId = await opened.harness.commit(
			async (tx) =>
				await tx.createTask(
					createScheduleTask(deps),
					{ jobId: JOB_ID, hash, firstAt: fireAt },
					{
						ownership: { kind: "conversation" },
						conversationId: root.id,
						background: true,
					},
				),
			BACKGROUND_CONTEXT,
		);
		await writeJobState(dir, { jobId: JOB_ID, fireAt, hash, taskId: taskId as number });
		// The task's first waiting phase sleeps on the overdue nextAt,
		// which returns IMMEDIATELY, so the fire lands in THIS process
		// unless we kill before it. But the marker must guarantee the
		// task is at its waiting checkpoint before the kill. Poll the
		// task record's checkpoint.
		const deadline = Date.now() + 20_000;
		for (;;) {
			const record = await opened.harness.getTask(taskId, BACKGROUND_CONTEXT);
			const checkpoint = record?.state.checkpoint as
				| { phase: string; nextAt?: number }
				| undefined;
			if (record !== undefined && checkpoint?.phase === "waiting") break;
			if (Date.now() > deadline) {
				return verifyFailed(
					`the task never reached its waiting checkpoint (state=${JSON.stringify(record?.state)})`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		marker("WAITING");
		setInterval(() => {}, 1_000);
		return new Promise<never>(() => {});
	}

	// setup-created: kill point (b) — the task fires in THIS process; the
	// marker lands the instant the run conversation is durable (the run
	// record's conversationId, written atomically in the creating
	// commit's init). The kill then lands between the conversation and
	// the submission; the verify pass's resumed task re-enters firing,
	// reuses the run record, and the requestId dedups the re-submission.
	const fireAt = Date.now() - 1_000;
	const taskId = await opened.harness.commit(
		async (tx) =>
			await tx.createTask(
				createScheduleTask(deps),
				{ jobId: JOB_ID, hash, firstAt: fireAt },
				{
					ownership: { kind: "conversation" },
					conversationId: root.id,
					background: true,
				},
			),
		BACKGROUND_CONTEXT,
	);
	await writeJobState(dir, { jobId: JOB_ID, fireAt, hash, taskId: taskId as number });
	const observeDeadline = Date.now() + 30_000;
	for (;;) {
		const record = (await opened.harness.snapshot(
			JobDoc,
			JOB_ID,
			BACKGROUND_CONTEXT,
		)) as { lastRun?: { conversationId?: number } } | undefined;
		if (record?.lastRun !== undefined && record.lastRun !== null) {
			marker(`CONVERSATION_CREATED:${String(record.lastRun.conversationId)}`);
			break;
		}
		if (Date.now() > observeDeadline) {
			return verifyFailed("the fire never landed before the kill deadline");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	setInterval(() => {}, 1_000);
	return new Promise<never>(() => {});
}

main().catch((error) => {
	process.stderr.write(`driver crashed: ${String(error)}\n`);
	process.exit(1);
});
