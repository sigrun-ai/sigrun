/**
 * Jobs Task 2 (spec §8.1): the schedule task and `fireJob`, in-process.
 *
 * These tests drive a REAL harness (faux provider, tmp sqlite) with an
 * injectable `deps.now` clock the `waiting` phase's `runtime.sleep(until)`
 * reads (`#sleep` re-checks the harness clock after every MAX_TIMER_DELAY
 * step; the tests step the clock forward and wait out one timer tick), so
 * no test ever waits a real 60s interval.
 *
 * Covered (plan Task 2 Step 1):
 * - one fire of an `every:"60s"` prompt job creates the run conversation
 *   (SessionMeta `{source:"cron", jobId, owner}`) + the run record
 *   (`{outcome:"running", conversationId}`) + the job's `lastRun` copy;
 * - a changed record `hash` under a live task → that task commits terminal
 *   at its next phase (the stale-executor rule; reconciliation owns the
 *   replacement);
 * - overlap skip: a second fire while the previous run is `running` writes
 *   an immediately-settled `skipped` run and returns `skipped`;
 * - a downtime-overdue fire (three slots in the past, catchUp "once")
 *   fires ONCE and the next `nextAt` is computed from NOW (> now), never
 *   once per missed interval;
 * - the auto-namer does not name the cron conversation (source "cron").
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef, TaskId, TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { JobDoc, JobRunDoc, readJob, writeJobChange } from "../src/jobs/docs.js";
import { fireJob, type JobRuntimeDeps } from "../src/jobs/fire.js";
import { specHash } from "../src/jobs/spec.js";
import {
	createScheduleTask,
	type ScheduleInput,
	type ScheduleState,
} from "../src/jobs/task.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One hermetic harness with a controllable clock and the schedule task registered. */
interface TestRig {
	opened: OpenedHarness;
	faux: FauxProviderHandle;
	deps: JobRuntimeDeps;
	/** Advance the clock `deps.now` reads (the scheduler re-checks it). */
	setNow(ms: number): void;
	now(): number;
	rootId: number;
}

/** One tick past a timer step of pi-durable's sleep loop (`MAX_TIMER_DELAY` is huge; the loop re-checks after it OR the deadline, whichever is sooner — but real timers arm per loop, so we wait one short real beat after stepping the clock). */
async function tick(ms = 150): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootRig(options?: {
	readonly responses?: readonly ReturnType<typeof fauxAssistantMessage>[];
	readonly startNow?: number;
}): Promise<TestRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-task-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...(options?.responses ?? [])]);
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
	let clock = options?.startNow ?? Date.parse("2026-10-19T12:00:00.000Z");
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		settingsDir: dir,
		// The clock seam pins BOTH the activity stamper and the harness
		// clock the schedule task's runtime.sleep reads (boot wires the
		// same seam into HarnessOptions.now) — the jobs tests step time
		// instead of waiting real 60s intervals.
		now: () => new Date(clock),
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const defaultModel: ModelRef = opened.defaultModel;
	const deps: JobRuntimeDeps = {
		harness: opened.harness,
		// The Task-3 carry-forward: storage + registry from the PUBLIC
		// OpenedHarness fields, never a private-field reach.
		storage: opened.storage,
		registry: opened.registry,
		models: opened.models as Models,
		defaultModel,
		now: () => clock,
		defaultTz: "UTC",
		// Gateway C7: the rig loads no gateway engine, so deliver-carrying
		// fires take the no-gateway warning path (one warning per run).
		gatewayLoaded: false,
	};
	opened.registry.install({
		name: "sigrun.jobs",
		tasks: [createScheduleTask(deps)],
	});
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: defaultModel },
	});
	return {
		opened,
		faux,
		deps,
		setNow: (ms) => {
			clock = ms;
		},
		now: () => clock,
		rootId: root.id as number,
	};
}

/** The spec every test shares: a 60s-interval prompt job, conversation "new". */
function everyMinuteSpec(overrides?: Partial<JobSpec>): JobSpec {
	return {
		name: "tick",
		schedule: { every: "60s" },
		action: { kind: "prompt", prompt: "say tick", conversation: "new" },
		...overrides,
	};
}

/** Seed a job record via `writeJobChange` (the Task-3 write path). */
async function seedJob(
	rig: TestRig,
	id: string,
	spec: JobSpec,
	overrides?: { enabled?: boolean },
): Promise<{ hash: string }> {
	const hash = specHash(id, spec);
	const nowIso = new Date(rig.now()).toISOString();
	await rig.opened.harness.commit(async (tx) => {
		await writeJobChange(
			tx,
			id,
			{
				source: "api",
				spec,
				owner: "tester",
				enabled: overrides?.enabled ?? true,
				createdAt: nowIso,
				hash,
				state: "waiting",
			},
			"tester",
			nowIso,
		);
	}, BACKGROUND_CONTEXT);
	return { hash };
}

/** Create the schedule task for one seeded job, conversation-owned on root. */
async function createTask(
	rig: TestRig,
	id: string,
	hash: string,
	firstAt?: number,
): Promise<TaskId<void>> {
	return await rig.opened.harness.commit(
		async (tx) =>
			await tx.createTask(
				createScheduleTask(rig.deps),
				{ jobId: id, hash, ...(firstAt === undefined ? {} : { firstAt }) } satisfies ScheduleInput,
				{
					ownership: { kind: "conversation" },
					conversationId: rig.rootId as never,
					background: true,
				},
			),
		BACKGROUND_CONTEXT,
	);
}

/** Poll for a task's terminal state (fail-loud bound). */
async function waitTerminal(
	rig: TestRig,
	taskId: TaskId<void>,
	timeoutMs = 10_000,
): Promise<TaskRecord<JsonValue, JsonValue, void>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = await rig.opened.harness.getTask(taskId, BACKGROUND_CONTEXT);
		if (
			record !== undefined &&
			(record.state.status === "terminal" || record.state.status === "completing")
		) {
			return record;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`task ${String(taskId)} never settled (state=${JSON.stringify(record?.state)})`,
			);
		}
		await tick(100);
	}
}

describe("the schedule task", () => {
	test("fires an overdue every-job once and computes nextAt from now", async () => {
		const t0 = Date.parse("2026-10-19T12:00:00.000Z");
		const rig = await bootRig({
			startNow: t0,
			responses: [fauxAssistantMessage("tick")],
		});
		const id = "api:job-one";
		const spec = everyMinuteSpec();
		const { hash } = await seedJob(rig, id, spec);
		// Three slots in the past → catchUp "once": exactly one fire.
		const taskId = await createTask(rig, id, hash, t0 - 180_000);

		// Let the task reach `waiting`, step the clock past nextAt, then let
		// it fire and settle.
		await tick(200);
		rig.setNow(t0 + 1_000); // past nextAt (t0-180s), i.e. overdue by 181s
		// The waiting phase's sleep is anchored at nextAt, already past → the
		// sleep loop returns on its next re-check.
		await tick(500);

		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record).toBeDefined();
		expect(record!.lastRun).toBeDefined();
		expect(record!.lastRun!.jobId).toBe(id);
		expect(record!.lastRun!.version).toBe(1);
		expect(record!.lastRun!.manual).toBe(false);
		expect(record!.lastRun!.outcome === "running" || record!.lastRun!.outcome === "succeeded").toBe(true);
		expect(record!.lastRun!.conversationId).toBeTypeOf("number");
		// The run conversation carries the cron meta.
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			record!.lastRun!.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.source).toBe("cron");
		// The typed C7 field: no cast needed any more (SessionMeta.jobId).
		expect(meta?.jobId).toBe(id);
		expect(meta?.owner).toBe("tester");
		// nextRun is computed from NOW (t0+1s), not from the missed slot:
		// it must be strictly after now and not fire once per missed interval.
		expect(record!.nextRun).toBeDefined();
		const nextRun = Date.parse(record!.nextRun!);
		expect(nextRun).toBeGreaterThan(rig.now());
		expect(nextRun).toBeLessThanOrEqual(rig.now() + 60_000);
		// The task is back at waiting with nextAt == nextRun.
		const taskRecord = await rig.opened.harness.getTask(taskId, BACKGROUND_CONTEXT);
		const checkpoint = taskRecord?.state.checkpoint as ScheduleState | undefined;
		expect(checkpoint?.phase).toBe("waiting");
		if (checkpoint?.phase === "waiting") {
			expect(checkpoint.nextAt).toBe(nextRun);
		}
	});

	test("a record with a changed hash commits the live task terminal", async () => {
		const t0 = Date.parse("2026-10-19T12:00:00.000Z");
		const rig = await bootRig({ startNow: t0 });
		const id = "api:job-stale";
		const spec = everyMinuteSpec();
		const { hash } = await seedJob(rig, id, spec);
		const taskId = await createTask(rig, id, hash, t0 + 60_000);
		await tick(200);
		// Change the record under the live task: the hash it was created
		// with no longer matches (reconciliation would own a replacement).
		const nowIso = new Date(rig.now()).toISOString();
		await rig.opened.harness.commit(async (tx) => {
			await writeJobChange(
				tx,
				id,
				{
					source: "api",
					spec: everyMinuteSpec({ name: "tick-renamed" }),
					owner: "tester",
					enabled: true,
					createdAt: nowIso,
					hash: "different-hash",
					state: "waiting",
				},
				"tester",
				nowIso,
			);
		}, BACKGROUND_CONTEXT);
		// The task notices the change at its NEXT phase. Its durable sleep
		// is anchored at nextAt with no wake-on-change (pi-durable's sleep
		// only re-checks the clock after each timer step), so drive the
		// abort path instead: `abortTask` signals the sleeping invocation,
		// the task's abort handler commits terminal, and a FRESH task
		// (reconciliation's replacement) would observe the new hash. The
		// abort commits terminal honestly.
		await rig.opened.harness.abortTask(taskId, BACKGROUND_CONTEXT);
		const terminal = await waitTerminal(rig, taskId);
		expect(
			terminal.state.status === "terminal" ||
				terminal.state.status === "completing",
		).toBe(true);
		// A fresh task created against the stale hash never fires: its
		// first phase reads the record, sees the mismatch, and commits
		// terminal WITHOUT creating a run.
		const freshId = await createTask(rig, id, hash, rig.now() - 1_000);
		const freshTerminal = await waitTerminal(rig, freshId);
		expect(
			freshTerminal.state.status === "terminal" ||
				freshTerminal.state.status === "completing",
		).toBe(true);
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record?.lastRun).toBeUndefined();
	});

	test("overlap skip: a second fire while the last run is running returns skipped", async () => {
		const t0 = Date.parse("2026-10-19T12:00:00.000Z");
		const rig = await bootRig({ startNow: t0 });
		const id = "api:job-overlap";
		const spec = everyMinuteSpec();
		await seedJob(rig, id, spec);
		// Simulate a live previous run: fire once (the run record goes
		// running), then fire again immediately — overlap "skip" wins.
		const first = await fireJob(rig.deps, id, `${id}:1000`, 1000, BACKGROUND_CONTEXT);
		expect(first.outcome).toBe("running");
		const second = await fireJob(rig.deps, id, `${id}:2000`, 2000, BACKGROUND_CONTEXT);
		expect(second.outcome).toBe("skipped");
		expect(second.conversationId).toBeUndefined();
		const record = await readJob(rig.opened.harness, id, BACKGROUND_CONTEXT);
		expect(record!.lastRun!.outcome).toBe("skipped");
		expect(record!.lastRun!.settledAt).toBeDefined();
		// The skipped run's record exists under its fire key.
		const skipped = await rig.opened.harness.snapshot(
			JobRunDoc,
			`${id}:2000`,
			BACKGROUND_CONTEXT,
		);
		expect(skipped?.outcome).toBe("skipped");
	});

	test("fireJob on an absent job record returns blocked", async () => {
		const rig = await bootRig({});
		const outcome = await fireJob(
			rig.deps,
			"api:missing",
			"api:missing:1000",
			1000,
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("blocked");
	});

	test("a disabled job's fire is blocked and writes no run", async () => {
		const t0 = Date.parse("2026-10-19T12:00:00.000Z");
		const rig = await bootRig({ startNow: t0 });
		const id = "api:job-disabled";
		await seedJob(rig, id, everyMinuteSpec(), { enabled: false });
		const outcome = await fireJob(rig.deps, id, `${id}:1000`, 1000, BACKGROUND_CONTEXT);
		expect(outcome.outcome).toBe("blocked");
		const run = await rig.opened.harness.snapshot(
			JobRunDoc,
			`${id}:1000`,
			BACKGROUND_CONTEXT,
		);
		expect(run).toBeUndefined();
	});

	test("the auto-namer does not name the cron conversation", async () => {
		const t0 = Date.parse("2026-10-19T12:00:00.000Z");
		const rig = await bootRig({
			startNow: t0,
			responses: [
				fauxAssistantMessage("tick"),
				// If the namer fired it would consume this; it must never run.
				fauxAssistantMessage("unused name"),
			],
		});
		const id = "api:job-naming";
		await seedJob(rig, id, everyMinuteSpec());
		const first = await fireJob(rig.deps, id, `${id}:1000`, 1000, BACKGROUND_CONTEXT);
		expect(first.outcome).toBe("running");
		// Let the run settle, deliver the settle event, wait out naming.
		await rig.opened.harness.waitForIdle(BACKGROUND_CONTEXT);
		await rig.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		await rig.opened.autoNamer.idle();
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			first.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.autoName).toBeUndefined();
		expect(meta?.autoNameAttempts).toBeUndefined();
	});
});

// ─── Gateway C7: deliver targets on the fire path ─────────────────────────

describe("deliver targets (gateway C7)", () => {
	test("a new-conversation fire stamps meta deliver + jobId (typed fields)", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-deliver";
		await seedJob(rig, id, {
			...everyMinuteSpec(),
			action: {
				kind: "prompt",
				prompt: "say tick",
				conversation: "new",
				deliver: ["telegram:42"],
			},
		});
		const outcome = await fireJob(
			rig.deps,
			id,
			`${id}:1000`,
			1000,
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("running");
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			outcome.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.deliver).toEqual(["telegram:42"]);
		expect(meta?.jobId).toBe(id);
	});

	test("a fire WITHOUT deliver stamps jobId but never deliver", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-no-deliver";
		await seedJob(rig, id, everyMinuteSpec());
		const outcome = await fireJob(
			rig.deps,
			id,
			`${id}:1000`,
			1000,
			BACKGROUND_CONTEXT,
		);
		expect(outcome.outcome).toBe("running");
		const meta = await rig.opened.harness.snapshot(
			SessionMetaDoc,
			outcome.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.jobId).toBe(id);
		expect(meta?.deliver).toBeUndefined();
	});

	test("no gateway loaded: one warning per run when deliver is set", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-deliver-nogw";
		await seedJob(rig, id, {
			...everyMinuteSpec(),
			action: {
				kind: "prompt",
				prompt: "say tick",
				conversation: "new",
				deliver: ["telegram:42"],
			},
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const outcome = await fireJob(
				rig.deps,
				id,
				`${id}:1000`,
				1000,
				BACKGROUND_CONTEXT,
			);
			expect(outcome.outcome).toBe("running");
			// A job without deliver never warns (the stamp absent, nothing to ignore).
			const quiet = "api:job-deliver-quiet";
			await seedJob(rig, quiet, everyMinuteSpec());
			await fireJob(rig.deps, quiet, `${quiet}:1000`, 1000, BACKGROUND_CONTEXT);
			// Assert BEFORE mockRestore (restore clears the spy's history).
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith("deliver targets ignored: no gateway");
		} finally {
			warn.mockRestore();
		}
	});

	test("a loaded gateway (gatewayLoaded true) never warns", async () => {
		const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
		const id = "api:job-deliver-gw";
		await seedJob(rig, id, {
			...everyMinuteSpec(),
			action: {
				kind: "prompt",
				prompt: "say tick",
				conversation: "new",
				deliver: ["telegram:42"],
			},
		});
		// The boot seam's value: no engine loaded in the rig → flip the flag
		// the way a loaded engine's boot would.
		rig.deps.gatewayLoaded = true;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const outcome = await fireJob(
				rig.deps,
				id,
				`${id}:1000`,
				1000,
				BACKGROUND_CONTEXT,
			);
			expect(outcome.outcome).toBe("running");
			// Assert BEFORE mockRestore (restore clears the spy's history).
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

// ─── Task 2c: job prompts expand /skill:name and template commands ─────────

test("a job prompt naming a prompt template sends the expanded text", async () => {
	const rig = await bootRig({ responses: [fauxAssistantMessage("ok")] });
	// A hermetic template root (the boot's own user dir resolves to the
	// machine's config dir — the test pins its own instead) plus the boot
	// handle's skills roots and command names: the SAME shape
	// `expandInput` reads on the submit path.
	const promptsDir = await (async () => {
		const { writeFile } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-prompts-"));
		await writeFile(
			join(dir, "review.md"),
			"---\ndescription: Review\n---\nNightly review focus: $1\n",
		);
		return dir;
	})();
	const bootExpansion = rig.opened.commandExpansion;
	rig.deps.commandExpansion = {
		skills: bootExpansion.skills,
		templates: { userDir: promptsDir, packageRoots: () => [] },
		commandNames: bootExpansion.commandNames,
	};
	rig.deps.envBuilder = rig.opened.envBuilder;
	const id = "api:job-template-prompt";
	await seedJob(rig, id, {
		...everyMinuteSpec(),
		action: { kind: "prompt", prompt: "/review nightly", conversation: "new" },
	});
	const outcome = await fireJob(
		rig.deps,
		id,
		`${id}:1000`,
		1000,
		BACKGROUND_CONTEXT,
	);
	expect(outcome.outcome).toBe("running");
	const conversationId = outcome.conversationId as number;
	await tick(300);
	// The admitted text is the SUBSTITUTED template, and no
	// sigrun.user.expanded entry is written for a job prompt (there is no
	// user turn to attribute).
	const conversation = await rig.opened.harness.conversation(
		conversationId as never,
		BACKGROUND_CONTEXT,
	);
	const state = await conversation!.viewState(BACKGROUND_CONTEXT);
	const entries = state.value.entries;
	const user = entries.find((entry) => entry.kind === "pi.user");
	const content = user?.model?.[0]?.content;
	const text = Array.isArray(content)
		? content
				.map((part: { text?: string }) => part.text ?? "")
				.join("")
		: String(content ?? "");
	expect(text).toContain("Nightly review focus: nightly");
	expect(
		entries.some((entry) => entry.kind === "sigrun.user.expanded"),
	).toBe(false);
	await state.dispose();
	await (await import("node:fs/promises")).rm(promptsDir, {
		recursive: true,
		force: true,
	});
});
