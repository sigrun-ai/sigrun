/**
 * Test-fixture extension package (provider plugins Task 1): a PROVIDER-ONLY
 * contributor — the factory result carries `name` + `providers` (and a §3
 * health producer) with NO `extension`, the minimal model-plugin shape (the
 * sigrun-ollama/opencode/pareto/bifrost plugins need no pi-durable surface).
 * The loader must load it (not quarantine) and boot must feed it to
 * `collectProviders` under the declared name.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ name, providers, health }`.
 */

import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const { provider } = fauxProvider({
	provider: "fixture-only-gw",
	models: [{ id: "fixture-only-m", name: "Fixture Only M" }],
});

/** Default export: factory returning a provider-only contributor. */
export default function createFixtureProviderOnly() {
	return {
		name: "sigrun-fixture-provider-only",
		providers: [{ provider }],
		health: () => "degraded",
	};
}
