/** Resolve and remove one job's on-disk state directory. */

import { rm } from "node:fs/promises";
import { join } from "node:path";

/** The complete job id is encoded into one path segment. */
export function jobStateDir(root: string, jobId: string): string {
	return join(root, encodeURIComponent(jobId));
}

/**
 * Remove job state, or do nothing when the selected owner has no jobs root.
 * Deletion failures reject so each job operation can apply its own policy.
 */
export async function removeJobState(root: string | undefined, jobId: string): Promise<void> {
	if (root === undefined) return;
	await rm(jobStateDir(root, jobId), { recursive: true, force: true });
}
