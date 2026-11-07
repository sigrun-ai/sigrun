/**
 * Test-fixture extension package (knowledge C7, Task 2): a published-hook
 * provider whose input schema fails `Compile` (the loader's compile check
 * quarantines it — the registry build never sees one in production).
 * The invalid bit: an unterminated regex `pattern` (Compile builds the
 * RegExp eagerly and throws).
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export default function createFixtureHookBadSchema() {
	return {
		extension: defineExtension({ name: "acme-bad-schema" }),
		publishedHooks: [
			{
				name: "recall.echo",
				// Compile throws: "(" is an unterminated regex group.
				input: Type.Object({ text: Type.String({ pattern: "(" }) }),
				async run() {
					return null;
				},
			},
		],
	};
}
