/**
 * Test-fixture extension package (knowledge C7, Task 2): a SECOND provider
 * of `recall.echo` (the ownership/shadowing cases). Records its runs
 * module-side so tests can assert the shadowed provider never ran.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** Every run of THIS provider's `recall.echo`. */
export const altRuns = [];

/** Clear the records (tests own their fixtures' state). */
export function resetHookProviderAlt() {
	altRuns.length = 0;
}

export default function createFixtureHookProviderAlt() {
	return {
		extension: defineExtension({ name: "acme-recall-alt" }),
		publishedHooks: [
			{
				name: "recall.echo",
				input: Type.Object({}),
				async run(payload, call) {
					altRuns.push({ caller: call.caller, payload });
					return { from: "alt" };
				},
			},
		],
	};
}
