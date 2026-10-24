/**
 * Test-fixture extension package (memory-seam Tasks 3 + 4): the
 * extension-facing event-contract stand-in. The factory result carries a
 * `runSettled` handler (Task 3) and the five lifecycle handlers (Task 4)
 * that record every delivered event MODULE-SIDE and export the records for
 * the test to read — the fixture-memory pattern (the loader imports this
 * file by the same `file://` URL the test dynamically imports, so both see
 * ONE module instance).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an ARITY-1 factory (it captures the seam host the
 * loader passes) returning `{ extension, runSettled, conversationCreated,
 * conversationForked, conversationArchived, conversationIdle,
 * harnessShutdown, ambientKinds }`. The shutdown handler commits through
 * the captured host (an ambient write — the one commit surface an
 * extension holds), which is what the "handler's commit lands" test reads
 * back: extension events never receive a commit-capable api, only the
 * host context the factory stashed.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Delivered runSettled events, recorded in delivery order. */
export const events = [];

/** Delivered lifecycle events (Task 4): `{handler, ...event}`, in order. */
export const lifecycle = [];

/** Delivered harnessShutdown events (Task 4): one `{at}` per delivery. */
export const shutdowns = [];

/**
 * The most recent conversation any event named — the shutdown handler's
 * commit target (harnessShutdown itself carries no conversation).
 */
let lastConversationId;

/** Clear the records (tests own their fixtures' state). */
export function resetEvents() {
	events.length = 0;
	lifecycle.length = 0;
	shutdowns.length = 0;
	lastConversationId = undefined;
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

/** Record one lifecycle delivery under its handler name. */
function recordLifecycle(handler, event) {
	lastConversationId =
		event.conversationId ?? event.childId ?? lastConversationId;
	lifecycle.push({ handler, ...event });
}

/** Default export: factory returning the extension + its event handlers. */
export default function createFixtureMemoryEvents(host) {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-memory-events",
		}),
		// Declared so the shutdown handler's ambient commit passes the host's
		// write gate (the loader validates the arrays; the host enforces them).
		ambientKinds: ["fixture-flush"],
		runSettled(event, api, context) {
			void api;
			void context;
			if (throwOnRunSettled) {
				throw new Error("fixture runSettled exploded");
			}
			lastConversationId = event.conversationId;
			events.push({
				conversationId: event.conversationId,
				...(event.owner === undefined ? {} : { owner: event.owner }),
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
		conversationCreated(event, api, context) {
			void api;
			void context;
			recordLifecycle("conversationCreated", {
				conversationId: event.conversationId,
			});
		},
		conversationForked(event, api, context) {
			void api;
			void context;
			recordLifecycle("conversationForked", {
				childId: event.childId,
				parentId: event.parentId,
				at: event.at,
				...(event.owner === undefined ? {} : { owner: event.owner }),
			});
		},
		conversationArchived(event, api, context) {
			void api;
			void context;
			recordLifecycle("conversationArchived", {
				conversationId: event.conversationId,
				archived: event.archived,
			});
		},
		conversationIdle(event, api, context) {
			void api;
			void context;
			recordLifecycle("conversationIdle", {
				conversationId: event.conversationId,
				idleMs: event.idleMs,
			});
		},
		async harnessShutdown(api, context) {
			void api;
			shutdowns.push({ at: Date.now() });
			// The flush-commit: admission is still open (the seal is
			// Harness.close), so a commit through the captured host lands.
			if (host !== undefined && lastConversationId !== undefined) {
				await host.setAmbient(
					lastConversationId,
					{
						key: "fixture-flush",
						place: "panel",
						body: {
							v: 1,
							root: { type: "markdown", text: "flushed at shutdown" },
						},
					},
					context,
				);
			}
		},
	};
}
