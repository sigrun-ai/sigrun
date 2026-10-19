/**
 * Test-fixture extension package (build-and-webui Task 6): an extension
 * whose factory result contributes webui bundles ALONGSIDE the extension —
 * the channel-bundle contributor shape. Two entries exercise the two dir
 * grammars:
 *
 * - `fixture-ui` with a RELATIVE dir (`"webui"`) — the loader resolves it
 *   against THIS module's URL (the npm-installed-package story: the bundle
 *   lives in the extension's own package, never the server cwd);
 * - `fixture-abs` with an ABSOLUTE dir (computed here at import time) —
 *   passes through the loader's resolution EXACTLY as contributed.
 *
 * The `webui/` subdir next to this file carries the served index.html
 * (marked content the tests assert on). Plain JavaScript so
 * `import(specifier)` resolves it directly — the same dynamic-import path
 * the loader uses for installed packages.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineExtension, section } from "@earendil-works/pi-durable";

const here = join(fileURLToPath(import.meta.url), "..");

/** Default export: factory returning the extension + its bundle contributions. */
export default function createFixtureWebui() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-webui",
			sections: [section("fixture-webui-note", () => "fixture webui section")],
		}),
		webuiBundles: [
			{ name: "fixture-ui", dir: "webui" },
			{ name: "fixture-abs", dir: join(here, "webui") },
		],
	};
}
