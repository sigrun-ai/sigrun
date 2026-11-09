/**
 * Test-fixture extension package (embedding-providers Task 1): the
 * QUARANTINE fixture — its factory result's `embeddingProviders` field
 * is whatever malformed value the test staged via
 * `setBadEmbeddingProviders` (the loader and the test import the SAME
 * file:// URL, one module instance). One case per quarantine rule,
 * driven from the test; each load must quarantine with the rule's
 * message.
 */

import { defineExtension } from "@earendil-works/pi-durable";

let staged;

export function setBadEmbeddingProviders(value) {
	staged = value;
}

export default function createFixtureEmbeddingBad() {
	return {
		extension: defineExtension({ name: "acme-bad-embedder" }),
		embeddingProviders: staged,
	};
}
