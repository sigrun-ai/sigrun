/**
 * Task B1 (UI refresh): the shared theme data.
 *
 * `src/shared/themes.ts` is pure colour data copied verbatim from the
 * palette mockup (docs/superpowers/specs/assets/2026-10-17-ui-refresh/
 * palettes.html). These tests pin the SHAPE completely (every palette
 * carries a full dark/light token set, every accent a dark/light pair)
 * and pin a few sentinel VALUES so a sloppy re-copy from the mockup
 * cannot pass unnoticed — the sentinels span the id→name remapping
 * (`iron`→`iron-ember`, `amber`→`baltic-amber`) and the `surface-2` →
 * `surface2` key rename.
 */

import { describe, expect, it } from "vitest";
import {
	ACCENTS,
	ACCENT_NAMES,
	DEFAULT_ACCENT,
	DEFAULT_PALETTE,
	PALETTES,
	PALETTE_NAMES,
	isAccentName,
	isPaletteName,
	type AccentName,
	type PaletteName,
} from "../src/shared/themes.js";

const TOKENS = [
	"bg",
	"surface",
	"surface2",
	"border",
	"text",
	"muted",
	"faint",
	"ok",
	"code",
] as const;

const MODES = ["dark", "light"] as const;

describe("shared themes", () => {
	it("ships exactly the four palettes, each with a complete dark/light token set", () => {
		expect([...PALETTE_NAMES]).toEqual([
			"fjord",
			"iron-ember",
			"polar-night",
			"birch-moss",
		]);
		for (const name of PALETTE_NAMES) {
			const palette = PALETTES[name];
			expect(palette.label.length, `${name} label`).toBeGreaterThan(0);
			expect(isAccentName(palette.defaultAccent), `${name} defaultAccent`).toBe(
				true,
			);
			for (const mode of MODES) {
				for (const token of TOKENS) {
					const value = palette[mode][token];
					expect(typeof value, `${name}.${mode}.${token}`).toBe("string");
					expect(value.length, `${name}.${mode}.${token}`).toBeGreaterThan(0);
				}
			}
		}
	});

	it("ships exactly the seven accents, each with a dark and a light value", () => {
		expect([...ACCENT_NAMES]).toEqual([
			"baltic-amber",
			"ember",
			"lingonberry",
			"glacier",
			"aurora",
			"lichen",
			"heather",
		]);
		for (const name of ACCENT_NAMES) {
			const accent = ACCENTS[name];
			expect(accent.label.length, `${name} label`).toBeGreaterThan(0);
			for (const mode of MODES) {
				expect(typeof accent[mode], `${name}.${mode}`).toBe("string");
				expect(accent[mode].length, `${name}.${mode}`).toBeGreaterThan(0);
			}
		}
	});

	it("defaults to Polar Night + Baltic Amber", () => {
		expect(DEFAULT_PALETTE).toBe("polar-night");
		expect(DEFAULT_ACCENT).toBe("baltic-amber");
	});

	it("pins verbatim mockup values (copy-fidelity sentinels)", () => {
		expect(PALETTES["polar-night"].label).toBe("Polar Night");
		expect(PALETTES["polar-night"].dark.bg).toBe("#090d16");
		expect(PALETTES["polar-night"].dark.surface2).toBe("#161e31"); // mockup `surface-2`
		expect(PALETTES["polar-night"].defaultAccent).toBe("aurora");
		expect(PALETTES["polar-night"].light.ok).toBe("#13866a");
		expect(PALETTES.fjord.light.surface2).toBe("#e3e9ef");
		expect(PALETTES["iron-ember"].label).toBe("Iron & Ember"); // mockup id `iron`
		expect(PALETTES["iron-ember"].dark.text).toBe("#e6e1da");
		expect(PALETTES["birch-moss"].light.code).toBe("rgba(0,0,0,.05)");
		expect(ACCENTS["baltic-amber"]).toEqual({
			label: "Baltic Amber", // mockup id `amber`
			dark: "#d6a24a",
			light: "#a8741f",
		});
		expect(ACCENTS.lingonberry.dark).toBe("#d0606a");
	});

	it("validates names, rejecting the legacy web accent and the mockup ids", () => {
		for (const name of PALETTE_NAMES) {
			expect(isPaletteName(name), `isPaletteName(${name})`).toBe(true);
		}
		for (const name of ACCENT_NAMES) {
			expect(isAccentName(name), `isAccentName(${name})`).toBe(true);
		}
		// The legacy web accent name must NOT validate — the plan renamed it.
		expect(isAccentName("amber")).toBe(false);
		// `aurora` is an accent id, not a palette (the palette is polar-night);
		// `iron` is the mockup id, not the plan name.
		expect(isPaletteName("aurora")).toBe(false);
		expect(isPaletteName("iron")).toBe(false);
		expect(isPaletteName("polar-night")).toBe(true);
		// Non-strings never validate.
		expect(isAccentName(undefined)).toBe(false);
		expect(isAccentName(7)).toBe(false);
		expect(isPaletteName(null)).toBe(false);
		expect(isPaletteName({})).toBe(false);
	});
});

// Compile-time shape checks: the exact exported surface later tasks
// consume verbatim (B2–B7, C1–C5). Assigning through these aliases
// fails to compile if a signature drifts.
const _paletteNames: readonly PaletteName[] = PALETTE_NAMES;
const _accentNames: readonly AccentName[] = ACCENT_NAMES;
void _paletteNames;
void _accentNames;
