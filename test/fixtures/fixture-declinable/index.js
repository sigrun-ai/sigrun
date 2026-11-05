/**
 * Test-fixture extension for the decline path (ask-user Task 1): a
 * declinable interaction kind ("decl.ask") whose records a human can
 * decline (status "skipped") through the decline route or the host's
 * declineInteraction.
 *
 * Plain JavaScript, no build step — the loader imports it directly via
 * its file URL. The factory takes the HOST CONTEXT (arity-1): it
 * declares the interaction kind, stashes the received host on
 * `globalThis.__declinableHost` (tests seed through it), and pushes
 * every delivered `interactionSettled` payload onto
 * `globalThis.__declinableSettled` (tests assert the decline carries
 * `{status: "skipped", declinedVia}`).
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** The interaction kind this fixture declares (the seam's write gate). */
const DECLINABLE_KIND = "decl.ask";

/**
 * @param host {{ seedInteraction: Function, declineInteraction: Function,
 *   snapshotInteraction: Function, peekInteraction: Function }}
 *   the sigrun seam host (src/harness/seam-host.ts) — required so the
 *   fixture seeds and declines through the same seam the routes serve.
 */
export default function createDeclinableFixture(host) {
	if (host === undefined) {
		throw new Error("declinable fixture requires the host context");
	}
	globalThis.__declinableHost = host;
	if (!Array.isArray(globalThis.__declinableSettled)) {
		globalThis.__declinableSettled = [];
	}

	return {
		interactionKinds: [DECLINABLE_KIND],
		extension: defineExtension({
			name: "sigrun-fixture-declinable",
		}),
		async interactionSettled(event, api, context) {
			void api;
			void context;
			globalThis.__declinableSettled.push(event);
		},
	};
}
