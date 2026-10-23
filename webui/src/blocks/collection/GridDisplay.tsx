/**
 * The grid display (UI-blocks U1 Task 3, spec §5.5): cards in as many
 * columns as fit. `minItemWidth` comes from the item template's `image`
 * presence (`m` with images, `s` without); `overflow: "wrap"` (default)
 * reflows, `overflow: "scroll"` stays one horizontal row (§12.3: the
 * compact single-column fallback does NOT apply to `scroll`).
 */

import type { ReactNode } from "react";
import type { CollectionBlock, Size } from "@sigrun/shared/blocks";
import { useWidthRem } from "../width";
import { type PreparedGroup } from "./Collection";
import { CardView } from "./Card";
import {
	BulkActionBar,
	useActivate,
	useCollectionView,
} from "./rows";

/** The size tokens in rem (shared with layout's grid). */
const SIZE_REM: Readonly<Record<Size, number>> = { s: 16, m: 24, l: 32 };

/** The minimum item width (spec §5.5: `m` when the template carries an
 *  image, `s` without). */
function minItemWidth(block: CollectionBlock): Size {
	return block.item.image !== undefined ? "m" : "s";
}

/** The grid display. */
export function GridDisplay(props: {
	block: CollectionBlock;
	groups: readonly PreparedGroup[];
}): ReactNode {
	const view = useCollectionView(props.block);
	const activate = useActivate(props.block);
	const rem = useWidthRem();
	const minWidth = minItemWidth(props.block);
	const scroll = props.block.overflow === "scroll";
	// The template columns: `scroll` forces one track (one horizontal
	// row); otherwise auto-fill at the minimum item width — compact
	// (`useWidthRem` measured under the min) collapses to one column,
	// matching §12.3's "one column" for wrap grids.
	const template = scroll
		? "1fr"
		: rem !== null && SIZE_REM[minWidth] > rem
			? "1fr"
			: `repeat(auto-fill, minmax(${SIZE_REM[minWidth]}rem, 1fr))`;
	const items = props.groups.flatMap((group) => [
		...group.buckets.visible,
		...group.buckets.quiet,
	]);
	return (
		<div
			className="blk blk-collection blk-grid-display"
			data-display="grid"
			data-overflow={props.block.overflow ?? "wrap"}
		>
			<BulkActionBar block={props.block} selection={view.selection} />
			<div
				className="blk-grid-items"
				style={{
					gridTemplateColumns: template,
					overflowX: scroll ? "auto" : undefined,
				}}
			>
				{items.map((prepared) => (
					<div
						key={prepared.id}
						className="blk-grid-card"
						data-item-id={prepared.id}
						onClick={() => activate(prepared.id)}
					>
						<CardView card={props.block.item} item={prepared.item} display="grid" />
					</div>
				))}
			</div>
		</div>
	);
}
