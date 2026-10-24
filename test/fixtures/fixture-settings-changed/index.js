/**
 * Test-fixture extension package (UI-blocks U4 Task 1): the
 * `onSettingsChanged` factory-result hook's stand-ins. TWO fixture
 * extensions in one module graph would collide on module state, so this
 * fixture exports one factory whose result carries a RECORDING handler,
 * and the sibling `fixture-settings-throws` carries a THROWING one —
 * the test asserts the recorder received its keys while the thrower's
 * rejection was logged and the write still succeeded.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * same dynamic-import path the loader uses). Contract: the default
 * export is an ARITY-0 factory returning
 * `{ extension, onSettingsChanged }`; the records live on the module
 * (the fixture-memory-events pattern — the loader and the test see ONE
 * module instance).
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Delivered `onSettingsChanged` key lists, in delivery order. */
export const received = [];

/** Clear the records (tests own their fixtures' state). */
export function reset() {
	received.length = 0;
}

/** Default export: factory returning the extension + the handler. */
export default function createSettingsChangedFixture() {
	return {
		extension: defineExtension({
			name: "acme-settings-changed",
		}),
		onSettingsChanged(keys) {
			received.push([...keys]);
		},
	};
}
