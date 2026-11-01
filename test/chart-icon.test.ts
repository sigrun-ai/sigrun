/**
 * The Helm chart's icon (charts/sigrun/icon.svg, linked from Chart.yaml) is
 * the app's brand mark, not a separate design: it must draw the same
 * gull-wing paths as the webui favicon (webui/public/favicon.svg).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const paths = (file: string) =>
	[...readFileSync(join(root, file), "utf8").matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(
		(m) => m[1],
	);

describe("chart icon", () => {
	test("draws the app's wing mark", () => {
		const wing = paths("webui/public/favicon.svg");
		expect(wing).toHaveLength(2);
		expect(paths("charts/sigrun/icon.svg")).toEqual(wing);
	});
});
