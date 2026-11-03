/**
 * The daterange field (UI-blocks U1 Task 5, spec §5.6): two dates
 * (`{start, end}`); `presets` fill BOTH dates from a duration
 * (`P7D`/`PT24H`-style ISO 8601 durations, resolved against "now").
 */

import type { ReactNode } from "react";
import type { DaterangeField, JsonValue } from "@sigrun/shared/blocks";
import { boundString, useSurfaceData } from "../context";
import { FieldRow, type FieldProps } from "./fields";

/** Resolve a preset duration against `now` (spec §5.3): the day and week
 *  parts walk CALENDAR days on the local date — "7 days ago" is the same
 *  wall-clock time seven days back, even when that span is 6×24h + 1×25h —
 *  while the `T…H/M/S` part is ELAPSED time, subtracted after the calendar
 *  part. Returns the two `YYYY-MM-DD` ends, or null for an unparseable
 *  duration. */
export function presetRange(
	duration: string,
	now: Date,
): { readonly start: string; readonly end: string } | null {
	const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
		duration,
	);
	if (match === null) return null;
	const weeks = Number(match[1] ?? 0);
	const days = Number(match[2] ?? 0);
	const hours = Number(match[3] ?? 0);
	const minutes = Number(match[4] ?? 0);
	const seconds = Number(match[5] ?? 0);
	const start = new Date(now.getTime());
	start.setDate(start.getDate() - (weeks * 7 + days));
	const elapsedMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
	const startDate = new Date(start.getTime() - elapsedMs);
	return { start: isoDay(startDate), end: isoDay(now) };
}

function range(value: JsonValue): { start: string; end: string } {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as { start?: JsonValue; end?: JsonValue };
		return {
			start: typeof record.start === "string" ? record.start : "",
			end: typeof record.end === "string" ? record.end : "",
		};
	}
	return { start: "", end: "" };
}

/** YYYY-MM-DD for a Date (local time — date inputs speak local). */
function isoDay(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function DaterangeFieldView(props: FieldProps<DaterangeField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	const label = boundString(data, field.label);
	const current = range(props.value);

	const write = (start: string, end: string): void =>
		props.onChange(field.name, { start, end });

	const applyPreset = (duration: string): void => {
		const next = presetRange(duration, new Date());
		if (next === null) return;
		write(next.start, next.end);
	};

	return (
		<FieldRow field={field} error={props.error}>
			<div className="blk-daterange">
				{field.presets !== undefined && field.presets.length > 0 && (
					<div className="blk-daterange-presets">
						{field.presets.map((preset) => (
							<button
								key={preset.id}
								type="button"
								disabled={props.disabled}
								onClick={() => applyPreset(preset.duration)}
							>
								{preset.label}
							</button>
						))}
					</div>
				)}
				<input
					type="date"
					aria-label={`${label} start`}
					value={current.start}
					min={field.min !== undefined ? String(field.min) : undefined}
					max={field.max !== undefined ? String(field.max) : undefined}
					disabled={props.disabled}
					onChange={(event) => write(event.target.value, current.end)}
				/>
				<input
					type="date"
					aria-label={`${label} end`}
					value={current.end}
					min={field.min !== undefined ? String(field.min) : undefined}
					max={field.max !== undefined ? String(field.max) : undefined}
					disabled={props.disabled}
					onChange={(event) => write(current.start, event.target.value)}
				/>
			</div>
		</FieldRow>
	);
}
