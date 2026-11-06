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
 * - `maintains`— every `maintain` call: `{user, deadline, runs, digestTexts}` — `digestTexts` records the text each `budget.run` resolved with (A9's wiring gate).
 * - `guidanceFor` — the per-user guidance map the target serves.
 * - `reviewFlags` — the per-user `wantsReview` map (C5; tests flip it).
 * - `reviewedCalls` — every `reviewed(user, conversationId)` call (C5).
 * - `reads` — every `notes_read` execute (C5's read tool: declared in
 *   `readTools`, model-visible for serving, allowed inside a review,
 *   NEVER wrapped — a call outside a curator run executes verbatim).
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

/** `notes_write` executes: `{user, text}` per call. */
export const writes = [];

/** `notes_write` change ids: one per execute (the `details.curation` carrier). */
export const writeChanges = [];

/** `notes_direct` executes: one record per call. */
export const directs = [];

/** `undo` calls: `{user, changeId}` per call. */
export const undos = [];

/** `maintain` calls: `{user, deadline, runs, digestTexts}` per call. */
export const maintains = [];

/** The per-user guidance the target serves (tests may flip it). */
export const guidanceFor = {
	alice: ["Put deploy lessons in the notes target."],
};

/** The per-user wantsReview answers the target serves (tests may flip). */
export const reviewFlags = {
	alice: false,
};

/** `reviewed` calls: `{user, conversationId}` per call (C5). */
export const reviewedCalls = [];

/** `notes_read` executes: `{key}` per call (C5's never-wrapped read tool). */
export const reads = [];

/** Reset every module-side record (tests own their fixtures' state). */
export function resetTargetFixture() {
	writes.length = 0;
	writeChanges.length = 0;
	directs.length = 0;
	undos.length = 0;
	maintains.length = 0;
	guidanceFor.alice = ["Put deploy lessons in the notes target."];
	reviewFlags.alice = false;
	reviewedCalls.length = 0;
	reads.length = 0;
}

const notesWrite = defineTool({
	name: "notes_write",
	description: "Write a note for the notes curation target.",
	parameters: Type.Object({
		text: Type.String({ description: "The note body." }),
	}),
	async execute(args) {
		writes.push({ text: args.text });
		// A9's run driver collects `details.curation` from tool results:
		// every write reports a change id + summary (the P8 undo surface's
		// convention — the fixture's change ids are random UUIDs).
		const changeId = randomUUID();
		writeChanges.push(changeId);
		return {
			output: [{ type: "text", text: `noted: ${args.text}` }],
			details: { curation: { changeId, summary: `notes_write ${args.text}` } },
		};
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

const notesRead = defineTool({
	name: "notes_read",
	description: "Read a note (the curation target's read tool).",
	parameters: Type.Object({
		key: Type.String({ description: "The note key." }),
	}),
	async execute(args) {
		reads.push({ key: args.key });
		return { output: [{ type: "text", text: `read: ${args.key}` }] };
	},
});

/** Default export: factory returning the extension + its curation target. */
export default function createFixtureCurationTarget() {
	return {
		extension: defineExtension({
			name: "fixture-curation-target",
			tools: [notesWrite, notesDirect, notesRead],
		}),
		curationTargets: [
			{
				name: "notes",
				tools: ["notes_write"],
				readTools: ["notes_read"],
				guidance: (user) => guidanceFor[user] ?? [],
				wantsReview: (user) => reviewFlags[user] ?? false,
				reviewed: (user, conversationId) => {
					reviewedCalls.push({ user, conversationId });
				},
				async undo(user, changeId) {
					undos.push({ user, changeId });
				},
				async maintain(user, ctx, budget) {
					void ctx;
					const digestTexts = [];
					if (budget.runs > 0) {
						const result = await budget.run("digest the notes", ["notes_write"]);
						digestTexts.push(result.text);
					}
					maintains.push({
						user,
						deadline: budget.deadline,
						runs: budget.runs,
						digestTexts,
					});
					return { changes: [] };
				},
			},
		],
	};
}
