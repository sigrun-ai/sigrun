/**
 * Test-fixture extension package (provider plugins Task 1): a plugin whose
 * factory result contributes a provider ALONGSIDE the extension — the
 * plugin shape that both registers a pi-durable surface and adds models to
 * the boot catalog. The contributed provider id (`fixture-gw`) is asserted
 * end-to-end through `openHarness` → `collectProviders` → `Models`.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the same
 * dynamic-import path the loader uses for installed packages. Contract:
 * the default export is a factory returning `{ extension, providers }`.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const { provider } = fauxProvider({
	provider: "fixture-gw",
	models: [{ id: "fixture-m", name: "Fixture M" }],
});

/** Default export: factory returning the extension + its provider contribution. */
export default function createFixtureProviders() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-providers",
			sections: [section("fixture-note", () => "fixture section")],
		}),
		providers: [{ provider }],
	};
}
