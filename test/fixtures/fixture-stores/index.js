/**
 * Stores-fixture extension (Task 5): captures the host context its
 * arity-1 factory receives so the loader-integration test can drive the
 * scoped `stores` handle (`ExtensionStores`, src/harness/stores.ts)
 * through the SAME object the factory saw during the "" phase of the
 * two-phase rekey — proving rekey re-points the scoped views in place
 * rather than swapping the host.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * same dynamic-import path the loader uses). No seam kinds declared:
 * this fixture exercises the stores handle, not the interaction/
 * ambient seams.
 */

export default function createStoresFixture(host) {
	if (host === undefined) {
		throw new Error("stores fixture requires the host context");
	}
	// Stash the received host BEFORE any contract check: the test reads
	// this even when the check below quarantines the load, so a missing
	// `stores` field fails the test with evidence, not a silent skip.
	globalThis.__fixtureStoresHost = host;
	if (host.stores === undefined) {
		throw new Error("stores fixture requires the stores handle");
	}
	return {
		extension: {
			name: "acme-tool",
			hooks: [],
			tools: [],
			sections: [],
		},
	};
}
