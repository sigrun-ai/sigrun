/**
 * Test-fixture extension package (warden Task 6): a decision CALLER. It
 * never awaits a call inside the factory body (the documented rule):
 * the factory STASHES the host, and the test drives `callFromCaller(...)`
 * below, which invokes `host.decisions.evaluate` and records the settled
 * result module-side (`results`).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Every settled evaluate result, in order. */
export const results = [];

/** In-flight calls fired during loading (the early-caller fixture). */
export const pending = [];

/** The captured host (the tests assert the slug identity through it). */
export let capturedHost;

/** Clear the records (tests own their fixtures' state). */
export function resetDecisionCaller() {
	results.length = 0;
	pending.length = 0;
	capturedHost = undefined;
}

/** Drive one evaluate through the stashed host; the result records. */
export async function callFromCaller(request, opts) {
	const result = await capturedHost.decisions.evaluate(request, opts);
	results.push(result);
	return result;
}

export default function createFixtureDecisionCaller(host) {
	capturedHost = host;
	return {
		extension: defineExtension({ name: "acme-notes" }),
	};
}
