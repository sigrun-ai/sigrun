/**
 * Test-fixture extension package (memory-seam Task 3): a factory result
 * carrying a MALFORMED `runSettled` field — a number, not a function. A
 * contract violation the loader must quarantine (fail-loud) with the exact
 * message the extension contract pins, never silently ignore.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ extension, runSettled }` —
 * this one violates the `runSettled?` shape.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Default export: factory returning a valid extension + a malformed runSettled. */
export default function createFixtureBadRunSettled() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-bad-runsettled",
		}),
		runSettled: 42,
	};
}
