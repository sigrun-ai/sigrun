/**
 * Daterange preset arithmetic (spec §5.3): day and week parts count
 * CALENDAR days on the local date — "7 days ago" is the same wall-clock
 * time seven calendar days back, even when that span is 6×24h + 1×25h —
 * while the `T…H/M/S` part stays ELAPSED time, applied after the calendar
 * part.
 */

// POSIX runtime-TZ support: Node honours TZ changes at runtime on POSIX
// hosts (Linux CI gates), so setting it here pins the DST cases below. The
// guard test fails loudly when a platform or pool ignores it, instead of
// letting these cases pass by accident in the host's zone. Deliberately
// NOT set suite-wide — every other webui test runs in the host's zone.
process.env.TZ = "America/Toronto";

import { describe, expect, test } from "vitest";
import { presetRange } from "./DaterangeField";

describe("daterange presets (§5.3 calendar days)", () => {
	test("the test pool honours POSIX runtime TZ", () => {
		// 2026-11-02 is EST (DST ended 2026-11-01): five hours behind UTC.
		expect(new Date("2026-11-02T04:30:00Z").getTimezoneOffset()).toBe(300);
	});

	test("P7D across the fall-back", () => {
		// Local: 2026-11-02 23:23 EST. Seven calendar days back is
		// 2026-10-26 23:23 — the span is 6×24h + 1×25h.
		expect(presetRange("P7D", new Date("2026-11-03T04:23:00Z"))).toEqual({
			start: "2026-10-26",
			end: "2026-11-02",
		});
	});

	test("P7D across the spring-forward", () => {
		// Local: 2026-03-09 23:30 EDT; seven calendar days back is
		// 2026-03-02 23:30 — the span is 6×24h + 1×23h.
		expect(presetRange("P7D", new Date("2026-03-10T03:30:00Z"))).toEqual({
			start: "2026-03-02",
			end: "2026-03-09",
		});
	});

	test("P1W equals P7D", () => {
		const now = new Date("2026-11-03T04:23:00Z");
		expect(presetRange("P1W", now)).toEqual(presetRange("P7D", now));
		expect(presetRange("P1W", now)).toEqual({
			start: "2026-10-26",
			end: "2026-11-02",
		});
	});

	test("P7D across a year boundary", () => {
		expect(presetRange("P7D", new Date("2026-01-03T17:00:00Z"))).toEqual({
			start: "2025-12-27",
			end: "2026-01-03",
		});
	});

	test("PT24H is elapsed time on the 25-hour day", () => {
		const now = new Date("2026-11-02T04:30:00Z");
		// Local: 2026-11-01 23:30 EST. 24 elapsed hours back lands at
		// 2026-11-01 00:30 EDT — the same local day, so a same-day range.
		expect(presetRange("PT24H", now)).toEqual({
			start: "2026-11-01",
			end: "2026-11-01",
		});
		// Calendar P1D from the same instant steps the local date back.
		expect(presetRange("P1D", now)).toEqual({
			start: "2026-10-31",
			end: "2026-11-01",
		});
	});

	test("P1DT1H is calendar then elapsed", () => {
		// Local: 2026-11-02 00:30 EST → calendar back to 2026-11-01 00:30
		// → minus one elapsed hour = 2026-10-31 23:30. Elapsed-only
		// (25 hours) would land on 2026-11-01.
		expect(presetRange("P1DT1H", new Date("2026-11-02T05:30:00Z"))).toEqual({
			start: "2026-10-31",
			end: "2026-11-02",
		});
	});

	test("an unparseable duration yields null", () => {
		expect(presetRange("7 days", new Date("2026-11-02T04:30:00Z"))).toBeNull();
	});
});
