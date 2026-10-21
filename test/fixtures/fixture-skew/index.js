/**
 * Test-fixture extension package (core-hardening Task 5): carries its OWN
 * nested `node_modules/@earendil-works/pi-durable` whose manifest says
 * version 0.0.1 — while the host runs 1.3.0.
 *
 * The entry itself imports NOTHING: the guard compares the version
 * resolution anchored at this file's directory (the tree the package's
 * bare imports WOULD use), not what the entry happens to import — so a
 * package that merely BUNDLES a different pi-durable is caught before it
 * runs. The loader must quarantine this fixture with the
 * `host module skew: …` error; nothing installs, no binding collects.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. The
 * factory result is a minimal contract-shape object (never reached when
 * the guard fires; keeps the regression signal loud if it ever doesn't).
 */

export default function createSkewFixture() {
	return {
		extension: {
			name: "sigrun-fixture-skew",
			hooks: [],
			tools: [],
			sections: [],
		},
	};
}
