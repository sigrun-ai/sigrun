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

import { SigrunApiError } from "../src/api.js";
import {
	launchOptionsFrom,
	tuiStartupMessage,
} from "../src/launch.js";

describe("launchOptionsFrom (Task 7: SIGRUN_TOKEN env, never argv)", () => {
	test("SIGRUN_TOKEN threads into the launch options (token)", () => {
		const options = launchOptionsFrom(
			{ server: "https://sigrun.example", user: "alice" },
			{ SIGRUN_TOKEN: "sgr_env_token" },
		);
		expect(options).toMatchObject({
			baseUrl: "https://sigrun.example",
			user: "alice",
			token: "sgr_env_token",
		});
	});

	test("no SIGRUN_TOKEN: no token in the options", () => {
		const options = launchOptionsFrom(
			{ server: "https://sigrun.example" },
			{},
		);
		expect(options).not.toHaveProperty("token");
	});

	test("a blank SIGRUN_TOKEN is treated as absent", () => {
		const options = launchOptionsFrom(
			{ server: "https://sigrun.example" },
			{ SIGRUN_TOKEN: "  " },
		);
		expect(options).not.toHaveProperty("token");
	});
});

describe("tuiStartupMessage (Task 7: the standalone 403 setup_required exit)", () => {
	test("a 403 setup_required api error maps to the attach-onboard hint", () => {
		const error = new SigrunApiError(
			"GET",
			"/v1/conversations",
			403,
			{ error: "setup_required" },
		);
		expect(tuiStartupMessage(error)).toBe(
			"server is not set up — run `sigrun attach` to onboard",
		);
	});

	test("other api errors map to undefined (the generic path prints them)", () => {
		expect(
			tuiStartupMessage(
				new SigrunApiError("GET", "/v1/conversations", 401, {
					error: "unauthenticated",
				}),
			),
		).toBeUndefined();
		expect(
			tuiStartupMessage(
				new SigrunApiError("GET", "/v1/conversations", 403, {
					error: "origin_mismatch",
				}),
			),
		).toBeUndefined();
	});

	test("a non-api error maps to undefined", () => {
		expect(tuiStartupMessage(new Error("boom"))).toBeUndefined();
	});
});
