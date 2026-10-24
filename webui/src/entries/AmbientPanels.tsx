/**
 * Ambient surfaces (the seam's channel half, docs/approval-ux-seams.md),
 * UI-blocks U6 Task 3: keyed status/panel surfaces rendered FROM BLOCK
 * TREES (placement `ambient`, spec §9.2).
 *
 * The `place` envelope field picks the chrome zone:
 *
 * - `status`: one line in the status bar — the body is a single
 *   line-level block (§9.2's one-line rule), rendered inline.
 * - `footer`: the left/middle/right zones — the body is one `columns`
 *   of one-line blocks, rendered inline per column.
 * - `panel`: the full tree above the composer.
 *
 * The envelope's `maxRows`/`overflow` budget applies to a panel's
 * root literal-rows collection (Review Focus 3): `drop` renders the
 * first `maxRows` cards and folds the rest behind "N more" (the
 * collection's quiet bucket), `summarize` replaces the tail with a
 * count line. Quiet cards fold via the collection's own quiet bucket.
 *
 * Ambient bodies carry LITERAL content only (the 2026-10-24 ruling:
 * no collection bindings — the envelope has no data document), so the
 * surface renders against an empty data document. Purely read-only —
 * ambient surfaces don't take answers (actions re-route through
 * interaction records). `details` renders collapsed, never interpreted.
 */

import type { ReactNode } from "react";
import type {
	Block,
	CollectionBlock,
	JsonObject,
	JsonValue,
} from "@sigrun/shared/blocks";
import type { AmbientWire } from "../api";
import { BlockView } from "../blocks/BlockView";
import {
	SurfaceActionsContext,
	SurfaceDataContext,
} from "../blocks/context";
import { ContainerWidth } from "../blocks/width";

/** Ambient bodies never bind (the ruling): the data document is empty. */
const EMPTY_DATA: JsonObject = {};

/** The renderer's standalone actions context (read-only). */
const AMBIENT_ACTIONS = {
	dispatch: (): void => {},
	access: "read" as const,
	viewState: {} as JsonObject,
	serverErrors: {} as Readonly<Record<string, string>>,
	setView: (): void => {},
};

/** The quiet fold for the drop overflow: mark the tail rows quiet so
 *  the collection's own "N more" toggle carries them (the panel's
 *  budget never LOSES rows — the user can still unfold). A template
 *  WITHOUT a `quiet` binding has no fold to ride (its isQuiet is
 *  always false), so the budget falls back to truncating the tail
 *  behind a one-line "<n> more" markdown row (Review fix — a
 *  quiet-less template's drop overflow silently no-op'd). */
function dropTail(
	collection: CollectionBlock,
	items: readonly JsonValue[],
	maxRows: number,
): Block {
	// No quiet binding: truncate + count line (the fold has nothing to
	// key on).
	if (collection.item.quiet === undefined) {
		const visible = items.slice(0, maxRows);
		const dropped = items.length - visible.length;
		// SAFETY: same block with a literal array swapped in (the ambient
		// literal-rows shape the schema now admits).
		const trimmed = { ...collection, items: [...visible] } as CollectionBlock;
		return {
			type: "stack",
			children: [trimmed, { type: "markdown", text: `${dropped} more` }],
		};
	}
	const visible = items.slice(0, maxRows);
	const tail = items.slice(maxRows).map((row) => {
		if (typeof row === "object" && row !== null && !Array.isArray(row)) {
			return { ...(row as JsonObject), quiet: true } as JsonValue;
		}
		return row;
	});
	// SAFETY: `items` is the same block with a literal array swapped in
	// (the ambient literal-rows shape the schema now admits); every other
	// prop is verbatim.
	return { ...collection, items: [...visible, ...tail] } as CollectionBlock;
}

/** Apply the panel row budget (Review Focus 3): only a root
 *  literal-rows collection on a panel surface budgets; anything else
 *  renders as authored. */
function budgetTree(surface: AmbientWire, root: Block): Block {
	if (surface.place !== "panel" || root.type !== "collection") return root;
	if (!Array.isArray(root.items)) return root; // bound elsewhere; ambient rejects these
	const maxRows = surface.maxRows;
	if (maxRows === undefined || root.items.length <= maxRows) return root;
	const dropped = root.items.length - maxRows;
	if (surface.overflow === "summarize") {
		// The count line: one markdown under the trimmed collection.
		return {
			type: "stack",
			children: [
				{ ...root, items: root.items.slice(0, maxRows) },
				{ type: "markdown", text: `${dropped} rows` },
			],
		};
	}
	if (surface.overflow === "wrap") return root; // panels wrap rows — no fold
	return dropTail(root, root.items, maxRows);
}

/** Render one ambient body (already placement-legal). */
function AmbientBody(props: { surface: AmbientWire }): ReactNode {
	const body = props.surface.body;
	if (body === undefined) return null;
	const root = budgetTree(props.surface, body.root);
	return (
		<SurfaceDataContext.Provider
			value={{ data: EMPTY_DATA, locale: navigator.language }}
		>
			<SurfaceActionsContext.Provider value={AMBIENT_ACTIONS}>
				<ContainerWidth>
					<BlockView block={root} />
				</ContainerWidth>
			</SurfaceActionsContext.Provider>
		</SurfaceDataContext.Provider>
	);
}

/** One ambient surface in its envelope. */
export function AmbientPanel(props: { surface: AmbientWire }): ReactNode {
	const { surface } = props;
	if (surface.body === undefined && surface.details === undefined) {
		return null;
	}
	return (
		<div
			className="ambient-surface"
			data-key={surface.key}
			data-place={surface.place}
		>
			<AmbientBody surface={surface} />
			{surface.details !== undefined && (
				<details className="ambient-details">
					<summary>details</summary>
					<pre>{JSON.stringify(surface.details, null, 2)}</pre>
				</details>
			)}
		</div>
	);
}

/** The ambient zone: one panel per surface key, stable order. */
export function AmbientPanels(props: {
	surfaces: readonly AmbientWire[];
}): ReactNode {
	const { surfaces } = props;
	if (surfaces.length === 0) return null;
	return (
		<div className="ambient-panels">
			{surfaces.map((surface) => (
				<AmbientPanel key={surface.key} surface={surface} />
			))}
		</div>
	);
}
