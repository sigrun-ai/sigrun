/**
 * The calendar display (UI-blocks U1 Task 4, spec §5.5/§12.3/§12.4):
 * month/week/day grids over the block's `time` fields; compact shows
 * the agenda (§12.3). Moves ride pointer events: dragging an item to
 * another day dispatches the `onMove` move with `to: {start, end}`
 * preserving duration; `onResize` drags the item's end (an edit with
 * `{itemId, end}`); `onCreate` drags an empty slot (a submit with
 * `{start, end}`). `[`/`]` shift the visible range and `t` returns to
 * today — all view-only (no dispatch).
 */

import { useRef, useState, type ReactNode } from "react";
import type {
	CollectionBlock,
	JsonObject,
	JsonValue,
} from "@sigrun/shared/blocks";
import { useSurfaceActions } from "../context";
import { useWidthClass } from "../width";
import { type PreparedGroup, type PreparedItem } from "./Collection";
import { CardView } from "./Card";
import { useActivate, useCollectionView } from "./rows";

/** The day key (YYYY-MM-DD) an ISO timestamp falls on. */
function dayKey(iso: string): string {
	return iso.slice(0, 10);
}

/** Shift a day key by `days`. */
function shiftDay(key: string, days: number): string {
	const date = new Date(`${key}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

/** The month key (YYYY-MM) of a day key. */
function monthKey(day: string): string {
	return day.slice(0, 7);
}

/** Shift a month key by `months`. */
function shiftMonth(key: string, months: number): string {
	const [yearRaw, monthRaw] = key.split("-");
	const year = Number(yearRaw);
	const month = Number(monthRaw) - 1 + months;
	const date = new Date(Date.UTC(year, month, 1));
	return date.toISOString().slice(0, 7);
}

/** Today's month key (view-range default; fake timers drive tests). */
function currentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

/** The days a month grid renders (1st through the month's end; the
 *  v1 grid is day-rows, not a weekday-aligned matrix). */
function daysInMonth(month: string): readonly string[] {
	const [yearRaw, monthRaw] = month.split("-");
	const year = Number(yearRaw);
	const m = Number(monthRaw);
	const days: string[] = [];
	const date = new Date(Date.UTC(year, m - 1, 1));
	while (date.getUTCMonth() === m - 1) {
		days.push(date.toISOString().slice(0, 10));
		date.setUTCDate(date.getUTCDate() + 1);
	}
	return days;
}

/** An item's start/end ISO strings under the time config. */
function itemRange(
	block: CollectionBlock,
	item: JsonValue,
): { start: string; end: string | undefined } | undefined {
	const time = block.time;
	if (time === undefined) return undefined;
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		return undefined;
	}
	const record = item as JsonObject;
	const start = record[time.start];
	if (typeof start !== "string") return undefined;
	const end = time.end === undefined ? undefined : record[time.end];
	return { start, end: typeof end === "string" ? end : undefined };
}

/** The drop day under a point (drag.ts's data-attribute hit-test). */
function dropDayAt(x: number, y: number): string | undefined {
	if (typeof document !== "object") return undefined;
	const element = document.elementFromPoint(x, y);
	const carrier = element?.closest("[data-drop-day]");
	return carrier?.getAttribute("data-drop-day") ?? undefined;
}

/** The calendar display. */
export function CalendarDisplay(props: {
	block: CollectionBlock;
	groups: readonly PreparedGroup[];
}): ReactNode {
	const block = props.block;
	const time = block.time;
	const view = useCollectionView(block);
	const activate = useActivate(block);
	const actions = useSurfaceActions();
	const widthClass = useWidthClass();
	const compact = widthClass === "compact";
	const writeAccess = actions.access === "write";
	const canMove = writeAccess && block.onMove !== undefined;
	const canResize = writeAccess && time?.onResize !== undefined;
	const canCreate = writeAccess && time?.onCreate !== undefined;

	// The visible month (view-only; `[`/`]`/`t` shift it).
	const [month, setMonth] = useState<string>(currentMonth);

	// Items grouped by day (the flat prepared list across groups).
	const byDay = new Map<string, PreparedItem[]>();
	const allItems = props.groups.flatMap((group) => [
		...group.buckets.visible,
		...group.buckets.quiet,
	]);
	for (const prepared of allItems) {
		const range = itemRange(block, prepared.item);
		if (range === undefined) continue;
		const day = dayKey(range.start);
		const list = byDay.get(day) ?? [];
		list.push(prepared);
		byDay.set(day, list);
	}

	/** The in-flight drag (move / resize / create share the pointer
	 *  state; the ref mirrors it for the down->up batch). */
	type Drag =
		| { kind: "move"; itemId: string; start: string; end: string | undefined }
		| { kind: "resize"; itemId: string; start: string }
		| { kind: "create" };
	const dragRef = useRef<Drag | null>(null);
	const [, setDragging] = useState(false);

	const onKeyDown = (event: { key: string }): void => {
		if (event.key === "[") setMonth((current) => shiftMonth(current, -1));
		else if (event.key === "]") setMonth((current) => shiftMonth(current, 1));
		else if (event.key === "t") setMonth(currentMonth());
	};

	const itemPointerDown = (
		kind: "move" | "resize",
		prepared: PreparedItem,
	): void => {
		const range = itemRange(block, prepared.item);
		if (range === undefined) return;
		dragRef.current =
			kind === "move"
				? { kind, itemId: prepared.id, start: range.start, end: range.end }
				: { kind, itemId: prepared.id, start: range.start };
		setDragging(true);
	};

	const onPointerUp = (event: { clientX: number; clientY: number }): void => {
		const drag = dragRef.current;
		if (drag === null) return;
		dragRef.current = null;
		setDragging(false);
		const day = dropDayAt(event.clientX, event.clientY);
		if (day === undefined) return;
		if (drag.kind === "move") {
			const onMove = block.onMove;
			if (onMove === undefined) return;
			// Preserve the duration; shift start and end by the day delta.
			const deltaDays =
				(Date.parse(`${day}T00:00:00Z`) -
					Date.parse(`${dayKey(drag.start)}T00:00:00Z`)) /
				86_400_000;
			const start = shiftInstant(drag.start, deltaDays);
			const end =
				drag.end === undefined ? undefined : shiftInstant(drag.end, deltaDays);
			actions.dispatch(
				{ type: "move", name: onMove },
				{
					itemId: drag.itemId,
					to: end === undefined ? { start } : { start, end },
				},
			);
			return;
		}
		if (drag.kind === "resize") {
			const onResize = time?.onResize;
			if (onResize === undefined || time?.end === undefined) return;
			// Keep the end's clock time; move its DAY to the drop day.
			const found = findItem(drag.itemId);
			const current =
				found === undefined ? undefined : itemRange(block, found.item);
			const endTime =
				current?.end !== undefined ? current.end.slice(10) : "T00:00:00Z";
			actions.dispatch(
				{ type: "edit", name: onResize },
				{ itemId: drag.itemId, end: `${day}${endTime}` },
			);
			return;
		}
		// create: a day-spanning slot.
		const onCreate = time?.onCreate;
		if (onCreate === undefined) return;
		actions.dispatch(
			{ type: "submit", name: onCreate, turn: false },
			{ start: `${day}T00:00:00Z`, end: `${shiftDay(day, 1)}T00:00:00Z` },
		);
	};

	const findItem = (itemId: string): PreparedItem | undefined =>
		allItems.find((prepared) => prepared.id === itemId);

	// Compact: the agenda — items sorted by start, one row each.
	if (compact || time?.range === "agenda") {
		const sorted = [...allItems].sort((a, b) => {
			const ra = itemRange(block, a.item)?.start ?? "";
			const rb = itemRange(block, b.item)?.start ?? "";
			return ra.localeCompare(rb);
		});
		return (
			<div
				className="blk blk-collection blk-calendar"
				data-display="calendar"
				data-layout="agenda"
				data-range-label={month}
				onKeyDown={onKeyDown}
			>
				{sorted.map((prepared) => (
					<div
						key={prepared.id}
						className="blk-agenda-row"
						onClick={() => activate(prepared.id)}
					>
						<span className="blk-agenda-when">
							{itemRange(block, prepared.item)?.start ?? ""}
						</span>
						<CardView card={block.item} item={prepared.item} display="list" />
					</div>
				))}
			</div>
		);
	}

	// Regular/wide: the month grid.
	const days = daysInMonth(month);
	return (
		<div
			className="blk blk-collection blk-calendar"
			data-display="calendar"
			data-layout="month"
			data-range-label={month}
			onKeyDown={onKeyDown}
		>
			<div className="blk-calendar-grid">
				{days.map((day) => (
					<div
						key={day}
						className="blk-calendar-day"
						data-day={day}
						data-drop-day={day}
						data-create-day={canCreate ? day : undefined}
						onPointerDown={
							canCreate
								? () => {
										dragRef.current = { kind: "create" };
										setDragging(true);
									}
								: undefined
						}
						onPointerUp={onPointerUp}
					>
						<div className="blk-calendar-daynum">{day.slice(8)}</div>
						{(byDay.get(day) ?? []).map((prepared) => (
							<div
								key={prepared.id}
								className="blk-calendar-item"
								data-drag-item={canMove ? prepared.id : undefined}
								onPointerDown={(event) => {
									event.stopPropagation?.();
									if (canMove) itemPointerDown("move", prepared);
								}}
								onPointerUp={onPointerUp}
								onClick={() => activate(prepared.id)}
							>
								<CardView card={block.item} item={prepared.item} display="lanes" />
								{canResize && (
									<span
										className="blk-calendar-resize"
										data-resize-item={prepared.id}
										onPointerDown={(event) => {
											event.stopPropagation?.();
											itemPointerDown("resize", prepared);
										}}
										onPointerUp={onPointerUp}
									/>
								)}
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

/** Shift an ISO instant by whole days, keeping its clock time. */
function shiftInstant(iso: string, days: number): string {
	const date = new Date(iso);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
