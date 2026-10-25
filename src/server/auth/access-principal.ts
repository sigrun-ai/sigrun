/** Project the authenticated caller into the shared access rule. */

import type { AccessPrincipal } from "@sigrun/shared/access";
import { storedGroups } from "../../harness/identity/groups.js";
import type { UserDirectory } from "../../harness/identity/users.js";
import { isSuperuser, type Principal } from "./principal.js";

/**
 * Read the CURRENT directory record on every access decision: stored group
 * changes therefore apply immediately. Absent records (including anonymous
 * callers) contribute no groups.
 */
export function accessPrincipalOf(
	principal: Principal,
	users: UserDirectory,
): AccessPrincipal {
	const record =
		principal.user === undefined ? undefined : users.get(principal.user);
	return {
		user: principal.user,
		superuser: isSuperuser(principal),
		...(record === undefined ? {} : { groups: storedGroups(record) }),
	};
}
