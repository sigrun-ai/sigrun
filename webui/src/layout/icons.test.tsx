/**
 * Wing-mark binding (0.4.0 Task 8 follow-up): the gull-wing brand mark's
 * two path literals exist in FOUR places — this component (BrandMark),
 * webui/public/favicon.svg, the WING array in
 * webui/scripts/render-icons.mjs (which rasterizes favicon-32.png and the
 * PWA icons), and the Rail test's own assertion literals. Three of those
 * were unbound copies: any one could drift from the mark without a test
 * noticing. This suite binds them: BrandMark's rendered paths must equal
 * favicon.svg's, which must equal render-icons.mjs's WING array. (The
 * chart icon is bound to favicon.svg separately by the root
 * test/chart-icon.test.ts suite.)
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { render } from "../test-utils";
import { BrandMark } from "./icons";

const webui = new URL("../../", import.meta.url);

/** The `d` attributes of an SVG source, in document order. */
function svgPaths(source: string): string[] {
	return [...source.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]!);
}

describe("wing mark binding", () => {
	test("favicon.svg and render-icons.mjs draw the same wing paths BrandMark renders", () => {
		const renderer = render(<BrandMark />);
		const rendered = renderer.root
			.findAllByType("path")
			.map((path) => path.props.d as string);
		expect(rendered).toHaveLength(2);

		// favicon.svg is hand-authored; its paths must be the same wing.
		const favicon = svgPaths(
			readFileSync(new URL("public/favicon.svg", webui), "utf8"),
		);
		expect(favicon).toEqual(rendered);

		// render-icons.mjs rasterizes the PNG icons from its WING array —
		// parse the quoted path strings out of the array literal.
		const script = readFileSync(
			new URL("scripts/render-icons.mjs", webui),
			"utf8",
		);
		const wingBlock = /const WING = \[(?<paths>[^\]]*)\];/.exec(script)
			?.groups?.paths;
		if (wingBlock === undefined) {
			throw new Error("render-icons.mjs carries no WING array");
		}
		const scripted = [...wingBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
		expect(scripted).toEqual(rendered);
	});
});
