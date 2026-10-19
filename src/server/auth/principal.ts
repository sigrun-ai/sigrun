/**
 * The resolved caller (core hardening W1 Task 3, spec §5.2/§5.8): what
 * the auth pipeline stamps on every request and what `whoami` serves.
 * `method` names the proof — the empty-method naive path ("none"), a
 * verified token ("token"), or a trusted forward-auth header set
 * ("proxy"). `service` marks the env service token (it skips the
 * setup gate; it is not a directory user).
 */

export interface Principal {
	/** The directory username; `undefined` under the naive method with no header. */
	readonly user: string | undefined;
	readonly name?: string;
	readonly email?: string;
	readonly admin: boolean;
	/** True for the `SIGRUN_API_TOKEN` service principal. */
	readonly service: boolean;
	readonly method: "none" | "token" | "proxy";
}

/**
 * Whether `p` may act as the superuser (spec §5.8): the unauthenticated
 * naive principal on a loopback workstation (`method "none"` with no
 * user header — the single-operator default) or a service token.
 * Authenticated principals are superusers only via `admin`.
 */
export function isSuperuser(p: Principal): boolean {
	return (p.method === "none" && p.user === undefined) || p.service;
}
