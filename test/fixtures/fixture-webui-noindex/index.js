/**
 * Test-fixture extension package (build-and-webui Task 6): contributes a
 * bundle whose dir has NO index.html (`no-bundle-dir` does not exist).
 * The loader has no filesystem coupling by contract — the entry registers
 * fine, and the SERVER's serve-time existence check fails loud, naming
 * the extension.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Default export: factory returning the extension + an unservable contribution. */
export default function createFixtureWebuiNoindex() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-webui-noindex",
		}),
		webuiBundles: [{ name: "fixture-noindex", dir: "no-bundle-dir" }],
	};
}
