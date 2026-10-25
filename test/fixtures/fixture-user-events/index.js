/**
 * Test-fixture extension package (core hardening W1 Task 4 + gateway
 * C6): the `userDeleted` and `interactionSettled` lifecycle-event
 * contract stand-ins. The factory result carries a `userDeleted` handler
 * (W1) and an `interactionSettled` handler (gateway C6) that record
 * every delivered payload MODULE-SIDE and export the records for the
 * test to read — the fixture-memory-events pattern (the loader imports
 * this file by the same `file://` URL the test dynamically imports, so
 * both see ONE module instance).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an ARITY-1 factory (it accepts the seam host the
 * loader passes, mirroring fixture-memory-events' shape) returning
 * `{ extension, userDeleted, interactionSettled }`. The records live on
 * the module (in memory, per the brief) and the factories ALSO return
 * getters over them, so a consumer holding the factory result reads the
 * same lists.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Delivered userDeleted payloads, recorded in delivery order. */
export const deletions = [];

/** Clear the records (tests own their fixtures' state). */
export function resetDeletions() {
	deletions.length = 0;
}

/** Delivered interactionSettled payloads (gateway C6), in delivery order. */
export const settlements = [];

/** Clear the settlement records (tests own their fixtures' state). */
export function resetSettlements() {
	settlements.length = 0;
}

/** Clear the records (tests own their fixtures' state). */
export const deletionChecks = [];
export function resetDeletionChecks() {
	deletionChecks.length = 0;
}

/** Optional failure injection for the handler-isolation contract. */
export const deletionThrows = [];

let deletionStatusObserver;
export function setDeletionStatusObserver(observer) {
	deletionStatusObserver = observer;
}

/** Default export: factory returning the extension + its event handlers. */
export default function createFixtureUserEvents(host) {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-user-events",
		}),
		async userDeleted(event, api, context) {
			void api;
			void context;
			deletions.push({ user: event.user, transferTo: event.transferTo });
			deletionChecks.push({
				user: event.user,
				record: await host.users.get(event.user),
				secret: await host.stores.user(event.user).secrets.get("provider-token"),
				...(deletionStatusObserver === undefined
					? {}
					: { services: deletionStatusObserver() }),
			});
			if (deletionThrows.includes(event.user)) {
				throw new Error(`fixture userDeleted failure: ${event.user}`);
			}
		},
		/** The factory-returned getter over the module-level records. */
		getDeletions: () => [...deletions],
		// Gateway C6: one delivery per terminal interaction transition, from
		// ANY writer (HTTP route answer, host answer, host settle) — the
		// payload mirrors the record's terminal envelope fields.
		interactionSettled(event, api, context) {
			void api;
			void context;
			settlements.push({
				conversationId: event.conversationId,
				callId: event.callId,
				kind: event.kind,
				status: event.status,
			});
		},
		/** The factory-returned getter over the module-level settlements. */
		getSettlements: () => [...settlements],
	};
}
