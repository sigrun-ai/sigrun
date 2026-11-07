/**
 * The shared-tool fixture (curator Task A8): declares TWO targets that
 * list the SAME tool. A tool names one curation target — the overlap
 * leaves `byTool` first-wins arbitrary and the shadowed target's undos
 * un-actionable, so the loader quarantines the extension.
 *
 * Plain JavaScript (the fixture-memory pattern).
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

const notesWrite = defineTool({
	name: "notes_write",
	description: "Write a note for the notes curation target.",
	parameters: Type.Object({
		text: Type.String({ description: "The note body." }),
	}),
	async execute(args) {
		return { output: [{ type: "text", text: `noted: ${args.text}` }] };
	},
});

/** Default export: two targets, both listing "notes_write". */
export default function createFixtureCurationTargetSharedTool() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target-shared-tool",
			tools: [notesWrite],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_write"],
				guidance: () => [],
				async undo() {},
			},
			{
				name: "archive",
				tools: ["notes_write"],
				guidance: () => [],
				async undo() {},
			},
		],
	};
}
