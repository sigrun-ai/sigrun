/**
 * The shared theme data (Task B1, UI refresh): the four palettes and
 * seven accents of the UI refresh, plus their name guards.
 *
 * PURE module: no imports at all (test/views-purity.test.ts enforces
 * this). Both clients — webui (bundler, DOM) and tui (NodeNext) —
 * consume this file from a single source; any import would drag a
 * dependency only one client can load or resolve.
 *
 * Colour values are copied verbatim from the UI-refresh palette mockup
 * (palettes.html), with the mockup ids renamed to the plan ids: palette `iron` →
 * `iron-ember`, `aurora` → `polar-night`, `birch` → `birch-moss`;
 * accent `amber` → `baltic-amber`; token key `surface-2` → `surface2`.
 */

export type PaletteName =
	| "fjord"
	| "iron-ember"
	| "polar-night"
	| "birch-moss";

export type AccentName =
	| "baltic-amber"
	| "ember"
	| "lingonberry"
	| "glacier"
	| "aurora"
	| "lichen"
	| "heather";

export type ModeName = "dark" | "light";

/** One mode's tokens: every value a CSS colour literal. */
export interface PaletteTokens {
	readonly bg: string;
	readonly surface: string;
	readonly surface2: string;
	readonly border: string;
	readonly text: string;
	readonly muted: string;
	readonly faint: string;
	readonly ok: string;
	readonly code: string;
}

export interface Palette {
	readonly label: string;
	readonly defaultAccent: AccentName;
	readonly dark: PaletteTokens;
	readonly light: PaletteTokens;
}

export interface Accent {
	readonly label: string;
	readonly dark: string;
	readonly light: string;
}

export const PALETTES: Readonly<Record<PaletteName, Palette>> = {
	fjord: {
		label: "Fjord",
		defaultAccent: "baltic-amber",
		dark: {
			bg: "#0b0f13",
			surface: "#11171e",
			surface2: "#18202a",
			border: "#222d39",
			text: "#dde6ee",
			muted: "#8d9cab",
			faint: "#5f6e7d",
			ok: "#7fbf9a",
			code: "rgba(255,255,255,.06)",
		},
		light: {
			bg: "#eef2f5",
			surface: "#ffffff",
			surface2: "#e3e9ef",
			border: "#d3dbe3",
			text: "#18212a",
			muted: "#4d5b69",
			faint: "#8593a1",
			ok: "#2f8a5a",
			code: "rgba(0,0,0,.05)",
		},
	},
	"iron-ember": {
		label: "Iron & Ember",
		defaultAccent: "ember",
		dark: {
			bg: "#0e0e0f",
			surface: "#161618",
			surface2: "#1e1e21",
			border: "#2a2a2e",
			text: "#e6e1da",
			muted: "#9a958e",
			faint: "#66625d",
			ok: "#8fb58a",
			code: "rgba(255,255,255,.06)",
		},
		light: {
			bg: "#f3f1ee",
			surface: "#fbfaf8",
			surface2: "#e9e6e1",
			border: "#dbd7d1",
			text: "#1c1b1a",
			muted: "#55524d",
			faint: "#8e8a84",
			ok: "#3e7a3a",
			code: "rgba(0,0,0,.05)",
		},
	},
	"polar-night": {
		label: "Polar Night",
		defaultAccent: "aurora",
		dark: {
			bg: "#090d16",
			surface: "#0f1524",
			surface2: "#161e31",
			border: "#1f2942",
			text: "#e2e8f3",
			muted: "#8e9ab2",
			faint: "#5d6984",
			ok: "#5fd4a8",
			code: "rgba(255,255,255,.06)",
		},
		light: {
			bg: "#f0f3f9",
			surface: "#ffffff",
			surface2: "#e4e9f3",
			border: "#d2d9e6",
			text: "#141b2b",
			muted: "#4b5670",
			faint: "#8691a8",
			ok: "#13866a",
			code: "rgba(0,0,0,.05)",
		},
	},
	"birch-moss": {
		label: "Birch & Moss",
		defaultAccent: "lichen",
		dark: {
			bg: "#0d100d",
			surface: "#141a15",
			surface2: "#1b221c",
			border: "#263027",
			text: "#e8e6dc",
			muted: "#9ba091",
			faint: "#666d60",
			ok: "#9cc48a",
			code: "rgba(255,255,255,.06)",
		},
		light: {
			bg: "#f3f2ea",
			surface: "#fbfbf6",
			surface2: "#e7e7dc",
			border: "#d8d8ca",
			text: "#1b1e18",
			muted: "#525849",
			faint: "#8b9080",
			ok: "#4a7a35",
			code: "rgba(0,0,0,.05)",
		},
	},
};

export const ACCENTS: Readonly<Record<AccentName, Accent>> = {
	"baltic-amber": { label: "Baltic Amber", dark: "#d6a24a", light: "#a8741f" },
	ember: { label: "Ember", dark: "#d9773a", light: "#b8571c" },
	lingonberry: { label: "Lingonberry", dark: "#d0606a", light: "#a83440" },
	glacier: { label: "Glacier", dark: "#8fb8d0", light: "#2f6f93" },
	aurora: { label: "Aurora", dark: "#5fd4a8", light: "#13866a" },
	lichen: { label: "Lichen", dark: "#b9c46a", light: "#6f7a1f" },
	heather: { label: "Heather", dark: "#a993c9", light: "#6c4f99" },
};

export const PALETTE_NAMES: readonly PaletteName[] = [
	"fjord",
	"iron-ember",
	"polar-night",
	"birch-moss",
];

export const ACCENT_NAMES: readonly AccentName[] = [
	"baltic-amber",
	"ember",
	"lingonberry",
	"glacier",
	"aurora",
	"lichen",
	"heather",
];

/** The shipped default: Polar Night + Baltic Amber. */
export const DEFAULT_PALETTE: PaletteName = "polar-night";

export const DEFAULT_ACCENT: AccentName = "baltic-amber";

export function isPaletteName(value: unknown): value is PaletteName {
	return (
		typeof value === "string" &&
		Object.prototype.hasOwnProperty.call(PALETTES, value)
	);
}

export function isAccentName(value: unknown): value is AccentName {
	return (
		typeof value === "string" &&
		Object.prototype.hasOwnProperty.call(ACCENTS, value)
	);
}
