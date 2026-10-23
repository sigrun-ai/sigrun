/**
 * Named icons in the terminal (UI-blocks spec §10.2): each of the 49
 * closed-set names maps to a Unicode glyph with an ASCII fallback. The
 * ASCII form is used when the terminal can't be assumed to render the
 * glyph (the plain/no-Unicode path, and tests that assert structure).
 *
 * Glyphs are chosen for terminal legibility over pictorial fidelity
 * (a 1-cell glyph beats a 2-cell emoji that shifts the grid): mostly
 * Miscellaneous Symbols and Dingbats, all narrow in standard terminals.
 */

import type { IconName } from "@sigrun/shared/blocks";

/** The Unicode glyph and its ASCII fallback, per icon name. */
const GLYPHS: Readonly<Record<IconName, readonly [string, string]>> = {
	// navigation and actions
	add: ["+", "+"],
	edit: ["✎", "e"],
	delete: ["✖", "x"],
	refresh: ["↻", "r"],
	search: ["⌕", "/"],
	filter: ["▽", "f"],
	share: ["⇱", "s"],
	copy: ["⧉", "c"],
	link: ["⚓", "l"],
	external: ["↗", "^"],
	more: ["⋯", "."],
	check: ["✓", "v"],
	close: ["✕", "x"],
	drag: ["⠿", "#"],
	// objects
	file: ["▤", "f"],
	folder: ["▸", ">"],
	calendar: ["▦", "#"],
	clock: ["◷", "o"],
	user: ["◔", "u"],
	users: ["◍", "U"],
	tag: ["◇", "t"],
	list: ["☰", "="],
	board: ["▥", "|"],
	chart: ["▄", "c"],
	image: ["▣", "i"],
	book: ["❑", "b"],
	cart: ["▤", "C"],
	home: ["⌂", "h"],
	bell: ["⚑", "B"],
	lock: ["▪", "L"],
	key: ["◂", "K"],
	// status
	info: ["ℹ", "i"],
	warn: ["▲", "!"],
	error: ["✖", "!!"],
	success: ["✓", "v"],
	pending: ["◌", "-"],
	running: ["▶", "R"],
	// weather
	sun: ["☀", "*"],
	moon: ["☾", ")"],
	cloud: ["☁", "o"],
	"cloud-sun": ["⛅", "o*"],
	"cloud-rain": ["☔", "or"],
	"cloud-snow": ["❄", "os"],
	"cloud-lightning": ["⚡", "ol"],
	fog: ["≋", "~"],
	wind: ["≈", "w"],
	droplets: ["❍", "d"],
	thermometer: ["▴", "T"],
	umbrella: ["☂", "u"],
};

/** The icon glyph for `name` (the ASCII fallback when the terminal
 * lacks Unicode support — callers pass `!ctx.unicode`). */
export function iconGlyph(name: IconName, ascii: boolean): string {
	const pair = GLYPHS[name];
	if (pair === undefined) return ascii ? "?" : name;
	return ascii ? pair[1] : pair[0];
}
