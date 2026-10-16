/**
 * Slug-fixture extension (Task 3): declares a SCOPED name
 * (`@acme/scoped-tool`) and captures the host context its arity-1 factory
 * receives — the loader-integration test asserts the slug (`scoped-tool`)
 * is the identity the captured host carries after the two-phase rekey.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the same
 * dynamic-import path the loader uses). The lazy `selfName` thunk trips
 * the ambient kind gate POST-load: the gate's SeamError embeds the host's
 * CURRENT identity name (the check runs before any harness wait), which
 * is how the test reads the slug straight out of the factory-received
 * host without touching seam records.
 */

export default function createSlugScoped(host) {
	if (host === undefined) {
		throw new Error("slug fixture requires the host context");
	}
	globalThis.__fixtureSlugHost = host;
	globalThis.__fixtureSlugSelfName = async () => {
		try {
			// Undeclared key: the kind gate rejects before any harness
			// wait, naming the host's identity in the error text (the
			// method is async, so the rejection carries the SeamError).
			await host.clearAmbient(
				"00000000-0000-0000-0000-000000000000",
				"slug.unused",
				{},
			);
			return "(no error thrown — kind gate did not fire)";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};
	return {
		ambientKinds: ["slug.panel"],
		extension: {
			name: "@acme/scoped-tool",
			hooks: [],
			tools: [],
			sections: [],
		},
	};
}
