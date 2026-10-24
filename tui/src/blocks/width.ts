/**
 * Terminal width for block rendering (UI-blocks U2 Task 1): the width
 * classes (spec §12.1), the `s`/`m`/`l` token scale (spec §5.2), and the
 * clamp/pad helpers every block renderer funnels through.
 *
 * The display-width measure is pi-tui's `visibleWidth` (grapheme-aware,
 * wcwidth-style, ANSI-safe) — re-exported here so block code has ONE
 * width import site and the Review-Focus-2 invariant ("every rendered
 * line's display width ≤ the pane") is enforced in one place:
 * {@link truncate}.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Size } from "@sigrun/shared/blocks";

/** The container width classes (spec §12.1, TUI column). */
export type WidthClass = "compact" | "regular" | "wide";

/** The compact/regular/wide boundary: cells (compact < 80 ≤ regular < 140 ≤ wide). */
export function widthClassOf(cells: number): WidthClass {
	if (cells < 80) return "compact";
	if (cells < 140) return "regular";
	return "wide";
}

/** Width tokens in cells (spec §5.2: the TUI maps s/m/l to 30/45/60). */
export const SIZE_CELLS: Readonly<Record<Size, number>> = {
	s: 30,
	m: 45,
	l: 60,
};

/**
 * Clamp one rendered line to `width` cells with an ellipsis (Review
 * Focus 2): ANSI-aware, wide-character-aware, never a mid-sequence cut.
 * Empty lines pass through.
 */
export function truncate(line: string, width: number): string {
	if (line === "") return "";
	return truncateToWidth(line, width, "…");
}

/** Pad a line to `width` cells by its DISPLAY width (for column joins). */
export function pad(line: string, width: number): string {
	const rest = width - visibleWidth(line);
	return rest > 0 ? line + " ".repeat(rest) : line;
}

/**
 * Fit a run of source lines into `width` cells: short runs stay one
 * line (truncated); longer word-wraps fold at spaces, each folded line
 * truncated. Used for plain-text values (markdown wraps itself).
 */
export function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [];
	const words = text.split(/\s+/).filter((w) => w !== "");
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current === "") {
			current = word;
		} else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current !== "") lines.push(current);
	return lines.map((line) => truncate(line, width));
}
