/**
 * The ambient seam TYPES (spec: docs/approval-ux-seams.md, "Ambient
 * surfaces"; the block mapping: UI-blocks design §9.2): the channel-neutral record
 * shapes for persistent read-mostly state — statusline slots and panel
 * widgets — written by extensions through the host context and rendered
 * by channels generically.
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
 * budget, refresh, expires) around a block-tree body (placement
 * `ambient`; `status`/`footer` allow one line), with opaque `details`.
 * The legacy `line`/`rows`/`gauge`/`ledger` primitives are REJECTED
 * (ruling 16: no compatibility layer).
 */

import type { Tree } from "./blocks/index.js";
import type { JsonObject } from "./json.js";

/** Where a channel places the surface. */
export type AmbientPlace = "status" | "footer" | "panel";

/** The strict envelope + block-tree body of one ambient surface. */
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
	/**
	 * The ambient body: a block tree (placement `ambient`). `status` and
	 * `footer` allow one line — a single line-level block or one
	 * `columns` of one-line blocks. Undefined = the surface is cleared.
	 * Legacy-shaped bodies fail validation (ruling 16).
	 */
	readonly body?: Tree;
	/** Opaque extension-owned payload; rendered collapsed, never interpreted. */
	readonly details?: JsonObject;
}
