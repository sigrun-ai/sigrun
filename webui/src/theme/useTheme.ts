/**
 * useTheme (Task 25): the light/dark + accent theme system (spec §6.1, the
 * mockup's `data-theme` / `data-accent` switch).
 *
 * The hook owns two values — `theme` (`"dark" | "light"`) and `accent` (one
 * of {@link ACCENTS}) — initialized from storage, written back through on
 * every change, and applied to the root element's `data-theme` /
 * `data-accent` attributes (the CSS custom properties in app.css switch on
 * those attributes; see the mockup's `:root` / `[data-theme]` /
 * `[data-accent]` blocks).
 *
 * Storage + root are injectable: the app uses the defaults (localStorage +
 * document.documentElement), tests pass fakes (the webui suite runs under
 * react-test-renderer with no DOM). When no localStorage exists the hook
 * falls back to a module-level in-memory store so state still works for the
 * session (never a crash on boot).
 */

import { useEffect, useState } from "react";

export type ThemeName = "dark" | "light";

/** The accent themes the mockup's CSS ships (app.css ports them verbatim). */
export const ACCENTS = ["indigo", "emerald", "amber"] as const;
export type AccentName = (typeof ACCENTS)[number];

export const THEME_STORAGE_KEY = "sigrun.theme";
export const ACCENT_STORAGE_KEY = "sigrun.accent";

/** The storage surface the hook needs (localStorage, or a test fake). */
export interface ThemeStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** The root-element surface the hook writes (`document.documentElement`). */
export interface ThemeRoot {
	dataset: Record<string, string | undefined>;
}

export interface ThemeState {
	readonly theme: ThemeName;
	readonly accent: AccentName;
	toggleTheme(): void;
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
	const doc = (
		globalThis as {
			document?: { documentElement?: ThemeRoot };
		}
	).document;
	return doc?.documentElement ?? null;
}

/** Parse a stored theme; garbage falls back to the dark default. */
function parseTheme(stored: string | null): ThemeName {
	return stored === "light" ? "light" : "dark";
}

/** Parse a stored accent; garbage falls back to the indigo default. */
function parseAccent(stored: string | null): AccentName {
	return (ACCENTS as readonly string[]).includes(stored ?? "")
		? (stored as AccentName)
		: "indigo";
}

export function useTheme(options?: {
	readonly storage?: ThemeStorage;
	readonly root?: ThemeRoot | null;
}): ThemeState {
	const storage = options?.storage ?? defaultStorage();
	const root =
		options?.root !== undefined ? options.root : defaultRoot();
	const [theme, setTheme] = useState<ThemeName>(() =>
		parseTheme(storage.getItem(THEME_STORAGE_KEY)),
	);
	const [accent, setAccentState] = useState<AccentName>(() =>
		parseAccent(storage.getItem(ACCENT_STORAGE_KEY)),
	);

	// Apply on mount + every change: the CSS custom properties switch on
	// these dataset attributes.
	useEffect(() => {
		if (root === null) return;
		root.dataset.theme = theme;
		root.dataset.accent = accent;
	}, [root, theme, accent]);

	return {
		theme,
		accent,
		toggleTheme() {
			const next: ThemeName = theme === "dark" ? "light" : "dark";
			storage.setItem(THEME_STORAGE_KEY, next);
			setTheme(next);
		},
		setAccent(next: AccentName) {
			storage.setItem(ACCENT_STORAGE_KEY, next);
			setAccentState(next);
		},
	};
}
