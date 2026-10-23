/**
 * The per-placement size limits of spec §4.5: max blocks per tree, and
 * max UTF-8 bytes of the serialized JSON for the tree and the data.
 *
 * Over a limit the server rejects with `413 surface_too_large` naming
 * the limit; `validateTree`/`validateData` surface the same error
 * strings. A collection counts as one block however many items it
 * binds, and a `data:` image URL counts toward whichever of the tree or
 * the data holds it (the sizes are measured over the serialized JSON,
 * so both hold by construction).
 */

import type { Placement } from "@sigrun/shared/blocks";

/** One row of the §4.5 limits table. */
export interface PlacementLimits {
	/** Max blocks in one tree (a collection counts as one). */
	readonly blocks: number;
	/** Max UTF-8 bytes of the serialized tree JSON. */
	readonly treeBytes: number;
	/** Max UTF-8 bytes of the serialized data JSON. */
	readonly dataBytes: number;
}

const KiB = 1024;
const MiB = 1024 * 1024;

/** Spec §4.5, one row per placement. */
export const LIMITS: Readonly<Record<Placement, PlacementLimits>> = {
	chat: { blocks: 200, treeBytes: 256 * KiB, dataBytes: 256 * KiB },
	interaction: { blocks: 100, treeBytes: 64 * KiB, dataBytes: 64 * KiB },
	ambient: { blocks: 100, treeBytes: 64 * KiB, dataBytes: 64 * KiB },
	view: { blocks: 2000, treeBytes: MiB, dataBytes: 4 * MiB },
	panel: { blocks: 2000, treeBytes: MiB, dataBytes: 4 * MiB },
	settings: { blocks: 2000, treeBytes: MiB, dataBytes: 4 * MiB },
};

/** UTF-8 byte length of a value's serialized JSON (spec §4.5 sizing). */
export function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
