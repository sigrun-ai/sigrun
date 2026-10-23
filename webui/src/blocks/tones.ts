/**
 * Tones (UI-blocks U1 Task 1, spec §10.1): meaning-based colouring.
 * Each tone maps onto CSS variables the theme already defines — the
 * palette tokens `useTheme` sets (`--accent`, `--ok`) plus the state
 * colours `app.css` pins per mode (`--warn`, `--danger`) — so a block
 * never carries a colour and every palette/accent combination just
 * works. Components set `data-tone` and colour through `blocks.css`.
 */

import type { Tone } from "@sigrun/shared/blocks";

/** The CSS custom property each tone reads its colour from. */
export const TONE_VARS: Readonly<Record<Tone, string>> = {
	neutral: "--text",
	accent: "--accent",
	good: "--ok",
	warn: "--warn",
	bad: "--danger",
	info: "--muted",
};

/** A tone's foreground style (`{ color: var(--x) }`), for the text and
 *  icon slots that colour directly. */
export function toneColor(tone: Tone): { readonly color: string } {
	return { color: `var(${TONE_VARS[tone]})` };
}

/** A tone's translucent background (the accent already has its tint;
 *  the others mix the tone colour into the surface). */
export function toneBackground(tone: Tone): { readonly background: string } {
	if (tone === "accent") return { background: "var(--accent-bg)" };
	return {
		background: `color-mix(in srgb, var(${TONE_VARS[tone]}) 12%, transparent)`,
	};
}
