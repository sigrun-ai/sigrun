/**
 * Test-fixture extension package (memory-seam Task 3): the extension-facing
 * `runSettled` contract stand-in. The factory result carries a `runSettled`
 * handler that records every delivered event MODULE-SIDE and exports the
 * record for the test to read — the fixture-memory pattern (the loader
 * imports this file by the same `file://` URL the test dynamically imports,
 * so both see ONE module instance).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ extension, runSettled }`.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Delivered runSettled events, recorded in delivery order. */
export const events = [];

/** Clear the record (tests own their fixtures' state). */
export function resetEvents() {
	events.length = 0;
}

/** When true, the next delivery throws instead of recording (isolation test). */
export let throwOnRunSettled = false;

/** Flip {@link throwOnRunSettled}. */
export function setThrowOnRunSettled(value) {
	throwOnRunSettled = value;
}

/** Text blocks of one assistant message joined (the answer's text). */
function answerText(message) {
	if (message === undefined) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Default export: factory returning the extension + its runSettled handler. */
export default function createFixtureMemoryEvents() {
	return {
		extension: defineExtension({
			name: "sigrun.fixture-memory-events",
		}),
		runSettled(event, api, context) {
			void api;
			void context;
			if (throwOnRunSettled) {
				throw new Error("fixture runSettled exploded");
			}
			events.push({
				conversationId: event.conversationId,
				inputs: [...event.inputs],
				inputTexts: [...event.inputTexts],
				outcome:
					event.outcome.status === "answered"
						? {
								status: "answered",
								answerEntryId: event.outcome.answerEntryId,
								answerText: answerText(event.outcome.answer),
							}
						: { status: "unanswered", reason: event.outcome.reason },
				apiKeys: Object.keys(api),
			});
		},
	};
}
