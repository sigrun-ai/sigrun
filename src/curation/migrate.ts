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
 *
 * The discard + import run inside `GitHistory.freshImport` (the
 * per-repo lock): a store write concurrent with the migration either
 * lands before the discard (its commit is discarded and its content is
 * re-imported from disk — nothing lost) or after the import (its own
 * commit on top). The unlocked rm of an earlier revision could delete
 * a repo a concurrent write had just committed (review I3).
 *
 * A "nothing" result ALSO writes the marker (whole-branch review C1):
 * without it, an empty user's first write commits fine, but the NEXT
 * boot's sweep sees a non-empty pathspec with no marker and freshImport
 * would discard that entire first-session history. The marker's "nothing
 * was imported" form is the same file; marker-last ordering is trivially
 * preserved (nothing precedes it).
 *
 * The residual failure window: a crash AFTER freshImport's commit but
 * BEFORE the marker write leaves an unmarked repo holding real import
 * commits — the next boot discards it and re-imports from disk (the
 * content is safe), but any feed entry / undo anchor / review link that
 * already recorded the discarded commits' shas dangles (their trailers
 * are lost with the discarded commits). The window is one writeFile
 * wide; closing it would need the marker inside the commit itself.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitHistory } from "../history/git.js";
import { historyDir, userRepoSpec } from "./paths.js";

export type MigrationResult = "migrated" | "already" | "nothing";

/**
 * Import the user's current curation store into the history repo.
 * "already" when the marker exists; "nothing" when the user has no
 * tracked content at all (the marker IS written — review C1: an
 * unmarked empty user loses their first write's history on the next
 * boot's sweep); "migrated" otherwise.
 *
 * A `user.git` without the marker on a repo this call did not just
 * build is a partial migration: it is discarded and the import runs
 * fresh.
 */
export async function migrateUserCuration(
	userArea: string,
	history: GitHistory,
): Promise<MigrationResult> {
	const marker = join(historyDir(userArea), "MIGRATED");
	if (await present(marker)) return "already";
	if (!(await pathspecContent(userArea))) {
		// Nothing to import — but the marker must exist anyway: an
		// unmarked user's first write commits into a repo the next boot
		// would treat as a partial migration and discard (review C1).
		await mkdir(historyDir(userArea), { recursive: true });
		await writeFile(marker, `${new Date().toISOString()}\n`);
		return "nothing";
	}
	// The discard + import are ONE locked operation (GitHistory.
	// freshImport): a concurrent store write either lands before the
	// discard (its content is re-imported from disk — nothing lost) or
	// after the import (its own commit on top). The work tree must exist
	// before the git dir can init inside it.
	await mkdir(historyDir(userArea), { recursive: true });
	const sha = await history.freshImport({
		actor: { kind: "outside" },
		summary: "Imported from the curation store",
	});
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
