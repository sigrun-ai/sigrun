/**
 * The boot-time account-link sweep (username-derivation Task 8, spec
 * §11.3): runs ONCE at boot, after the identity stores open and before
 * the listener binds — never on the request path, and never inside the
 * claim lock (boot is single-threaded before serving).
 *
 * Two repair classes:
 *
 * - DANGLING LINKS: an `accounts.json` row whose `user` no longer
 *   exists (a hand-edited file, or a crash between a user deletion and
 *   its link cleanup). The sweep REMOVES them — the link names an
 *   identity that cannot resolve, so keeping it only preserves a
 *   conflict block against a future re-add.
 *
 * - CRASH ORPHANS: a `source === "proxy"` user with NO proxy link
 *   (Task 3's crash window: the user row landed, the link write never
 *   did). The sweep LISTS them, never repairs: the original proxy
 *   username is not derivable from the directory key (collisions
 *   suffix it), so the operator repairs with
 *   `sigrun user link <key> --proxy <username>`.
 */

import type { AccountStore } from "./accounts.js";
import type { UserDirectory } from "./users.js";

export interface LinkSweepResult {
	/** How many dangling links were removed. */
	readonly removedDangling: number;
	/** Directory keys of proxy-source users with no proxy link. */
	readonly orphans: readonly string[];
}

/**
 * Remove links whose user is gone and list proxy-source users with no
 * proxy link. Reads each store once (mtime-reloading reads), then
 * unlinks the dangling rows through the store's own serialized
 * mutation.
 */
export async function sweepAccountLinks(
	users: UserDirectory,
	accounts: AccountStore,
): Promise<LinkSweepResult> {
	const known = new Set(users.list().map((record) => record.user));
	const links = accounts.list();
	const dangling = links.filter((link) => !known.has(link.user));
	let removedDangling = 0;
	for (const link of dangling) {
		if (await accounts.unlink(link.provider, link.subject)) {
			removedDangling += 1;
		}
	}
	const linkedProxyUsers = new Set(
		accounts
			.list()
			.filter((link) => link.provider === "proxy")
			.map((link) => link.user),
	);
	const orphans = users
		.list()
		.filter(
			(record) => record.source === "proxy" && !linkedProxyUsers.has(record.user),
		)
		.map((record) => record.user);
	return { removedDangling, orphans };
}
