/**
 * Test-fixture extension package (Task 9e): a memory-surface extension whose
 * factory result carries a §3 health producer reporting "degraded".
 *
 * Owns the `long-term-memory` section (the memory-surface key, hardcoded
 * here like every fixture string) so boot resolves it — not the no-op
 * default — as the memory extension; its `health` producer must therefore
 * drive the §5 `health.memory` field.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the same
 * dynamic-import path the loader uses for installed packages. Contract: the
 * default export is a factory returning `{ extension, health? }`.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";

/** Default export: factory returning the extension + a degraded §3 producer. */
export default function createFixtureMemory() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-memory-degraded",
			sections: [section("long-term-memory", () => "fixture memory section")],
		}),
		health: () => "degraded",
	};
}
