/**
 * The §5.9 job access rule, shared (tabs+skills Task 5): moved OUT of
 * `routes/jobs.ts` unchanged in behaviour so the REST routes and the
 * `core/jobs` view (`core-views/jobs.ts`) resolve the SAME verdicts —
 * hidden is absence/404 everywhere, never a 403 tell; a read-only
 * caller on a write path is the one 403.
 *
 * Two shapes, exactly the routes' old inline logic:
 *
 * - {@link jobAccess} — the access verdict for one LIVE row (the
 *   record's owner/sharing through `accessOf`);
 * - {@link resolveJob} — one job resolved for the access rule: the
 *   live record's row when it exists; for a RETIRED job (the history
 *   routes' case) the newest revision's shape, which answers until
 *   retention trims the records. `undefined` only when neither exists.
 */

import { accessOf, type Access, type AccessPrincipal, type Sharing } from "@sigrun/shared/access";
import type { JobWire } from "@sigrun/shared/jobs";
import type { JobsService } from "../jobs/index.js";

/** The §5.9 resource form ({owner?, sharing?}) of a job row. */
function resourceOf(row: { owner?: string; sharing?: Sharing }) {
	return {
		...(row.owner === undefined ? {} : { owner: row.owner }),
		...(row.sharing === undefined ? {} : { sharing: row.sharing }),
	};
}

/** One job resolved for the access rule: the row + the caller's access. */
export interface ResolvedJob {
	readonly row: Omit<JobWire, "access">;
	readonly access: Access;
}

/** The caller's access to one LIVE job row (§5.9 `accessOf`). */
export function jobAccess(
	principal: AccessPrincipal,
	row: Omit<JobWire, "access">,
): Access {
	return accessOf(principal, resourceOf(row));
}

/**
 * Resolve one job for the access rule: the live record's row when it
 * exists; for a RETIRED job the newest revision's shape (access is
 * evaluated against that revision's owner/sharing — the record is gone
 * with the retire). `undefined` only when neither exists (unknown id).
 */
export async function resolveJob(
	jobs: JobsService,
	principal: AccessPrincipal,
	id: string,
): Promise<ResolvedJob | undefined> {
	const wire = await jobs.get(id);
	if (wire !== undefined) {
		const { access: _ignored, ...row } = wire;
		return { row, access: accessOf(principal, resourceOf(row)) };
	}
	// Retired: the newest revision answers until retention trims it.
	const [newest] = await jobs.revisions(id);
	if (newest === undefined) return undefined;
	const row: Omit<JobWire, "state" | "access"> = {
		id,
		name: newest.spec.name,
		source: newest.source,
		...(newest.owner === undefined ? {} : { owner: newest.owner }),
		...(newest.sharing === undefined ? {} : { sharing: newest.sharing }),
		schedule: newest.spec.schedule,
		action: newest.spec.action,
		enabled: newest.enabled,
		version: newest.version,
	};
	return {
		// The retired row's status went with the record; the nudge only
		// needs identity + definition (clients refetch the list).
		row: { ...row, state: "disabled" },
		access: accessOf(principal, resourceOf(row)),
	};
}
