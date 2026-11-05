/**
 * Test-fixture extension package (knowledge C7, Task 2): a published-hook
 * PROVIDER. Publishes one hook, `recall.echo`, whose `run` records every
 * call module-side (`runs` — the fixture-memory pattern: the loader and
 * the test import the SAME file:// URL, one module instance) and echoes
 * the payload back. The input schema requires a string `text` (the
 * schema-rejection path); the output schema pins the echo shape (the
 * bad-output path rides `mode: "silent"`).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 * Contract: the default export is a factory returning
 * `{ extension, publishedHooks }`.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

/** Every `recall.echo` run: `{caller, user, conversationId, payload}`. */
export const runs = [];

/** Clear the records (tests own their fixtures' state). */
export function resetHookProvider() {
	runs.length = 0;
}

export default function createFixtureHookProvider() {
	return {
		extension: defineExtension({ name: "acme-recall" }),
		publishedHooks: [
			{
				name: "recall.echo",
				description: "echo the text back (fixture provider)",
				input: Type.Object({
					text: Type.String(),
					mode: Type.Optional(Type.String()),
				}),
				output: Type.Object({
					echo: Type.String(),
					caller: Type.String(),
				}),
				async run(payload, call) {
					runs.push({
						caller: call.caller,
						user: call.user,
						conversationId: call.conversationId,
						payload,
					});
					if (payload.mode === "silent") {
						// Deliberately off-schema (the bad-output branch).
						return { nope: true };
					}
					return { echo: payload.text, caller: call.caller };
				},
			},
		],
	};
}
