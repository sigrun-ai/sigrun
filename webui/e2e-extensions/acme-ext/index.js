/**
 * E2E fixture for the Extensions settings section (W3 Task 7): the
 * stores-fixture shape (arity-1 factory that requires the host) with a
 * package manifest carrying a version, so the browser row renders
 * name + status + `v0.2.0`.
 *
 * Plain JavaScript so the loader imports it directly; no seam kinds
 * declared (this fixture exercises the settings/secrets surface only).
 */

export default function createAcmeExt(host) {
	if (host === undefined) {
		throw new Error("acme-ext requires the host context");
	}
	if (host.stores === undefined) {
		throw new Error("acme-ext requires the stores handle");
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
