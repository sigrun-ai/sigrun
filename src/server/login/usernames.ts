import type { LoginResult } from "../../extension.js";

/** Assign a new directory username; this never selects an existing user. */
export function assignUsername(
	profile: LoginResult["profile"],
	subject: string,
	taken: (user: string) => boolean,
): string {
	const candidate = profile.username ?? profile.email?.split("@", 1)[0] ?? subject;
	const base = candidate
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/^[^a-z0-9]+/, "") || "user";
	if (!taken(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const candidateWithSuffix = `${base}-${suffix}`;
		if (!taken(candidateWithSuffix)) return candidateWithSuffix;
	}
}
