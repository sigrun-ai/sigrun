/**
 * The C5 own-host rule (proxy-trust Task 4b): a peer that IS this host —
 * loopback (127.0.0.0/8, ::1) or any current interface address — can
 * reach the server without traversing the forward-auth proxy, because
 * every local process shares those source addresses. Trusting such a
 * peer through a CIDR RANGE would let any local process impersonate
 * users, so an own-host peer vouches only when:
 *
 *  1. the shared secret is configured (`secret` + `secretHeader`) — the
 *     existing secret check then decides; or
 *  2. that exact address is listed explicitly in `trustedProxies` (a
 *     bare address, or a /32 (IPv4) / /128 (IPv6) entry) — an explicit
 *     operator decision, which the boot warning surfaces.
 *
 * Otherwise both identity-trust paths (the request pipeline's proxy
 * method and onboarding's `resolveProxyIdentity`) reject exactly the
 * way an untrusted peer is rejected, with the OWN_HOST diagnostic.
 */

import { networkInterfaces } from "node:os";
import { isIP } from "node:net";

/** Interface addresses refresh at most this often (milliseconds). */
const CACHE_TTL_MS = 30_000;

let testAddresses: readonly string[] | undefined;
let cached: { readonly addresses: readonly string[]; readonly readAt: number } | undefined;

/** The seam override, or the real interface list (cached ≤ 30 s). */
function ownHostAddresses(): readonly string[] {
	if (testAddresses !== undefined) return testAddresses;
	const now = Date.now();
	if (cached === undefined || now - cached.readAt >= CACHE_TTL_MS) {
		const addresses: string[] = [];
		for (const entries of Object.values(networkInterfaces())) {
			for (const entry of entries ?? []) addresses.push(entry.address);
		}
		cached = { addresses, readAt: now };
	}
	return cached.addresses;
}

/**
 * Fold a v4-mapped v6 spelling (`::ffff:10.42.9.9`) to the v4 address —
 * `ipAllowed`'s normalization, so the own-host check sees the same
 * address the allowlist check did.
 */
function unwrap(address: string): string {
	const trimmed = address.trim();
	if (trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4) {
		return trimmed.slice(7);
	}
	return trimmed;
}

function isLoopback(address: string): boolean {
	if (address === "::1") return true;
	if (isIP(address) !== 4) return false;
	return address.split(".")[0] === "127";
}

/** Loopback (127.0.0.0/8, ::1) or any current interface address; `::ffff:` unwrapped. */
export function isOwnHostAddress(address: string | undefined): boolean {
	if (address === undefined) return false;
	const candidate = unwrap(address);
	if (isLoopback(candidate)) return true;
	return ownHostAddresses().some((entry) => unwrap(entry) === candidate);
}

/** True when `address` is listed exactly in `cidrs`: a bare address, or a /32 (IPv4) or /128 (IPv6) entry for it. */
export function listedExactly(address: string, cidrs: readonly string[]): boolean {
	const candidate = unwrap(address);
	for (const raw of cidrs) {
		const entry = raw.trim();
		if (entry === "") continue;
		const slash = entry.indexOf("/");
		if (slash === -1) {
			if (unwrap(entry) === candidate) return true;
			continue;
		}
		const base = unwrap(entry.slice(0, slash));
		if (base !== candidate) continue;
		const prefix = Number(entry.slice(slash + 1));
		const family = isIP(candidate);
		if (family === 4 && prefix === 32) return true;
		if (family === 6 && prefix === 128) return true;
	}
	return false;
}

/** The C5 rule: false only for an own-host peer reached through a range with no shared secret configured. */
export function ownHostPeerPermitted(
	address: string | undefined,
	trustedProxies: readonly string[],
	secretConfigured: boolean,
): boolean {
	if (!isOwnHostAddress(address)) return true;
	if (secretConfigured) return true;
	return listedExactly(address!, trustedProxies);
}

/** Test seam: replace the interface addresses (loopback stays implicit); `undefined` restores os.networkInterfaces(). */
export function setOwnHostAddressesForTests(addresses: readonly string[] | undefined): void {
	testAddresses = addresses;
	cached = undefined;
}

/** Explicitly listed own-host entries (verbatim spellings), for the boot warning. */
export function listedOwnHostEntries(trustedProxies: readonly string[]): string[] {
	return trustedProxies.filter((entry) => {
		const trimmed = entry.trim();
		if (trimmed === "") return false;
		const slash = trimmed.indexOf("/");
		const base = slash === -1 ? trimmed : trimmed.slice(0, slash);
		if (slash !== -1) {
			const prefix = Number(trimmed.slice(slash + 1));
			const family = isIP(unwrap(base));
			if (family === 4 && prefix !== 32) return false;
			if (family === 6 && prefix !== 128) return false;
			if (family === 0) return false;
		}
		return isOwnHostAddress(base);
	});
}
