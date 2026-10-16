/**
 * Test-fixture extension package (Task 9e): a valid extension whose factory
 * result carries a MALFORMED §3 health field — a string, not a function.
 * A contract violation the loader must quarantine (fail-loud), never
 * silently ignore: a package that THINKS it reports health but doesn't would
 * otherwise read as healthy forever.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ extension, health? }` — this
 * one violates the `health?` shape.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";

/** Default export: factory returning a valid extension + a malformed health. */
export default function createFixtureMalformed() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-malformed-health",
			sections: [section("fixture-note", () => "fixture section")],
		}),
		health: "ok",
	};
}
