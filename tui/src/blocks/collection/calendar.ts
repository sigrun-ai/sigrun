/**
 * The `calendar` display (UI-blocks U2 Task 4, spec §5.5 + §12.3 +
 * §12.4): a month grid at regular/wide (day-rows — the same v1 shape
 * as U1's grid, not a weekday-aligned matrix); compact shows the
 * agenda (§12.3), as does `time.range: "agenda"` at any width.
 *
 * Keyboard (§12.4): `[`/`]` shift the visible month, `t` returns to
 * today — all view-only, nothing dispatches. `m` on an event picks it
 * up; arrows move it by DAY; Enter drops, dispatching `onMove` with
 * `{itemId, to: {start, end}}` — the duration preserved by shifting
 * start AND end by the day delta (the same payload as U1's pointer
 * drop). Esc cancels.
 *
 * The v1 TUI calendar has no pointer create/resize gestures (`onCreate`
 * and `onResize` stay U1-pointer-only affordances; noted in the task
 * report).
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CollectionBlock, JsonObject, JsonValue } from "@sigrun/shared/blocks";
import type { BlockCtx } from "../context.js";
import { truncate, widthClassOf } from "../width.js";
import { cardLines } from "./card.js";
import {
	CollectionState,
	collectionItems,
	dispatchActivate,
	sortItems,
	type CollectionItem,
} from "./shared.js";

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

/** Shift an ISO instant by whole days, keeping its clock time. */
function shiftInstant(iso: string, days: number): string {
	const date = new Date(iso);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Today's month key (view-range default; fake timers drive tests). */
function currentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

/** Shift a month key by `months`. */
function shiftMonth(key: string, months: number): string {
	const [yearRaw, monthRaw] = key.split("-");
	const year = Number(yearRaw);
	const month = Number(monthRaw) - 1 + months;
	return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

/** The days a month grid renders (1st through the month's end). */
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

/** An item's start/end ISO strings under the block's `time` config. */
function itemRange(
	block: CollectionBlock,
	item: JsonValue,
): { start: string; end: string | undefined } | undefined {
	const time = block.time;
	if (time === undefined) return undefined;
	if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
	const record = item as JsonObject;
	const start = record[time.start];
	if (typeof start !== "string") return undefined;
	const end = time.end === undefined ? undefined : record[time.end];
	return { start, end: typeof end === "string" ? end : undefined };
}

/** The picked-up calendar move (item plus its ORIGINAL range; the
 *  day delta applies on drop). */
interface HeldEvent {
	readonly itemId: string;
	readonly start: string;
	readonly end: string | undefined;
	/** The day the item is currently placed on. */
	at: string;
}

/** The calendar display. */
export class CalendarComponent implements Component {
	readonly #block: CollectionBlock;
	readonly #ctx: BlockCtx;
	readonly #state = new CollectionState();
	#tick = 0;
	/** The visible month (view-only; `[`/`]`/`t` shift it). */
	#month = currentMonth();
	/** The agenda cursor (a flat item index over the agenda order). */
	#cursor = 0;
	/** The picked-up event (calendar moves use a day placement, not the
	 *  lanes' group/index placement — the session wrapper tracks it). */
	#held: HeldEvent | undefined;

	constructor(block: CollectionBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
	}

	/** Every item with a parseable time range, in start order. */
	#events(): { row: CollectionItem; start: string; end: string | undefined }[] {
		const rows: { row: CollectionItem; start: string; end: string | undefined }[] = [];
		for (const row of sortItems(collectionItems(this.#block, this.#ctx), this.#block.sort)) {
			const range = itemRange(this.#block, row.item);
			if (range === undefined) continue;
			rows.push({ row, start: range.start, end: range.end });
		}
		rows.sort((a, b) => a.start.localeCompare(b.start));
		return rows;
	}

	render(width: number): string[] {
		this.#tick += 1;
		const compact = widthClassOf(width) === "compact" || this.#block.time?.range === "agenda";
		const events = this.#events();
		if (compact) return this.#agenda(width, events);
		return this.#monthGrid(width, events);
	}

	/** The agenda: items sorted by start, one row each. */
	#agenda(
		width: number,
		events: readonly { row: CollectionItem; start: string; end: string | undefined }[],
	): string[] {
		const lines: string[] = [this.#ctx.theme.dim(truncate(this.#month, width))];
		events.forEach((event, index) => {
			const cursor = index === this.#cursor ? "> " : "  ";
			const held = this.#held?.itemId === event.row.id;
			const mark = held ? (this.#ctx.unicode ? "✋ " : "* ") : "";
			const card = cardLines(
				this.#block.item,
				event.row.item,
				this.#ctx,
				width - cursor.length - mark.length - 12,
				0,
				this.#tick,
			);
			const when = `${event.start.slice(0, 10)} `;
			const [first, ...rest] = card;
			lines.push(truncate(`${cursor}${mark}${when}${first ?? ""}`, width));
			for (const line of rest) {
				lines.push(truncate(`${cursor}${" ".repeat(mark.length + when.length)}${line}`, width));
			}
		});
		return lines;
	}

	/** The month grid: one row per day, events under their day. */
	#monthGrid(
		width: number,
		events: readonly { row: CollectionItem; start: string; end: string | undefined }[],
	): string[] {
		const byDay = new Map<string, { row: CollectionItem; start: string }[]>();
		for (const event of events) {
			const day = dayKey(event.start);
			const list = byDay.get(day) ?? [];
			list.push(event);
			byDay.set(day, list);
		}
		const lines: string[] = [this.#ctx.theme.bold(truncate(this.#month, width))];
		for (const day of daysInMonth(this.#month)) {
			const todays = byDay.get(day) ?? [];
			const heldHere = this.#held !== undefined && this.#held.at === day;
			const marker = heldHere ? (this.#ctx.unicode ? " ⌄" : " v") : "";
			lines.push(truncate(`${day.slice(8)}${marker}`, width));
			for (const event of todays) {
				const held = this.#held?.itemId === event.row.id;
				const mark = held ? (this.#ctx.unicode ? "✋ " : "* ") : "";
				const card = cardLines(
					this.#block.item,
					event.row.item,
					this.#ctx,
					width - 2 - mark.length,
					0,
					this.#tick,
				);
				const [first, ...rest] = card;
				lines.push(truncate(`  ${mark}${first ?? ""}`, width));
				for (const line of rest) {
					lines.push(truncate(`  ${" ".repeat(mark.length)}${line}`, width));
				}
			}
		}
		return lines;
	}

	handleInput(data: string): void {
		// Range keys are always view-only (§12.4).
		if (data === "[") {
			this.#month = shiftMonth(this.#month, -1);
			return;
		}
		if (data === "]") {
			this.#month = shiftMonth(this.#month, 1);
			return;
		}
		if (data === "t") {
			this.#month = currentMonth();
			return;
		}

		const events = this.#events();

		// A pick-up in flight: arrows move the event by DAY.
		const held = this.#held;
		if (held !== undefined) {
			if (data === "\x1b") {
				this.#held = undefined;
				return;
			}
			let delta = 0;
			if (data === "\x1b[C" || data === "\x1b[B") delta = 1;
			if (data === "\x1b[D" || data === "\x1b[A") delta = -1;
			if (delta !== 0) {
				this.#held = { ...held, at: shiftDay(held.at, delta) };
				return;
			}
			if (data === "\r") {
				this.#held = undefined;
				const days =
					(Date.parse(`${held.at}T00:00:00Z`) -
						Date.parse(`${dayKey(held.start)}T00:00:00Z`)) /
					86_400_000;
				if (days === 0) return;
				const onMove = this.#block.onMove;
				if (onMove === undefined) return;
				const start = shiftInstant(held.start, days);
				const end = held.end === undefined ? undefined : shiftInstant(held.end, days);
				const to: JsonObject = end === undefined ? { start } : { start, end };
				this.#ctx.dispatch(
					{ type: "move", name: onMove },
					{ itemId: held.itemId, to },
				);
			}
			return;
		}

		if (this.#cursor >= events.length) this.#cursor = Math.max(0, events.length - 1);
		const current = events[this.#cursor];
		if (data === "\x1b[B") {
			this.#cursor = Math.min(events.length - 1, this.#cursor + 1);
			return;
		}
		if (data === "\x1b[A") {
			this.#cursor = Math.max(0, this.#cursor - 1);
			return;
		}
		if (data === "m" && current !== undefined && this.#block.onMove !== undefined) {
			this.#held = {
				itemId: current.row.id,
				start: current.start,
				end: current.end,
				at: dayKey(current.start),
			};
			return;
		}
		if (data === "\r" && current !== undefined) {
			dispatchActivate(this.#block, this.#ctx, current.row);
		}
	}

	invalidate(): void {
		// State (range, cursor, the pick-up) survives re-renders.
	}
}
