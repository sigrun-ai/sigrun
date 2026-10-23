/**
 * The card template (UI-blocks spec §5.5.1) as terminal lines: a FIXED
 * line layout, every slot optional except `title`, each slot resolved
 * against the item (`./` pointers).
 *
 * Layout, top to bottom:
 *  1. eyebrow line (dimmed small text)
 *  2. title line: icon glyph, tone marker, title (title carries the
 *     tone's colour through TuiTheme)
 *  3. subtitle (one line)
 *  4. body, wrapped and clamped to 4 lines (spec: lists and lanes clamp;
 *     the TUI clamps in every display — a 100-cell grid card cannot
 *     afford a full body either, and `detail` panes are Task 4's)
 *  5. badges + meta on ONE line (badges first, then meta facts)
 *  6. metrics, one per line (`label: value`, `formatValue` formatted)
 *  7. status: spinner frame (when `spinner` binds true) + tone marker +
 *     label — the frame ticks per render (`spinnerFrame`)
 *  8. deps as `after: id, id, …`
 *
 * The card `tone` marker also leads the title; with no tone binding the
 * marker is the neutral one so lines align.
 */

import { formatValue } from "@sigrun/shared/blocks";
import type { Card, CardMeta, IconName, JsonValue } from "@sigrun/shared/blocks";
import { bindRaw, bindText, bindTone, type BlockCtx } from "../context.js";
import { iconGlyph } from "../icons.js";
import { toneFg, toneMarker } from "../tones.js";
import { truncate, wrapPlain } from "../width.js";

/** The body clamp (spec §5.5.1: 4 lines in lists and lanes). */
export const CARD_BODY_LINES = 4;

/** The braille spinner frames (ASCII: the classic four-bar cycle). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_FRAMES_ASCII = ["*", "+", "x", "+"];

/** The spinner frame for render `tick` (a render-indexed clock: the TUI
 * has no card-local timers, so a spinning status advances as renders
 * arrive — the same convention ambient rows use). */
export function spinnerFrame(tick: number, ascii: boolean): string {
	const frames = ascii ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;
	return frames[tick % frames.length] ?? frames[0] ?? "*";
}

/** One meta entry resolved to its display text ("" = omit). */
function metaText(entry: CardMeta, ctx: BlockCtx, item: JsonValue): string {
	if ("person" in entry) {
		// The extension supplies the display name; `user` is the handle
		// and is not shown (spec §5.5.1).
		return bindText(entry.person.name, ctx);
	}
	if ("time" in entry) {
		const at = bindRaw(entry.time, ctx);
		return at === undefined ? "" : formatValue(at, entry.format, ctx.locale, ctx.timeZone);
	}
	return bindText(entry.text, ctx);
}

/**
 * The card's lines for `item` at `width`, indented `indent` cells.
 * `tick` indexes the spinner frame (the owning component's render
 * count). Lines are display-width truncated, never wider than the pane.
 */
export function cardLines(
	card: Card,
	item: JsonValue,
	ctx: BlockCtx,
	width: number,
	indent: number,
	tick: number,
): string[] {
	const pad = " ".repeat(indent);
	const inner = Math.max(1, width - indent);
	const itemCtx: BlockCtx = { ...ctx, item };
	const lines: string[] = [];
	const clamp = (line: string): string => truncate(line, inner);

	// 1. eyebrow
	const eyebrow = bindText(card.eyebrow, itemCtx);
	if (eyebrow !== "") lines.push(pad + clamp(ctx.theme.dim(eyebrow)));

	// 2. title: icon, tone marker, toned title text.
	const tone = bindTone(card.tone, itemCtx);
	const title = bindText(card.title, itemCtx);
	const icon = card.icon === undefined ? "" : `${iconGlyph(bindText(card.icon, itemCtx) as IconName, !ctx.unicode)} `;
	const marker = `${toneMarker(tone, !ctx.unicode)} `;
	lines.push(pad + clamp(`${icon}${marker}${toneFg(ctx.theme, tone)(title)}`));

	// 3. subtitle
	const subtitle = bindText(card.subtitle, itemCtx);
	if (subtitle !== "") lines.push(pad + clamp(subtitle));

	// 4. body, clamped to CARD_BODY_LINES.
	const body = bindText(card.body, itemCtx);
	if (body !== "") {
		for (const line of wrapPlain(body, inner).slice(0, CARD_BODY_LINES)) {
			lines.push(pad + line);
		}
	}

	// 5. badges + meta, one line.
	const parts: string[] = [];
	for (const badge of card.badges ?? []) {
		const text = bindText(badge.text, itemCtx);
		if (text === "") continue;
		const badgeTone = bindTone(badge.tone, itemCtx);
		parts.push(`[${toneFg(ctx.theme, badgeTone)(text)}]`);
	}
	const metaParts = (card.meta ?? [])
		.map((entry) => metaText(entry, itemCtx, item))
		.filter((text) => text !== "");
	if (metaParts.length > 0) parts.push(metaParts.join(" · "));
	if (parts.length > 0) lines.push(pad + clamp(parts.join(" ")));

	// 6. metrics, one per line.
	for (const metric of card.metrics ?? []) {
		const label = bindText(metric.label, itemCtx);
		const value = bindRaw(metric.value, itemCtx);
		if (label === "" || value === undefined) continue;
		lines.push(pad + clamp(`${label}: ${formatValue(value, metric.format, ctx.locale, ctx.timeZone)}`));
	}

	// 7. status (spinner frame + tone marker + label).
	if (card.status !== undefined) {
		const label = bindText(card.status.label, itemCtx);
		if (label !== "") {
			const statusTone = bindTone(card.status.tone, itemCtx);
			const spin = bindRaw(card.status.spinner, itemCtx) === true;
	const frame = spin ? `${spinnerFrame(Math.max(0, tick - 1), !ctx.unicode)} ` : "";
			const statusMarker = `${toneMarker(statusTone, !ctx.unicode)} `;
			lines.push(pad + clamp(`${frame}${statusMarker}${toneFg(ctx.theme, statusTone)(label)}`));
		}
	}

	// 8. deps ("after: …").
	const depsRaw = bindRaw(card.deps, itemCtx);
	if (Array.isArray(depsRaw)) {
		const deps = depsRaw.filter((dep): dep is string => typeof dep === "string");
		if (deps.length > 0) lines.push(pad + clamp(`after: ${deps.join(", ")}`));
	}

	return lines;
}
