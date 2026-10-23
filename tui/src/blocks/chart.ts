/**
 * The `chart` block (UI-blocks spec §5.4): one y-axis, mixed series
 * kinds, thresholds as horizontal rules.
 *
 * - Lines and areas draw on a {@link BrailleCanvas} (2×4 dots per
 *   cell); bars draw with the block ramp `▁▂▃▄▅▆▇█` on one row per
 *   tick; stacked `area`/`bar` series accumulate.
 * - A threshold draws as a dashed rule (`╌`, ASCII `-`) in its tone.
 * - Below 30 cells the chart degrades to a sparkline plus the latest
 *   value per series (§12.3); below 80 the legend moves below the
 *   plot.
 * - Long series downsample with the shared `lttb` before plotting.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatValue, lttb } from "@sigrun/shared/blocks";
import type { ChartBlock, ChartSeries, JsonValue } from "@sigrun/shared/blocks";
import { bindRaw, bindText, type BlockCtx } from "./context.js";
import { BrailleCanvas, sparkline } from "./braille.js";
import { pad, truncate } from "./width.js";
import { toneFg } from "./tones.js";
import { Lines } from "./layout.js";

/** Below this width the chart is sparklines plus latest values. */
const SPARKLINE_BELOW = 30;

/** The legend sits below the plot below this width (the compact class). */
const LEGEND_BELOW = 80;

/** Plot rows for the full chart (the axes and legend add the rest). */
const PLOT_ROWS = 8;

/** The series palette (chart is the one block that goes beyond tones). */
const SERIES_TOKENS = ["accent", "ok", "warn", "muted", "code"] as const;

/** The dashed-rule glyphs for thresholds. */
const DASH = "╌";
const DASH_ASCII = "-";

/** One series resolved to its points. */
interface Series {
	name: string;
	kind: "line" | "area" | "bar";
	data: [number, number][];
}

/** Resolve `block.series` to points (bindings and literal arrays). */
function seriesOf(block: ChartBlock, ctx: BlockCtx): Series[] {
	const out: Series[] = [];
	for (const series of block.series) {
		const name = bindText(series.name, ctx);
		const data = bindRaw(series.data, ctx);
		if (!Array.isArray(data)) continue;
		const points: [number, number][] = [];
		for (const pair of data) {
			if (
				Array.isArray(pair) &&
				typeof pair[0] === "number" &&
				typeof pair[1] === "number"
			) {
				points.push([pair[0], pair[1]]);
			}
		}
		out.push({ name, kind: series.kind, data: points });
	}
	return out;
}

/** Downsample line/area series for the dot budget (spec §5.4: lttb).
 * The original series index rides along — the downsampled copies are
 * fresh objects, so identity lookup against `all` would miss. */
function displaySeries(all: Series[], cells: number): { series: Series; index: number }[] {
	return all.map((series, index) => ({
		series:
			series.kind === "bar"
				? series
				: { ...series, data: lttb(series.data, Math.max(2, cells * 2)) },
		index,
	}));
}

/** Domain/range across all series, honouring the axis's pinned bounds. */
function bounds(
	block: ChartBlock,
	ctx: BlockCtx,
	all: Series[],
): { xMin: number; xMax: number; yMin: number; yMax: number } {
	let xMin = Infinity;
	let xMax = -Infinity;
	let yMin = Infinity;
	let yMax = -Infinity;
	const stacked = block.stacked === true;
	for (const series of all) {
		if (stacked && series.kind !== "line") continue; // sums handled below
		for (const [x, y] of series.data) {
			xMin = Math.min(xMin, x);
			xMax = Math.max(xMax, x);
			yMin = Math.min(yMin, y);
			yMax = Math.max(yMax, y);
		}
	}
	if (stacked) {
		// Sum same-x points across the stacked series for the range.
		const sums = new Map<number, number>();
		for (const series of all) {
			if (series.kind === "line") continue;
			for (const [x, y] of series.data) {
				sums.set(x, (sums.get(x) ?? 0) + y);
				xMin = Math.min(xMin, x);
				xMax = Math.max(xMax, x);
			}
		}
		for (const sum of sums.values()) {
			yMin = Math.min(yMin, 0, sum);
			yMax = Math.max(yMax, sum);
		}
	}
	// Thresholds never stretch the domain: the y axis labels the data
	// bounds; a threshold outside them clamps to the edge rule row.
	if (!Number.isFinite(xMin)) {
		xMin = 0;
		xMax = 1;
	}
	if (!Number.isFinite(yMin)) {
		yMin = 0;
		yMax = 1;
	}
	// Lines never stack (the chart keeps them over any stacked fill).
	for (const series of all) {
		if (series.kind !== "line") continue;
		for (const [, y] of series.data) {
			yMin = Math.min(yMin, y);
			yMax = Math.max(yMax, y);
		}
	}
	yMin = block.y?.min ?? yMin;
	yMax = block.y?.max ?? yMax;
	if (yMax === yMin) yMax = yMin + 1;
	if (xMax === xMin) xMax = xMin + 1;
	void ctx;
	return { xMin, xMax, yMin, yMax };
}

/** The y label for one bound: the value plus the unit. */
function yLabel(block: ChartBlock, ctx: BlockCtx, value: number): string {
	const unit = bindText(block.y?.unit, ctx);
	const text = formatValue(value, block.y?.format, ctx.locale);
	return unit === "" ? text : `${text} ${unit}`;
}

/** One x tick label. */
function xLabel(block: ChartBlock, ctx: BlockCtx, value: number): string {
	if (block.x.kind === "time") {
		return formatValue(
			value as JsonValue,
			block.x.format ?? "time",
			ctx.locale,
			ctx.timeZone,
		);
	}
	return formatValue(value, block.x.format, ctx.locale);
}

/**
 * A left-aligned ruler of `cells` cells with `labels` spread across
 * it (first label at the left edge, last at the right edge).
 */
function ruler(labels: string[], cells: number): string {
	const out = Array.from({ length: cells }, () => " ");
	if (labels.length === 0 || cells <= 0) return out.join("");
	const slots = Math.min(labels.length, Math.max(2, Math.floor(cells / 8)));
	for (let i = 0; i < slots; i++) {
		const label = labels[Math.round((i * (labels.length - 1)) / Math.max(1, slots - 1))] ?? "";
		const at = Math.min(
			cells - visibleWidth(label),
			Math.round((i * (cells - 1)) / Math.max(1, slots - 1)),
		);
		if (at < 0) continue;
		for (let c = 0; c < [...label].length && at + c < cells; c++) {
			out[at + c] = label[c] ?? " ";
		}
	}
	return out.join("");
}

/** The narrow fallback: `name <sparkline> <latest>` per series. */
function sparklineRows(block: ChartBlock, ctx: BlockCtx, width: number): string[] {
	const out: string[] = [];
	for (const series of seriesOf(block, ctx)) {
		const values = series.data.map((point) => point[1]);
		const latest = values[values.length - 1];
		const latestText =
			latest === undefined
				? ""
				: formatValue(latest, block.y?.format, ctx.locale);
		const budget = Math.max(
			1,
			width - visibleWidth(series.name) - visibleWidth(latestText) - 2,
		);
		const ramp = sparkline(values, Math.min(5, budget), ctx.unicode);
		out.push(
			truncate(
				`${ctx.theme.bold(series.name)} ${series.kind === "bar" ? ramp : ctx.theme.fg("accent")(ramp)} ${latestText}`,
				width,
			),
		);
	}
	return out;
}

/** The legend line: `name · name · name`, coloured per series. */
function legendLine(ctx: BlockCtx, all: Series[], width: number): string {
	const sep = ctx.unicode ? " · " : " | ";
	const parts = all.map((series, index) => {
		const token = SERIES_TOKENS[index % SERIES_TOKENS.length] ?? "accent";
		return ctx.theme.fg(token)(series.name);
	});
	return truncate(parts.join(sep), width);
}

/** The full chart (width ≥ 30). */
function fullChart(block: ChartBlock, ctx: BlockCtx, width: number): string[] {
	const title = bindText(block.title, ctx);
	const all = seriesOf(block, ctx);
	if (all.length === 0) {
		return title === "" ? [] : [truncate(ctx.theme.bold(title), width)];
	}
	const { xMin, xMax, yMin, yMax } = bounds(block, ctx, all);
	const labelMax = yLabel(block, ctx, yMax);
	const labelMin = yLabel(block, ctx, yMin);
	const gutter = Math.max(visibleWidth(labelMax), visibleWidth(labelMin)) + 1;
	const plotCells = Math.max(1, width - gutter - 1);
	const plotted = displaySeries(all, plotCells);

	const unicode = ctx.unicode;
	const canvas = new BrailleCanvas(plotCells, PLOT_ROWS);
	const xDot = (x: number): number =>
		Math.round(((x - xMin) / (xMax - xMin)) * (plotCells * 2 - 1));
	// Dot-space y counts from the BOTTOM (the canvas flips into cell rows).
	const yDot = (y: number): number =>
		Math.round(((y - yMin) / (yMax - yMin)) * (PLOT_ROWS * 4 - 1));

	// Bars draw first (per x tick, as a column of blocks); lines and
	// areas then plot over them (the last plotter owns the cell).
	// Bars plot from the ORIGINAL series (their sparse ticks must not
	// downsample); lines/areas plot from the downsampled copies.
	const barSeries = all.filter((series) => series.kind === "bar");
	const otherSeries = plotted
		.filter(({ series }) => series.kind !== "bar")
		.map(({ series, index }) => ({ series, index }));

	// Cumulative heights for stacked bars (same-x points accumulate).
	const cumulative = new Map<number, number>();
	const bars: { x: number; from: number; to: number; index: number }[] = [];
	for (const series of barSeries) {
		const index = all.indexOf(series);
		for (const [x, y] of series.data) {
			const base = block.stacked === true ? (cumulative.get(x) ?? 0) : 0;
			cumulative.set(x, base + y);
			bars.push({ x, from: base, to: base + y, index });
		}
	}

	/** One bar's cell text at a plot row (eighth-block partial at the top). */
	const barAt = (bar: { x: number; from: number; to: number; index: number }, row: number): string | undefined => {
		const rowTop = yMax - (row / PLOT_ROWS) * (yMax - yMin);
		const rowBottom = yMax - ((row + 1) / PLOT_ROWS) * (yMax - yMin);
		if (bar.to <= rowBottom || bar.from >= rowTop) return undefined;
		const top = Math.min(bar.to, rowTop);
		const frac = (top - rowBottom) / (rowTop - rowBottom);
		const level = Math.max(1, Math.min(8, Math.round(frac * 8)));
		const glyph = unicode
			? (level === 8 ? "█" : "▁▂▃▄▅▆▇"[level - 1])
			: (level === 8 ? "#" : "_.,-+=*"[level - 1]);
		const token = SERIES_TOKENS[bar.index % SERIES_TOKENS.length] ?? "accent";
		return ctx.theme.fg(token)(glyph);
	};

	// Lines and areas on the Braille canvas.
	const lineCumulative = new Map<number, number>();
	if (block.stacked === true) {
		// Areas stack: each area plots its top edge at the running sum.
		for (const { series } of otherSeries) {
			if (series.kind !== "area") continue;
			for (const [x, y] of series.data) {
				lineCumulative.set(x, (lineCumulative.get(x) ?? 0) + y);
			}
		}
	}
	const areas = otherSeries.filter(({ series }) => series.kind === "area");
	const lines = otherSeries.filter(({ series }) => series.kind === "line");
	const areaTops: { series: Series; top: [number, number][]; index: number }[] = [];
	const running = new Map<number, number>();
	for (const { series, index } of areas) {
		const top: [number, number][] = series.data.map(([x, y]) => {
			const base = block.stacked === true ? (running.get(x) ?? 0) : 0;
			running.set(x, base + y);
			return [x, base + y];
		});
		areaTops.push({ series, top, index });
	}

	if (unicode) {
		// Areas: fill from the axis up to the top edge.
		for (const { top, index } of areaTops) {
			for (let i = 0; i < top.length - 1; i++) {
				const a = top[i] as [number, number];
				const b = top[i + 1] as [number, number];
				const xa = xDot(a[0]);
				const xb = xDot(b[0]);
				for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++) {
					const t = xa === xb ? 0 : (x - xa) / (xb - xa);
					const y = yDot(a[1] + (b[1] - a[1]) * t);
					canvas.fill(x, 0, x, y, index);
				}
			}
		}
		// Lines (and area top edges) plot over the fills.
		const strokes: { data: [number, number][]; index: number }[] = [
			...areaTops.map(({ top, index }) => ({ data: top, index })),
			...lines.map(({ series, index }) => ({ data: series.data, index })),
		];
		for (const { data, index } of strokes) {
			for (let i = 0; i < data.length - 1; i++) {
				const a = data[i] as [number, number];
				const b = data[i + 1] as [number, number];
				canvas.line(xDot(a[0]), yDot(a[1]), xDot(b[0]), yDot(b[1]), index);
			}
			if (data.length === 1) {
				const only = data[0] as [number, number];
				canvas.plot(xDot(only[0]), yDot(only[1]), index);
			}
		}
	}

	// Thresholds: one dashed rule per threshold, at its plot row; the
	// row is blanked first so the dashes paint over the series.
	const thresholdRows = (block.thresholds ?? []).map((threshold) => ({
		threshold,
		row: Math.max(
			0,
			Math.min(PLOT_ROWS - 1, Math.round(((yMax - threshold.at) / (yMax - yMin)) * (PLOT_ROWS - 1))),
		),
	}));
	for (const { row } of thresholdRows) canvas.blankRow(row);

	// Assemble the plot rows.
	const plotLines: string[] = [];
	for (let row = 0; row < PLOT_ROWS; row++) {
		let gutterText = " ".repeat(gutter);
		if (row === 0) gutterText = pad(labelMax, gutter);
		if (row === PLOT_ROWS - 1) gutterText = pad(labelMin, gutter);
		let body: string;
		const rule = thresholdRows.find((entry) => entry.row === row);
		if (rule !== undefined) {
			const glyph = unicode ? DASH : DASH_ASCII;
			const label = bindText(rule.threshold.label, ctx);
			// Label FIRST: terminal themes wrap the rule in zero-width SGR,
			// and a tail label would sit past the width clamp when a theme's
			// markers are not ANSI (test themes mark tones visibly).
			const dashes = glyph.repeat(Math.max(0, plotCells - (label === "" ? 0 : visibleWidth(label) + 1)));
			const dashed = label === "" ? dashes : `${label} ${dashes}`;
			body = toneFg(ctx.theme, rule.threshold.tone)(dashed);
		} else if (unicode) {
			const raw = canvas.rows()[row] ?? "";
			let painted = "";
			for (let cell = 0; cell < plotCells; cell++) {
				const ch = raw[cell] ?? " ";
				// Stacked bars share one x cell: pick the segment whose
				// value range covers THIS row (not just the first at x).
				let barGlyph: string | undefined;
				for (const one of bars) {
					const xCell = Math.round(((one.x - xMin) / (xMax - xMin)) * (plotCells - 1));
					if (xCell !== cell) continue;
					barGlyph = barAt(one, row);
					if (barGlyph !== undefined) break;
				}
				if (barGlyph !== undefined && (ch === " " || canvas.cellOwner(cell, row) < 0)) {
					painted += barGlyph;
					continue;
				}
				const owner = canvas.cellOwner(cell, row);
				const token = SERIES_TOKENS[(owner < 0 ? 0 : owner) % SERIES_TOKENS.length] ?? "accent";
				painted += owner < 0 || ch === " " ? " " : ctx.theme.fg(token)(ch);
			}
			body = painted;
		} else {
			// ASCII: one marker per occupied cell ("*", line "/" for slopes).
			let ascii = "";
			for (let cell = 0; cell < plotCells; cell++) {
				let barGlyph: string | undefined;
				for (const one of bars) {
					const xCell = Math.round(((one.x - xMin) / (xMax - xMin)) * (plotCells - 1));
					if (xCell !== cell) continue;
					barGlyph = barAt(one, row);
					if (barGlyph !== undefined) break;
				}
				if (barGlyph !== undefined) {
					ascii += barGlyph;
					continue;
				}
				const bits = canvas.cellBits(cell, row);
				ascii += bits === 0 ? " " : "*";
			}
			body = ascii;
		}
		plotLines.push(pad(truncate(gutterText + body, width), width));
	}

	// The x axis: tick labels across the plot width.
	const tickCount = Math.min(6, Math.max(2, Math.floor(plotCells / 12)));
	const ticks: string[] = [];
	for (let i = 0; i < tickCount; i++) {
		ticks.push(xLabel(block, ctx, xMin + ((xMax - xMin) * i) / (tickCount - 1)));
	}
	plotLines.push(pad(truncate(" ".repeat(gutter) + ruler(ticks, plotCells), width), width));

	const legend = legendLine(ctx, all, width);
	const out: string[] = [];
	if (title !== "") out.push(truncate(ctx.theme.bold(title), width));
	if (width >= LEGEND_BELOW) out.push(legend);
	out.push(...plotLines);
	if (width < LEGEND_BELOW) out.push(legend);
	return out;
}

/** `chart`: the spec §5.4 block. */
export function renderChart(block: ChartBlock, ctx: BlockCtx): Component {
	return new Lines((width) => {
		if (width < SPARKLINE_BELOW) return sparklineRows(block, ctx, width);
		return fullChart(block, ctx, width);
	});
}

/** Re-exported so the render dispatch imports one module per block. */
export type { ChartSeries };
