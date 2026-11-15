/**
 * Test-fixture extension (defensive inputs): ONE tool whose model-visible
 * output is tiny while its `details` is as large as the call asks for.
 *
 * That is the real-world shape the cap exists for — `@sigrun/ext-mcp`
 * sets `details: result` (the raw MCP payload) and the model only ever
 * sees the bounded `content` blocks, so a single MCP call can store
 * megabytes beside a few kilobytes of text.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * fixture-curation-target pattern).
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export default function fixture() {
	const tool = defineTool({
		name: "big-result",
		description: "Returns a tiny output and a huge details payload.",
		parameters: Type.Object({ bytes: Type.Number() }),
		async execute(args) {
			return {
				// What the model sees: small on purpose.
				output: [{ type: "text", text: "ok" }],
				// What gets stored beside it: unbounded without the cap.
				details: {
					payload: "z".repeat(args.bytes),
					nested: { note: "structured data the UI may read" },
				},
			};
		},
	});
	return {
		extension: defineExtension({
			name: "fixture-big-details",
			tools: [tool],
		}),
	};
}
