/**
 * The TUI's request headers (2026-11-10, tailnet CLI access): ONE builder
 * for every HTTP path, so each request carries the fixed client label
 * `x-sigrun-client: tui` (an exact-match route rule can key on it) plus
 * the identity headers under the trim-then-omit rule every call site
 * already used.
 */

import { describe, expect, test } from "vitest";
import {
	CLIENT_HEADER,
	CLIENT_NAME,
	clientHeaders,
} from "../src/client-headers.js";

describe("clientHeaders", () => {
	test("always carries the fixed client label and the given accept", () => {
		expect(CLIENT_HEADER).toBe("x-sigrun-client");
		expect(CLIENT_NAME).toBe("tui");
		expect(clientHeaders({ accept: "text/event-stream" })).toEqual({
			accept: "text/event-stream",
			"x-sigrun-client": "tui",
		});
	});

	test("user and token are trimmed", () => {
		expect(
			clientHeaders({
				accept: "application/json",
				user: "  alice ",
				token: " sgr_example ",
			}),
		).toEqual({
			accept: "application/json",
			"x-sigrun-client": "tui",
			"x-sigrun-user": "alice",
			authorization: "Bearer sgr_example",
		});
	});

	test("undefined, empty, and whitespace user/token are omitted", () => {
		for (const value of [undefined, "", "   "]) {
			const headers = clientHeaders({
				accept: "application/json",
				...(value === undefined ? {} : { user: value, token: value }),
			});
			expect(headers).toEqual({
				accept: "application/json",
				"x-sigrun-client": "tui",
			});
		}
	});
});
