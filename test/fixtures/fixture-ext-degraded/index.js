/**
 * Test-fixture extension package (Task 9e): a NON-memory extension whose
 * factory result carries a §3 health producer reporting "degraded".
 *
 * Owns no `long-term-memory` section, so its retained producer must NOT feed
 * the §5 `health.memory` field — the §3 aggregation rule is "the loaded
 * memory extension's producer", not "any extension's producer". This fixture
 * is the discriminator against that wrong generalization.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ extension, health? }`.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";

/** Default export: factory returning the extension + a degraded §3 producer. */
export default function createFixtureExt() {
	return {
		extension: defineExtension({
			name: "sigrun.fixture-ext-degraded",
			sections: [section("fixture-note", () => "fixture section")],
		}),
		health: () => "degraded",
	};
}
