/**
 * The twin-declarer fixture (curator Task A7): declares target `notes`
 * TWICE — the same qualified id within one extension's list. The loader
 * must quarantine the extension (the LATER duplicate is the violation;
 * a qualified id names one curation target, never two).
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

/** Default export: one extension, one target name declared twice. */
export default function createFixtureCurationTargetTwin() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target-twin",
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
				name: "notes",
				tools: ["notes_write"],
				guidance: () => [],
				async undo() {},
			},
		],
	};
}
