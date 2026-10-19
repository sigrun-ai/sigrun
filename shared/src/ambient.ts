/**
 * The ambient seam TYPES (spec: docs/approval-ux-seams.md, "Ambient
 * surfaces"): the channel-neutral record shapes for persistent
 * read-mostly state — statusline slots and panel widgets — written by
 * extensions through the host context and rendered by channels
 * generically.
 *
 * The CANONICAL type declarations live here (the shared leaf package);
 * `src/harness/ambient.ts` imports them (type-only) for the doc
 * definitions and validation runtime. The records ride the §5 wire
 * AS-IS (envelope + body + details — never projected), so these shapes
 * are the channel contract too (see `@sigrun/shared/views`).
 *
 * Lifecycle difference from interactions: an ambient surface is replaced
 * repeatedly (write = FULL state replacement, never a delta) and never
 * blocks. One slot key is owned by exactly one extension (allocation,
 * not silent composition — the pi-zentui chrome-skin lesson).
 *
 * Layering mirrors the interaction seam: strict envelope (key, place,
 * budget, refresh, expires) around a body composed only from the closed
 * ambient primitives (line, rows, gauge, ledger), with opaque `details`.
 */

import type { JsonObject } from "./json.js";

/** Where a channel places the surface. */
export type AmbientPlace = "status" | "footer" | "panel";

/** One widget row (primitive B). */
export type AmbientRow = {
	readonly id: string;
	readonly label: string;
	/** Channel-schemed glyph state (todo statuses, agent run states). */
	readonly status?: string;
	/** Severity ordering/color: 0 = severe .. 2 = quiet. */
	readonly severity?: 0 | 1 | 2;
	/** Folded away by default (warden's quiet verdicts). */
	readonly quiet?: boolean;
	readonly detail?: string;
	/** Nesting depth for tree rendering (pi-goal-x task tree). */
	readonly depth?: number;
	/** Dependency ids for marker rendering (rpiv-todo blockedBy). */
	readonly deps?: string[];
	/** Present-continuous spinner label while the row is active. */
	readonly spinnerLabel?: string;
	readonly metrics?: AmbientMetrics;
}

/** Numeric metrics with an optional derived-format hint. */
export type AmbientMetrics = {
	readonly tokens?: number;
	readonly cost?: number;
	readonly current?: number;
	readonly total?: number;
	readonly completed?: number;
	/** Derived display hint for numeric fields ("2.5k", currency) — the
	 * host-reuse lesson from every footer extension. */
	readonly format?: "compact" | "usd" | "percent";
}

/** The `line` primitive: one keyed statusline/footer line, optionally segmented. */
export type AmbientLine = {
	readonly text: string;
	/** Segmented composition for powerline-style slots (pi-powerline,
	 * pi-zentui): sub-segments with placement zones. */
	readonly segments?: {
		readonly id: string;
		readonly text: string;
		readonly place?: "left" | "middle" | "right";
	}[];
}

/** The `gauge` primitive: live progress with optional check rows. */
export type AmbientGauge = {
	readonly label: string;
	readonly percent?: number;
	readonly phase?: string;
	readonly elapsedMs?: number;
	readonly recentOutput?: string[];
	/** Check rows (pi-goal-x auditor): row-shaped, same schema as rows[]. */
	readonly checks?: AmbientRow[];
}

/** One ledger entry (primitive D): append-style feed with per-entry amend. */
export type AmbientLedgerEntry = {
	readonly id: string;
	readonly at: number;
	readonly kind: string;
	readonly summary: string;
	readonly detail?: string[];
}

/** The ambient body: ONLY these keys, each from the closed primitives. */
export type AmbientBody = {
	readonly line?: AmbientLine;
	readonly rows?: AmbientRow[];
	readonly gauge?: AmbientGauge;
	readonly ledger?: AmbientLedgerEntry[];
}

/** The strict envelope + closed-primitive body of one ambient surface. */
export type AmbientRecord = {
	/** The keyed slot id ("goal", "rpiv-todos", "fabric"). */
	readonly key: string;
	/** Which extension owns this key (set by the host context, not the author). */
	readonly owner: string;
	readonly place: AmbientPlace;
	/** Panel row budget / line-slot width guidance (channel advisory). */
	readonly maxRows?: number;
	/** Overflow policy for panels (rpiv-todo's drop-completed-first rule). */
	readonly overflow?: "drop" | "wrap" | "summarize";
	/** Channel re-render hint between data writes (countdowns, clocks), ms. */
	readonly refreshMs?: number;
	/** Auto-clear rule: "never" stays until replaced with an empty body. */
	readonly expires: "never" | "idle";
	readonly updatedAt: number;
	readonly body?: AmbientBody;
	/** Opaque extension-owned payload; rendered collapsed, never interpreted. */
	readonly details?: JsonObject;
}
