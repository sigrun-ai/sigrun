/**
 * Replacement fixture for the built-in MCP extension (Task 2 Review Focus
 * 1): the manifest name is `sigrun-ext-mcp` — the built-in's own package
 * name — so a configured load of this package must REPLACE the built-in
 * (the built-in is skipped, this one loads, the /v1/extensions row gains
 * `replacedBy`). Registers one marker tool, `acme_replacement`, so a test
 * can tell the fixture (not the built-in) loaded.
 *
 * Plain JavaScript, no build step — the loader imports it directly via
 * its file URL. Host runtime modules are dev-dependencies only: the
 * loader's host-module links provide them.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const marker = defineTool({
	name: "acme_replacement",
	description: "Marker proving the configured replacement loaded.",
	parameters: Type.Object({}),
	async execute() {
		return { output: [{ type: "text", text: "replacement-loaded" }] };
	},
});

export default function fixtureReplacesMcp() {
	return {
		extension: defineExtension({
			name: "acme.mcp-replacement",
			tools: [marker],
		}),
	};
}
