/**
 * The core-side job skill-reference reader (curator P6, A9): the skill
 * names a user's job PROMPTS reference — `/skill:name` tokens in every
 * prompt action's text, from job records the durable scan sees (api,
 * file, and extension sources alike), ENABLED AND PAUSED alike.
 *
 * The curator's diet step (Part B) needs this as the "job depends on
 * this skill" signal: archiving a skill a paused job still references
 * would break the job the moment it is re-enabled, so paused jobs count
 * exactly as much as live ones.
 *
 * Pure read: one storage scan over the `sigrun.job` family (the same
 * `scanJobs` primitive the jobs service's own reads use), filtered by
 * owner, then a text scan for `/skill:name` tokens. No mutation, no
 * task enumeration.
 */

import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { scanJobs } from "./docs.js";

/** The `/skill:name` token grammar (the expansion path's own prefix). */
const SKILL_TOKEN = /(?:^|\s)\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/**
 * Every skill name the user's job prompts reference (`/skill:name`
 * tokens), paused jobs included. A user with no jobs (or an unknown
 * user) reads an empty set — the scan is the truth, never a directory
 * check.
 */
export async function jobSkillRefs(
	storage: Storage,
	user: string,
	ctx: Context,
): Promise<ReadonlySet<string>> {
	const jobs = await scanJobs(storage, ctx);
	const refs = new Set<string>();
	for (const { record } of jobs) {
		if (record.owner !== user) continue;
		const action = record.spec.action;
		if (action.kind !== "prompt") continue;
		for (const match of action.prompt.matchAll(SKILL_TOKEN)) {
			refs.add(match[1]!);
		}
	}
	return refs;
}
