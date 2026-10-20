/**
 * The resolved caller (core hardening W1 Task 3, spec §5.2/§5.8): what
 * the auth pipeline stamps on every request and what `whoami` serves.
 * `method` names the proof — the empty-method naive path ("none"), a
 * verified token ("token"), or a trusted forward-auth header set
 * ("proxy"). `service` marks the env service token (it skips the
 * setup gate; it is not a directory user).
 *
 * SINGLE-SOURCE BRIDGE (core hardening W5 Task 2, the Task 1 review's
 * binding carry-forward): the shape is DECLARED ONCE, on the extension
 * contract (`Principal` in src/extension.ts, shipped as the types-only
 * `sigrun/extension` subpath) — this server-side name is a re-export of
 * it, so the pipeline, the routes, and every extension handler share
 * one spelling that cannot drift. The bridge lives HERE (server-side)
 * because the contract's import allowlist is pi-durable/pi-ai/shared:
 * the contract cannot import this module.
 */

import type { Principal as ContractPrincipal } from "../../extension.js";

export type Principal = ContractPrincipal;

/**
 * Whether `p` may act as the superuser (spec §5.8): the unauthenticated
 * naive principal on a loopback workstation (`method "none"` with no
 * user header — the single-operator default) or a service token.
 * Authenticated principals are superusers only via `admin`.
 */
export function isSuperuser(p: Principal): boolean {
	return (p.method === "none" && p.user === undefined) || p.service;
}
