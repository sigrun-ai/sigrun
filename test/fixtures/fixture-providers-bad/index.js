/**
 * Test-fixture extension package (provider plugins Task 1): a MALFORMED
 * provider contribution — a `providers` entry with no `provider.id`. The
 * loader validates every entry fail-loud (like health/submit): the package
 * THINKS it contributed a provider, so the load quarantines with an error
 * naming the providers field, never a silent drop.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

/** Default export: factory returning a malformed providers entry. */
export default function createFixtureProviderBad() {
	return {
		name: "sigrun-fixture-provider-bad",
		providers: [{}],
	};
}
