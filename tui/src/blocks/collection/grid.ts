/**
 * The `grid` display (UI-blocks spec §5.5 + §12.3): cards in as many
 * columns as fit — `floor(width / token)` with the token from the item
 * template's `image` presence (`m` = 45 cells with an image, `s` = 30
 * without; §5.5's minItemWidth). `overflow: "scroll"` stays one
 * horizontal row (the row clips at the pane edge; there is no second
 * row). At compact width the fallback is one column (§12.3).
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CollectionBlock } from "@sigrun/shared/blocks";
import { type BlockCtx } from "../context.js";
import { pad, truncate, widthClassOf } from "../width.js";
import { cardLines } from "./card.js";
import { collectionItems, sortItems, type CollectionItem } from "./shared.js";

/** `grid`: floor(width / token) card columns. */
export class GridComponent implements Component {
	readonly #block: CollectionBlock;
	readonly #ctx: BlockCtx;
	#tick = 0;

	constructor(block: CollectionBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
	}

	#rows(): CollectionItem[] {
		return sortItems(collectionItems(this.#block, this.#ctx), this.#block.sort);
	}

	render(width: number): string[] {
		this.#tick += 1;
		const rows = this.#rows();
		const itemWidth = this.#block.item.image === undefined ? 30 : 45; // s / m token (§5.2)
		let columns = Math.max(1, Math.floor(width / itemWidth));
		if (this.#block.overflow === "scroll") {
			// One row, clipped at the pane edge.
			columns = Math.max(1, columns);
			return this.#renderRow(rows, width, itemWidth).slice(0, this.#rowHeight(rows, itemWidth, width));
		}
		if (widthClassOf(width) === "compact") columns = 1;
		const lines: string[] = [];
		for (let start = 0; start < rows.length; start += columns) {
			lines.push(...this.#renderRow(rows.slice(start, start + columns), width, itemWidth));
		}
		return lines;
	}

	/** The tallest card of a row, in lines. */
	#rowHeight(rows: readonly CollectionItem[], itemWidth: number, width: number): number {
		let height = 0;
		for (const row of rows) {
			height = Math.max(
				height,
				cardLines(this.#block.item, row.item, this.#ctx, itemWidth - 2, 0, this.#tick).length,
			);
		}
		void width;
		return height;
	}

	/** One grid row: the cards side by side, each padded to `itemWidth`. */
	#renderRow(rows: readonly CollectionItem[], width: number, itemWidth: number): string[] {
		const perCard = rows.map((row) =>
			cardLines(this.#block.item, row.item, this.#ctx, itemWidth - 2, 0, this.#tick),
		);
		const height = perCard.reduce((max, card) => Math.max(max, card.length), 0);
		const lines: string[] = [];
		for (let line = 0; line < height; line++) {
			const cells = perCard.map((card) => pad(card[line] ?? "", itemWidth - 2));
			const joined = cells.join("  ");
			const text = joined.trimEnd() === "" ? "" : joined;
			if (text === "") {
				lines.push("");
			} else {
				lines.push(truncate(text.replace(/\s+$/, ""), width));
			}
		}
		return lines;
	}

	invalidate(): void {
		// The grid holds no view state beyond the spinner tick.
	}
}
