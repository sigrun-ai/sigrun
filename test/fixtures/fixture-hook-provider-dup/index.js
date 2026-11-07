/**
 * Test-fixture extension package (knowledge C7, Task 2): a published-hook
 * provider declaring the SAME name twice within one result — the
 * intra-extension duplicate quarantines (house style: an extension that
 * THINKS it published hooks must not silently lose them).
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export default function createFixtureHookDup() {
	return {
		extension: defineExtension({ name: "acme-dup-hooks" }),
		publishedHooks: [
			{
				name: "recall.echo",
				input: Type.Object({}),
				async run() {
					return null;
				},
			},
			{
				name: "recall.echo",
				input: Type.Object({}),
				async run() {
					return null;
				},
			},
		],
	};
}
