/**
 * Brand asset renderer (0.4.0 Task 8) — rasterizes the gull-wing brand
 * mark (candidate A, picked 2026-10-31) into the PWA icon set:
 *
 *   favicon-32.png        32    amber rounded tile, dark 2.6 stroke (the
 *                               16px inverse — mirrors favicon.svg, which
 *                               is hand-authored; keep the geometry here
 *                               and that file in step)
 *   apple-touch-icon.png  180   full-bleed fjord-dark, amber mark
 *   icon-192.png          192   full-bleed fjord-dark, amber mark
 *   icon-512.png          512   full-bleed fjord-dark, amber mark
 *   icon-maskable-512.png 512   the mark at 80% (the maskable safe zone)
 *
 * Colors come from the DEFAULT palette (fjord) + default accent
 * (baltic-amber) in shared/src/themes.ts — the same values the webui's
 * brand tile renders with. `sharp` is a workspace-root dependency
 * (src/server/images/convert.ts already uses it); no new deps.
 *
 * Run: node webui/scripts/render-icons.mjs   (from the repo root or webui/)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PUBLIC_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"public",
);

/** The gull-wing mark — the exact paths BrandMark renders (icons.tsx). */
const WING = [
	"M4 16c3.2-1.4 6.9-4.6 8.4-8.4l.6 2.2 2.2.6",
	"M8.5 18.5c2.7-1.5 5.4-4.4 6.6-7.4l1.5 1.2 1.9-.3",
];

// shared/src/themes.ts — fjord (the default palette) dark values + the
// baltic-amber (the default accent) dark value.
const DARK_BG = "#0b0f13";
const AMBER = "#d6a24a";

/**
 * The mark as a `<g>`: its 24-unit grid mapped onto `scale` of a
 * size×size tile, centered. `strokeUnits` is the stroke width in 24-grid
 * units (the same terms BrandMark / the mockup use: 1.9 rail, 2.6
 * favicon, 1.5 app icon).
 */
function mark(size, { stroke, strokeUnits, scale = 1 }) {
	const box = size * scale;
	const offset = (size - box) / 2;
	return (
		`<g transform="translate(${offset} ${offset}) scale(${box / 24})" ` +
		`fill="none" stroke="${stroke}" stroke-width="${strokeUnits}" ` +
		`stroke-linecap="round" stroke-linejoin="round">` +
		WING.map((d) => `<path d="${d}"/>`).join("") +
		`</g>`
	);
}

function svgDoc(size, body) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
		`viewBox="0 0 ${size} ${size}">${body}</svg>`
	);
}

/** A full-bleed dark tile with the amber mark (the app-icon look). */
function darkTile(size, markScale) {
	return svgDoc(
		size,
		`<rect width="${size}" height="${size}" fill="${DARK_BG}"/>` +
			mark(size, { stroke: AMBER, strokeUnits: 1.5, scale: markScale }),
	);
}

const ICONS = [
	// The favicon inverse: an amber tile (rounded at tab size) with a
	// fjord-dark stroke at a heavy 2.6 for 16px legibility, the mark at
	// 80% — favicon.svg's exact geometry (25.6/32 = the mockup's 13-of-16).
	{
		file: "favicon-32.png",
		svg: svgDoc(
			32,
			`<rect width="32" height="32" rx="6" fill="${AMBER}"/>` +
				mark(32, { stroke: DARK_BG, strokeUnits: 2.6, scale: 0.8 }),
		),
	},
	// iOS home screen: full-bleed (Apple masks the corners itself).
	{ file: "apple-touch-icon.png", svg: darkTile(180, 0.6) },
	// PWA launcher icons: full-bleed dark, amber mark at 60% (the mockup's
	// 72-of-120 app icon); launchers mask their own corners.
	{ file: "icon-192.png", svg: darkTile(192, 0.6) },
	{ file: "icon-512.png", svg: darkTile(512, 0.6) },
	// Maskable: the mark at 80% so no critical detail sits in the outer
	// 20% any launcher mask may crop to.
	{ file: "icon-maskable-512.png", svg: darkTile(512, 0.8) },
];

await mkdir(PUBLIC_DIR, { recursive: true });
for (const icon of ICONS) {
	const png = await sharp(Buffer.from(icon.svg)).png().toBuffer();
	await writeFile(join(PUBLIC_DIR, icon.file), png);
	console.log(`rendered webui/public/${icon.file} (${png.length} bytes)`);
}
