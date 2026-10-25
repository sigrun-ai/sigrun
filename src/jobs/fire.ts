/**
 * Jobs Task 2 (spec §8.1 "The executor" + crash safety): `fireJob`.
 *
 * ONE fire path for the schedule task, run-now, and (Task 3+) external
 * triggers. The run record IS the fire's idempotency record: keyed
 * `<jobId>:<fireAt>` (scheduled) or `<jobId>:<manual ms>` (run-now), it
 * is written ATOMICALLY with the run's creation:
 *
 * - `conversation: "new"` prompt: inside the SAME commit that creates
 *   the run conversation (`harness.createConversation({…, init})` — the
 *   `init` callback runs in the creating commit). The conversation and
 *   its run record are atomic; a crash either lands both or neither.
 * - fixed-conversation prompt: the run record commits FIRST (its own
 *   `harness.commit`), then the task submits with
 *   `requestId = "job:" + fireKey`. On re-entry a present run record
 *   means "submitted or about to be", so the task submits again and the
 *   conversation-scoped requestId dedups.
 * - `task` action: the run record and `tx.createTask(…, {ownership:
 *   {kind:"task", taskId: <schedule task>}})` share ONE
 *   `runtime.commit`. The schedule task's `runtime` is threaded in for
 *   this branch only.
 *
 * Overlap: with the default `overlap: "skip"` and the job's `lastRun`
 * still `running`, the fire writes an immediately-settled `skipped` run
 * (plus the `lastRun` refresh) and returns — the skipped fire is visible
 * history, never a silent drop. `overlap: "queue"` admits anyway (the
 * conversation's inbox queues the input).
 *
 * Blocked: absent/disabled record, or a `task` action naming an
 * unregistered task (reason pinned by the plan) — `state: "blocked"` is
 * patched onto the record and no run is written.
 *
 * The run's TERMINAL outcome is settled elsewhere (the event-bus
 * `runSettled` observer for prompts, Task 3's task-settle observation for
 * task runs); `fireJob` returns once the fire is admitted.
 */

import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type {
	Conversation,
	ConversationId,
	Harness,
	ModelRef,
	Registry,
	Storage,
	TaskId,
	TaskRuntime,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { EnvBuilder } from "../harness/workspace.js";
import type { JobRunWire } from "@sigrun/shared/jobs";
import { parseModelSpec } from "../config.js";
import { expandInput } from "../commands/expand.js";
import type { CommandExpansion } from "../commands/expand.js";
import { SessionMetaDoc } from "../server/session-meta.js";
import { noteThen } from "../server/turns/submit-turn.js";
import { JobRunDoc, patchJob, readJob, type JobRecord } from "./docs.js";
import type { ScheduleInput, ScheduleState } from "./task.js";

/** What `fireJob` needs beyond the record it reads itself. */
export interface JobRuntimeDeps {
	harness: Harness;
	/** The storage handle — sigrun's boot-exposed instance (`OpenedHarness.storage`), threaded here instead of a private-field reach. */
	storage: Storage;
	/** The application-owned registry (`OpenedHarness.registry`) — the run-now task-action lookup's snapshot source. */
	registry: Registry;
	models: Models;
	defaultModel: ModelRef;
	/** Epoch ms — the injectable clock (tests pin it). */
	now(): number;
	/** Resolved `server.timezone` (default: the process TZ). */
	defaultTz: string;
	/**
	 * The command-expansion handle (Task 2c): a job prompt `/review
	 * nightly` sends the EXPANDED text — the same roots, the same live
	 * reads, as the submit path. No `typed`/`command` entry is written
	 * for job prompts (there is no user turn to attribute).
	 */
	commandExpansion?: CommandExpansion;
	/**
	 * The workspace env builder (boot's `envBuilder`) — required when
	 * `commandExpansion` is wired (the workspace template root reads
	 * through it, exactly like the submit op).
	 */
	envBuilder?: EnvBuilder;
	/**
	 * Whether a gateway engine loaded at boot (`OpenedHarness.gatewayEngine
	 * !== undefined`, gateway C7): a `deliver`-carrying fire with no
	 * engine warns once per run — the targets are stamped for a deliverer
	 * that does not exist, which must be visible, never silent.
	 */
	gatewayLoaded: boolean;
}

export interface FireResult {
	outcome: "running" | "skipped" | "blocked";
	conversationId?: number;
}

/**
 * Fire one job under `fireKey`. `fireAt` is the epoch ms the key pins
 * (the scheduled slot, or `deps.now()` for run-now). `runtime` is
 * present only when the schedule task drives the fire (the `task`
 * branch needs its commit line).
 */
export async function fireJob(
	deps: JobRuntimeDeps,
	id: string,
	fireKey: string,
	fireAt: number,
	context: Context,
	runtime?: TaskRuntime<ScheduleInput, ScheduleState, void, object>,
): Promise<FireResult> {
	const record = await readJob(deps.harness, id, context);
	if (record === undefined || !record.enabled) {
		return { outcome: "blocked" };
	}
	const action = record.spec.action;
	const manual = fireKey.slice(id.length + 1).startsWith("manual:");
	const startedAt = new Date(deps.now()).toISOString();
	const baseRun: JobRunWire = {
		jobId: id,
		version: record.version,
		fireAt: new Date(fireAt).toISOString(),
		manual,
		outcome: "running",
		startedAt,
	};

	// Idempotency: a present run record means this fire already ran (or
	// is running) — reuse its conversation/task and never double-create.
	const prior = await deps.harness.snapshot(JobRunDoc, fireKey, context);
	if (prior !== undefined) {
		if (prior.outcome === "skipped") return { outcome: "skipped" };
		if (prior.outcome !== "running") {
			// Already settled (succeeded/failed): the Task-3 re-entry fix —
			// a re-entered fire whose run record already settled reports
			// the SETTLED outcome, never "running" (a crash-recovered fire
			// re-entering after the observer settled must not re-admit).
			return {
				outcome: "blocked",
				...(prior.conversationId === undefined
					? {}
					: { conversationId: prior.conversationId }),
			};
		}
		// Still running: re-submit (the requestId dedups) or nothing (task
		// runs re-admit by re-creating with the same record — see below).
	}

	// Overlap: the previous run is still live.
	const last = record.lastRun;
	if (
		prior === undefined &&
		(record.spec.overlap ?? "skip") === "skip" &&
		last !== undefined &&
		last.outcome === "running"
	) {
		const skipped: JobRunWire = {
			...baseRun,
			outcome: "skipped",
			settledAt: startedAt,
		};
		await deps.harness.commit(async (tx) => {
			await tx.doc(JobRunDoc, fireKey, skipped);
		}, context);
		await patchJob(
			deps.harness,
			id,
			(draft) => {
				draft.lastRun = skipped;
			},
			context,
		);
		return { outcome: "skipped" };
	}

	if (action.kind === "prompt") {
		return await firePrompt(deps, id, record, fireKey, baseRun, prior, context);
	}
	return await fireTaskAction(
		deps,
		id,
		record,
		fireKey,
		baseRun,
		prior,
		context,
		runtime,
	);
}

/**
 * Expand a job prompt through the wired roots (Task 2c): a prompt
 * starting with `/` that names a skill or template becomes the expanded
 * text the model sees; anything else is returned verbatim. Expansion
 * errors (an unterminated quote) are LOUD — the fire fails rather than
 * admitting a half-parsed prompt.
 */
async function jobPromptText(
	deps: JobRuntimeDeps,
	conversationId: ConversationId,
	prompt: string,
	context: Context,
): Promise<string> {
	if (deps.commandExpansion === undefined || !prompt.startsWith("/")) {
		return prompt;
	}
	const conversation = await deps.harness.conversation(conversationId, context);
	if (conversation === undefined) return prompt;
	const env = await conversationEnv(deps, conversation);
	const expansion = await expandInput(
		[{ type: "text", text: prompt }],
		deps.commandExpansion,
		env,
		context,
	);
	const part = expansion.parts[0];
	return part !== undefined && part.type === "text" ? part.text : prompt;
}

/**
 * The conversation workspace env for a job's conversation — the same
 * `envBuilder` seam the harness and the submit op use (the expansion's
 * workspace template root reads through it).
 */
async function conversationEnv(
	deps: JobRuntimeDeps,
	conversation: Conversation,
): Promise<ExecutionEnv> {
	const builder = deps.envBuilder;
	if (builder === undefined) {
		throw new Error(
			"fireJob: no env builder wired (commandExpansion requires envBuilder)",
		);
	}
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	const built = await builder(
		{
			conversationId: conversation.id,
			...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
			read: deps.harness,
		},
		BACKGROUND_CONTEXT,
	);
	if (built === undefined) {
		throw new Error("envBuilder returned no ExecutionEnv");
	}
	return built;
}

// ---------------------------------------------------------------------------
// The prompt action
// ---------------------------------------------------------------------------

async function firePrompt(
	deps: JobRuntimeDeps,
	id: string,
	record: JobRecord,
	fireKey: string,
	baseRun: JobRunWire,
	prior: JobRunWire | undefined,
	context: Context,
): Promise<FireResult> {
	const action = record.spec.action;
	if (action.kind !== "prompt") throw new Error("unreachable");

	// Fixed conversation: the run record commits first, then the submit
	// (re-entry re-submits; the requestId dedups).
	if (action.conversation !== "new") {
		const conversationId = action.conversation;
		const conversation = await deps.harness.conversation(
			conversationId as ConversationId,
			context,
		);
		if (conversation === undefined) {
			return { outcome: "blocked" };
		}
		const run: JobRunWire = {
			...baseRun,
			conversationId,
		};
		if (prior === undefined) {
			await deps.harness.commit(async (tx) => {
				await tx.doc(JobRunDoc, fireKey, run);
			}, context);
			await patchJob(deps.harness, id, (draft) => {
				draft.lastRun = run;
			}, context);
		}
		const prompt = await jobPromptText(
			deps,
			conversationId as ConversationId,
			action.prompt,
			context,
		);
		await noteThen(
			deps.harness,
			conversation,
			() =>
				conversation.submit(
					{
						type: "input",
						content: [{ type: "text", text: prompt }],
						requestId: `job:${fireKey}`,
					},
					context,
				),
			context,
		);
		return { outcome: "running", conversationId };
	}

	// conversation: "new" — the run record + conversation in ONE commit.
	let conversationId: number | undefined = prior?.conversationId;
	if (conversationId === undefined) {
		// Gateway C7: the deliver targets need a deliverer. With no engine
		// loaded the stamped targets point at nothing — ONE warning per run
		// (the fire itself proceeds; the stamp stays for whoever reads it).
		if (action.deliver !== undefined && !deps.gatewayLoaded) {
			console.warn("deliver targets ignored: no gateway");
		}
		const model =
			action.model !== undefined
				? parseModelSpec(action.model, "job action model")
				: deps.defaultModel;
		const conversation = await deps.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model,
					...(action.thinking === undefined
						? {}
						: { thinkingLevel: action.thinking as never }),
				},
				init: async (tx, newId) => {
					const run: JobRunWire = {
						...baseRun,
						conversationId: newId as number,
					};
					await tx.doc(JobRunDoc, fireKey, run);
					const meta = await tx.doc(SessionMetaDoc, newId);
					meta.source = "cron";
					// Gateway C7: the job stamp — typed SessionMeta fields (the
					// pre-C7 cast is gone). Copy, never alias: the doc tracker
					// takes alias-free ownership of the array.
					meta.jobId = id;
					if (action.deliver !== undefined) meta.deliver = [...action.deliver];
					if (record.owner !== undefined) meta.owner = record.owner;
					if (action.runSharing !== undefined) meta.sharing = action.runSharing;
					meta.name = runName(record.spec.name, deps.now(), record, deps);
				},
			},
			context,
		);
		conversationId = conversation.id as number;
		const run: JobRunWire = { ...baseRun, conversationId };
		await patchJob(deps.harness, id, (draft) => {
			draft.lastRun = run;
		}, context);
	}

	const conversation = await deps.harness.conversation(
		conversationId as ConversationId,
		context,
	);
	if (conversation === undefined) {
		// The run record exists but its conversation vanished: a blocked
		// fire (never silently succeed).
		return { outcome: "blocked" };
	}
	const prompt = await jobPromptText(
		deps,
		conversationId as ConversationId,
		action.prompt,
		context,
	);
	await noteThen(
		deps.harness,
		conversation,
		() =>
			conversation.submit(
				{
					type: "input",
					content: [{ type: "text", text: prompt }],
					requestId: `job:${fireKey}`,
				},
				context,
			),
		context,
	);
	return { outcome: "running", conversationId };
}

/** `<job name> · <YYYY-MM-DD HH:mm in the job's timezone>` (the plan's name). */
function runName(name: string, at: number, record: JobRecord, deps: JobRuntimeDeps): string {
	const schedule = record.spec.schedule;
	const tz =
		("cron" in schedule ? schedule.timezone : undefined) ?? deps.defaultTz;
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date(at));
	const field = (type: string): string =>
		parts.find((part) => part.type === type)?.value ?? "";
	return `${name} · ${field("year")}-${field("month")}-${field("day")} ${field("hour")}:${field("minute")}`;
}

// ---------------------------------------------------------------------------
// The task action
// ---------------------------------------------------------------------------

async function fireTaskAction(
	deps: JobRuntimeDeps,
	id: string,
	record: JobRecord,
	fireKey: string,
	baseRun: JobRunWire,
	prior: JobRunWire | undefined,
	context: Context,
	runtime: TaskRuntime<ScheduleInput, ScheduleState, void, object> | undefined,
): Promise<FireResult> {
	const action = record.spec.action;
	if (action.kind !== "task") throw new Error("unreachable");

	// The target task must be registered by an installed extension.
	const snapshot = depsRegistry(deps, runtime);
	const target = snapshot.task(action.task);
	if (target === undefined) {
		const reason = `task ${action.task} is not registered`;
		await patchJob(
			deps.harness,
			id,
			(draft) => {
				draft.state = "blocked";
				draft.reason = reason;
			},
			context,
		);
		return { outcome: "blocked" };
	}

	if (prior !== undefined) {
		// Re-entry: the record (and its task) exist. The task's terminal
		// outcome settles the run (Task 3's observer); nothing to re-do.
		return {
			outcome: "running",
			...(prior.conversationId === undefined
				? {}
				: { conversationId: prior.conversationId }),
		};
	}

	// The run record + the created task share ONE commit. With the
	// schedule task driving, that's the task's own commit line (the child
	// task is owned by it, so deleting the job cascades). Run-now without
	// a runtime creates the child conversation-owned on root — the
	// cascade is Task 3's delete path's concern (abortTask by scan).
	const run: JobRunWire = { ...baseRun };
	if (runtime !== undefined) {
		let taskId: TaskId | undefined;
		await runtime.commit(async (tx) => {
			taskId = await tx.createTask(
				target as never,
				(action.input ?? {}) as never,
				{ ownership: { kind: "task", taskId: runtime.taskId } },
			);
			await tx.doc(JobRunDoc, fireKey, {
				...run,
				taskId: taskId as unknown as number,
			});
			return undefined;
		}, context);
		run.taskId = taskId as unknown as number;
	} else {
		// Run-now (no schedule-task runtime): the child task is
		// conversation-owned on the ROOT conversation — Task 3's spec for
		// the run-now path (Task 2's shape omitted the conversationId and
		// threw on a Session commit, which requires it for a
		// conversation-owned task).
		const rootConversation = await deps.harness.root(context);
		await deps.harness.commit(async (tx) => {
			const taskId = await tx.createTask(target as never, (action.input ?? {}) as never, {
				ownership: { kind: "conversation" },
				conversationId: rootConversation.id,
			});
			await tx.doc(JobRunDoc, fireKey, {
				...run,
				taskId: taskId as unknown as number,
			});
		}, context);
	}
	await patchJob(deps.harness, id, (draft) => {
		draft.lastRun = run;
	}, context);
	return { outcome: "running" };
}

/**
 * The registry snapshot the task-action lookup reads: the driving
 * runtime's when inside the schedule task (the phase's snapshot), else
 * the `registry` threaded through `JobRuntimeDeps` (sigrun's boot-owned
 * `OpenedHarness.registry` — the BINDING Task-3 carry-forward, replacing
 * the harness private-field reach).
 */
function depsRegistry(
	deps: JobRuntimeDeps,
	runtime: TaskRuntime<ScheduleInput, ScheduleState, void, object> | undefined,
): { task(name: string): unknown } {
	if (runtime !== undefined) return runtime.registry;
	const registry = deps.registry;
	if (registry === undefined) {
		throw new Error("fireJob: no registry available outside a task");
	}
	return registry.snapshot();
}
