/** Embedding-providers Task 3: a caller that stashes its host. */

import { defineExtension } from "@earendil-works/pi-durable";

export const results = [];
export const pending = [];
export let capturedHost;

export function resetEmbeddingCaller() {
	results.length = 0;
	pending.length = 0;
	capturedHost = undefined;
}

export async function callFromCaller(texts = ["acme input"], opts = {}) {
	const result = await capturedHost.embeddings.embed(texts, opts);
	results.push(result);
	return result;
}

export default function createFixtureEmbeddingCaller(host) {
	capturedHost = host;
	return {
		extension: defineExtension({ name: "acme-embedding-caller" }),
	};
}
