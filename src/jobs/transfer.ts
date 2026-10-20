/**
 * Jobs Task 3 (spec §5.8 + §8.3): the ownership-transfer participant.
 *
 * Registered by `createServer` behind the core conversation participant
 * (`registerCoreOwnershipParticipant` first — conversations transfer
 * before the jobs records do). For a `from → to` transfer it rewrites
 * every `api` job record whose `owner === from` to `owner: to` through
 * `writeJobChange` — which recomputes NOTHING itself (the caller does)
 * but bumps `version` and writes a `changedBy: "transfer"` revision —
 * then calls `jobs.reconcile()`: the owner rides the spec hash, so the
 * changed hash makes reconciliation abort the old executor and create a
 * new one (the plan's "new hash → task recreated").
 *
 * Declared (`file`/`extension`) records are NOT rewritten here — their
 * source owns the owner field; the next boot's reconciliation warns when
 * a declared owner no longer exists in the directory (the job runs
 * ownerless until the source is edited — spec §8.3's posture).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerOwnershipParticipant, type OwnershipParticipant } from "../server/ownership.js";
import type { ServerContext } from "../server/context.js";
import { scanJobs, writeJobChange, type JobRecord } from "./docs.js";
import { specHash } from "./spec.js";

/**
 * Register the jobs transfer participant on `ctx` (createServer calls
 * this right after the core conversation participant).
 */
export function registerJobsOwnershipParticipant(ctx: ServerContext): void {
	const participant: OwnershipParticipant = async (from, to) => {
		const { opened } = ctx;
		const jobs = opened.jobs;
		const storage = opened.storage;
		const nowIso = new Date().toISOString();
		const records = await scanJobs(storage, BACKGROUND_CONTEXT);
		for (const { id, record } of records) {
			if (record.source !== "api") continue;
			if (record.owner !== from) continue;
			const spec = { ...record.spec, owner: to };
			const next: Omit<JobRecord, "version" | "updatedAt"> = {
				...record,
				spec,
				owner: to,
				hash: specHash(id, spec),
			};
			await opened.harness.commit(async (tx) => {
				await writeJobChange(tx, id, next, "transfer", nowIso);
			}, BACKGROUND_CONTEXT);
		}
		await jobs.reconcile();
	};
	registerOwnershipParticipant(ctx, participant);
}
