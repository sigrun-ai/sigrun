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
import { AUTH_FAILURE_MESSAGE, FRONT_AUTH_FAILURE_MESSAGE } from "../src/api.js";
import { createStreamHealthNotices } from "../src/launch.js";

describe("createStreamHealthNotices", () => {
	test("error then open → exactly one disconnected + one reconnected notice", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		health.onError("conversation stream closed by the server");
		health.onOpen();
		expect(notices).toEqual(["stream: disconnected", "stream: reconnected"]);
	});

	test("a reconnect storm repeats neither notice (state-deduped, not time-deduped)", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		// Repeated failures while down: one notice.
		health.onError("conversation stream read failed: ECONNRESET");
		health.onError("conversation stream closed by the server");
		health.onError("conversation stream responded with status 503");
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
		health.onError("conversation stream closed by the server");
		health.onOpen();
		health.onError("conversation stream read failed: ECONNRESET");
		health.onOpen();
		expect(notices).toEqual([
			"stream: disconnected",
			"stream: reconnected",
			"stream: disconnected",
			"stream: reconnected",
		]);
	});

	test("a plain (non-auth) watch error carries the generic transition notice (review F1)", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		health.onError("conversation stream responded with status 503");
		health.onOpen();
		expect(notices).toEqual(["stream: disconnected", "stream: reconnected"]);
	});

	test("the auth-failure message surfaces VERBATIM, once, and stops the transition machine (review F1)", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		health.onError(AUTH_FAILURE_MESSAGE);
		// Repeated deliveries of the auth message (the watcher is dead, but
		// a race could re-deliver) stay at ONE notice.
		health.onError(AUTH_FAILURE_MESSAGE);
		expect(notices).toEqual([AUTH_FAILURE_MESSAGE]);
		// The stream never reconnected: an onOpen after the auth failure
		// does NOT announce a bogus "reconnected" — the credential is the
		// problem, not the transport.
		health.onOpen();
		expect(notices).toEqual([AUTH_FAILURE_MESSAGE]);
	});

	test("the front-auth message latches the same way as the token message", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		health.onError(FRONT_AUTH_FAILURE_MESSAGE);
		health.onError(FRONT_AUTH_FAILURE_MESSAGE);
		health.onOpen();
		expect(notices).toEqual([FRONT_AUTH_FAILURE_MESSAGE]);
	});

	test("an unrelated message mentioning authentication is not the auth failure", () => {
		const notices: string[] = [];
		const health = createStreamHealthNotices((message) => notices.push(message));
		health.onError("authentication failed (401) for some other reason");
		expect(notices).toEqual(["stream: disconnected"]);
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
				new SigrunApiError("GET", "/v1/conversations", 403, {
					error: "origin_mismatch",
				}),
			),
		).toBeUndefined();
	});

	test("a 401 api error maps to the auth-failure hint (Task 5)", () => {
		expect(
			tuiStartupMessage(
				new SigrunApiError("GET", "/v1/auth/whoami", 401, {
					error: "unauthenticated",
				}),
			),
		).toBe(
			"authentication failed (401): SIGRUN_TOKEN is missing, expired, or revoked — create one in Settings → API tokens",
		);
	});

	test("a non-api error maps to undefined", () => {
		expect(tuiStartupMessage(new Error("boom"))).toBeUndefined();
	});
});
