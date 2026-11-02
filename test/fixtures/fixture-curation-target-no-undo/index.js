/**
 * Test-fixture extension package (curator Task A7 — the quarantine
 * rules): declares ONE curation target `notes` whose `tools` list names
 * `notes_write` — a tool the extension DOES register — but carries NO
 * `undo`. The loader must quarantine the extension with
 * `curation target "notes" has no undo` (no undo, no magic).
 *
 * Plain JavaScript (the fixture-memory pattern). Contract: the default
 * export is a factory returning `{ extension, curationTargets }`.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

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

/** Default export: factory returning the extension + its undo-less target. */
export default function createFixtureCurationTargetNoUndo() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target-no-undo",
			tools: [notesWrite],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_write"],
				guidance: () => [],
				// undo intentionally ABSENT — the quarantine rule's vehicle.
			},
		],
	};
}
