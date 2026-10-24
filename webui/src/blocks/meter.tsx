/**
 * The meter block (UI-blocks U1 Task 2, spec §5.3): a labelled progress
 * bar over `[min, max]` (defaults 0–1). The tone is the highest
 * threshold at or below the value — accent below every threshold — and
 * the fill clamps to [0%, 100%] so out-of-range data cannot break the
 * layout. `value` is a non-string `Bindable`; the `bound` helper's
 * literal-branch fix means a binding to a missing path renders the
 * empty meter (0% fill), never the `{$: …}` object.
 */

import type { ReactNode } from "react";
import { formatValue, type MeterBlock, type Tone } from "@sigrun/shared/blocks";
import { bound, boundString, useSurfaceData } from "./context";

/** The tone a value takes under `thresholds`: the highest one reached
 *  (the greatest `at` at or below the value — independent of the
 *  thresholds' array order; the first of equal `at`s wins). */
export function meterTone(
	value: number | undefined,
	thresholds: readonly { readonly at: number; readonly tone: Tone }[] | undefined,
): Tone {
	if (value === undefined || thresholds === undefined) return "accent";
	let reached: { readonly at: number; readonly tone: Tone } | undefined;
	for (const threshold of thresholds) {
		if (
			threshold.at <= value &&
			(reached === undefined || threshold.at > reached.at)
		) {
			reached = threshold;
		}
	}
	return reached?.tone ?? "accent";
}

/** The fill fraction, clamped to [0, 1]. */
export function meterFraction(
	value: number,
	min: number,
	max: number,
): number {
	if (max === min) return 0;
	const fraction = (value - min) / (max - min);
	return Math.min(1, Math.max(0, fraction));
}

/** A meter block. */
export function MeterBlockView(props: { block: MeterBlock }): ReactNode {
	const ctx = useSurfaceData();
	const block = props.block;
	const min = block.min ?? 0;
	const max = block.max ?? 1;
	const value = bound(ctx, block.value);
	const tone = meterTone(value, block.thresholds);
	const label = boundString(ctx, block.label);

	const fraction =
		value === undefined ? 0 : meterFraction(value, min, max);
	const valueText =
		value === undefined ? "" : formatValue(value, block.format, ctx.locale);

	return (
		<div
			className="blk blk-meter"
			data-block="meter"
			data-tone={tone}
		>
			{(label !== "" || valueText !== "") && (
				<div className="blk-meter-head">
					{label !== "" && (
						<span className="blk-meter-label" dir="auto">{label}</span>
					)}
					{valueText !== "" && (
						<span className="blk-meter-value">{valueText}</span>
					)}
				</div>
			)}
			<div
				className="blk-meter-track"
				role="meter"
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuenow={value ?? undefined}
				aria-label={label !== "" ? label : undefined}
			>
				<div className="blk-meter-fill" style={{ width: `${fraction * 100}%` }} />
			</div>
		</div>
	);
}
