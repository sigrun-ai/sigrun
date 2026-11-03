/**
 * Curation history migration (tabs+skills plan, Task 9): a per-user
 * one-shot import of the pre-git curation store into the user's git
 * history repo.
 *
 * Runs at boot for every directory user AND lazily the first time
 * `curationOf` constructs a user's stores (users created after boot).
 * The marker `curation/history/MIGRATED` is written LAST: without it,
 * any partial `user.git` is discarded and the import is redone. The
 * legacy artifacts (`feed.jsonl`, `versions/`) are never touched — they
 * stay read-only on disk and outside the repo's pathspec.
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitHistory } from "../history/git.js";
import { historyDir, userRepoSpec } from "./paths.js";

export type MigrationResult = "migrated" | "already" | "nothing";

/**
 * Import the user's current curation store into the history repo.
 * "already" when the marker exists; "nothing" when the user has no
 * tracked content at all (no marker written — the first real write can
 * still import); "migrated" otherwise.
 *
 * A `user.git` without the marker is a partial migration: it is
 * discarded and the import runs fresh.
 */
export async function migrateUserCuration(
	userArea: string,
	history: GitHistory,
): Promise<MigrationResult> {
	const marker = join(historyDir(userArea), "MIGRATED");
	if (await present(marker)) return "already";
	if (!(await pathspecContent(userArea))) return "nothing";
	// Discard a partial repo before the import: GitHistory would
	// otherwise treat it as an existing repo and the import commit
	// would land on top of the half-imported state. A user.git without
	// the marker is ALWAYS partial (the marker is the import's last
	// step).
	await rm(join(historyDir(userArea), "user.git"), { recursive: true, force: true });
	// The work tree must exist before the git dir can init inside it.
	await mkdir(historyDir(userArea), { recursive: true });
	const sha = await history.write(
		{
			actor: { kind: "outside" },
			summary: "Imported from the curation store",
		},
		async () => {},
	);
	if (sha === undefined) {
		// Git failed (fail-soft): no commit, no marker — the next boot
		// retries the whole import.
		return "nothing";
	}
	await mkdir(historyDir(userArea), { recursive: true });
	await writeFile(marker, `${new Date().toISOString()}\n`);
	return "migrated";
}

/** Whether any pathspec entry exists in the work tree. */
async function pathspecContent(userArea: string): Promise<boolean> {
	for (const entry of userRepoSpec(userArea).pathspec) {
		if (await present(join(userArea, entry))) return true;
	}
	return false;
}

async function present(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
