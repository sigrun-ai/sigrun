/**
 * CIDR allowlist membership for peer addresses (W1 Task 3): the proxy
 * method's trusted-proxies check. `net.BlockList` is the engine;
 * v4-mapped v6 spellings (`::ffff:10.42.3.4`) are folded to the v4
 * address first — a dual-stack socket reports v4 peers mapped, and the
 * allowlist spells v4 ranges.
 */

import { BlockList, isIP } from "node:net";

/** Fold a v4-mapped v6 spelling (`::ffff:10.42.3.4`) to the v4 address. */
export function normalizePeerAddress(address: string): string {
	const trimmed = address.trim();
	if (trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4) {
		return trimmed.slice(7);
	}
	return trimmed;
}

/**
 * Whether `address` (a socket remote address) falls in any of `cidrs`
 * (CIDR ranges or bare IPs). Malformed entries never match; an
 * undefined/unparseable address never matches.
 */
export function ipAllowed(
	address: string | undefined,
	cidrs: readonly string[],
): boolean {
	if (address === undefined) return false;
	const candidate = normalizePeerAddress(address);
	const family = isIP(candidate);
	if (family === 0) return false;
	const list = new BlockList();
	for (const entry of cidrs) {
		const trimmed = entry.trim();
		if (trimmed === "") continue;
		const slash = trimmed.indexOf("/");
		try {
			if (slash === -1) {
				const entryFamily = isIP(trimmed);
				if (entryFamily === 0) continue;
				list.addAddress(trimmed, entryFamily === 6 ? "ipv6" : "ipv4");
			} else {
				const base = trimmed.slice(0, slash);
				const prefix = Number(trimmed.slice(slash + 1));
				const entryFamily = isIP(base);
				if (entryFamily === 0 || !Number.isInteger(prefix)) continue;
				list.addSubnet(base, prefix, entryFamily === 6 ? "ipv6" : "ipv4");
			}
		} catch {
			// A malformed entry matches nothing (never trust everyone).
		}
	}
	return list.check(candidate, family === 6 ? "ipv6" : "ipv4");
}
