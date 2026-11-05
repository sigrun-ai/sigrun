/**
 * Test-fixture extension package (knowledge Task 3 / C5 — the
 * registered-read-tool rule): declares ONE curation target `notes`
 * whose `readTools` names `notes_other_read` — a tool this extension
 * does NOT register. The loader must quarantine the extension (a
 * declared read tool must be a tool the declaring extension registers,
 * the same discipline as the listed write tools).
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

/** Default export: one extension, one target with an unregistered read tool. */
export default function createFixtureCurationTargetBadReadTool() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target-bad-read-tool",
			tools: [notesWrite],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_write"],
				readTools: ["notes_other_read"],
				guidance: () => [],
				async undo() {},
			},
		],
	};
}
