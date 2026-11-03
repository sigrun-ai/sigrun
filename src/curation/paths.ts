/**
 * Curator path helpers (P2): the per-user learned skills root and the
 * per-user curation state directory, both derived from the managed user
 * area (`<dataDir>/users/<user>` — `ManagedPaths.userAreas`).
 *
 * Pure derivations: no filesystem access, no validation — the sandbox
 * policy owns creation and the grant validators own admission.
 */

import { join } from "node:path";
import type { GitRepoSpec } from "../history/git.js";

/** The owner's learned skills root: `<userArea>/skills`. */
export function learnedSkillsDir(userArea: string): string {
	return join(userArea, "skills");
}

/** The owner's curation state directory: `<userArea>/curation`. */
export function curationDir(userArea: string): string {
	return join(userArea, "curation");
}

/**
 * The owner's curation history root: `<userArea>/curation/history`
 * (tabs+skills Task 9). Holds `user.git` (the per-user curation repo),
 * later `workspace.git` (Task 10), and the `MIGRATED` marker. A plain
 * directory, never a git work tree.
 */
export function historyDir(userArea: string): string {
	return join(userArea, "curation", "history");
}

/**
 * The ONE per-user curation repo (tabs+skills Task 9): skills,
 * archive, overlays and state in one history, with `userArea` as the
 * work tree. `feed.jsonl` and `versions/` are deliberately OUTSIDE the
 * pathspec — read-only legacy after migration.
 */
export function userRepoSpec(userArea: string): GitRepoSpec {
	return {
		gitDir: join(historyDir(userArea), "user.git"),
		workTree: userArea,
		pathspec: ["skills", "curation/archive", "curation/overlays", "curation/state.json"],
	};
}
