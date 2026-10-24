/**
 * The refused-address ranges for image-proxy fetching (UI-blocks U7,
 * spec §11.2 verbatim): loopback, `0.0.0.0/8`, RFC 1918 private,
 * link-local, CGNAT `100.64.0.0/10`, unique-local `fc00::/7`,
 * multicast, and the IPv4-mapped IPv6 forms of all of them.
 *
 * IPv4-mapped literals (`::ffff:10.0.0.1`) are normalized by
 * `BlockList.check`, so the IPv4 rules cover every mapped form in
 * both dotted and full 8-group notation. Anything that is not an IP
 * literal at all is refused too (fail closed): the fetcher connects
 * only to literals the vetting understood.
 */

import { BlockList, isIP } from "node:net";

const REFUSED = new BlockList();

// IPv4
REFUSED.addSubnet("0.0.0.0", 8, "ipv4");
REFUSED.addSubnet("127.0.0.0", 8, "ipv4");
REFUSED.addSubnet("10.0.0.0", 8, "ipv4");
REFUSED.addSubnet("172.16.0.0", 12, "ipv4");
REFUSED.addSubnet("192.168.0.0", 16, "ipv4");
REFUSED.addSubnet("169.254.0.0", 16, "ipv4");
REFUSED.addSubnet("100.64.0.0", 10, "ipv4");
REFUSED.addSubnet("224.0.0.0", 4, "ipv4");
REFUSED.addAddress("255.255.255.255", "ipv4");
// IPv6
REFUSED.addSubnet("::", 128, "ipv6");
REFUSED.addSubnet("::1", 128, "ipv6");
REFUSED.addSubnet("fc00::", 7, "ipv6");
REFUSED.addSubnet("fe80::", 10, "ipv6");
REFUSED.addSubnet("ff00::", 8, "ipv6");

/** True when `ip` is an address the image proxy must never connect to. */
export function isRefusedAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) return REFUSED.check(ip, "ipv4");
	if (family === 6) return REFUSED.check(ip, "ipv6");
	return true;
}
