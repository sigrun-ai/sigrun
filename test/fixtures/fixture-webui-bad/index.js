/**
 * Test-fixture extension package (build-and-webui Task 6): a MALFORMED
 * webuiBundles entry — a `name` that violates the contributed-bundle name
 * grammar (`^[a-z][a-z0-9_-]*$`; this one is uppercase). The loader
 * validates every entry fail-loud (like providers/health/submit): the
 * package THINKS it contributed a bundle, so the load quarantines with an
 * error naming the webuiBundles field, never a silent drop.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Default export: factory returning the extension + a malformed contribution. */
export default function createFixtureWebuiBad() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-webui-bad",
		}),
		webuiBundles: [{ name: "Fixture-UI", dir: "webui" }],
	};
}
