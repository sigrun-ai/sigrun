/**
 * The ambient seam (spec: docs/approval-ux-seams.md, "Ambient surfaces";
 * the block mapping: UI-blocks design §9.2): core-owned,
 * channel-neutral records for persistent read-mostly state — statusline
 * slots and panel widgets — written by extensions through the host
 * context and rendered by channels generically.
 *
 * SPLIT (build-and-webui Task 1): the canonical TYPE declarations live in
 * the `@sigrun/shared` package (`shared/src/ambient.ts` — the records ride
 * the §5 wire as-is, so the shapes ARE the channel contract); this module
 * owns the docs, validation, and registry RUNTIME, importing the types
 * (type-only — no runtime dependency on the built package).
 *
 * Lifecycle difference from interactions: an ambient surface is replaced
 * repeatedly (write = FULL state replacement, never a delta) and never
 * blocks. One slot key is owned by exactly one extension (allocation,
 * not silent composition — the pi-zentui chrome-skin lesson).
 *
 * Layering mirrors the interaction seam: strict envelope (key, place,
 * budget, refresh, expires) around a block-tree body (placement
 * `ambient`; `status`/`footer` allow one line), with opaque `details`.
 * Legacy-shaped bodies FAIL with paths (ruling 16).
 */

import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type {
	ConversationDocFamilyToken,
} from "@earendil-works/pi-durable";
import type {
	AmbientPlace,
	AmbientRecord,
} from "@sigrun/shared/ambient";
import { validateTree } from "../blocks/validate.js";
import type { StoredTree } from "./interactions.js";

export type { AmbientPlace, AmbientRecord } from "@sigrun/shared/ambient";

/**
 * The ambient record as the doc family stores it: the public wire record
 * with `body` mirrored (`StoredTree`, imported from the interaction seam
 * — one spelling of the mirror). Identical at runtime; `validateAmbient`
 * gates every write through `validateTree`.
 */
export type StoredAmbientRecord = Omit<AmbientRecord, "body"> & {
	readonly body?: StoredTree;
};

/**
 * Narrow a stored record to the public wire record. SAFETY: the two
 * shapes are identical at runtime — a stored body passed `validateTree`
 * (placement `ambient`) at write time, and a validated tree IS the JSON
 * the mirror describes; the cast only restores the type-level naming
 * `JsonObject`-erasure removed.
 */
export function asAmbientRecord(
	value: Readonly<StoredAmbientRecord>,
): Readonly<AmbientRecord> {
	return value as unknown as Readonly<AmbientRecord>;
}

/**
 * The ambient record family: one record per surface key, per conversation.
 * (Session-scoped statuslines that outlive one conversation are a v2
 * concern; channels today render conversation-scoped state.)
 */
export const AmbientDoc: ConversationDocFamilyToken<StoredAmbientRecord, string> =
	defineDocFamily<StoredAmbientRecord, string>({
		kind: "sigrun.ambient",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		family: true,
		initial: (key: string) => ({
			key,
			owner: "",
			place: "status",
			expires: "never",
			updatedAt: 0,
		}),
	});

/**
 * The ambient slot registry (session singleton): surface key -> owning
 * extension name. One owner per key; a second claimant fails loud (the
 * host context refuses the write) — allocation, not silent composition.
 */
export type AmbientOwners = {
	readonly owners: Record<string, string>;
}

export const AmbientOwnersDoc = defineDoc<AmbientOwners>({
	kind: "sigrun.ambient.owners",
	version: 1,
	scope: "session",
	initial: () => ({ owners: {} }),
});

const PLACES: ReadonlySet<string> = new Set(["status", "footer", "panel"]);
const OVERFLOWS: ReadonlySet<string> = new Set(["drop", "wrap", "summarize"]);

/**
 * Structural validation of one ambient record: the envelope's own checks,
 * then the body tree through `validateTree({placement: "ambient"})` with
 * the one-line rule for `status`/`footer` (§9.2). Returns the error text
 * (with the tree paths) or null.
 */
export function validateAmbient(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return "ambient record must be an object";
	}
	const r = value as Record<string, unknown>;
	if (typeof r.key !== "string" || r.key.length === 0) {
		return "key must be a non-empty string";
	}
	if (typeof r.place !== "string" || !PLACES.has(r.place)) {
		return `place must be one of status|footer|panel (got ${String(r.place)})`;
	}
	if (r.maxRows !== undefined && typeof r.maxRows !== "number") {
		return "maxRows must be a number";
	}
	if (r.overflow !== undefined && !OVERFLOWS.has(String(r.overflow))) {
		return `overflow must be one of drop|wrap|summarize (got ${String(r.overflow)})`;
	}
	if (r.refreshMs !== undefined && typeof r.refreshMs !== "number") {
		return "refreshMs must be a number";
	}
	if (r.expires !== "never" && r.expires !== "idle") {
		return `expires must be "never" or "idle" (got ${String(r.expires)})`;
	}
	if (typeof r.updatedAt !== "number") {
		return "updatedAt must be a number";
	}
	const body = r.body;
	if (body === undefined) return null; // an empty write clears the surface
	// Ruling 16 (no compatibility layer): legacy-shaped bodies (objects
	// keyed line/rows/gauge/ledger rather than {v, root}) fail HERE, with
	// the path — a tree is {v, root}.
	const result = validateTree(body, {
		placement: "ambient",
		ambientPlace: r.place as AmbientPlace,
	});
	if (!result.ok) {
		const first = result.errors[0];
		if (first === undefined) return "body must be a block tree";
		// The tree-relative path joins the record's field ("body.root…")
		// so the error names where the record is wrong, not just the tree.
		return `body is not a valid ambient tree: body.${first.path} ${first.message}`;
	}
	return null;
}
