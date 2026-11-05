/**
 * Test-fixture extension package (knowledge C7, Task 2): a published-hook
 * CALLER. It never awaits a call inside the factory body (the documented
 * rule): the factory STASHES the host, and the test drives
 * `callFromCaller(...)` below, which invokes `host.publishedHooks.call`
 * and records the settled result module-side (`calls`).
 *
 * `callDuringLoad` fires ONE call from the factory body WITHOUT awaiting
 * it (start-during-loading case): the registry-ready deferred resolves
 * after `loadExtensions` returns, and the result lands in `calls` when
 * the test awaits `pending` after boot.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Every settled call result, in order. */
export const calls = [];

/** The in-flight call the factory fired during loading (if any). */
export const pending = [];

/** The captured host (the tests assert the slug identity through it). */
export let capturedHost;

/** Clear the records (tests own their fixtures' state). */
export function resetHookCaller() {
	calls.length = 0;
	pending.length = 0;
	capturedHost = undefined;
}

/** Fire a call through the stashed host; the settled result records. */
export async function callFromCaller(name, payload, opts) {
	const result = await capturedHost.publishedHooks.call(name, payload, opts);
	calls.push(result);
	return result;
}

export default function createFixtureHookCaller(host) {
	capturedHost = host;
	return {
		extension: defineExtension({ name: "acme-notes" }),
	};
}

/** A caller variant that fires ONE call during loading (never awaited). */
export function createFixtureEarlyCaller(host) {
	capturedHost = host;
	pending.push(
		host.publishedHooks
			.call("recall.echo", { text: "early" })
			.then((result) => calls.push(result)),
	);
	return {
		extension: defineExtension({ name: "acme-early" }),
	};
}
