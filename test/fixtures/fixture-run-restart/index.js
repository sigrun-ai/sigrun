/**
 * Durable run-settled Task 3: one extension whose module state survives two
 * openHarness boots in one process. The first boot blocks delivery on a gate;
 * the second records replayed/live events in their actual delivery order.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export const events = [];
export let blocked = false;
export let entered = 0;
let releaseBlocked = () => {};
let enteredBlocked = () => {};
let enteredGate = Promise.resolve();
let blockedGate = Promise.resolve();

export function resetRunRestartFixture() {
	events.length = 0;
	blocked = false;
	entered = 0;
	releaseBlocked = () => {};
	enteredBlocked = () => {};
	enteredGate = Promise.resolve();
	blockedGate = Promise.resolve();
}

export function blockRunSettled() {
	blocked = true;
	enteredGate = new Promise((resolve) => {
		enteredBlocked = resolve;
	});
	blockedGate = new Promise((resolve) => {
		releaseBlocked = resolve;
	});
}

export function waitForBlockedRunSettled() {
	return enteredGate;
}

export function releaseRunSettled() {
	releaseBlocked();
}

export default function createRunRestartFixture() {
	return {
		extension: defineExtension({ name: "fixture-run-restart" }),
		async runSettled(event) {
			if (blocked) {
				entered += 1;
				enteredBlocked();
				await blockedGate;
				return;
			}
			events.push({
				conversationId: event.conversationId,
				inputs: [...event.inputs],
				inputTexts: [...event.inputTexts],
				replayed: event.replayed === true,
				outcome: event.outcome.status,
			});
		},
	};
}
