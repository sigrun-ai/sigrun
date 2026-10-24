/**
 * Test-fixture extension package (UI-blocks U4 Task 1): the THROWING
 * `onSettingsChanged` stand-in — its handler rejects on every call, so
 * the test asserts the write still succeeds (200) and the rejection is
 * logged naming the extension.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. The
 * factory result carries `onSettingsChanged` that always throws.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Default export: factory returning the extension + the throwing handler. */
export default function createSettingsThrowsFixture() {
	return {
		extension: defineExtension({
			name: "acme-settings-throws",
		}),
		onSettingsChanged(keys) {
			throw new Error(
				`acme-settings-throws rejects onSettingsChanged for ${keys.join(", ")}`,
			);
		},
	};
}
