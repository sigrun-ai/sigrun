/**
 * Tone → terminal styling (UI-blocks spec §10.1): extensions set
 * MEANING (`neutral | accent | good | warn | bad | info`); this module
 * is the one place a tone becomes visual treatment, mapped through
 * {@link TuiTheme} tokens only — never raw SGR in block code.
 *
 * The TUI's tone treatment is a left marker column plus colour: the
 * marker makes tone legible without colour (NO_COLOR, Review Focus 5)
 * and doubles as the accent stripe `card.tone` calls for. On a
 * terminal that cannot render Unicode (`ctx.unicode === false`) the
 * markers take their ASCII forms (§10.2) so tone stays legible there
 * too.
 */

import type { Tone } from "@sigrun/shared/blocks";
import type { TuiTheme, TuiToken } from "../theme.js";

/**
 * The palette token each tone paints with (the TUI's tone table,
 * twin of the webui's `TONE_VARS`: `info` is a quiet emphasis, not a
 * state colour, so it maps to `muted` exactly as the webui maps it to
 * `--muted`).
 */
const TONE_TOKEN: Readonly<Record<Tone, TuiToken>> = {
	neutral: "text",
	accent: "accent",
	good: "ok",
	warn: "warn",
	bad: "bad",
	info: "muted",
};

/** The colourless marker: tone legible with NO_COLOR set (Focus 5). */
const TONE_MARKER: Readonly<Record<Tone, string>> = {
	neutral: "•",
	accent: "◆",
	good: "✓",
	warn: "▲",
	bad: "!",
	info: "·",
};

/**
 * The marker on a no-Unicode terminal (§10.2's ASCII path): the same
 * shapes in printable ASCII — `good` is `v`, matching `icons.ts`'s
 * `check` fallback, so a tone and its icon degrade alike. `bad` is
 * already ASCII.
 */
const TONE_MARKER_ASCII: Readonly<Record<Tone, string>> = {
	neutral: "-",
	accent: "*",
	good: "v",
	warn: "^",
	bad: "!",
	info: ".",
};

/** Style `text` in the tone's colour. */
export function toneFg(theme: TuiTheme, tone: Tone): (s: string) => string {
	return theme.fg(TONE_TOKEN[tone] ?? "text");
}

/**
 * The tone's one-character marker (shown in addition to colour);
 * `ascii` selects the no-Unicode form (§10.2 — callers pass
 * `!ctx.unicode`).
 */
export function toneMarker(tone: Tone, ascii: boolean): string {
	const table = ascii ? TONE_MARKER_ASCII : TONE_MARKER;
	return table[tone] ?? (ascii ? "-" : "•");
}
