/**
 * Test-fixture extension package (build-and-webui Task 6): contributes a
 * bundle under the SAME NAME as fixture-webui's `fixture-ui` — the
 * collision case. Load order [fixture-webui, fixture-webui-alt] makes this
 * the LAST registration, so it owns the name (last-registered-wins) with a
 * warn + a recorded collision; its `webui-alt/` dir carries DIFFERENT
 * marked content so the served-bundle assertion proves which entry won.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";

/** Default export: factory returning the extension + its bundle contribution. */
export default function createFixtureWebuiAlt() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-webui-alt",
			sections: [section("fixture-webui-alt-note", () => "fixture alt section")],
		}),
		webuiBundles: [{ name: "fixture-ui", dir: "webui-alt" }],
	};
}
