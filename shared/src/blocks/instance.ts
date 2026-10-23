/**
 * The instance-key helpers the CHANNELS need (UI-blocks U3 Task 5, spec
 * §7.3): `canonicalJson` (the default `instanceKey`) and
 * `eventKeyWeb`/`eventKeyNode` (the wire `k` — sha256 hex of
 * `slug\0id\0key`). The server's copy lives in
 * `src/server/surfaces/instance.ts`; these are the DOM- and Node-safe
 * twins (WebCrypto's `crypto.subtle.digest` vs `node:crypto`), kept
 * byte-compatible by the shared canonical-JSON rule.
 *
 * The wire's purity rule holds: NO node: imports here — the Node flavor
 * is a separate module (`instance-node.ts`) so the webui never sees it.
 */

import type { JsonObject, JsonValue } from "../json.js";

/**
 * Canonical JSON: every object serializes with keys SORTED (recursive);
 * primitives and arrays serialize as usual. Two params objects equal up
 * to key order produce byte-identical strings — the same rule as the
 * server's `canonicalJson` (kept in sync by hand; both sides pin it by
 * test).
 */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value).sort();
		const parts = keys.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalJson(
					(value as JsonObject)[key] as JsonValue,
				)}`,
		);
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value) as string;
}

/** The default instance key (spec §7.3): canonical JSON of the params. */
export function instanceKey(params: JsonObject): string {
	return canonicalJson(params);
}

/** The hex encoding of a sha256 digest buffer. */
function hex(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/**
 * The wire `k` for one surface instance (spec §7.3), WebCrypto flavor:
 * `sha256(slug + "\0" + id + "\0" + key)` hex. Async (the DOM digest is
 * promise-shaped); the Node twin (`instance-node.ts`) is sync.
 */
export async function eventKeyWeb(
	slug: string,
	id: string,
	key: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode([slug, id, key].join("\u0000")),
	);
	return hex(digest);
}
