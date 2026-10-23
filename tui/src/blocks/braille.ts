/**
 * The Braille dot canvas and the display ramps (UI-blocks spec §5.4):
 * the pieces `chart` and the narrow-fallback sparkline draw with.
 *
 * - {@link BrailleCanvas} is a `cells×rows` cell grid of 2×4 dot
 *   subpixels (Unicode Braille Patterns, U+2800 base). Each cell also
 *   records the index of the series that plotted into it LAST, which
 *   is how multi-colour charts colour a shared cell.
 * - {@link sparkline} renders a value series onto the eighth-block
 *   ramp `▁▂▃▄▅▆▇█` (or the ASCII ramp `_.,-+=*#` on a no-Unicode
 *   terminal), downsampling with the shared `lttb` when the series is
 *   longer than the cell budget.
 */

import { lttb } from "@sigrun/shared/blocks";

/**
 * Dot bit per (x, y) subpixel: bit index is `col * 4 + row` where
 * `col = x % 2` and `row = y % 4`. Dot-space y counts from the BOTTOM
 * of the canvas (chart-style), so `plot` also flips the cell row:
 * (x, 0) lands in the LAST cell row. The suite pins plot(0,0)=bit0,
 * plot(0,1)=bit1, plot(1,0)=bit4, plot(1,1)=bit5, plot(0,2)=bit2,
 * plot(1,3)=bit7 on a one-row canvas.
 */
const DOT_BIT: readonly (readonly number[])[] = [
	[0x01, 0x02, 0x04, 0x08],
	[0x10, 0x20, 0x40, 0x80],
];

/** A Braille dot canvas: `cells` columns × `rows` rows of 2×4 dots. */
export class BrailleCanvas {
	readonly #cells: number;
	readonly #rows: number;
	readonly #bits: Uint8Array;
	readonly #owner: Int32Array;

	constructor(cells: number, rows: number) {
		this.#cells = Math.max(0, cells);
		this.#rows = Math.max(0, rows);
		this.#bits = new Uint8Array(this.#cells * this.#rows);
		this.#owner = new Int32Array(this.#cells * this.#rows).fill(-1);
	}

	/** Plot one dot; out-of-range coordinates are ignored. */
	plot(x: number, y: number, series?: number): void {
		const cellX = Math.floor(x / 2);
		// Dot-space y counts from the BOTTOM; cell rows count top-down.
		const cellY = Math.floor(y / 4);
		if (cellX < 0 || cellY < 0 || cellX >= this.#cells || cellY >= this.#rows) return;
		const index = (this.#rows - 1 - cellY) * this.#cells + cellX;
		const row = y % 4;
		const col = x % 2;
		const bit = (DOT_BIT[col] as readonly number[])[row] ?? 0;
		this.#bits[index] = (this.#bits[index] ?? 0) | bit;
		if (series !== undefined) this.#owner[index] = series;
	}

	/** A straight dot-space line from (x0, y0) to (x1, y1): the steps
	 * are the CHEBYSHEV distance (diagonal-adjacent dots step one
	 * dot-space cell at a time). */
	line(x0: number, y0: number, x1: number, y1: number, series?: number): void {
		const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
		for (let i = 0; i <= steps; i++) {
			this.plot(
				Math.round(x0 + ((x1 - x0) * i) / steps),
				Math.round(y0 + ((y1 - y0) * i) / steps),
				series,
			);
		}
	}

	/** Fill the dot rectangle (x0..x1, y0..y1) inclusive. */
	fill(x0: number, y0: number, x1: number, y1: number, series?: number): void {
		for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
			for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
				this.plot(x, y, series);
			}
		}
	}

	/** The dot bits set in one cell. */
	cellBits(cellX: number, cellY: number): number {
		return this.#bits[cellY * this.#cells + cellX] ?? 0;
	}

	/** The series index that plotted into this cell last (−1: none). */
	cellOwner(cellX: number, cellY: number): number {
		return this.#owner[cellY * this.#cells + cellX] ?? -1;
	}

	/** Clear one cell row (a threshold rule paints over it). */
	blankRow(cellY: number): void {
		if (cellY < 0 || cellY >= this.#rows) return;
		for (let cell = 0; cell < this.#cells; cell++) {
			const index = cellY * this.#cells + cell;
			this.#bits[index] = 0;
			this.#owner[index] = -1;
		}
	}

	/** The canvas as one Braille string per cell row. */
	rows(): string[] {
		const out: string[] = [];
		for (let row = 0; row < this.#rows; row++) {
			let line = "";
			for (let cell = 0; cell < this.#cells; cell++) {
				line += String.fromCharCode(0x2800 + this.cellBits(cell, row));
			}
			out.push(line);
		}
		return out;
	}
}

/** The eighth-block ramp (index 0..8: empty through full). */
const BLOCK_RAMP = "▁▂▃▄▅▆▇█"; // 8 cells, index 0..7

/** The ASCII ramp for no-Unicode terminals (same 1..8 shape heights). */
const ASCII_RAMP = "_.,-+*#"; // same 1..8 shape heights

/**
 * A one-cell-per-sample sparkline of `values`, at most `maxCells`
 * cells (longer series downsample with `lttb`, keeping both ends).
 * `unicode: false` selects the ASCII ramp. Empty input renders empty;
 * a flat series renders mid-height cells.
 */
export function sparkline(
	values: readonly number[],
	maxCells: number,
	unicode: boolean,
): string {
	if (values.length === 0 || maxCells <= 0) return "";
	const points = values.map((value, index): [number, number] => [index, value]);
	const sampled = lttb(points, Math.max(1, maxCells));
	const ys = sampled.map((point) => point[1]);
	const min = Math.min(...ys);
	const max = Math.max(...ys);
	const ramp = unicode ? BLOCK_RAMP : ASCII_RAMP;
	// One shape per cell: floor(t * 8) clamped to the ramp (the top
	// eighth of the range is the full block). A flat series renders
	// mid-height (index 3 of 8).
	return sampled
		.map((point) => {
			if (max === min) return ramp[3];
			const t = (point[1] - min) / (max - min);
			return ramp[Math.max(0, Math.min(7, Math.floor(t * 8)))];
		})
		.join("");
}
