/**
 * Tone → terminal styling (UI-blocks spec §10.1): extensions set
 * MEANING (`neutral | accent | good | warn | bad | info`); this module
 * is the one place a tone becomes visual treatment, mapped through
 * {@link TuiTheme} tokens only — never raw SGR in block code.
 *
 * The TUI's tone treatment is a left marker column plus colour: the
 * marker makes tone legible without colour (NO_COLOR, Review Focus 5)
 * and doubles as the accent stripe `card.tone` calls for.
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

/** Style `text` in the tone's colour. */
export function toneFg(theme: TuiTheme, tone: Tone): (s: string) => string {
	return theme.fg(TONE_TOKEN[tone] ?? "text");
}

/** The tone's one-character marker (shown in addition to colour). */
export function toneMarker(tone: Tone): string {
	return TONE_MARKER[tone] ?? "•";
}
