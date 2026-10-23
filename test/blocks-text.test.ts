/**
 * U0 Task 3 — `toText` (spec §14.3) and `formatValue` (spec §5.3): the
 * deterministic plain-text projection of a surface and the one value
 * formatter behind `stat`, `meter`, table columns, chart axes and card
 * time slots.
 *
 * Determinism contract (spec §14.3): the same input and locale give the
 * same bytes — asserted byte-for-byte across two calls and across a
 * `structuredClone` whose object keys are inserted in a different
 * order (object keys are visited in schema order, never insertion
 * order). Every gallery fixture is snapshotted at widths 80 and 160
 * with locale `en-CA` (the extension-unit-test recipe).
 *
 * `formatValue` here runs first (its own RED/GREEN cycle — Task 3's
 * first commit); the `toText` suites join in the second.
 */

import { describe, expect, it } from "vitest";
import { formatValue } from "@sigrun/shared/blocks";

const LOCALE = "en-CA";

// ─── formatValue (spec §5.3 formats) ──────────────────────────────────────

describe("formatValue", () => {
	it("bytes: 1536 → 1.5 KB", () => {
		expect(formatValue(1536, "bytes", LOCALE)).toBe("1.5 KB");
	});

	it("bytes: whole units below the first step stay bytes; larger steps scale", () => {
		expect(formatValue(512, "bytes", LOCALE)).toBe("512 B");
		expect(formatValue(2048, "bytes", LOCALE)).toBe("2 KB");
		expect(formatValue(1024 * 1024, "bytes", LOCALE)).toBe("1 MB");
	});

	it("duration: 11520000 ms → 3h 12m (two most significant units)", () => {
		expect(formatValue(11520000, "duration", LOCALE)).toBe("3h 12m");
	});

	it("duration: smaller spans use their own units", () => {
		expect(formatValue(0, "duration", LOCALE)).toBe("0s");
		expect(formatValue(45000, "duration", LOCALE)).toBe("45s");
		expect(formatValue(1500, "duration", LOCALE)).toBe("1s 500ms");
		expect(formatValue(90061000, "duration", LOCALE)).toBe("1d 1h");
	});

	it("compact: 2500 → 2.5K", () => {
		expect(formatValue(2500, "compact", LOCALE)).toBe("2.5K");
	});

	it("number: groups digits per locale", () => {
		expect(formatValue(1234567, "number", LOCALE)).toBe("1,234,567");
		expect(formatValue(1234567, undefined, LOCALE)).toBe("1,234,567");
	});

	it("percent: 0–1 fractions render as percentages", () => {
		expect(formatValue(0.42, "percent", LOCALE)).toBe("42%");
		expect(formatValue(0.03, "percent", LOCALE)).toBe("3%");
	});

	it("currency:<ISO 4217> formats amounts", () => {
		expect(formatValue(1234.5, "currency:USD", LOCALE)).toBe("US$1,234.50");
	});

	it("datetime / date / time format epoch milliseconds in the locale", () => {
		const at = 1760000000000; // 2025-10-09T08:53:20Z
		expect(formatValue(at, "datetime", LOCALE, "UTC")).toBe("Oct 9, 2025, 8:53 a.m.");
		expect(formatValue(at, "date", LOCALE, "UTC")).toBe("Oct 9, 2025");
		expect(formatValue(at, "time", LOCALE, "UTC")).toBe("8:53:20 a.m.");
	});

	it("datetime formats accept ISO strings too", () => {
		expect(formatValue("2025-10-09T08:53:20Z", "datetime", LOCALE, "UTC")).toBe(
			"Oct 9, 2025, 8:53 a.m.",
		);
	});

	it("relative formats a timestamp against now", () => {
		const fiveMinAgo = Date.now() - 5 * 60_000;
		expect(formatValue(fiveMinAgo, "relative", LOCALE)).toBe("5 minutes ago");
	});

	it("null renders empty; strings pass through; booleans spell out", () => {
		expect(formatValue(null, undefined, LOCALE)).toBe("");
		expect(formatValue("acme", undefined, LOCALE)).toBe("acme");
		expect(formatValue(true, undefined, LOCALE)).toBe("true");
	});

	it("objects and arrays render as sorted-key JSON (deterministic bytes)", () => {
		expect(formatValue({ b: 1, a: [true, null] }, undefined, LOCALE)).toBe(
			'{"a":[true,null],"b":1}',
		);
	});

	it("an unknown format falls back to plain number formatting", () => {
		expect(formatValue(2500, "furlongs", LOCALE)).toBe("2,500");
	});
});
