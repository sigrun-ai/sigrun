/**
 * Factory-time settings-read fixture (provider plugins Task 9, review
 * P1): an ASYNC arity-1 factory that reads `host.stores.settings.get()`
 * DURING its body — before the declared name is known — and stashes the
 * result on globalThis for the loader test.
 *
 * The package's manifest name slugifies to the declared extension name
 * ("acme-settings-tool"): the documented requirement for extensions
 * that read scoped settings at factory time. The loader derives its
 * PROVISIONAL host identity from the load specifier (this package's
 * manifest name via `provisionalSlugFor`), so a factory-time read must
 * resolve `settings/acme-settings-tool.json` — never a placeholder
 * scope (the pre-fix "" read `settings/.json` and was silently inert).
 *
 * Plain JavaScript, no build step — the loader imports it directly.
 */

export default async function createSettingsReadFixture(host) {
	if (host === undefined) {
		throw new Error("settings-read fixture requires the host context");
	}
	if (host.stores === undefined) {
		throw new Error("settings-read fixture requires the stores handle");
	}
	// THE factory-time read the P1 is about: before the loader knows the
	// declared name, the scoped settings view must already key on the
	// package-derived slug.
	globalThis.__fixtureSettingsSeen = await host.stores.settings.get();
	return {
		extension: {
			name: "acme-settings-tool",
			hooks: [],
			tools: [],
			sections: [],
		},
	};
}
