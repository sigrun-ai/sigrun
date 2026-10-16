/**
 * The stream-health transition notices (fix wave F5, tui/src/launch.ts):
 * state-deduped stream-transport surfacing — the first watch error shows
 * "stream: disconnected", the next successful (re)connect shows
 * "stream: reconnected", and neither repeats within its state (a reconnect
 * storm must not fill the pane with retries).
 *
 * The shell itself needs a real terminal; the transition logic is a pure
 * state machine, tested here.
 */

import { describe, expect, test } from "vitest";
import { createStreamHealthNotices } from "../src/launch.js";

describe("createStreamHealthNotices", () => {
	test("error then open → exactly one disconnected + one reconnected notice", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		health.onError();
		health.onOpen();
		expect(notices).toEqual(["stream: disconnected", "stream: reconnected"]);
	});

	test("a reconnect storm repeats neither notice (state-deduped, not time-deduped)", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		// Repeated failures while down: one notice.
		health.onError();
		health.onError();
		health.onError();
		expect(notices).toEqual(["stream: disconnected"]);
		// A healthy steady state opens silently (no "reconnected" without a
		// prior "disconnected").
		health.onOpen();
		health.onOpen();
		expect(notices).toEqual(["stream: disconnected", "stream: reconnected"]);
	});

	test("a later outage notices again (transitions, not latches)", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		health.onError();
		health.onOpen();
		health.onError();
		health.onOpen();
		expect(notices).toEqual([
			"stream: disconnected",
			"stream: reconnected",
			"stream: disconnected",
			"stream: reconnected",
		]);
	});
});
