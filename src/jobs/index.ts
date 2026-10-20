/**
 * Jobs Task 3 — the `JobsService`: the service surface over the three
 * job record families (spec §8.3 + §8.4's service half; Task 4 owns the
 * routes).
 *
 * ONE object per opened harness, constructed at boot and exposed as
 * `OpenedHarness.jobs`. Every method is a thin composition over the
 * Task-2 primitives (`writeJobChange`, `scanJobs`, `listRuns`,
 * `listRevisions`, `patchJob`, `pruneHistory`) plus the Task-3
 * reconciliation (`reconcileJobs` — every API write reconciles that one
 * job) and `fireJob` (run-now).
 *
 * - `list`/`get`/`runs`/`revisions` READ records only — the job record
 *   is the listing table; task records are never enumerated for
 *   listing, and `runs`/`revisions` still answer for a RETIRED job
 *   until retention trims them.
 * - `createApi`/`updateApi`/`deleteApi`/`transfer` WRITE through
 *   `writeJobChange` (version bump + revision, one commit); declared
 *   ids (`file:`/`ext:`) throw {@link JobDeclaredError}.
 * - `runNow` fires `fireJob` with the manual fire key.
 * - `reconcile` delegates to {@link reconcileJobs} (boot's post-resume
 *   call and the ownership participant's follow-up).
 *
 * `access` on the wire rows is NOT computed here — the route derives it
 * per principal (§5.9 `accessOf`); the service serves raw rows.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import type {
	JobRevisionWire,
	JobRunWire,
	JobSpec,
	JobWire,
} from "@sigrun/shared/jobs";
import {
	JobDoc,
	listRevisions,
	listRuns,
	patchJob,
	pruneHistory,
	readJob,
	scanJobs,
	writeJobChange,
	type JobRecord,
} from "./docs.js";
import { fireJob, type JobRuntimeDeps } from "./fire.js";
import {
	reconcileJobs,
	type ReconcileSources,
} from "./reconcile.js";
import { specHash } from "./spec.js";
import type { SettingsFile } from "../harness/settings.js";

/** Thrown when an API write targets a `file:`/`ext:` job id (409 `job_declared`). */
export class JobDeclaredError extends Error {
	constructor(id: string) {
		super(`job ${id} is declared by its source — edit the source instead`);
		this.name = "JobDeclaredError";
	}
}

/** Thrown when an API write targets a missing job. */
export class JobNotFoundError extends Error {
	constructor(id: string) {
		super(`job ${id} does not exist`);
		this.name = "JobNotFoundError";
	}
}

/** The live `jobHistory` limits (spec §8.1, ruling 14 — read per call). */
function historyLimits(
	settings: () => SettingsFile,
): { runs: number; revisions: number } {
	const jobHistory = settings().jobHistory;
	return {
		runs: jobHistory?.runs ?? 50,
		revisions: jobHistory?.revisions ?? 50,
	};
}

/** The wire row of a record (access left for the route). */
function toWire(id: string, record: JobRecord): JobWire {
	return {
		id,
		name: record.spec.name,
		source: record.source,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		...(record.sharing === undefined
			? {}
			: { sharing: JSON.parse(JSON.stringify(record.sharing)) }),
		schedule: record.spec.schedule,
		action: record.spec.action,
		enabled: record.enabled,
		state: record.state,
		...(record.reason === undefined ? {} : { reason: record.reason }),
		version: record.version,
		...(record.nextRun === undefined ? {} : { nextRun: record.nextRun }),
		...(record.lastRun === undefined
			? {}
			: { lastRun: record.lastRun }),
		// The route computes access per principal; the service's raw row
		// carries the neutral default.
		access: "write",
	};
}

export interface JobsServiceDeps {
	readonly harness: Harness;
	/** `OpenedHarness.storage` — the records-only scans' handle. */
	readonly storage: Storage;
	/** The fire deps (clock, tz, models, registry). */
	readonly runtime: JobRuntimeDeps;
	/** The root conversation id — the schedule tasks' owner. */
	readonly rootId: number;
	/** The declared sources, read live per reconcile. */
	readonly sources: () => ReconcileSources;
	/** The settings store's live read (jobHistory). */
	readonly settings: () => SettingsFile;
}

export interface JobsService {
	list(): Promise<JobWire[]>;
	get(id: string): Promise<JobWire | undefined>;
	createApi(spec: JobSpec, owner: string | undefined): Promise<JobWire>;
	updateApi(
		id: string,
		patch: Partial<JobSpec> & { enabled?: boolean },
		changedBy: string,
	): Promise<JobWire>;
	runs(id: string, limit: number): Promise<JobRunWire[]>;
	revisions(id: string): Promise<JobRevisionWire[]>;
	deleteApi(id: string, changedBy: string): Promise<void>;
	runNow(id: string): Promise<{
		outcome: "running" | "skipped" | "blocked";
		conversationId?: number;
	}>;
	reconcile(): Promise<void>;
}

/** Create the service (boot constructs exactly one per opened harness). */
export function createJobsService(deps: JobsServiceDeps): JobsService {
	const ctx: Context = BACKGROUND_CONTEXT;
	const limits = (): { runs: number; revisions: number } =>
		historyLimits(deps.settings);

	/** Reconcile that one job's executor after a write. */
	const reconcileOne = async (): Promise<void> =>
		await reconcileJobs(
			{
				harness: deps.harness,
				storage: deps.storage,
				runtime: deps.runtime,
				rootId: deps.rootId,
				sources: deps.sources,
			},
			ctx,
		);

	return {
		async list(): Promise<JobWire[]> {
			const records = await scanJobs(deps.storage, ctx);
			return records.map(({ id, record }) => toWire(id, record));
		},

		async get(id: string): Promise<JobWire | undefined> {
			const record = await readJob(deps.harness, id, ctx);
			return record === undefined ? undefined : toWire(id, record);
		},

		async createApi(
			spec: JobSpec,
			owner: string | undefined,
		): Promise<JobWire> {
			const id = `api:${crypto.randomUUID()}`;
			const hash = specHash(id, spec);
			const nowIso = new Date(deps.runtime.now()).toISOString();
			await deps.harness.commit(
				async (tx) => {
					await writeJobChange(
						tx,
						id,
						{
							source: "api",
							spec: JSON.parse(JSON.stringify(spec)),
							...(owner === undefined ? {} : { owner }),
							enabled: spec.enabled ?? true,
							createdAt: nowIso,
							hash,
							state: "waiting",
						},
						owner ?? "api",
						nowIso,
					);
				},
				ctx,
			);
			await pruneHistory(
				deps.storage,
				deps.harness,
				id,
				limits(),
				ctx,
			);
			await reconcileOne();
			const record = await readJob(deps.harness, id, ctx);
			if (record === undefined) throw new JobNotFoundError(id);
			return toWire(id, record);
		},

		async updateApi(
			id: string,
			patch: Partial<JobSpec> & { enabled?: boolean },
			changedBy: string,
		): Promise<JobWire> {
			const prior = await readJob(deps.harness, id, ctx);
			if (prior === undefined) throw new JobNotFoundError(id);
			if (prior.source !== "api") throw new JobDeclaredError(id);
			const spec: JobSpec = {
				...prior.spec,
				...patch,
			};
			const enabled = patch.enabled ?? prior.enabled;
			const hash = specHash(id, spec);
			const nowIso = new Date(deps.runtime.now()).toISOString();
			await deps.harness.commit(
				async (tx) => {
					await writeJobChange(
						tx,
						id,
						{
							source: "api",
							spec: JSON.parse(JSON.stringify(spec)),
							...(prior.owner === undefined ? {} : { owner: prior.owner }),
							...(prior.sharing === undefined
								? {}
								: { sharing: prior.sharing }),
							enabled,
							createdAt: prior.createdAt,
							hash,
							// Status fields the caller omitted are preserved
							// by writeJobChange's draft-merge; state resets to
							// waiting so a re-enable's executor re-derives it.
							state: enabled ? "waiting" : "disabled",
						},
						changedBy,
						nowIso,
					);
				},
				ctx,
			);
			await pruneHistory(
				deps.storage,
				deps.harness,
				id,
				limits(),
				ctx,
			);
			await reconcileOne();
			const record = await readJob(deps.harness, id, ctx);
			if (record === undefined) throw new JobNotFoundError(id);
			return toWire(id, record);
		},

		async runs(id: string, limit: number): Promise<JobRunWire[]> {
			return await listRuns(deps.storage, id, Math.max(0, limit), ctx);
		},

		async revisions(id: string): Promise<JobRevisionWire[]> {
			return await listRevisions(deps.storage, id, ctx);
		},

		async deleteApi(id: string, changedBy: string): Promise<void> {
			const prior = await readJob(deps.harness, id, ctx);
			if (prior === undefined) throw new JobNotFoundError(id);
			if (prior.source !== "api") throw new JobDeclaredError(id);
			const nowIso = new Date(deps.runtime.now()).toISOString();
			await deps.harness.commit(
				async (tx) => {
					// The final `enabled:false` revision, then the retire.
					await writeJobChange(
						tx,
						id,
						{ ...prior, enabled: false },
						changedBy,
						nowIso,
					);
					await tx.retireDoc(JobDoc, id);
				},
				ctx,
			);
			await reconcileOne();
		},

		async runNow(id: string): Promise<{
			outcome: "running" | "skipped" | "blocked";
			conversationId?: number;
		}> {
			// ONE clock reading: the manual fire key and the run's fireAt must
			// agree — the settle path re-derives the run-record key from
			// fireAt, and two readings would write the settle under a
			// different key than the fire stored the run under.
			const now = deps.runtime.now();
			const fireKey = `${id}:manual:${now}`;
			return await fireJob(deps.runtime, id, fireKey, now, ctx);
		},

		reconcile: reconcileOne,
	};
}

export { reconcileJobs } from "./reconcile.js";
