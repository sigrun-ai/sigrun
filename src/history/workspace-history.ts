/**
 * Workspace skills history (tabs+skills plan, Task 10): the SECOND
 * per-user repo — `<workspace>/skills` under git, caught up on every
 * settled run with actor `agent` and the Sigrun-Conversation trailer.
 *
 * The git dir lives under the user's curation history root
 * (`<userArea>/curation/history/workspace.git`), NEVER inside the work
 * tree — the work tree is a live user directory the agent edits, so the
 * layout itself (not an info/exclude line) keeps the repo out of the
 * staged content. Pathspec `["."]` with `add --all --force` stages the
 * whole skills tree, including deletions of tracked files whose pathspec
 * root no longer exists on disk (Task 7's shipped "exists on disk OR
 * tracked" staging rule).
 */

import { join } from "node:path";
import type { GitHistory, GitRepoSpec } from "./git.js";
import { historyDir } from "../curation/paths.js";

/**
 * The workspace skills repo layout: gitDir
 * `<userArea>/curation/history/workspace.git`, workTree
 * `<workspace>/skills`, pathspec `["."]`.
 */
export function workspaceRepoSpec(userArea: string, workspace: string): GitRepoSpec {
	return {
		gitDir: join(historyDir(userArea), "workspace.git"),
		workTree: join(workspace, "skills"),
		pathspec: ["."],
	};
}

export interface WorkspaceHistoryCacheDeps {
	/** The caller's cache (boot holds it; tests own theirs). */
	readonly cache: Map<string, GitHistory>;
	/** The instance factory for a NEW (user, workspace path) pair. */
	readonly create: (workspace: string) => GitHistory;
}

/**
 * The user's workspace skills history, cached per (user, workspace
 * path): a changed workspace path yields a NEW instance on the SAME
 * gitDir, so the history follows the user across workspace moves — one
 * log, one commit per tree. `workspace` undefined (the workspaceRoot
 * rules' refusals) resolves to no history.
 */
export function workspaceHistoryFor(
	user: string,
	workspace: string | undefined,
	deps: WorkspaceHistoryCacheDeps,
): GitHistory | undefined {
	if (workspace === undefined) return undefined;
	// NUL-separated: no (user, workspace) pair can collide on a boundary.
	const key = `${user}\0${workspace}`;
	const cached = deps.cache.get(key);
	if (cached !== undefined) return cached;
	const history = deps.create(workspace);
	deps.cache.set(key, history);
	return history;
}
