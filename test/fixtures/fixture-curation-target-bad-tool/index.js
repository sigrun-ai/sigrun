/**
 * A target-listed tool registration the loader validates: the extension
 * that declared the target must register EVERY tool the target lists.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const registered = defineTool({
	name: "notes_write",
	description: "Write a note for the notes curation target.",
	parameters: Type.Object({
		text: Type.String({ description: "The note body." }),
	}),
	async execute(args) {
		return { output: [{ type: "text", text: `noted: ${args.text}` }] };
	},
});

/** Default export: a target listing a tool the extension never registers. */
export default function createFixtureCurationTargetBadTool() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target-bad-tool",
			tools: [registered],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_other_write"],
				guidance: () => [],
				async undo() {},
			},
		],
	};
}
