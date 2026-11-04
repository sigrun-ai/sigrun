/**
 * Visibility for an ARBITRARY directory user (notices Task 3): the
 * request-scoped `visibleTo` (routes/interactions.ts) answers for the
 * REQUEST principal; the notices service needs the same answer for the
 * notice's RECIPIENT — usually not the caller at all (a post targeting
 * another user's conversation, or the list read pruning a revoked
 * share).
 *
 * The rule is the same one `visibleTo` runs: `accessOf` over the
 * conversation's SessionMetaDoc snapshot, with the principal projected
 * from the DIRECTORY (stored groups only — never request-supplied
 * claims), absent record → not visible. A userless conversation (no
 * meta) reads as ownerless → visible, exactly like `visibleTo`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { accessOf } from "@sigrun/shared/access";
import { storedGroups } from "../harness/identity/groups.js";
import type { ServerContext } from "./context.js";
import { SessionMetaDoc } from "./session-meta.js";

/**
 * Whether `user` (a directory username) can SEE conversation `id`:
 * `accessOf` over the session-meta snapshot with the user's stored
 * groups. `false` when the directory has no record for the name.
 */
export async function visibleToUser(
	ctx: ServerContext,
	id: ConversationId,
	user: string,
): Promise<boolean> {
	const record = ctx.opened.identity.users.get(user);
	if (record === undefined) return false;
	const meta = await ctx.opened.harness.snapshot(
		SessionMetaDoc,
		id,
		BACKGROUND_CONTEXT,
	);
	return (
		accessOf(
			{ user, superuser: false, groups: storedGroups(record) },
			meta ?? {},
		) !== "none"
	);
}
