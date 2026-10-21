/**
 * Jobs Task 3 (spec §8.3 "Records → tasks"): reconciliation — the ONE
 * function that maps job RECORDS onto schedule-task EXECUTORS.
 *
 * Two passes, in order:
 *
 * 1. **Declared → records.** Every file (settings.json `jobs[]`) and
 *    extension (factory-result `jobs[]`) declaration upserts its record
 *    through `writeJobChange` — `changedBy` = `"file"` /
 *    `"extension:<slug>"`, so a change bumps `version` and writes a
 *    revision; an UNCHANGED declaration (same source, spec, owner,
 *    sharing, enabled, hash) writes nothing. Records whose declaration
 *    vanished are RETIRED (a final `enabled:false` revision rides the
 *    same commit). `api` records are never touched here — the API owns
 *    them.
 *
 * 2. **Records → tasks.** Live tasks come from
 *    `storage.scanTasks({kind: "sigrun.schedule"})`, paged, filtered
 *    in-memory to non-terminal — used ONLY to match executors, never
 *    for listing (the job record is the listing table). For every
 *    record:
 *    - enabled with no live task of the matching `hash` → abort any
 *      live task for that `jobId`, then create one (a single
 *      `harness.commit` carrying `tx.createTask`, conversation-owned on
 *      the ROOT conversation, `background: true`);
 *    - a live task whose record is retired, disabled, or hash-mismatched
 *      → `harness.abortTask` (the task's own stale-executor rule then
 *      settles it honestly);
 *    - disabled records get `state: "disabled"`.
 *
 * Boot calls `reconcile` immediately before `resume()` (the scheduler
 * starts executors at resume, the next line — awaiting anything after
 * resume would race post-boot registry installs against recovered agent
 * resolution); every API write calls it for
 * one job. It is IDEMPOTENT — a second run with unchanged state creates
 * nothing, aborts nothing, writes nothing.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import type {
	Cursor,
	Harness,
	Storage,
	TaskRecord,
} from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import {
	JobDoc,
	patchJob,
	scanJobs,
	writeJobChange,
	type JobRecord,
} from "./docs.js";
import type { JobRuntimeDeps } from "./fire.js";
import { nextFireAt } from "./schedule.js";
import { specHash } from "./spec.js";
import { createScheduleTask } from "./task.js";

/** One declared job, pre-validated (file or extension source). */
export interface DeclaredJob {
	readonly id: string;
	readonly spec: JobSpec;
	/** `"file"` or the extension slug. */
	readonly declaredBy: string;
}

/** The declaration sets reconcile folds into source lists. */
export interface ReconcileSources {
	readonly file: readonly JobSpec[];
	/** One entry per extension that declared jobs (the loader's bindings). */
	readonly extensions: readonly { extension: string; jobs: readonly JobSpec[] }[];
}

const SCAN_PAGE = 500;

/** The file id of a declared name. */
export function fileJobId(name: string): string {
	return `file:${name}`;
}

/** The extension id of a declared name. */
export function extensionJobId(slug: string, name: string): string {
	return `ext:${slug}:${name}`;
}

/** Every non-terminal schedule task, keyed by jobId. */
export async function liveScheduleTasksByJob(
	storage: Storage,
	ctx: Context,
): Promise<Map<string, TaskRecord<JsonValue, JsonValue, JsonValue>[]>> {
	const byJob = new Map<
		string,
		TaskRecord<JsonValue, JsonValue, JsonValue>[]
	>();
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await storage.scanTasks(
			{ kind: "sigrun.schedule" },
			SCAN_PAGE,
			cursor,
			ctx,
		);
		for (const record of page.items) {
			if (
				record.state.status === "terminal" ||
				record.state.status === "completing"
			) {
				continue;
			}
			// An abort-marked task is not a live executor: `abortTask`
			// returns "marked" and completes asynchronously, so a pending
			// abort must not count as the job's executor (reconcile would
			// skip creating the replacement, or re-abort a settling task).
			if (record.abortRequested === true) continue;
			const jobId = (record.input as { jobId?: unknown }).jobId;
			if (typeof jobId !== "string") continue;
			const list = byJob.get(jobId) ?? [];
			list.push(record);
			byJob.set(jobId, list);
		}
		if (page.next === undefined) return byJob;
		cursor = page.next;
	}
}

/** The record a declaration reconciles to (omitted status fields preserved). */
function declaredRecord(
	id: string,
	spec: JobSpec,
	hash: string,
	nowIso: string,
): Omit<JobRecord, "version" | "updatedAt"> {
	return {
		source: id.startsWith("ext:") ? "extension" : "file",
		spec,
		...(spec.owner === undefined ? {} : { owner: spec.owner }),
		...(spec.sharing === undefined ? {} : { sharing: spec.sharing }),
		enabled: spec.enabled ?? true,
		createdAt: nowIso,
		hash,
		state: "waiting",
	};
}

/** Whether a record already mirrors a declaration exactly (no write). */
function mirrorsDeclaration(
	record: JobRecord,
	id: string,
	spec: JobSpec,
	hash: string,
): boolean {
	return (
		record.hash === hash &&
		record.source === (id.startsWith("ext:") ? "extension" : "file") &&
		record.spec.name === spec.name &&
		JSON.stringify(record.spec) === JSON.stringify(spec) &&
		record.enabled === (spec.enabled ?? true) &&
		record.owner === spec.owner &&
		(record.sharing === undefined) === (spec.sharing === undefined) &&
		(record.sharing === undefined ||
			JSON.stringify(record.sharing) === JSON.stringify(spec.sharing))
	);
}

export interface ReconcileDeps {
	/** The harness whose Session line every commit rides. */
	readonly harness: Harness;
	/** The boot-exposed storage handle (`OpenedHarness.storage`). */
	readonly storage: Storage;
	/** The fire deps (clock, tz, models) task creation threads. */
	readonly runtime: JobRuntimeDeps;
	/** The root conversation's id — the schedule tasks' owner. */
	readonly rootId: number;
	/** The declared sources (file specs + the loader's job bindings). */
	readonly sources: () => ReconcileSources;
}

/**
 * Reconcile every source into records, then every record into tasks.
 * See the module doc for the pass order and semantics.
 */
export async function reconcileJobs(
	deps: ReconcileDeps,
	ctx: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	const nowIso = new Date(deps.runtime.now()).toISOString();
	// ── Pass 1: declared → records ───────────────────────────────────
	const declared: DeclaredJob[] = [
		...deps.sources().file.map((spec) => ({
			id: fileJobId(spec.name),
			spec,
			declaredBy: "file",
		})),
		...deps.sources().extensions.flatMap(({ extension, jobs }) =>
			jobs.map((spec) => ({
				id: extensionJobId(extension, spec.name),
				spec,
				declaredBy: `extension:${extension}`,
			})),
		),
	];
	const declaredIds = new Set(declared.map((job) => job.id));
	const records = new Map<string, JobRecord>();
	for (const { id, record } of await scanRecords(deps.storage, ctx)) {
		records.set(id, record);
	}
	for (const job of declared) {
		const hash = specHash(job.id, job.spec);
		const prior = records.get(job.id);
		if (prior === undefined) {
			await deps.harness.commit(
				async (tx) => {
					await writeJobChange(
						tx,
						job.id,
						declaredRecord(job.id, job.spec, hash, nowIso),
						job.declaredBy,
						nowIso,
					);
				},
				ctx,
			);
			continue;
		}
		if (mirrorsDeclaration(prior, job.id, job.spec, hash)) continue;
		// A changed declaration (or a re-appeared retired record):
		// writeJobChange carries `next` over the draft, preserving the
		// status fields (state/reason/nextRun/lastRun) the declaration
		// does not own — "lastRun is preserved".
		await deps.harness.commit(
			async (tx) => {
				await writeJobChange(
					tx,
					job.id,
					declaredRecord(job.id, job.spec, hash, nowIso),
					job.declaredBy,
					nowIso,
				);
			},
			ctx,
		);
	}
	// Retire declared-source records whose declaration is gone.
	for (const [id, record] of records) {
		if (record.source === "api") continue;
		if (declaredIds.has(id)) continue;
		await retireRecord(deps.harness, id, record, nowIso, ctx);
	}
	// ── Pass 2: records → tasks ─────────────────────────────────────
	const after = new Map<string, JobRecord>();
	for (const { id, record } of await scanRecords(deps.storage, ctx)) {
		after.set(id, record);
	}
	const liveByJob = await liveScheduleTasksByJob(deps.storage, ctx);
	// Retired ids first: a record retired this pass (or on an earlier
	// boot/crash) no longer appears in `after`, so its live executor — if
	// any survived — must be aborted here, keyed on the live-task scan.
	for (const [id, tasks] of liveByJob) {
		if (after.has(id)) continue;
		for (const task of tasks) {
			await deps.harness.abortTask(task.id, ctx);
		}
	}
	for (const [id, record] of after) {
		const live = liveByJob.get(id) ?? [];
		const matching = live.filter(
			(task) =>
				(task.input as { hash?: unknown }).hash === record.hash,
		);
		if (record.enabled) {
			if (matching.length === 0) {
				for (const task of live) {
					await deps.harness.abortTask(task.id, ctx);
				}
				await createExecutor(deps, id, record, ctx);
			}
			// A matching live task exists: leave it (the same task id
			// survives an unchanged reboot). Extra stale live tasks for
			// the same id are still pruned.
			for (const task of live) {
				if (
					(task.input as { hash?: unknown }).hash !== record.hash
				) {
					await deps.harness.abortTask(task.id, ctx);
				}
			}
		} else {
			for (const task of live) {
				await deps.harness.abortTask(task.id, ctx);
			}
			if (record.state !== "disabled") {
				await patchRecord(
					deps.harness,
					id,
					(draft) => {
						draft.state = "disabled";
					},
					ctx,
				);
			}
		}
	}
}

/** All live job records (the records-only scan). */
async function scanRecords(
	storage: Storage,
	ctx: Context,
): Promise<{ id: string; record: JobRecord }[]> {
	// scanJobs already pages + reads current values.
	return scanJobs(storage, ctx);
}

/** Retire one declared-source record with a final `enabled:false` revision. */
async function retireRecord(
	harness: Harness,
	id: string,
	record: JobRecord,
	nowIso: string,
	ctx: Context,
): Promise<void> {
	if (!record.enabled) {
		// Already disabled (a prior delete-style revision exists): just
		// retire the record.
		await harness.commit(async (tx) => {
			await tx.retireDoc(JobDoc, id);
		}, ctx);
		return;
	}
	await harness.commit(async (tx) => {
		await writeJobChange(
			tx,
			id,
			{
				...record,
				enabled: false,
			},
			"retire",
			nowIso,
		);
		await tx.retireDoc(JobDoc, id);
	}, ctx);
}

/** One small status edit (state/reason) — no version bump. */
async function patchRecord(
	harness: Harness,
	id: string,
	change: (draft: JobRecord) => void,
	ctx: Context,
): Promise<void> {
	await patchJob(harness, id, change as never, ctx);
}

/** Create the schedule task for one enabled record (ONE commit). */
async function createExecutor(
	deps: ReconcileDeps,
	id: string,
	record: JobRecord,
	ctx: Context,
): Promise<void> {
	const firstAt = nextFireAt(
		record.spec.schedule,
		deps.runtime.now(),
		deps.runtime.defaultTz,
	);
	await deps.harness.commit(
		async (tx) => {
			await tx.createTask(
				createScheduleTask(deps.runtime),
				{
					jobId: id,
					hash: record.hash,
					...(firstAt === undefined ? {} : { firstAt }),
				},
				{
					ownership: { kind: "conversation" },
					conversationId: deps.rootId as never,
					background: true,
				},
			);
		},
		ctx,
	);
}
