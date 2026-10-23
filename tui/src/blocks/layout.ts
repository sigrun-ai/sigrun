/**
 * The layout blocks (UI-blocks spec §5.2): `stack`, `columns`, `grid`,
 * `section` as pi-tui components.
 *
 * Columns/grid honour the compact fallbacks (spec §12.3): `columns`
 * stack when the minimums don't fit; `grid` runs
 * `max(1, floor(width / minItemWidth))` columns so a compact pane gets
 * one. Every line every block emits is clamped to the pane
 * ({@link truncate} — Review Focus 2).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type {
	Block,
	ColumnsBlock,
	GridBlock,
	SectionBlock,
	Size,
	StackBlock,
	Tone,
} from "@sigrun/shared/blocks";
import { renderBlock } from "./render.js";
import { bindText, bindTone, type BlockCtx } from "./context.js";
import { SIZE_CELLS, pad, truncate } from "./width.js";
import { toneFg, toneMarker } from "./tones.js";

/** The blank line counts the `gap` tokens map to. */
const GAP_LINES: Readonly<Record<Size, number>> = { s: 0, m: 1, l: 2 };

/** The section header rule character. */
const RULE = "─";

/**
 * A component from a width-aware line builder. Each produced line is
 * clamped to the render width (the invariant every block must keep).
 */
export class Lines implements Component {
	readonly #build: (width: number) => string[];

	constructor(build: (width: number) => string[]) {
		this.#build = build;
	}

	render(width: number): string[] {
		return this.#build(width).map((line: string) => truncate(line, width));
	}

	invalidate(): void {
		// Stateless render: lines re-assemble on the next render call.
	}
}

/** Join child blocks vertically, a blank line between neighbours. */
function stacked(
	children: readonly Block[],
	ctx: BlockCtx,
	width: number,
	gap: number,
): string[] {
	const out: string[] = [];
	for (const child of children) {
		const lines = renderBlock(child, ctx).render(width);
		if (out.length > 0 && lines.length > 0) {
			for (let i = 0; i < gap; i++) out.push("");
		}
		out.push(...lines);
	}
	return out;
}

/** Render `children` vertically with `gap` blank lines between. */
export function renderStack(block: StackBlock, ctx: BlockCtx): Component {
	return new Lines((width) =>
		stacked(block.children, ctx, width, GAP_LINES[block.gap ?? "m"]),
	);
}

/** Render children side by side, stacking when the minimums don't fit. */
export function renderColumns(block: ColumnsBlock, ctx: BlockCtx): Component {
	return new Lines((width) => {
		const minimums = block.children.map((child) =>
			child.minWidth === undefined ? SIZE_CELLS.s : SIZE_CELLS[child.minWidth],
		);
		const total =
			minimums.reduce((a, b) => a + b, 0) + Math.max(0, block.children.length - 1);
		// Compact fallback (spec §12.3): stack when the minimums don't fit.
		if (width < total) {
			return stacked(
				block.children.map((child) => child.block),
				ctx,
				width,
				1,
			);
		}
		// Side by side: render each child at a weighted slot, then zip
		// the line arrays into rows (shorter columns pad with blanks).
		const weights = block.children.map((child) => child.weight ?? 1);
		const weightSum = weights.reduce((a, b) => a + b, 0);
		const separators = block.children.length - 1;
		const slots = weights.map((weight) =>
			Math.max(1, Math.floor(((width - separators) * weight) / weightSum)),
		);
		const rendered = block.children.map((child, index) =>
			renderBlock(child.block, ctx).render(slots[index] as number),
		);
		const height = Math.max(...rendered.map((lines) => lines.length));
		const rows: string[] = [];
		for (let row = 0; row < height; row++) {
			rows.push(
				rendered
					.map((lines, index) => pad(lines[row] ?? "", slots[index] as number))
					.join(" "),
			);
		}
		return rows;
	});
}

/** One grid row under construction: its cells with spans and lines. */
interface GridCell {
	span: number;
	lines: string[];
}

/** Render children in as many columns as `minItemWidth` allows. */
export function renderGrid(block: GridBlock, ctx: BlockCtx): Component {
	return new Lines((width) => {
		const minItem = SIZE_CELLS[block.minItemWidth];
		const columns = Math.max(1, Math.floor(width / minItem));
		const columnWidth = Math.max(1, Math.floor((width - (columns - 1)) / columns));
		// Slot each child by its span ("full" spans every column).
		const rows: GridCell[][] = [];
		let current: GridCell[] = [];
		let used = 0;
		const flush = (): void => {
			if (current.length > 0) rows.push(current);
			current = [];
			used = 0;
		};
		for (const child of block.children) {
			let span = 1;
			if (child.span === "full") span = columns;
			else if (child.span !== undefined) span = Math.min(child.span, columns);
			if (used > 0 && used + span > columns) flush();
			current.push({
				span,
				lines: renderBlock(child.block, ctx).render(columnWidth * span + (span - 1)),
			});
			used += span;
		}
		flush();
		// Zip each row's cells into lines (shorter cells pad with blanks).
		const out: string[] = [];
		for (const row of rows) {
			const height = Math.max(...row.map((cell) => cell.lines.length));
			const widths = row.map((cell) => columnWidth * cell.span + (cell.span - 1));
			for (let line = 0; line < height; line++) {
				out.push(
					row
						.map((cell, index) => pad(cell.lines[line] ?? "", widths[index] as number))
						.join(" "),
				);
			}
		}
		return out;
	});
}

/** Render a titled, optionally toned group of children. */
export function renderSection(block: SectionBlock, ctx: BlockCtx): Component {
	return new Lines((width) => {
		const title = bindText(block.title ?? "", ctx);
		const subtitle = bindText(block.subtitle ?? "", ctx);
		const out: string[] = [];
		if (title !== "") {
			if (block.tone !== undefined) {
				const tone = bindTone(block.tone, ctx);
				const head = `${toneFg(ctx.theme, tone)(toneMarker(tone, !ctx.unicode))} ${title}`;
				const rule = RULE.repeat(Math.max(0, width - visibleWidth(head) - 1));
				out.push(`${head} ${ctx.theme.dim(rule)}`);
			} else {
				const rule = RULE.repeat(Math.max(0, width - visibleWidth(title) - 1));
				out.push(`${title} ${ctx.theme.dim(rule)}`);
			}
		}
		if (subtitle !== "") out.push(ctx.theme.dim(subtitle));
		// `collapsed` is the author's INITIAL state (§5.2): children stay
		// hidden until a later task's toggle expands them.
		const children = block.collapsed
			? []
			: block.children.filter((child): child is Block => "name" in child === false);
		const inner = width - 2;
		const body = stacked(children, ctx, Math.max(1, inner), GAP_LINES.m);
		for (const line of body) out.push(line === "" ? "" : `  ${line}`);
		return out;
	});
}
