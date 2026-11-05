/**
 * Test-fixture extension package (warden Task 6): the QUARANTINE fixture
 * — its factory result's `decisionProviders` field is whatever malformed
 * value the test staged via `setBadDecisionProviders` (the loader and the
 * test import the SAME file:// URL, one module instance). One case per
 * quarantine rule, driven from the test; each load must quarantine with
 * the rule's message.
 */

import { defineExtension } from "@earendil-works/pi-durable";

let staged;

export function setBadDecisionProviders(value) {
	staged = value;
}

export default function createFixtureDecisionBad() {
	return {
		extension: defineExtension({ name: "acme-bad-decider" }),
		decisionProviders: staged,
	};
}
