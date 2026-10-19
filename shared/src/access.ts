/**
 * Per-resource sharing and content access (core hardening W1 Task 5, spec
 * §5.9 ruling 6/10: per-resource sharing; groups cut).
 *
 * Part of the shared leaf package (`@sigrun/shared`): the server computes
 * access through `accessOf`, the clients render the `sharing` state — one
 * source of truth, no drift. PURE module: no imports at all (the
 * views-purity guard enforces this across `shared/src`).
 *
 * The rules, in order (first match wins):
 *
 * 1. superuser → write;
 * 2. ownerless resource → household write (everyone);
 * 3. user === owner → write;
 * 4. household sharing with a defined user → the shared level;
 * 5. people sharing including the user → the shared level;
 * 6. otherwise none (hidden: 404 on every :id route, absent from lists).
 *
 * Anonymous callers (a principal with no user) get nothing from a shared
 * resource: sharing widens access for identified users only (rule 4/5
 * require a defined user), while ownerless stays open to everyone by
 * rule 2.
 */

/** What a conversation's owner grants beyond themselves. */
export type Sharing =
	| { readonly scope: "private" }
	| { readonly scope: "household"; readonly level: "read" | "write" }
	| {
			readonly scope: "people";
			// The property is readonly; the ARRAY is mutable-typed because a
			// SessionMeta doc must stay JsonObject-assignable (pi-durable's
			// JsonValue arrays are mutable) — treat it as immutable anyway.
			readonly users: string[];
			readonly level: "read" | "write";
	  };

/** The resolved access level of a principal to one resource. */
export type Access = "none" | "read" | "write";

/** What accessOf needs of the caller (the server's Principal projects here). */
export interface AccessPrincipal {
	readonly user?: string;
	readonly superuser?: boolean;
}

/**
 * Resolve one principal's access to one resource. Rule order per the
 * module doc; the first matching rule wins.
 */
export function accessOf(
	p: AccessPrincipal,
	r: { readonly owner?: string; readonly sharing?: Sharing },
): Access {
	// 1. The superuser always writes.
	if (p.superuser === true) return "write";
	// 2. Ownerless is household-write for everyone.
	if (r.owner === undefined) return "write";
	// 3. The owner always writes.
	if (p.user !== undefined && p.user === r.owner) return "write";
	// 4./5. Sharing widens identified users only — an anonymous caller
	// (no user) falls straight through to none.
	if (p.user !== undefined && r.sharing !== undefined) {
		if (r.sharing.scope === "household") return r.sharing.level;
		if (r.sharing.scope === "people" && r.sharing.users.includes(p.user)) {
			return r.sharing.level;
		}
	}
	// 6. Hidden.
	return "none";
}

/**
 * Type guard for the wire value: every scope shape checked strictly
 * (wrong field types are not a Sharing). An empty `people.users` list is
 * valid (shares with nobody yet) — validation is about shape, not policy.
 */
export function isSharing(value: unknown): value is Sharing {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	switch (record.scope) {
		case "private":
			return true;
		case "household":
			return record.level === "read" || record.level === "write";
		case "people":
			return (
				Array.isArray(record.users) &&
				record.users.every((user) => typeof user === "string") &&
				(record.level === "read" || record.level === "write")
			);
		default:
			return false;
	}
}
