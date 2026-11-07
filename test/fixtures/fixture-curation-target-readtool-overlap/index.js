/**
 * Test-fixture extension package (knowledge Task 3 / C5 — the
 * tools/readTools disjointness rule): declares ONE curation target
 * `notes` whose `readTools` names `notes_write` — a name ALSO present
 * in `tools`. The loader must quarantine the extension: a read tool is
 * never wrapped and never gated, so a name on both lists is a
 * contradiction (wrap-or-not) that fails loud.
 *
 * Plain JavaScript (the fixture-memory pattern). Contract: the default
 * export is a factory returning `{ extension, curationTargets }`.
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

/** Default export: one extension, one target with an overlapping read tool. */
export default function createFixtureCurationTargetReadtoolOverlap() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target-readtool-overlap",
			tools: [notesWrite],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_write"],
				readTools: ["notes_write"],
				guidance: () => [],
				async undo() {},
			},
		],
	};
}
