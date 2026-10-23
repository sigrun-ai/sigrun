/**
 * The chart block (UI-blocks U1 Task 2, spec §5.4/§12.3): hand-written
 * SVG, no chart library. One y-axis; line/area/bar series may mix in a
 * single chart; series colours come from the `--chart-1..8` ramp in
 * order — blocks.css is that ramp's sole definition (stop 1 rides
 * `--accent`; stops 2–8 are fixed hex per mode; the shared themes
 * module defines no series tokens); line/area series downsample to at
 * most 2,000 points with `lttb`; `stacked` accumulates area/bar
 * baselines; thresholds draw as horizontal rules carrying their tone.
 *
 * Width fallbacks (§12.3): `full` (axes + legend beside), `compact`
 * (fewer x-ticks, legend below — fewer than 640 px of container), and
 * `spark` (below 16 rem: one polyline + the latest value per series —
 * no axes, no bars).
 */

import { useMemo, type CSSProperties, type ReactNode } from "react";
import {
	formatValue,
	lttb,
	type ChartBlock,
	type ChartSeries,
} from "@sigrun/shared/blocks";
import { bound, boundString, useSurfaceData } from "./context";
import { useWidthInfo } from "./width";

/** The display cap (spec §5.4: "at most 2,000 points", lttb). */
const MAX_POINTS = 2000;

/** The sparkline fallback's container threshold (§12.3: "below … 16 rem"). */
const SPARK_MAX_REM = 16;

/** The compact fallback's container threshold (a 640 px / 40 rem column). */
const COMPACT_MAX_PX = 640;

/** px of container width per x-axis tick (the brief's density rule). */
const PX_PER_X_TICK = 80;

/** The fixed y-axis tick count. */
const Y_TICKS = 5;

/** The chart's inner coordinate system. */
const WIDTH = 640;
const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 24, left: 44 };

/** A series' prepared points, its literal-or-bound raw data resolved. */
interface ResolvedSeries {
	readonly name: string;
	readonly kind: "line" | "area" | "bar";
	readonly points: readonly (readonly [number, number])[];
}

/** Read a series' `data` prop: a binding resolves (missing → no
 *  points — renders empty, never an error); a literal passes through. */
function seriesData(
	ctx: ReturnType<typeof useSurfaceData>,
	data: ChartSeries["data"],
): readonly (readonly [number, number])[] {
	const resolved = bound(ctx, data) ?? [];
	return Array.isArray(resolved)
		? resolved.filter(
				(point): point is readonly [number, number] =>
					Array.isArray(point) &&
					point.length === 2 &&
					typeof point[0] === "number" &&
					typeof point[1] === "number",
			)
		: [];
}

/** Nice ticks for `[min, max]` (the 1-2-5 progression), `count` out. */
function niceTicks(min: number, max: number, count: number): number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
	if (min === max) return [min];
	const step = (max - min) / Math.max(1, count - 1);
	const magnitude = 10 ** Math.floor(Math.log10(step));
	const normalized = step / magnitude;
	const nice =
		normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	const unit = nice * magnitude;
	const start = Math.ceil(min / unit) * unit;
	const ticks: number[] = [];
	for (let value = start; value <= max + unit * 1e-6; value += unit) {
		ticks.push(Math.round(value / unit) * unit);
	}
	return ticks;
}

/** One series' SVG path (line) or area path (closed to the baseline). */
function seriesPath(
	series: ResolvedSeries,
	index: number,
	extent: Extent,
	stackedBase: readonly number[] | undefined,
): { readonly d: string; readonly area: boolean } {
	const { x0, x1, y0, y1 } = extent;
	const xs = x1 - x0 || 1;
	const ys = y1 - y0 || 1;
	const points = series.points;
	if (points.length === 0) return { d: "", area: false };
	const toX = (x: number): number => PAD.left + ((x - x0) / xs) * (WIDTH - PAD.left - PAD.right);
	const toY = (y: number): number => PAD.top + (1 - (y - y0) / ys) * (HEIGHT - PAD.top - PAD.bottom);
	if (series.kind === "bar") return { d: "", area: false };
	const line = points
		.map((point, i) => {
			const y = stackedBase === undefined ? point[1] : point[1] + (stackedBase[i] ?? 0);
			return `${i === 0 ? "M" : "L"}${toX(point[0]).toFixed(2)},${toY(y).toFixed(2)}`;
		})
		.join(" ");
	if (series.kind !== "area") return { d: line, area: false };
	const first = points[0]!;
	const last = points[points.length - 1]!;
	const base0 = stackedBase === undefined ? y0 : (stackedBase[0] ?? y0);
	const base1 =
		stackedBase === undefined ? y0 : (stackedBase[points.length - 1] ?? y0);
	const area = `${line} L${toX(last[0]).toFixed(2)},${toY(base1).toFixed(2)} L${toX(first[0]).toFixed(2)},${toY(base0).toFixed(2)} Z`;
	return { d: area, area: true };
}

/** The chart's [x, y] extent plus its tick arrays. */
interface Extent {
	readonly x0: number;
	readonly x1: number;
	readonly y0: number;
	readonly y1: number;
	readonly xTicks: readonly number[];
	readonly yTicks: readonly number[];
}

/** Compute the extent and ticks from the resolved series. */
function extentOf(
	series: readonly ResolvedSeries[],
	stacked: boolean,
	yAxis: ChartBlock["y"],
	xTickCount: number,
): Extent {
	const allX: number[] = [];
	const rawY: number[] = [];
	for (const s of series) {
		for (const point of s.points) {
			allX.push(point[0]);
			rawY.push(point[1]);
		}
	}
	// Stacked bars/areas: totals per x, not raw values, set the domain.
	const stackTotals = new Map<number, number>();
	if (stacked) {
		for (const s of series) {
			if (s.kind === "line") continue;
			for (const [x, y] of s.points) {
				stackTotals.set(x, (stackTotals.get(x) ?? 0) + y);
			}
		}
		for (const total of stackTotals.values()) rawY.push(total);
	}
	if (allX.length === 0) {
		return { x0: 0, x1: 1, y0: yAxis?.min ?? 0, y1: yAxis?.max ?? 1, xTicks: [0, 1], yTicks: niceTicks(yAxis?.min ?? 0, yAxis?.max ?? 1, Y_TICKS) };
	}
	let x0 = Math.min(...allX);
	let x1 = Math.max(...allX);
	if (x0 === x1) {
		x0 -= 0.5;
		x1 += 0.5;
	}
	let y0 = yAxis?.min ?? (stacked ? 0 : Math.min(...rawY));
	let y1 = yAxis?.max ?? Math.max(...rawY);
	if (y0 === y1) {
		y0 -= 1;
		y1 += 1;
	}
	return {
		x0,
		x1,
		y0,
		y1,
		xTicks: niceTicks(x0, x1, xTickCount),
		yTicks: niceTicks(y0, y1, Y_TICKS),
	};
}

/** The chart block. */
export function ChartBlockView(props: { block: ChartBlock }): ReactNode {
	const ctx = useSurfaceData();
	const width = useWidthInfo();
	const block = props.block;

	// §12.3's fallback ladder: sparkline below 16 rem; compact (fewer
	// ticks, legend below) below a 640 px column; full otherwise. An
	// unmeasured container renders full (the ResizeObserver's default).
	const rem = width.rem;
	const px = rem === null ? WIDTH : rem * 16;
	const mode = rem !== null && rem < SPARK_MAX_REM
		? "spark"
		: px < COMPACT_MAX_PX
			? "compact"
			: "full";

	const series: readonly ResolvedSeries[] = block.series.map((s) => ({
		name: boundString(ctx, s.name),
		kind: s.kind,
		points: seriesData(ctx, s.data),
	}));

	// Downsample line/area for DISPLAY (bars bucket separately below);
	// lttb keeps first/last and the visually largest triangles.
	const downsampled = series.map((s): ResolvedSeries => ({
		...s,
		points:
			s.kind === "bar" || s.points.length <= MAX_POINTS
				? s.points
				: lttb(s.points, MAX_POINTS),
	}));

	// Stacking baselines: for bar/area series, the running total of the
	// previous stackable series at each x.
	const stackBases = useMemo(() => computeStackBases(downsampled, block.stacked === true), [downsampled, block.stacked]);

	const xTickCount = Math.max(2, Math.floor(px / PX_PER_X_TICK));
	const extent = useMemo(
		() => extentOf(downsampled, block.stacked === true, block.y, xTickCount),
		[downsampled, block.stacked, block.y, xTickCount],
	);

	const title = boundString(ctx, block.title);
	const yUnit = boundString(ctx, block.y?.unit);

	if (mode === "spark") {
		return (
			<div className="blk blk-chart" data-block="chart" data-chart-mode="spark">
				{title !== "" && (
					<div className="blk-chart-title" dir="auto">{title}</div>
				)}
				{downsampled.map((s, index) => (
					<SparkRow
						key={index}
						series={s}
						color={`var(--chart-${(index % 8) + 1})`}
						locale={ctx.locale}
					/>
				))}
			</div>
		);
	}

	return (
		<div className="blk blk-chart" data-block="chart" data-chart-mode={mode}>
			{(title !== "" || downsampled.length > 1) && (
				<div className="blk-chart-head">
					{title !== "" && (
						<div className="blk-chart-title" dir="auto">{title}</div>
					)}
					{downsampled.length > 0 && (
						<div
							className="blk-chart-legend"
							data-legend={mode === "compact" ? "below" : "beside"}
						>
							{downsampled.map((s, index) => (
								<span
									key={index}
									className="blk-chart-legend-item"
									style={{ color: `var(--chart-${(index % 8) + 1})` }}
								>
									<span
										className="blk-chart-swatch"
										style={{ background: `var(--chart-${(index % 8) + 1})` }}
									/>
									{s.name}
								</span>
							))}
						</div>
					)}
				</div>
			)}
			<svg
				className="blk-chart-svg"
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				role="img"
				aria-label={title !== "" ? title : "chart"}
			>
				{renderYAxis(extent, block, yUnit, ctx.locale)}
				{renderXAxis(extent, block, ctx.locale)}
				{renderSeries(downsampled, extent, stackBases)}
				{renderThresholds(block, extent, ctx)}
			</svg>
		</div>
	);
}

/** Compute each series' stacking baseline (the totals under it). */
function computeStackBases(
	series: readonly ResolvedSeries[],
	stacked: boolean,
): readonly (readonly number[] | undefined)[] {
	if (!stacked) return series.map(() => undefined);
	const totals = new Map<number, number>();
	return series.map((s) => {
		if (s.kind === "line") return undefined;
		const base = s.points.map(([x]) => totals.get(x) ?? 0);
		for (const [x, y] of s.points) {
			totals.set(x, (totals.get(x) ?? 0) + y);
		}
		return base;
	});
}

/** The y-axis: ticks, gridlines and the caption (format + unit). */
function renderYAxis(
	extent: Extent,
	block: ChartBlock,
	unit: string,
	locale: string,
): ReactNode {
	const format = block.y?.format;
	const { y0, y1 } = extent;
	const ys = y1 - y0 || 1;
	return (
		<g className="blk-chart-y">
			{extent.yTicks.map((tick) => {
				const y = PAD.top + (1 - (tick - y0) / ys) * (HEIGHT - PAD.top - PAD.bottom);
				return (
					<g key={tick} data-tick="y">
						<line
							x1={PAD.left}
							x2={WIDTH - PAD.right}
							y1={y}
							y2={y}
							className="blk-chart-grid"
						/>
						<text x={PAD.left - 6} y={y + 4} textAnchor="end" className="blk-chart-tick">
							{formatValue(tick, format, locale)}
						</text>
					</g>
				);
			})}
			{(unit !== "" || format !== undefined) && (
				<text
					x={PAD.left - 6}
					y={PAD.top - 2}
					textAnchor="end"
					className="blk-chart-tick blk-chart-y-caption"
				>
					{unit}
				</text>
			)}
		</g>
	);
}

/** The x-axis: ticks along the bottom, formatted per `x.format`. */
function renderXAxis(
	extent: Extent,
	block: ChartBlock,
	locale: string,
): ReactNode {
	const { x0, x1 } = extent;
	const xs = x1 - x0 || 1;
	const y = HEIGHT - PAD.bottom + 16;
	return (
		<g className="blk-chart-x">
			{extent.xTicks.map((tick) => {
				const x = PAD.left + ((tick - x0) / xs) * (WIDTH - PAD.left - PAD.right);
				return (
					<g key={tick} data-tick="x">
						<line
							x1={x}
							x2={x}
							y1={HEIGHT - PAD.bottom}
							y2={HEIGHT - PAD.bottom + 4}
							className="blk-chart-tick-line"
						/>
						<text x={x} y={y} textAnchor="middle" className="blk-chart-tick">
							{formatValue(tick, block.x.format ?? (block.x.kind === "time" ? "datetime" : undefined), locale)}
						</text>
					</g>
				);
			})}
		</g>
	);
}

/** All series in order: areas first (background), then bars, lines. */
function renderSeries(
	series: readonly ResolvedSeries[],
	extent: Extent,
	stackBases: readonly (readonly number[] | undefined)[],
): ReactNode {
	const order = [
		...series.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "area"),
		...series.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "bar"),
		...series.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "line"),
	];
	return (
		<g className="blk-chart-series">
			{order.map(({ s, i }) => {
				const color = `var(--chart-${(i % 8) + 1})`;
				if (s.kind === "bar") {
					return (
						<Bars
							key={`s${i}`}
							series={s}
							index={i}
							extent={extent}
							base={stackBases[i]}
							color={color}
						/>
					);
				}
				const { d, area } = seriesPath(s, i, extent, stackBases[i]);
				if (d === "") return null;
				return (
					<path
						key={`s${i}`}
						data-kind={s.kind}
						data-series={i}
						d={d}
						fill={area ? `color-mix(in srgb, ${color} 25%, transparent)` : "none"}
						stroke={color}
						strokeWidth={2}
						strokeLinejoin="round"
						strokeLinecap="round"
					/>
				);
			})}
		</g>
	);
}

/** One bar series' rects (shared-x grouping when unstacked). */
function Bars(props: {
	series: ResolvedSeries;
	index: number;
	extent: Extent;
	base: readonly number[] | undefined;
	color: string;
}): ReactNode {
	const { series, index, extent, base, color } = props;
	const { x0, x1, y0, y1 } = extent;
	const xs = x1 - x0 || 1;
	const ys = y1 - y0 || 1;
	const inner = WIDTH - PAD.left - PAD.right;
	const step = series.points.length > 1 ? inner / series.points.length : inner;
	const barWidth = Math.max(1, step * 0.6);
	return (
		<g data-kind="bar" data-series={index}>
			{series.points.map((point, i) => {
				const value = base === undefined ? point[1] : point[1] + (base[i] ?? 0);
				const bottomValue = base === undefined ? Math.max(0, y0) : (base[i] ?? y0);
				const x = PAD.left + ((point[0] - x0) / xs) * inner;
				const yTop = PAD.top + (1 - (value - y0) / ys) * (HEIGHT - PAD.top - PAD.bottom);
				const yBottom =
					PAD.top + (1 - (bottomValue - y0) / ys) * (HEIGHT - PAD.top - PAD.bottom);
				return (
					<rect
						key={`${point[0]}-${i}`}
						data-series={index}
						x={x - barWidth / 2}
						y={Math.min(yTop, yBottom)}
						width={barWidth}
						height={Math.abs(yBottom - yTop)}
						fill={color}
					/>
				);
			})}
		</g>
	);
}

/** Threshold rules: a dashed horizontal line + its bound label at `at`. */
function renderThresholds(
	block: ChartBlock,
	extent: Extent,
	ctx: ReturnType<typeof useSurfaceData>,
): ReactNode {
	const thresholds = block.thresholds ?? [];
	if (thresholds.length === 0) return null;
	const { y0, y1 } = extent;
	const ys = y1 - y0 || 1;
	return (
		<g className="blk-chart-thresholds">
			{thresholds.map((threshold, index) => {
				const y =
					PAD.top + (1 - (threshold.at - y0) / ys) * (HEIGHT - PAD.top - PAD.bottom);
				const label = boundString(ctx, threshold.label);
				return (
					<g key={index} data-threshold-at={threshold.at} data-tone={threshold.tone}>
						<line
							className="blk-chart-threshold"
							x1={PAD.left}
							x2={WIDTH - PAD.right}
							y1={y}
							y2={y}
						/>
						{label !== "" && (
							<text
								x={WIDTH - PAD.right}
								y={y - 4}
								textAnchor="end"
								className="blk-chart-threshold-label"
								data-tone={threshold.tone}
							>
								{label}
							</text>
						)}
					</g>
				);
			})}
		</g>
	);
}

/** The sparkline fallback: one polyline + the latest value per series. */
function SparkRow(props: {
	series: ResolvedSeries;
	color: string;
	locale: string;
}): ReactNode {
	const { series, color, locale } = props;
	const values = series.points.map(([, y]) => y);
	const last = values.length > 0 ? values[values.length - 1]! : undefined;
	const width = 100;
	const height = 24;
	let d = "";
	if (values.length > 1) {
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = max - min || 1;
		d = series.points
			.map((point, index) => {
				const x = (index / (series.points.length - 1)) * width;
				const y = height - ((point[1] - min) / span) * height;
				return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
			})
			.join(" ");
	}
	return (
		<div className="blk-chart-spark-row">
			<svg
				className="blk-chart-spark"
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				{d !== "" && <path d={d} fill="none" stroke={color} strokeWidth={2} />}
			</svg>
			<span className="blk-chart-spark-name" dir="auto">{series.name}</span>
			<span className="blk-chart-spark-value">
				{last === undefined ? "" : formatValue(last, undefined, locale)}
			</span>
		</div>
	);
}
