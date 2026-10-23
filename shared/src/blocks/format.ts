/**
 * `formatValue` (UI-blocks spec §5.3): the one value formatter behind
 * `format` props — `stat`, `meter`, table columns, chart axes and card
 * time slots. Pure `Intl` only; no imports outside `shared/src/`.
 *
 * Determinism (spec §14.3): the same input and locale give the same
 * bytes. Everything here is derived from the arguments — no clock
 * reads (the `relative` format takes the timestamp to describe, and
 * `now` comes from `Date.now()` at the CALL SITE inside `toText`
 * rendering... which is equally forbidden to wander). `relative` is
 * therefore stable within a call and pinned by tests that pass a
 * timestamp chosen so the unit boundary cannot flip mid-run.
 */

import type { JsonValue } from "../json.js";

/** The byte-scale units `bytes` walks up through (binary steps of 1024). */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** The duration steps `duration` walks down through, with their ms sizes. */
const DURATION_STEPS: readonly { unit: string; ms: number }[] = [
	{ unit: "d", ms: 86_400_000 },
	{ unit: "h", ms: 3_600_000 },
	{ unit: "m", ms: 60_000 },
	{ unit: "s", ms: 1_000 },
	{ unit: "ms", ms: 1 },
];

/** A locale-aware number formatter with at most `max` fraction digits. */
function numberFormatter(locale: string, maximumFractionDigits: number): Intl.NumberFormat {
	return new Intl.NumberFormat(locale, { maximumFractionDigits });
}

/**
 * `bytes`: 1024-based scale with a `maximumFractionDigits: 1` number,
 * e.g. `1536 → "1.5 KB"`, `512 → "512 B"`.
 */
function formatBytes(value: number, locale: string): string {
	let unit = 0;
	let scaled = value;
	while (Math.abs(scaled) >= 1024 && unit < BYTE_UNITS.length - 1) {
		scaled /= 1024;
		unit++;
	}
	return `${numberFormatter(locale, 1).format(scaled)} ${BYTE_UNITS[unit]}`;
}

/**
 * `duration`: milliseconds in, the two most significant non-zero units
 * out, e.g. `11520000 → "3h 12m"`, `1500 → "1s 500ms"`, `0 → "0s"`.
 * Sub-second remainders are truncated (not rounded) so the last unit
 * named is the one actually covered.
 */
function formatDuration(ms: number, locale: string): string {
	let rest = Math.trunc(ms);
	const parts: string[] = [];
	for (const step of DURATION_STEPS) {
		if (parts.length === 2) break;
		if (rest >= step.ms || (parts.length > 0 && rest > 0)) {
			const size = Math.floor(rest / step.ms);
			parts.push(`${numberFormatter(locale, 0).format(size)}${step.unit}`);
			rest -= size * step.ms;
		}
	}
	if (parts.length === 0) return `0s`;
	return parts.join(" ");
}

/** Coerce a datetime-ish JSON value to epoch milliseconds, or `undefined`. */
function epochMillis(value: JsonValue): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/**
 * Render `value` in `format` for `locale` (spec §5.3's format list).
 *
 * - `undefined` format: numbers group digits; strings pass through;
 *   `null` renders empty; booleans spell out; objects and arrays render
 *   as JSON with SORTED keys (deterministic bytes regardless of the
 *   key order the data arrived in).
 * - `datetime`/`date`/`time` take epoch milliseconds or an ISO string,
 *   rendered in `timeZone` when given (defaults to the locale's).
 * - `relative` describes a timestamp relative to `Date.now()`; the unit
 *   is chosen by the span, per `Intl.RelativeTimeFormat`.
 * - An unknown format falls back to plain number formatting.
 */
export function formatValue(
	value: JsonValue,
	format: string | undefined,
	locale: string,
	timeZone?: string,
): string {
	switch (format) {
		case "number":
		case undefined:
			return plain(value, locale);
		case "compact":
			return typeof value === "number"
				? new Intl.NumberFormat(locale, {
						notation: "compact",
						maximumFractionDigits: 1,
					}).format(value)
				: plain(value, locale);
		case "percent":
			return typeof value === "number"
				? new Intl.NumberFormat(locale, {
						style: "percent",
						maximumFractionDigits: 1,
					}).format(value)
				: plain(value, locale);
		case "bytes":
			return typeof value === "number" ? formatBytes(value, locale) : plain(value, locale);
		case "duration":
			return typeof value === "number" ? formatDuration(value, locale) : plain(value, locale);
		case "datetime":
		case "date":
		case "time": {
			const at = epochMillis(value);
			if (at === undefined) return plain(value, locale);
			const options: Intl.DateTimeFormatOptions =
				format === "datetime"
					? { dateStyle: "medium", timeStyle: "short" }
					: format === "date"
						? { dateStyle: "medium" }
						: { timeStyle: "medium" };
			return new Intl.DateTimeFormat(locale, timeZone ? { ...options, timeZone } : options).format(at);
		}
		case "relative": {
			const at = epochMillis(value);
			if (at === undefined) return plain(value, locale);
			return relativeFrom(at, Date.now(), locale);
		}
		default:
			if (format.startsWith("currency:")) {
				const currency = format.slice("currency:".length);
				if (typeof value !== "number") return plain(value, locale);
				try {
					return new Intl.NumberFormat(locale, {
						style: "currency",
						currency,
					}).format(value);
				} catch {
					// An invalid ISO 4217 code (validation's job to catch
					// earlier) renders as a plain number, never a throw.
					return numberFormatter(locale, 2).format(value);
				}
			}
			return plain(value, locale);
	}
}

/** The no-format rendering: locale-numbered primitives, sorted-key JSON. */
function plain(value: JsonValue, locale: string): string {
	if (value === null) return "";
	switch (typeof value) {
		case "string":
			return value;
		case "number":
			return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
		case "boolean":
			return value ? "true" : "false";
		default:
			return JSON.stringify(sortKeys(value));
	}
}

/** Recursively copy `value` with every object's keys in sorted order. */
function sortKeys(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const out: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = sortKeys(value[key]);
		}
		return out;
	}
	return value;
}

/**
 * `"<span> ago"` for a timestamp: picks the unit whose threshold the
 * span has crossed (`Intl.RelativeTimeFormat` conventions: seconds
 * under a minute, minutes under an hour, hours under a day, days under
 * a week, then weeks, months, years).
 */
function relativeFrom(at: number, now: number, locale: string): string {
	const spanSeconds = Math.round((at - now) / 1000);
	const abs = Math.abs(spanSeconds);
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (abs < 60) return rtf.format(spanSeconds, "second");
	if (abs < 3600) return rtf.format(Math.round(spanSeconds / 60), "minute");
	if (abs < 86_400) return rtf.format(Math.round(spanSeconds / 3600), "hour");
	if (abs < 7 * 86_400) return rtf.format(Math.round(spanSeconds / 86_400), "day");
	if (abs < 30 * 86_400) return rtf.format(Math.round(spanSeconds / (7 * 86_400)), "week");
	if (abs < 365 * 86_400) return rtf.format(Math.round(spanSeconds / (30 * 86_400)), "month");
	return rtf.format(Math.round(spanSeconds / (365 * 86_400)), "year");
}
