/**
 * Jobs Task 2 (spec §8.1): the three job record families.
 *
 * Every job — from any source — is one `sigrun.job` session-scoped
 * document-family record keyed by jobId, holding the current definition +
 * status. History lives in two more families: `sigrun.job.revision`
 * (one immutable snapshot per version, key `<jobId>:<version>`) and
 * `sigrun.job.run` (one record per fire, key `<jobId>:<fireKey>` — the
 * fire's idempotency record). All three are document families precisely
 * because they commit ATOMICALLY with task creation and run-conversation
 * creation (spec ruling 13; a separate database could not).
 *
 * Writes:
 * - `writeJobChange` is the ONE job-record change path: it bumps
 *   `version`, stamps `updatedAt`, and writes the matching revision in
 *   the SAME commit (callers pass the ambient tx).
 * - `patchJob` is the small status-edit path (state/reason/nextRun/
 *   lastRun) — no version bump, no revision.
 * - Retention (`pruneHistory`, ruling 14): keep the newest `limits.runs`
 *   runs and the newest `limits.revisions` revisions plus any revision a
 *   retained run references; the rest RETIRE (pi-durable keeps retired
 *   incarnations — listing is bounded, the database is not; §12 owns
 *   compaction).
 *
 * Enumeration is `storage.scanDocuments` over the session scope — the
 * Harness exposes no family listing — filtered by key prefix for one
 * job's runs/revisions. Task records are never enumerated for listing.
 */

import type { Context, Draft } from "@earendil-works/chord";
import {
	defineDocFamily,
	type Harness,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import type { Sharing } from "@sigrun/shared/access";
import type {
	JobRevisionWire,
	JobRunWire,
	JobSpec,
	JobWire,
} from "@sigrun/shared/jobs";

/** The `sigrun.job` record (plan Global Constraints), verbatim. */
export type JobRecord = {
	source: "api" | "file" | "extension";
	spec: JobSpec;
	owner?: string;
	sharing?: Sharing;
	enabled: boolean;
	createdAt: string;
	hash: string;
	state: JobWire["state"];
	reason?: string;
	version: number;
	updatedAt: string;
	nextRun?: string;
	lastRun?: JobRunWire;
};

// ---------------------------------------------------------------------------
// The three families
// ---------------------------------------------------------------------------

/** `sigrun.job`, key = jobId. The definition + status row. */
export const JobDoc = defineDocFamily<JobRecord, JobRecord>({
	kind: "sigrun.job",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
});

/** `sigrun.job.revision`, key = `<jobId>:<version>` — immutable snapshots. */
export const JobRevisionDoc = defineDocFamily<JobRevisionWire, JobRevisionWire>({
	kind: "sigrun.job.revision",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
});

/** `sigrun.job.run`, key = `<jobId>:<fireKey>` — the idempotency record. */
export const JobRunDoc = defineDocFamily<JobRunWire, JobRunWire>({
	kind: "sigrun.job.run",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
});

// ---------------------------------------------------------------------------
// Reads (storage scans — the harness exposes no family listing)
// ---------------------------------------------------------------------------

const SCAN_PAGE = 500;

/** All live job records, keyed by id (enumeration = records, never tasks). */
export async function scanJobs(
	storage: Storage,
	ctx: Context,
): Promise<{ id: string; record: JobRecord }[]> {
	const out: { id: string; record: JobRecord }[] = [];
	let cursor: Awaited<ReturnType<Storage["scanDocuments"]>>["next"];
	for (;;) {
		const page = await storage.scanDocuments(
			{
				scope: { kind: "session" },
				at: "current",
				kind: JobDoc.definition.kind,
			},
			SCAN_PAGE,
			cursor,
			ctx,
		);
		for (const item of page.items) {
			if (item.key === undefined) continue;
			const stored = await storage.document(item.id, "current", ctx);
			if (stored === undefined) continue;
			out.push({ id: item.key, record: stored.value as unknown as JobRecord });
		}
		if (page.next === undefined) return out;
		cursor = page.next;
	}
}

/** One job record by id (undefined when absent or retired). */
export async function readJob(
	harness: Harness,
	id: string,
	ctx: Context,
): Promise<JobRecord | undefined> {
	return await harness.snapshot(JobDoc, id, ctx);
}

/**
 * One job's run records, newest first (by `startedAt`), capped at `limit`.
 * The scan walks every live `sigrun.job.run` record and filters by the
 * `<jobId>:` key prefix — O(total retained runs), fine at household scale
 * (spec §8.1: indexed per-job queries are §12).
 */
export async function listRuns(
	storage: Storage,
	jobId: string,
	limit: number,
	ctx: Context,
): Promise<JobRunWire[]> {
	const prefix = `${jobId}:`;
	const runs: JobRunWire[] = [];
	let cursor: Awaited<ReturnType<Storage["scanDocuments"]>>["next"];
	for (;;) {
		const page = await storage.scanDocuments(
			{
				scope: { kind: "session" },
				at: "current",
				kind: JobRunDoc.definition.kind,
			},
			SCAN_PAGE,
			cursor,
			ctx,
		);
		for (const item of page.items) {
			if (item.key === undefined || !item.key.startsWith(prefix)) continue;
			const stored = await storage.document(item.id, "current", ctx);
			if (stored === undefined) continue;
			runs.push(stored.value as unknown as JobRunWire);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	return runs.slice(0, Math.max(0, limit));
}

/** One job's revisions, newest first (by version). */
export async function listRevisions(
	storage: Storage,
	jobId: string,
	ctx: Context,
): Promise<JobRevisionWire[]> {
	const prefix = `${jobId}:`;
	const revisions: JobRevisionWire[] = [];
	let cursor: Awaited<ReturnType<Storage["scanDocuments"]>>["next"];
	for (;;) {
		const page = await storage.scanDocuments(
			{
				scope: { kind: "session" },
				at: "current",
				kind: JobRevisionDoc.definition.kind,
			},
			SCAN_PAGE,
			cursor,
			ctx,
		);
		for (const item of page.items) {
			if (item.key === undefined || !item.key.startsWith(prefix)) continue;
			const stored = await storage.document(item.id, "current", ctx);
			if (stored === undefined) continue;
			revisions.push(stored.value as unknown as JobRevisionWire);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	revisions.sort((a, b) => b.version - a.version);
	return revisions;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The ONE job-record change path: bump `version`, stamp `updatedAt`, and
 * write the matching immutable revision — all in the caller's commit.
 * `next` omits `version`/`updatedAt` (this function derives them); every
 * definition-relevant field (`spec`/`owner`/`sharing`/`enabled`) moves
 * only through here, so history is complete by construction.
 */
export async function writeJobChange(
	tx: Tx,
	id: string,
	next: Omit<JobRecord, "version" | "updatedAt">,
	changedBy: string,
	nowIso: string,
): Promise<void> {
	// The seed only applies when the record is absent (first creation);
	// for a change the draft starts at the CURRENT value. Carry the
	// caller's `next` over it field by field (status fields the caller
	// omitted — state/reason/nextRun/lastRun — are preserved, per the
	// reconciliation rule: "lastRun is preserved").
	const seed: JobRecord = {
		...next,
		version: 0,
		updatedAt: nowIso,
	};
	const draft = await tx.doc(JobDoc, id, seed);
	const priorVersion = (draft as JobRecord).version;
	const version = priorVersion + 1;
	// Apply `next` onto the draft (object-optional keys ride through).
	const target = draft as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(next)) {
		if (value === undefined) delete target[key];
		else target[key] = value;
	}
	target.version = version;
	target.updatedAt = nowIso;
	const applied = target as unknown as JobRecord;
	const revision: JobRevisionWire = {
		jobId: id,
		version,
		source: applied.source,
		spec: JSON.parse(JSON.stringify(applied.spec)) as JobSpec,
		...(applied.owner === undefined ? {} : { owner: applied.owner }),
		...(applied.sharing === undefined ? {} : { sharing: applied.sharing }),
		enabled: applied.enabled,
		changedAt: nowIso,
		changedBy,
	};
	await tx.doc(JobRevisionDoc, `${id}:${version}`, revision);
}

/**
 * A small status edit on the job record (state/reason/nextRun/lastRun) —
 * NO version bump, NO revision. The change runs in one `harness.commit`,
 * so concurrent status writes cannot lose each other's fields.
 */
export async function patchJob(
	harness: Harness,
	id: string,
	change: (draft: Draft<JobRecord>) => void,
	ctx: Context,
): Promise<void> {
	// Existence + the seed are read OUTSIDE the commit (Tx has no
	// `snapshot`, and Session reads queue on the line the commit holds).
	// The seed is ignored when the record exists — tx.doc returns the live
	// draft — so the pre-read never shadows a concurrent change.
	const prior = await harness.snapshot(JobDoc, id, ctx);
	if (prior === undefined) return;
	await harness.commit(async (tx) => {
		const draft = await tx.doc(JobDoc, id, { ...prior });
		change(draft);
	}, ctx);
}

/**
 * Retention (ruling 14), applied when a run settles and when a revision
 * is written: retire the oldest runs beyond `limits.runs` and the oldest
 * revisions beyond `limits.revisions`, EXCEPT a revision any retained run
 * references (a run's outcome must always map to its exact definition).
 *
 * The storage handle is a PARAMETER (the Task-3 carry-forward): callers
 * thread `OpenedHarness.storage` — the private-field reach this function
 * used to make is deleted.
 */
export async function pruneHistory(
	storage: Storage,
	harness: Harness,
	jobId: string,
	limits: { runs: number; revisions: number },
	ctx: Context,
): Promise<void> {
	const runs = await listRuns(storage, jobId, Number.MAX_SAFE_INTEGER, ctx);
	const revisions = await listRevisions(storage, jobId, ctx);
	const keptRuns = runs.slice(0, Math.max(0, limits.runs));
	const dropRuns = runs.slice(Math.max(0, limits.runs));
	const referencedVersions = new Set(keptRuns.map((run) => run.version));
	const keptRevisions: JobRevisionWire[] = [];
	const dropRevisions: JobRevisionWire[] = [];
	for (const revision of revisions) {
		if (
			keptRevisions.length < Math.max(0, limits.revisions) ||
			referencedVersions.has(revision.version)
		) {
			keptRevisions.push(revision);
		} else {
			dropRevisions.push(revision);
		}
	}
	await harness.commit(async (tx) => {
		for (const run of dropRuns) {
			await tx.retireDoc(JobRunDoc, runKeyOf(run));
		}
		for (const revision of dropRevisions) {
			await tx.retireDoc(JobRevisionDoc, `${jobId}:${revision.version}`);
		}
	}, ctx);
}

/**
 * The fire key a stored run was written under, re-derived for retiring:
 * scheduled runs key on `<jobId>:<fireAt epoch ms>`; manual runs on
 * `<jobId>:manual:<startedAt epoch ms>` (the manual fire stamps it).
 */
function runKeyOf(run: JobRunWire): string {
	if (run.manual) {
		return `${run.jobId}:manual:${Date.parse(run.startedAt)}`;
	}
	return `${run.jobId}:${Date.parse(run.fireAt)}`;
}
