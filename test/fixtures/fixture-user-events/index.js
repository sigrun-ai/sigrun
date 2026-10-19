/**
 * Test-fixture extension package (core hardening W1 Task 4): the
 * `userDeleted` lifecycle-event contract stand-in. The factory result
 * carries a `userDeleted` handler that records every delivered payload
 * MODULE-SIDE and exports the records for the test to read — the
 * fixture-memory-events pattern (the loader imports this file by the same
 * `file://` URL the test dynamically imports, so both see ONE module
 * instance).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an ARITY-1 factory (it accepts the seam host the
 * loader passes, mirroring fixture-memory-events' shape) returning
 * `{ extension, userDeleted }`. The records live on the module (in memory,
 * per the brief) and the factory ALSO returns a getter over them, so a
 * consumer holding the factory result reads the same list.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Delivered userDeleted payloads, recorded in delivery order. */
export const deletions = [];

/** Clear the records (tests own their fixtures' state). */
export function resetDeletions() {
	deletions.length = 0;
}

/** Default export: factory returning the extension + its userDeleted handler. */
export default function createFixtureUserEvents() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-user-events",
		}),
		userDeleted(event, api, context) {
			void api;
			void context;
			deletions.push({ user: event.user, transferTo: event.transferTo });
		},
		/** The factory-returned getter over the module-level records. */
		getDeletions: () => [...deletions],
	};
}
