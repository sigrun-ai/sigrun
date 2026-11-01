/**
 * Test-fixture extension package (curator Task A7 — the curation-target
 * contract, spec P7): declares ONE curation target `notes` over the
 * `notes_write` tool (with working `undo` and `maintain`), plus an
 * UNLISTED tool `notes_direct` that writes directly — the shape A8's
 * wrapping test uses to prove only LISTED tools are intercepted (an
 * extension that wants a direct "remember this" tool registers it
 * outside its target declaration and owns that write path itself).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * fixture-memory pattern: the loader imports this file by the same
 * `file://` URL the test dynamically imports, so both hold ONE module
 * instance). Contract: the default export is a factory returning
 * `{ extension, curationTargets }`; the extension registers BOTH tools
 * so the loader's registered-tool check passes for the listed one.
 *
 * Module-side records (exported for the tests):
 * - `writes`   — every `notes_write` execute: `{user, text}` (A8 asserts
 *   the wrapper never lets a listed tool execute outside a run).
 * - `directs`  — every `notes_direct` execute (A8 asserts it runs).
 * - `undos`    — every `undo` call: `{user, changeId}`.
 * - `maintains`— every `maintain` call: `{user, deadline, runs}`.
 * - `guidanceFor` — the per-user guidance map the target serves.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

/** `notes_write` executes: `{user, text}` per call. */
export const writes = [];

/** `notes_direct` executes: one record per call. */
export const directs = [];

/** `undo` calls: `{user, changeId}` per call. */
export const undos = [];

/** `maintain` calls: `{user, deadline, runs}` per call. */
export const maintains = [];

/** The per-user guidance the target serves (tests may flip it). */
export const guidanceFor = {
	alice: ["Put deploy lessons in the notes target."],
};

/** Reset every module-side record (tests own their fixtures' state). */
export function resetTargetFixture() {
	writes.length = 0;
	directs.length = 0;
	undos.length = 0;
	maintains.length = 0;
	guidanceFor.alice = ["Put deploy lessons in the notes target."];
}

const notesWrite = defineTool({
	name: "notes_write",
	description: "Write a note for the notes curation target.",
	parameters: Type.Object({
		text: Type.String({ description: "The note body." }),
	}),
	async execute(args) {
		writes.push({ text: args.text });
		return { output: [{ type: "text", text: `noted: ${args.text}` }] };
	},
});

const notesDirect = defineTool({
	name: "notes_direct",
	description: "Write a note directly, outside the curation target.",
	parameters: Type.Object({
		text: Type.String({ description: "The note body." }),
	}),
	async execute(args) {
		directs.push({ text: args.text });
		return { output: [{ type: "text", text: `direct: ${args.text}` }] };
	},
});

/** Default export: factory returning the extension + its curation target. */
export default function createFixtureCurationTarget() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target",
			tools: [notesWrite, notesDirect],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_write"],
				guidance: (user) => guidanceFor[user] ?? [],
				async undo(user, changeId) {
					undos.push({ user, changeId });
				},
				async maintain(user, ctx, budget) {
					void ctx;
					maintains.push({
						user,
						deadline: budget.deadline,
						runs: budget.runs,
					});
					return { changes: [] };
				},
			},
		],
	};
}
