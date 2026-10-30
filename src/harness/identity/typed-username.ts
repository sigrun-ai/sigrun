/**
 * Resolve an operator-typed username to its canonical key. Typed entry
 * points refuse collisions rather than silently suffixing them; the caller
 * owns the surrounding claim/admission locking and supplies `taken`.
 */

import { deriveUsername } from "@sigrun/shared/usernames";

export type NormalizedTypedUsername =
	| { ok: true; key: string }
	| { ok: false; error: "invalid_username" | "username_taken" };

/** Derive a typed username, refusing unusable input and existing keys. */
export function normalizeTypedUsername(
	input: string,
	taken: (key: string) => boolean,
): NormalizedTypedUsername {
	const key = deriveUsername(input);
	if (key === undefined) return { ok: false, error: "invalid_username" };
	if (taken(key)) return { ok: false, error: "username_taken" };
	return { ok: true, key };
}
