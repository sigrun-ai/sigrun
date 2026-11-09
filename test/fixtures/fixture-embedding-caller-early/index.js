/** Embedding-providers Task 3: fire one call from the factory body. */

import { defineExtension } from "@earendil-works/pi-durable";
import { pending, results } from "../fixture-embedding-caller/index.js";

export default function createFixtureEmbeddingCallerEarly(host) {
	pending.push(
		host.embeddings.embed(["early acme input"]).then((result) => results.push(result)),
	);
	return {
		extension: defineExtension({ name: "acme-embedding-caller-early" }),
	};
}
