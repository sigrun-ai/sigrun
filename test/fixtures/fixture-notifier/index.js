/**
 * Test-fixture extension package (core hardening W5 Task 6 — notifiers,
 * spec §9.6): declares TWO notifier contributions — `throwing` (always
 * rejects: the error-isolation probe) and `recorder` (records every
 * event). Plain JavaScript so `import(specifier)` resolves it directly
 * (the fixture-channel pattern). Contract: the default export is an
 * arity-1 factory returning `{ extension, notifiers }`.
 *
 * The recorder writes to the ONE array shared across module instances
 * through globalThis (the loader's `import()` and a test's static import
 * may be separate instances — globalThis is the one shared address
 * space): whichever instance loads first registers its array, and every
 * later instance reads and writes that same one.
 */

import { defineExtension } from "@earendil-works/pi-durable";

const localEvents = [];

/** Every recorded event (the loader instance's array, via globalThis). */
export function notifierEvents() {
	return globalThis.__fixtureNotifierEvents ?? localEvents;
}

/** Clear the recorded events (per-test isolation). */
export function resetNotifierEvents() {
	notifierEvents().length = 0;
}

export default function createFixtureNotifier(host) {
	if (host === undefined) {
		throw new Error("notifier fixture requires the host context");
	}
	return {
		extension: defineExtension({ name: "fixture-notifier" }),
		notifiers: [
			{
				name: "throwing",
				async notify() {
					throw new Error("fixture notifier boom");
				},
			},
			{
				name: "recorder",
				async notify(event) {
					notifierEvents().push(event);
				},
			},
		],
	};
}
