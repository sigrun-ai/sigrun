/**
 * Ambient surfaces (the seam's channel half, docs/approval-ux-seams.md):
 * the generic panel for keyed status/panel surfaces.
 *
 * Rendering contract: one slot per key; `line` as text (segments joined by
 * zone); `rows` as a list — severity-sorted with quiet folded by default,
 * glyph per status enum, deps rendered as markers, metrics formatted via
 * the `format` hint; `gauge` as label+percent bar with phase/elapsed/recent
 * output; `ledger` as a newest-first feed. `details` renders collapsed,
 * never interpreted. Purely read-only — ambient surfaces don't take answers
 * in v1 (actions re-route through interaction records).
 */

import type {
	AmbientMetricsWire,
	AmbientRowWire,
	AmbientWire,
} from "../api";

function formatMetric(value: number, format: string | undefined): string {
	if (format === "usd") return `$${value.toFixed(4)}`;
	if (format === "percent") return `${Math.round(value * 100)}%`;
	if (format === "compact" && Math.abs(value) >= 1000) {
		return `${(value / 1000).toFixed(1)}k`;
	}
	return String(value);
}

function MetricsSpan(props: { metrics: AmbientMetricsWire | undefined }) {
	const { metrics } = props;
	if (metrics === undefined) return null;
	const parts: string[] = [];
	if (metrics.tokens !== undefined) {
		parts.push(`tok ${formatMetric(metrics.tokens, metrics.format)}`);
	}
	if (metrics.cost !== undefined) {
		parts.push(`$${metrics.cost.toFixed(4)}`);
	}
	if (metrics.total !== undefined) {
		parts.push(`${metrics.completed ?? metrics.current ?? 0}/${metrics.total}`);
	} else if (metrics.current !== undefined) {
		parts.push(`cur ${metrics.current}`);
	}
	if (parts.length === 0) return null;
	return <span className="ambient-metrics">{parts.join(" · ")}</span>;
}

function RowsList(props: { rows: readonly AmbientRowWire[] }) {
	const { rows } = props;
	const sorted = [...rows].sort((a, b) => {
		const sa = a.severity ?? 2;
		const sb = b.severity ?? 2;
		if (sa !== sb) return sa - sb;
		return a.id < b.id ? -1 : 1;
	});
	const visible = sorted.filter((row) => row.quiet !== true);
	const quietCount = sorted.length - visible.length;
	return (
		<ul className="ambient-rows">
			{visible.map((row) => (
				<li
					key={row.id}
					className="ambient-row"
					data-status={row.status ?? "none"}
					style={row.depth !== undefined ? { paddingLeft: `${row.depth * 1.2}rem` } : undefined}
				>
					<span className="ambient-row-glyph">
						{row.status ?? "·"}
					</span>
					<span className="ambient-row-label">{row.label}</span>
					{row.spinnerLabel !== undefined && (
						<span className="ambient-row-spinner">{row.spinnerLabel}</span>
					)}
					{row.detail !== undefined && (
						<span className="ambient-row-detail">{row.detail}</span>
					)}
					{row.deps !== undefined && row.deps.length > 0 && (
						<span className="ambient-row-deps">⛓ {row.deps.join(",")}</span>
					)}
					<MetricsSpan metrics={row.metrics} />
				</li>
			))}
			{quietCount > 0 && (
				<li className="ambient-row ambient-quiet-summary">
					+{quietCount} quiet
				</li>
			)}
		</ul>
	);
}

/** One ambient surface. */
export function AmbientPanel(props: { surface: AmbientWire }) {
	const { surface } = props;
	const body = surface.body;
	const line = body?.line;
	const rows = body?.rows ?? [];
	const gauge = body?.gauge;
	const ledger = body?.ledger ?? [];
	const empty =
		line === undefined && rows.length === 0 && gauge === undefined && ledger.length === 0;
	if (empty && surface.details === undefined) return null;
	return (
		<div className="ambient-surface" data-key={surface.key} data-place={surface.place}>
			<div className="ambient-surface-title">
				<span className="ambient-key">{surface.key}</span>
				<span className="ambient-owner">{surface.owner}</span>
			</div>
			{line !== undefined && (
				<div className="ambient-line">
					{line.segments !== undefined && line.segments.length > 0
						? line.segments.map((segment) => (
								<span
									key={segment.id}
									className={`ambient-segment ambient-segment-${segment.place ?? "left"}`}
								>
									{segment.text}
								</span>
							))
						: line.text}
				</div>
			)}
			{rows.length > 0 && <RowsList rows={rows} />}
			{gauge !== undefined && (
				<div className="ambient-gauge">
					<div className="ambient-gauge-label">
						{gauge.label}
						{gauge.phase !== undefined && ` · ${gauge.phase}`}
						{gauge.elapsedMs !== undefined &&
							` · ${(gauge.elapsedMs / 1000).toFixed(1)}s`}
					</div>
					{gauge.percent !== undefined && (
						<div className="ambient-gauge-bar">
							<div
								className="ambient-gauge-fill"
								style={{ width: `${Math.min(100, Math.max(0, gauge.percent))}%` }}
							/>
						</div>
					)}
					{gauge.checks !== undefined && gauge.checks.length > 0 && (
						<RowsList rows={gauge.checks} />
					)}
					{gauge.recentOutput !== undefined && gauge.recentOutput.length > 0 && (
						<pre className="ambient-recent-output">
							{gauge.recentOutput.slice(-3).join("\n")}
						</pre>
					)}
				</div>
			)}
			{ledger.length > 0 && (
				<ul className="ambient-ledger">
					{[...ledger].reverse().map((entry) => (
						<li key={entry.id} className="ambient-ledger-entry">
							<span className="ambient-ledger-kind">{entry.kind}</span>
							<span className="ambient-ledger-summary">{entry.summary}</span>
							{entry.detail !== undefined && entry.detail.length > 0 && (
								<span className="ambient-ledger-detail">
									{entry.detail.join(" · ")}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
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
export function AmbientPanels(props: { surfaces: readonly AmbientWire[] }) {
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
