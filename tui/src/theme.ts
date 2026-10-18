/**
 * The TUI theme (Task C1, UI refresh): wraps src/shared/themes.ts's
 * palettes in pi-tui's color pipeline (parseColor → foregroundAnsi /
 * backgroundAnsi) so components style text through token names instead
 * of raw SGR sequences. The palette DATA lives in one place
 * (src/shared/themes.ts, shared with the webui — zero duplication);
 * this module owns only the terminal mapping.
 *
 * Degradation: `colorMode` threads through foregroundAnsi/backgroundAnsi,
 * so a 256color terminal gets `38;5;N` (pi-tui's nearest-256 mapping)
 * instead of truecolor `38;2;r;g;b`. The launcher resolves the mode at
 * boot via `getTerminalColorMode()`; tests pass it explicitly.
 *
 * The `code` token is CSS `rgba(...)` (the shared data's overlay chip):
 * pi-tui's parseColor takes hex/`rgb()` only, so it is alpha-composited
 * over the mode's `bg` token here — the same visual the webui gets from
 * layering the overlay on the background.
 */

import {
	backgroundAnsi,
	foregroundAnsi,
	parseColor,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";
import {
	ACCENTS,
	PALETTES,
	type AccentName,
	type ModeName,
	type PaletteName,
	type PaletteTokens,
} from "../../src/shared/themes.js";

/** A palette token, or the accent colour. */
export type TuiToken = keyof PaletteTokens | "accent";

/**
 * Terminal styling surface: token-named fg/bg plus the plain attribute
 * helpers. `fg`/`bg` return string wrappers so call sites compose
 * (`theme.fg("muted")(text)`) without holding SGR sequences.
 */
export interface TuiTheme {
	fg(token: TuiToken): (s: string) => string;
	bg(token: TuiToken): (s: string) => string;
	bold(s: string): string;
	dim(s: string): string;
	italic(s: string): string;
}

export interface TuiThemeOptions {
	readonly palette: PaletteName;
	readonly accent: AccentName;
	readonly mode: ModeName;
	readonly colorMode: TerminalColorMode;
}

const RESET = "\u001b[0m";
const attr = (code: string, s: string): string => `\u001b[${code}m${s}${RESET}`;

/** Alpha-composite a CSS `rgba(r,g,b,a)` over an opaque base. */
function compositeOver(rgba: string, base: string): string {
	const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
		rgba.replace(/\s/g, ""),
	);
	if (!m) return base;
	const [, rs, gs, bs, as = "1"] = m;
	const [r, g, b, a] = [Number(rs), Number(gs), Number(bs), Number(as)];
	const [br, bg, bb] = hexToRgb(base);
	const mix = (fg: number, bgv: number): number =>
		Math.round(fg * a + bgv * (1 - a));
	return rgbToHex(mix(r, br), mix(g, bg), mix(b, bb));
}

function hexToRgb(hex: string): [number, number, number] {
	const value = hex.replace("#", "");
	return [
		parseInt(value.slice(0, 2), 16),
		parseInt(value.slice(2, 4), 16),
		parseInt(value.slice(4, 6), 16),
	];
}

function rgbToHex(r: number, g: number, b: number): string {
	const two = (n: number): string => n.toString(16).padStart(2, "0");
	return `#${two(r)}${two(g)}${two(b)}`;
}

/** Resolve a token to a parseable colour for the palette+mode. */
function resolveToken(
	tokens: PaletteTokens,
	accentHex: string,
	token: TuiToken,
): string {
	if (token === "accent") return accentHex;
	const value = tokens[token];
	// `code` is the rgba overlay chip; composite over the mode's bg.
	if (value.startsWith("rgba")) return compositeOver(value, tokens.bg);
	return value;
}

/**
 * Build the theme. Precomputes each token's fg/bg SGR (pi-tui's cached
 * sequence idiom — `styleTextWithAnsi` without the dependency) and wraps
 * it in reset-terminated spans.
 */
export function createTuiTheme(options: TuiThemeOptions): TuiTheme {
	const tokens = PALETTES[options.palette][options.mode];
	const accentHex = ACCENTS[options.accent][options.mode];
	const mode = options.colorMode;
	const fgSequences = new Map<TuiToken, string>();
	const bgSequences = new Map<TuiToken, string>();
	for (const token of [
		"bg",
		"surface",
		"surface2",
		"border",
		"text",
		"muted",
		"faint",
		"ok",
		"code",
		"accent",
	] as const satisfies readonly TuiToken[]) {
		const color = parseColor(resolveToken(tokens, accentHex, token));
		fgSequences.set(token, foregroundAnsi(color, mode));
		bgSequences.set(token, backgroundAnsi(color, mode));
	}
	const span = (seq: string, s: string): string => `${seq}${s}${RESET}`;
	return {
		fg: (token) => (s) => span(fgSequences.get(token) ?? "", s),
		bg: (token) => (s) => span(bgSequences.get(token) ?? "", s),
		bold: (s) => attr("1", s),
		dim: (s) => attr("2", s),
		italic: (s) => attr("3", s),
	};
}

/**
 * The no-colour fallback (tests, non-TTY sinks): every method is the
 * identity — the structure renders identically without SGR sequences.
 */
export function plainTuiTheme(): TuiTheme {
	const identity = (s: string): string => s;
	return {
		fg: () => identity,
		bg: () => identity,
		bold: identity,
		dim: identity,
		italic: identity,
	};
}
