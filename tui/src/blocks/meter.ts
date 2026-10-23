/**
 * The `meter` block (UI-blocks spec §5.3): `label value` plus a bar
 * filling the rest of the line — `█`/`░` on a Unicode terminal,
 * `#`/`-` without one. A crossed threshold's tone paints the bar and
 * the value (the LAST crossed threshold wins, matching the webui).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatValue } from "@sigrun/shared/blocks";
import type { JsonValue, MeterBlock, Tone } from "@sigrun/shared/blocks";
import { bindRaw, bindText, type BlockCtx } from "./context.js";
import { truncate } from "./width.js";
import { toneFg } from "./tones.js";
import { Lines } from "./layout.js";

/** The highest threshold the value crosses, if any. */
function crossedTone(block: MeterBlock, value: number): Tone | undefined {
	let tone: Tone | undefined;
	for (const threshold of block.thresholds ?? []) {
		if (value >= threshold.at) tone = threshold.tone;
	}
	return tone;
}

/** `meter`: one line, `label value bar` exactly `width` cells. */
export function renderMeter(block: MeterBlock, ctx: BlockCtx): Component {
	return new Lines((width) => {
		const raw = bindRaw(block.value, ctx);
		const value = typeof raw === "number" ? raw : 0;
		const min = block.min ?? 0;
		const max = block.max ?? 1;
		const label = bindText(block.label, ctx);
		const text = formatValue(value as JsonValue, block.format, ctx.locale);
		const head = label === "" ? text : `${label} ${text}`;
		const tone = crossedTone(block, value);
		const paint = tone === undefined ? (s: string): string => s : toneFg(ctx.theme, tone);
		const barCells = Math.max(1, width - visibleWidth(head) - 1);
		const t = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
		const bar = meterBar(t, barCells, !ctx.unicode);
		return [truncate(`${paint(head)} ${paint(bar)}`, width)];
	});
}

/**
 * The bare meter bar (no label): `filled`/`empty` cells of the 0–1
 * `level`, for inline cells (the collection table's `meter` column).
 */
export function meterBar(level: number, cells: number, ascii: boolean): string {
	const fill = ascii ? "#" : "█";
	const empty = ascii ? "-" : "░";
	const t = Math.max(0, Math.min(1, level));
	const filled = Math.floor(cells * t);
	return fill.repeat(filled) + empty.repeat(cells - filled);
}
