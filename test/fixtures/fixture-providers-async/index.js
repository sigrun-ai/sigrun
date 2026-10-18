/**
 * Test-fixture extension package (provider plugins Task 1): an ASYNC
 * factory — returns a Promise resolving to a provider-only contributor.
 * The plan's plugins read their scoped settings store inside the factory
 * (loader awaits factories), so a Promise result is the supported shape,
 * never a quarantine.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an async factory returning `{ name, providers }`.
 */

import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const { provider } = fauxProvider({
	provider: "fixture-async-gw",
	models: [{ id: "fixture-async-m", name: "Fixture Async M" }],
});

/** Default export: async factory returning a provider-only contributor. */
export default async function createFixtureProviderAsync() {
	// The settings-reading plugin shape: the factory awaits before resolving.
	await Promise.resolve();
	return {
		name: "sigrun-fixture-provider-async",
		providers: [{ provider }],
	};
}
