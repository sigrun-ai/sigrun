/**
 * Test-fixture ask-user extension (ask-user Task 2, reused by Task 3 with
 * `interactiveTools`): a DECLINABLE interaction kind ("askwait.q") and one
 * tool `wait_for_human` whose execute seeds a question record and then
 * waits — the "waiting question" half of the message-decline rules.
 * Task 3: the factory result declares `interactiveTools: ["wait_for_human"]`
 * — core hides it in job and curator runs and `host.jobs.isJobRun` learns
 * whether a run is job-driven.
 *
 * Plain JavaScript, no build step — the loader imports it directly via
 * its file URL. The factory takes the HOST CONTEXT (arity-1): it
 * declares the interaction kind, stashes the host on
 * `globalThis.__askWaitHost` (tests seed through it), and resolves each
 * waiting call from its `interactionSettled` handler (the settle event,
 * not a poll, ends the wait).
 *
 * Test controls:
 *   - `globalThis.__askWaitGate`: when set to a Promise, the tool's
 *     execute awaits it FIRST — before seeding — so a test can admit a
 *     human message while the tool round is live but no card exists yet
 *     (the "not yet shown" case, Review Focus 2).
 *   - The waiters map is module-level, keyed by callId: the
 *     `interactionSettled` handler resolves the matching call's waiter.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { awaitWithContext } from "@earendil-works/chord/context";
import { BLOCK_SET_VERSION } from "@sigrun/shared/blocks";

/** The interaction kind this fixture declares (the seam's write gate). */
const ASK_KIND = "askwait.q";

/** A record is terminal once a human (or expiry) has settled it. */
const TERMINAL = new Set(["answered", "skipped", "expired", "cancelled"]);

/** callId → resolve(values): the waiting execute's settle latch. */
const waiters = new Map();

/**
 * @param host {{ seedInteraction: Function, snapshotInteraction: Function }}
 *   the sigrun seam host (src/harness/seam-host.ts) — required so the
 *   fixture seeds and reads interaction records through the same seam
 *   the server routes serve.
 */
export default function createAskWaitFixture(host) {
	if (host === undefined) {
		throw new Error("ask-wait fixture requires the host context");
	}
	globalThis.__askWaitHost = host;

	const waitForHuman = defineTool({
		name: "wait_for_human",
		description: "Ask the human a question and wait for the answer.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(args, api, context) {
			// Test hook: hold the tool BEFORE the card exists (a message
			// admitted now is queued behind this live tool round).
			const gate = globalThis.__askWaitGate;
			if (typeof gate?.then === "function") {
				await awaitWithContext(gate, context);
			}
			const callId = api.callId;
			await host.seedInteraction(
				api.conversationId,
				{
					kind: ASK_KIND,
					callId,
					status: "pending",
					createdAt: Date.now(),
					declinable: true,
					body: {
						v: BLOCK_SET_VERSION,
						root: {
							type: "form",
							id: "ask",
							bind: "/values",
							mode: "submit",
							children: [
								{
									type: "choice",
									name: "q1",
									label: "Pick one",
									options: [
										{ id: "a", label: "A" },
										{ id: "b", label: "B" },
									],
								},
							],
						},
					},
				},
				context,
			);
			// A record seeded already-settled (a queued human message
			// pre-declined it) never registers a waiter — the settle event
			// fired during seeding, before the waiter could exist.
			const seeded = await host.snapshotInteraction(
				api.conversationId,
				callId,
				context,
			);
			if (seeded !== undefined && TERMINAL.has(seeded.status)) {
				return {
					output: [{ type: "text", text: resultText(seeded) }],
				};
			}
			const settled = new Promise((resolve) => {
				waiters.set(callId, resolve);
			});
			// Cancellation-safe wait: rejects on abort/close.
			const record = await awaitWithContext(settled, context);
			return { output: [{ type: "text", text: resultText(record) }] };
		},
	});

	return {
		interactionKinds: [ASK_KIND],
		interactiveTools: ["wait_for_human"],
		extension: defineExtension({
			name: "sigrun-fixture-ask-wait",
			tools: [waitForHuman],
		}),
		async interactionSettled(event, api, context) {
			void api;
			void context;
			const resolve = waiters.get(event.callId);
			if (resolve !== undefined) {
				waiters.delete(event.callId);
				resolve(event);
			}
		},
	};
}

/**
 * The tool result text the tests assert on. `answer` arrives in two
 * shapes: the `interactionSettled` event carries the plain values record;
 * a `snapshotInteraction` record carries `{values}`.
 */
function resultText(record) {
	if (record?.status === "answered") {
		const answer = record.answer;
		const values =
			typeof answer === "object" && answer !== null && "values" in answer
				? answer.values
				: (answer ?? {});
		return `answered:${JSON.stringify(values)}`;
	}
	return `declined:${record?.declinedVia ?? record?.status}`;
}
