/**
 * Curation state removal on user deletion (curator A10, spec §6.4):
 * a departing user's learned skills and curation state are REMOVED with
 * them, never transferred — a skill distilled from their conversations
 * can carry their paths, hosts and preferences, and must not load for
 * the recipient (memory's shape; the spec's call).
 *
 * Core owns exactly the two roots under the managed user area:
 * `<userArea>/skills` (the learned root) and `<userArea>/curation`
 * (versions, overlays, the feed, usage counters). The user area itself,
 * workspaces and every extension-owned per-user dir stay for the §10.6
 * recipient/retention rules; targets clean their own data through their
 * `userDeleted` handler.
 *
 * Fail-closed counterpart (Review Focus 1): the per-user stores gate
 * EVERY operation on the live directory record (A4/A5's `userExists`),
 * so a curator run in flight when its user is deleted cannot write —
 * its late calls fail `user removed` and create nothing. This function
 * only removes what exists; it never recreates a root.
 */

import { rm } from "node:fs/promises";
import { curationDir, learnedSkillsDir } from "./paths.js";

/**
 * Remove one user's learned skills root and curation state directory.
 * Idempotent (`force`): absent roots are a no-op, and nothing is ever
 * created. Symlink-safe by construction — `rm` removes a symlinked
 * root itself, never its target.
 */
export async function removeUserCuration(userArea: string): Promise<void> {
	await rm(learnedSkillsDir(userArea), { recursive: true, force: true });
	await rm(curationDir(userArea), { recursive: true, force: true });
}
