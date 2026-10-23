/**
 * Instance keys (UI-blocks U3 Task 2, spec §7.3): a surface instance is
 * addressed by `(slug, id, key)` where `key` is `instanceKey(params)` —
 * by default the CANONICAL JSON of the params object, with every
 * object's keys sorted recursively, so `{a:1,b:2}` and `{b:2,a:1}`
 * address the same instance. An extension may override `instanceKey`
 * per surface; the spec's hash form (`eventKey`, sha256 over
 * `slug \0 id \0 key`) is what events name instances by — params never
 * appear on the wire (computed here so Task 4's events share it).
 */

import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";

/**
 * Canonical JSON: every object serializes with keys SORTED (recursive);
 * primitives and arrays serialize as usual. Two params objects equal up
 * to key order produce byte-identical strings.
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

/**
 * The default instance key (spec §7.3): canonical JSON of the params.
 * A surface's own `instanceKey` overrides this; the service applies the
 * override, this is the fallback.
 */
export function instanceKey(params: JsonObject): string {
	return canonicalJson(params);
}

/**
 * The wire name of an instance (spec §7.3): `sha256(slug + "\0" + id +
 * "\0" + key)` hex. Events carry `k`, never the key or the params.
 */
export function eventKey(slug: string, id: string, key: string): string {
	return createHash("sha256").update([slug, id, key].join("\u0000")).digest("hex");
}
