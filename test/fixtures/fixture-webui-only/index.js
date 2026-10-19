/**
 * Test-fixture extension package (build-and-webui Task 6, final-review
 * test-gap pin): a CONTRIBUTOR-ONLY webui-bundle result — `name` +
 * `webuiBundles` with NO `extension` field. The loader's contributor-only
 * gate accepts `providers` OR `webuiBundles`; this fixture is the
 * tripwire for the webuiBundles half — if that gate ever regresses to
 * providers-only, this result falls through the contract resolution and
 * the contribution silently disappears.
 *
 * The contributed dir deliberately does not exist on disk: registration
 * never touches the filesystem (the server owns the index.html check at
 * serve time).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

/** Default export: factory returning a contributor-only webuiBundles result. */
export default function createFixtureWebuiOnly() {
	return {
		name: "sigrun-fixture-webui-only",
		webuiBundles: [{ name: "fixture-only-ui", dir: "webui" }],
	};
}
