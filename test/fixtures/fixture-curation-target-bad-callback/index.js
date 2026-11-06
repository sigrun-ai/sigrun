/**
 * Test-fixture extension package (knowledge Task 3 / C5 — the review
 * callback shape rule): declares ONE curation target `notes` whose
 * `wantsReview` is NOT a function. The loader must quarantine the
 * extension — a target that THINKS it requests reviews must not
 * silently lose the field.
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

/** Default export: one extension, one target with a non-function wantsReview. */
export default function createFixtureCurationTargetBadCallback() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target-bad-callback",
			tools: [notesWrite],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_write"],
				wantsReview: "sometimes",
				guidance: () => [],
				async undo() {},
			},
		],
	};
}
