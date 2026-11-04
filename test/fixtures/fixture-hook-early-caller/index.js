/**
 * Test-fixture extension package (knowledge C7, Task 2): the EARLY caller —
 * fires ONE `recall.echo` call from its factory body WITHOUT awaiting it
 * (the documented rule is "never AWAIT a call inside a factory body";
 * firing one is the registry-ready-wait case: the call's deferred resolves
 * when boot builds the registry, right after `loadExtensions` returns).
 *
 * Records share the fixture-hook-caller module (one file:// instance): the
 * settled result lands in `calls`, the in-flight promise in `pending`.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { calls, pending } from "../fixture-hook-caller/index.js";

export default function createFixtureEarlyCaller(host) {
	pending.push(
		host.publishedHooks
			.call("recall.echo", { text: "early" })
			.then((result) => calls.push(result)),
	);
	return {
		extension: defineExtension({ name: "acme-early" }),
	};
}
