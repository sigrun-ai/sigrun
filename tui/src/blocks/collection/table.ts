/**
 * The `table` display (UI-blocks spec §5.5 + §12.3): display-width
 * aligned columns (CJK-safe via pi-tui's `visibleWidth`), `s` picks a
 * sortable column and cycles asc → desc, 50 rows per page with
 * PgUp/PgDn, and the compact fallback — rows as cards with
 * `priority: "low"` columns behind Enter-expand.
 *
 * Sort and page are view-only (§6.2): they never dispatch. The footer
 * carries the page range ("1–50 of 120"); the sort menu lists the
 * sortable columns only.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatValue } from "@sigrun/shared/blocks";
import type { CollectionBlock, CollectionColumn, CollectionSort, JsonObject } from "@sigrun/shared/blocks";
import { bindText, type BlockCtx } from "../context.js";
import { truncate, widthClassOf } from "../width.js";
import { meterBar } from "../meter.js";
import { cardLines } from "./card.js";
import {
	CollectionState,
	collectionItems,
	compareItems,
	sortItems,
	type CollectionItem,
} from "./shared.js";

/** The page size (spec §5.5: paged at 50 rows). */
export const TABLE_PAGE_SIZE = 50;

/** The sort menu entries: the sortable columns' labels. */
function sortableColumns(block: CollectionBlock): CollectionColumn[] {
	return (block.columns ?? []).filter((column) => column.sortable === true);
}

/** One cell's display text. */
function cellText(
	column: CollectionColumn,
	row: CollectionItem,
	ctx: BlockCtx,
	width: number,
): string {
	const value = row.item[column.field];
	if (column.cell === "meter") {
		const level = typeof value === "number" ? value : 0;
		return meterBar(level, Math.max(4, Math.min(10, Math.floor(width / 4))), !ctx.unicode);
	}
	if (value === undefined || value === null) return "";
	return formatValue(value, column.format, ctx.locale, ctx.timeZone);
}

/** `table`: aligned, sortable, paged columns; cards at compact width. */
export class TableComponent implements Component {
	readonly #block: CollectionBlock;
	readonly #ctx: BlockCtx;
	readonly #state = new CollectionState();
	#sort: CollectionSort | undefined;
	#page = 0;
	#tick = 0;

	constructor(block: CollectionBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
		this.#sort = block.sort;
	}

	#rows(): CollectionItem[] {
		return sortItems(collectionItems(this.#block, this.#ctx), this.#sort);
	}

	render(width: number): string[] {
		this.#tick += 1;
		if (widthClassOf(width) === "compact") return this.#renderCompact(width);
		return this.#renderFull(width);
	}

	// ─── the full table ──────────────────────────────────────────────

	#renderFull(width: number): string[] {
		const columns = this.#block.columns ?? [];
		const rows = this.#rows();
		const pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
		if (this.#page >= pages) this.#page = pages - 1;
		const pageRows = rows.slice(
			this.#page * TABLE_PAGE_SIZE,
			(this.#page + 1) * TABLE_PAGE_SIZE,
		);

		if (this.#state.menu?.kind === "sort") {
			const lines = [truncate("Sort by", width)];
			sortableColumns(this.#block).forEach((column, index) => {
				const cursor = index === this.#state.menuCursor ? "> " : "  ";
				const arrow =
					this.#sort?.field === column.field ? (this.#sort.dir === "asc" ? " ▲" : " ▼") : "";
				lines.push(truncate(`${cursor}${bindText(column.label, this.#ctx)}${arrow}`, width));
			});
			return lines;
		}

		// Column widths: the widest display width of header or cells,
		// clamped so the table fits the pane.
		const labels = columns.map((column) => bindText(column.label, this.#ctx));
		const widths = columns.map((column, index) => {
			let widest = visibleWidth(labels[index] ?? "");
			for (const row of pageRows) {
				widest = Math.max(widest, visibleWidth(cellText(column, row, this.#ctx, width)));
			}
			return widest;
		});
		const gaps = Math.max(0, columns.length - 1) * 2;
		let budget = width - 2 - gaps; // the cursor column + separators
		for (let i = columns.length - 1; i >= 0 && widths.reduce((a, b) => a + b, 0) > budget; i--) {
			widths[i] = Math.max(4, (widths[i] ?? 4) - (widths.reduce((a, b) => a + b, 0) - budget));
			budget = width - 2 - gaps;
		}

		const join = (cells: string[], cursor: string): string =>
			truncate(
				cursor +
					cells
						.map((cell, index) => {
							const column = columns[index];
							const cellWidth = widths[index] ?? 4;
							const fits = visibleWidth(cell) <= cellWidth;
							const text = fits ? cell : truncate(cell, cellWidth);
							const rest = cellWidth - visibleWidth(text);
							const padStr = rest > 0 ? " ".repeat(rest) : "";
							// numeric formats right-align; text left-aligns.
							return column?.format === "number" && text !== ""
								? padStr + text
								: text + padStr;
						})
						.join("  "),
				width,
			);

		const lines: string[] = [join(labels, "  ")];
		for (const row of pageRows) {
			lines.push(
				join(
					columns.map((column) => cellText(column, row, this.#ctx, width)),
					"  ",
				),
			);
		}
		const from = this.#page * TABLE_PAGE_SIZE + 1;
		const to = Math.min(rows.length, (this.#page + 1) * TABLE_PAGE_SIZE);
		const range = rows.length === 0 ? "0 of 0" : `${from}–${to} of ${rows.length}`;
		lines.push(truncate(this.#ctx.theme.dim(range), width));
		return lines;
	}

	// ─── the compact fallback (rows as cards, §12.3) ────────────────

	#renderCompact(width: number): string[] {
		const rows = this.#rows();
		const lines: string[] = [];
		const cursorRow = Math.min(this.#state.cursor, rows.length - 1);
		rows.forEach((row, index) => {
			const cursor = index === cursorRow ? "> " : "  ";
			const inner = width - 2;
			const card = cardLines(this.#block.item, row.item, this.#ctx, inner, 0, this.#tick);
			lines.push(truncate(cursor + (card[0] ?? ""), width));
			for (const line of card.slice(1)) lines.push(truncate(cursor + line, width));
			// High-priority columns ride the card as "label: value" lines.
			for (const column of this.#block.columns ?? []) {
				if (column.priority === "low") continue;
				if (column.cell === "meter") continue;
				const value = cellText(column, row, this.#ctx, width);
				if (value === "") continue;
				lines.push(truncate(`${cursor}${bindText(column.label, this.#ctx)}: ${value}`, width));
			}
			// Low-priority columns sit behind Enter-expand (§12.3).
			if (this.#state.expanded.has(row.id)) {
				for (const column of this.#block.columns ?? []) {
					if (column.priority !== "low") continue;
					const value = cellText(column, row, this.#ctx, width);
					if (value === "") continue;
					lines.push(
						truncate(`${cursor}${bindText(column.label, this.#ctx)}: ${value}`, width),
					);
				}
			}
		});
		return lines;
	}

	handleInput(data: string): void {
		if (this.#state.menu?.kind === "sort") {
			const columns = sortableColumns(this.#block);
			if (data === "\x1b") {
				this.#state.menu = null;
				return;
			}
			if (data === "\x1b[B") {
				this.#state.menuCursor = Math.min(columns.length - 1, this.#state.menuCursor + 1);
				return;
			}
			if (data === "\x1b[A") {
				this.#state.menuCursor = Math.max(0, this.#state.menuCursor - 1);
				return;
			}
			if (data === "\r") {
				const column = columns[this.#state.menuCursor];
				if (column !== undefined) {
					// Sorting the same column again flips the direction.
					this.#sort =
						this.#sort?.field === column.field && this.#sort.dir === "asc"
							? { field: column.field, dir: "desc" }
							: { field: column.field, dir: "asc" };
					this.#page = 0;
				}
				this.#state.menu = null;
			}
			return;
		}
		if (data === "s" && sortableColumns(this.#block).length > 0) {
			this.#state.menu = { kind: "sort" };
			this.#state.menuCursor = 0;
			return;
		}
		if (data === "\x1b[6~") {
			const pages = Math.ceil(this.#rows().length / TABLE_PAGE_SIZE);
			this.#page = Math.min(Math.max(0, pages - 1), this.#page + 1);
			return;
		}
		if (data === "\x1b[5~") {
			this.#page = Math.max(0, this.#page - 1);
			return;
		}
		const rows = this.#rows();
		if (data === "\x1b[B") {
			this.#state.cursor = Math.min(rows.length - 1, this.#state.cursor + 1);
			return;
		}
		if (data === "\x1b[A") {
			this.#state.cursor = Math.max(0, this.#state.cursor - 1);
			return;
		}
		if (data === "\r") {
			const row = rows[this.#state.cursor];
			if (row === undefined) return;
			// Compact: Enter toggles the low-priority expand; full table:
			// Enter activates (onActivate rides the card template's click).
			if (this.#state.expanded.has(row.id)) this.#state.expanded.delete(row.id);
			else this.#state.expanded.add(row.id);
		}
	}

	invalidate(): void {
		// View state survives re-renders.
	}
}

export { compareItems };
