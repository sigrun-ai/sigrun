import { timingSafeEqual } from "node:crypto";

/** Constant-time setup-code comparison shared by every claim surface. */
export function setupCodeMatches(
	presented: string | undefined,
	expected: string | undefined,
): boolean {
	if (presented === undefined || expected === undefined) return false;
	const left = Buffer.from(presented, "utf8");
	const right = Buffer.from(expected, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}
