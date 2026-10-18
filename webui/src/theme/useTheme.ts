/**
 * useTheme (B2, UI refresh): the mode/palette/accent theme system over
 * `src/shared/themes.ts` (the B1 pure module — the single palette/accent
 * data source; nothing here duplicates it).
 *
 * Three values, each persisted under its own storage key and applied to
 * the root element on every change:
 * - `mode` (`"dark" | "light" | "system"`, `sigrun.theme`; the legacy
 *   Task-25 `dark`/`light` values load as explicit modes). `system`
 *   follows `matchMedia("(prefers-color-scheme: dark)")` LIVE — the
 *   listener stays attached, so an OS flip re-themes mid-session.
 * - `palette` (one of PALETTES, `sigrun.palette`; garbage → the default,
 *   rewritten on load).
 * - `accent` (one of ACCENTS, `sigrun.accent`; the stored legacy `amber`
 *   migrates to `baltic-amber`, any other unknown value → DEFAULT_ACCENT,
 *   both rewritten on load).
 *
 * `resolved` is the mode the UI paints: the stored mode unless system,
 * where the live media query decides. The palette's tokens for that mode
 * land on the root as CSS custom properties (`--bg --surface --surface-2
 * --border --text --muted --faint --ok --code --accent --accent-bg`) plus
 * `data-mode`/`data-palette`/`data-accent` attributes; `--accent-bg` is
 * the accent at 14% alpha in dark mode, 16% in light. app.css consumes
 * ONLY those tokens (its :root block carries the default palette's dark
 * values as the pre-mount paint fallback).
 *
 * Storage, root, and matchMedia are injectable: the app uses the defaults
 * (localStorage + document.documentElement + window.matchMedia), tests
 * pass fakes (the webui suite runs under react-test-renderer with no
 * DOM). A missing localStorage falls back to a session in-memory store so
 * boot never crashes.
 */

import { useEffect, useState } from "react";
import {
	ACCENTS,
	DEFAULT_ACCENT,
	DEFAULT_PALETTE,
	PALETTES,
	isAccentName,
	isPaletteName,
	type AccentName,
	type ModeName,
	type PaletteName,
} from "../../../src/shared/themes.js";

export type { AccentName, ModeName, PaletteName } from "../../../src/shared/themes.js";

/** The selectable mode: an explicit colour scheme, or follow the OS. */
export type ThemeMode = "dark" | "light" | "system";

export const THEME_STORAGE_KEY = "sigrun.theme";
export const PALETTE_STORAGE_KEY = "sigrun.palette";
export const ACCENT_STORAGE_KEY = "sigrun.accent";

/** The storage surface the hook needs (localStorage, or a test fake). */
export interface ThemeStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** The root-element surface the hook writes (`document.documentElement`). */
export interface ThemeRoot {
	dataset: Record<string, string | undefined>;
	setProperty(name: string, value: string): void;
}

/** The matchMedia surface the hook listens to (system mode). */
export interface MediaQueryLike {
	readonly matches: boolean;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

export type MatchMediaFn = (query: string) => MediaQueryLike | null;

export interface ThemeState {
	readonly mode: ThemeMode;
	readonly resolved: ModeName;
	readonly palette: PaletteName;
	readonly accent: AccentName;
	setMode(mode: ThemeMode): void;
	setPalette(palette: PaletteName): void;
	setAccent(accent: AccentName): void;
}

/* The no-localStorage fallback (private browsing modes, odd embeds): state
   works for the session, nothing persists across reloads. */
const memoryStorage: ThemeStorage = (() => {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
	};
})();

function defaultStorage(): ThemeStorage {
	const candidate = (globalThis as { localStorage?: ThemeStorage })
		.localStorage;
	return candidate ?? memoryStorage;
}

function defaultRoot(): ThemeRoot | null {
	const root = (
		globalThis as unknown as { document?: Document }
	).document?.documentElement;
	if (root === undefined) return null;
	// The root adapter: dataset for the attributes, and the element's
	// inline style for the token custom properties.
	return {
		dataset: root.dataset,
		setProperty: (name, value) => {
			root.style.setProperty(name, value);
		},
	};
}

function defaultMatchMedia(): MatchMediaFn | null {
	const media = (globalThis as { matchMedia?: MatchMediaFn }).matchMedia;
	return media ?? null;
}

/** Parse a stored mode; garbage falls back to the system default. */
function parseMode(stored: string | null): ThemeMode {
	return stored === "dark" || stored === "light" ? stored : "system";
}

/**
 * Load the stored accent, migrating legacy/unknown values and REWRITING
 * the store when a migration happened (the brief's "rewritten on load").
 */
function loadAccent(storage: ThemeStorage): AccentName {
	const stored = storage.getItem(ACCENT_STORAGE_KEY);
	if (stored === "amber") {
		const migrated: AccentName = "baltic-amber";
		storage.setItem(ACCENT_STORAGE_KEY, migrated);
		return migrated;
	}
	if (isAccentName(stored)) return stored;
	storage.setItem(ACCENT_STORAGE_KEY, DEFAULT_ACCENT);
	return DEFAULT_ACCENT;
}

/** Load the stored palette; garbage → the default, rewritten on load. */
function loadPalette(storage: ThemeStorage): PaletteName {
	const stored = storage.getItem(PALETTE_STORAGE_KEY);
	if (isPaletteName(stored)) return stored;
	storage.setItem(PALETTE_STORAGE_KEY, DEFAULT_PALETTE);
	return DEFAULT_PALETTE;
}

/** The palette's token → the CSS custom property it becomes. */
const TOKEN_PROPERTIES: Readonly<Record<string, string>> = {
	bg: "--bg",
	surface: "--surface",
	surface2: "--surface-2",
	border: "--border",
	text: "--text",
	muted: "--muted",
	faint: "--faint",
	ok: "--ok",
	code: "--code",
};

/**
 * The accent at `alpha` as an `rgba()` literal (the `--accent-bg` tint).
 * Falls back to a CSS `color-mix()` for a non-hex accent (none today, but
 * the accent table is shared data, not this module's to assume).
 */
function withAlpha(color: string, alpha: number): string {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
	if (hex === null) {
		return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
	}
	const digits = hex[1]!.length === 3
		? hex[1]!
				.split("")
				.map((digit) => digit + digit)
				.join("")
		: hex[1]!;
	const red = Number.parseInt(digits.slice(0, 2), 16);
	const green = Number.parseInt(digits.slice(2, 4), 16);
	const blue = Number.parseInt(digits.slice(4, 6), 16);
	return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function useTheme(options?: {
	readonly storage?: ThemeStorage;
	readonly root?: ThemeRoot | null;
	readonly matchMedia?: MatchMediaFn | null;
}): ThemeState {
	const storage = options?.storage ?? defaultStorage();
	const root = options?.root !== undefined ? options.root : defaultRoot();
	const matchMedia =
		options?.matchMedia !== undefined ? options.matchMedia : defaultMatchMedia();

	const [mode, setModeState] = useState<ThemeMode>(() =>
		parseMode(storage.getItem(THEME_STORAGE_KEY)),
	);
	const [palette, setPaletteState] = useState<PaletteName>(() =>
		loadPalette(storage),
	);
	const [accent, setAccentState] = useState<AccentName>(() =>
		loadAccent(storage),
	);
	// The LIVE system preference (dark when the query matches, else light).
	const [systemDark, setSystemDark] = useState<boolean>(() => {
		const query = matchMedia?.("(prefers-color-scheme: dark)");
		return query?.matches ?? true;
	});

	// Follow the OS in system mode: the listener stays attached for the
	// hook's lifetime, so a preference change re-themes mid-session.
	useEffect(() => {
		const query = matchMedia?.("(prefers-color-scheme: dark)");
		if (query === undefined || query === null) return;
		const onChange = () => setSystemDark(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, [matchMedia]);

	const resolved: ModeName =
		mode === "system" ? (systemDark ? "dark" : "light") : mode;

	// Apply on mount + every change: the palette's tokens for the resolved
	// mode as inline custom properties (app.css has no palette data of its
	// own), plus the dataset attributes the CSS switches on.
	useEffect(() => {
		if (root === null) return;
		const tokens = PALETTES[palette][resolved];
		for (const [token, property] of Object.entries(TOKEN_PROPERTIES)) {
			root.setProperty(property, tokens[token as keyof typeof tokens]);
		}
		const accentColor = ACCENTS[accent][resolved];
		root.setProperty("--accent", accentColor);
		root.setProperty(
			"--accent-bg",
			withAlpha(accentColor, resolved === "dark" ? 0.14 : 0.16),
		);
		root.dataset.mode = resolved;
		root.dataset.palette = palette;
		root.dataset.accent = accent;
	}, [root, resolved, palette, accent]);

	return {
		mode,
		resolved,
		palette,
		accent,
		setMode(next: ThemeMode) {
			storage.setItem(THEME_STORAGE_KEY, next);
			setModeState(next);
		},
		setPalette(next: PaletteName) {
			storage.setItem(PALETTE_STORAGE_KEY, next);
			setPaletteState(next);
		},
		setAccent(next: AccentName) {
			storage.setItem(ACCENT_STORAGE_KEY, next);
			setAccentState(next);
		},
	};
}
