/**
 * The TUI theme (Task C1, UI refresh): wraps src/shared/themes.ts's
 * palettes in pi-tui's color pipeline (parseColor → foregroundAnsi /
 * backgroundAnsi) so components style text through token names instead
 * of raw SGR sequences. The palette data lives in ONE place (themes.ts,
 * shared with the webui); this module owns only the terminal mapping.
 */

import { describe, expect, test } from "vitest";
import { createTuiTheme, plainTuiTheme } from "../src/theme.js";
import {
	ACCENTS,
	DEFAULT_ACCENT,
	DEFAULT_PALETTE,
	PALETTES,
} from "../../src/shared/themes.js";

const TRUECOLOR = { palette: DEFAULT_PALETTE, accent: DEFAULT_ACCENT, mode: "dark", colorMode: "truecolor" } as const;

describe("createTuiTheme (truecolor)", () => {
	test("fg(accent) renders the Baltic Amber RGB SGR", () => {
		const theme = createTuiTheme(TRUECOLOR);
		const out = theme.fg("accent")("x");
		// #d6a24a → r214 g162 b74 → SGR 38;2;214;162;74
		expect(out).toContain("38;2;214;162;74");
		expect(out).toContain("x");
	});

	test("fg(token) uses the palette+mode's value", () => {
		const theme = createTuiTheme({
			palette: "fjord",
			accent: DEFAULT_ACCENT,
			mode: "dark",
			colorMode: "truecolor",
		});
		// fjord dark text #dde6ee → 221 230 238
		expect(theme.fg("text")("y")).toContain("38;2;221;230;238");
	});

	test("bg(token) emits a background SGR", () => {
		const theme = createTuiTheme(TRUECOLOR);
		expect(theme.bg("bg")("z")).toContain("48;2;");
	});

	test("mode light flips the token values", () => {
		const accent = ACCENTS["baltic-amber"].light; // #a8741f
		const theme = createTuiTheme({
			palette: "fjord",
			accent: "baltic-amber",
			mode: "light",
			colorMode: "truecolor",
		});
		expect(theme.fg("accent")("x")).toContain("38;2;168;116;31");
		expect(accent).toBe("#a8741f");
	});

	test("bold/dim/italic wrap with attribute SGRs", () => {
		const theme = createTuiTheme(TRUECOLOR);
		expect(theme.bold("b")).toMatch(/1m.*b.*22m|^.*\[1mb/);
		expect(theme.dim("d")).toContain("2m");
		expect(theme.italic("i")).toContain("3m");
	});

	test("every palette token and accent styles without throwing", () => {
		for (const palette of Object.keys(PALETTES)) {
			for (const mode of ["dark", "light"] as const) {
				const theme = createTuiTheme({
					palette: palette as keyof typeof PALETTES,
					accent: "lichen",
					mode,
					colorMode: "truecolor",
				});
				for (const token of ["bg", "surface", "surface2", "border", "text", "muted", "faint", "ok", "code"]) {
					expect(theme.fg(token as never)("t")).toContain("t");
					expect(theme.bg(token as never)("t")).toContain("t");
				}
				expect(theme.fg("accent")("t")).toContain("t");
			}
		}
	});
});

describe("createTuiTheme (256color degradation)", () => {
	test("a 256color call differs from truecolor and is a valid SGR", () => {
		const accent = parseFor("baltic-amber");
		const tc = createTuiTheme(TRUECOLOR).fg("accent")("x");
		const c256 = createTuiTheme({
			palette: DEFAULT_PALETTE,
			accent: DEFAULT_ACCENT,
			mode: "dark",
			colorMode: "256color",
		}).fg("accent")("x");
		expect(c256).not.toBe(tc);
		expect(c256).toMatch(/\[38;5;\d+m/);
		expect(accent).toBeDefined();
	});
});

describe("plainTuiTheme", () => {
	test("every method is the identity function", () => {
		const theme = plainTuiTheme();
		expect(theme.fg("text")("abc")).toBe("abc");
		expect(theme.fg("accent")("abc")).toBe("abc");
		expect(theme.bg("bg")("abc")).toBe("abc");
		expect(theme.bold("abc")).toBe("abc");
		expect(theme.dim("abc")).toBe("abc");
		expect(theme.italic("abc")).toBe("abc");
	});
});

function parseFor(accent: string): string {
	return ACCENTS[accent as keyof typeof ACCENTS].dark;
}
