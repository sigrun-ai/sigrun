/**
 * The loopback test shared by the auth surface (core-hardening W1).
 *
 * Two consumers with one notion of "local": `effectiveMethods` (the
 * defaults ruling — `[]` methods on a loopback bind, `["token"]`
 * otherwise) and Task 3's pipeline Host check (a loopback bind only
 * accepts loopback `Host` values). The set is `127.0.0.0/8`, `::1`,
 * and `localhost` (spec §5.2) — deliberately NOT `::` or link-local:
 * binding those exposes the server beyond this machine.
 */

import { BlockList, isIP } from "node:net";

const v4Loopback = new BlockList();
v4Loopback.addSubnet("127.0.0.0", 8);
const v6Loopback = new BlockList();
// The family hints are required: BlockList's auto-detection does not
// accept `::1` at add time and does not match it at check time (Node 26
// behavior, verified — the plan's Review Focus 1 assumes explicit
// normalization/family handling around BlockList, which is this).
v6Loopback.addAddress("::1", "ipv6");

/**
 * Whether `host` is a loopback bind address: any `127.x.x.x`, `::1`
 * (including its expanded, bracketed, and v4-mapped spellings), or the
 * `localhost` name (case-insensitive). Everything else — the container
 * default `0.0.0.0`, `::`, LAN addresses, other hostnames — is not.
 */
export function isLoopbackHost(host: string): boolean {
	let candidate = host.trim().toLowerCase();
	// The URL-hostname form brackets IPv6 literals.
	if (candidate.startsWith("[") && candidate.endsWith("]")) {
		candidate = candidate.slice(1, -1);
	}
	if (candidate === "localhost") return true;
	// A v4-mapped v6 address binds the v4 address it maps to (Node
	// accepts `::ffff:127.0.0.1` as a bind address; BlockList does not
	// fold the mapping itself).
	if (
		candidate.startsWith("::ffff:") &&
		isIP(candidate.slice(7)) === 4
	) {
		candidate = candidate.slice(7);
	}
	const family = isIP(candidate);
	if (family === 4) return v4Loopback.check(candidate);
	if (family === 6) return v6Loopback.check(candidate, "ipv6");
	return false;
}
