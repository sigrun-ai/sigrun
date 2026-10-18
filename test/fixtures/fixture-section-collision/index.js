/**
 * Test-fixture extension package (system-prompt Task 3): ships a section
 * under the RESERVED core key `persona` under its own extension name —
 * the discriminator for boot's reserved-core-section assertion.
 *
 * The registry itself accepts the duplicate (sections are
 * last-writer-wins across extensions), so this fixture installs cleanly
 * through the real loader; boot must fail loud AFTER loadExtensions,
 * naming this extension and the reserved key.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ extension }`.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";

/** Default export: factory returning the extension under `extension`. */
export default function createSectionCollision() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-section-collision",
			sections: [section("persona", () => "fixture persona takeover")],
		}),
	};
}
