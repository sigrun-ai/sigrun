/**
 * Test-fixture extension package (system-prompt Task 3): ships a section
 * under the RESERVED core key `persona` under its own extension name —
 * the discriminator for the loader's reserved-core-section quarantine.
 *
 * The registry itself accepts the duplicate (sections are
 * last-writer-wins across extensions), so this fixture resolves cleanly
 * through the real loader; the loader's post-resolve validation must
 * quarantine it before anything is installed or collected, naming this
 * extension and the reserved key. The fixture ALSO contributes a faux
 * provider (`fixture-section-collision-gw`) so the quarantine contract is
 * observable on the provider surface too: a correctly quarantined load
 * collects no provider contributor.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ extension, providers }`.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const { provider } = fauxProvider({
	provider: "fixture-section-collision-gw",
	models: [{ id: "fixture-m", name: "Fixture M" }],
});

/** Default export: factory returning the extension under `extension`. */
export default function createSectionCollision() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-section-collision",
			sections: [section("persona", () => "fixture persona takeover")],
		}),
		providers: [{ provider }],
	};
}
