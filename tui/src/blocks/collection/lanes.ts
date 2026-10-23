/**
 * The `lanes` display (UI-blocks U2 Task 4, spec §5.5 + §12.3 + §12.4):
 * one lane per group, side by side in regular/wide; compact shows ONE
 * lane with a Tab/Shift+Tab switcher and a per-item "Move to…" menu
 * (the `.` action-menu) for cross-lane moves.
 *
 * Keyboard moves (§12.4): `m` picks the item under the cursor up,
 * arrows place it (left/right across lanes, up/down within), Enter
 * drops with the U1 pointer-drop payload `{itemId, from: {group,
 * index}, to: {group, index}}`, Esc cancels. Review Focus 1: the
 * pick-up survives a resize — the placement is recomputed from the
 * live block data on every key, never cached from the rendered lines.
 *
 * `x` checks, `Space` selects, Enter on an item with no pick-up in
 * flight activates it. Quiet items fold behind a per-lane "N more"
 * row. The cursor is (lane, row); at regular/wide lanes render side by
 * side and the cursor lane is the compact-selected one.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CollectionBlock } from "@sigrun/shared/blocks";
import type { BlockCtx } from "../context.js";
import { truncate, widthClassOf } from "../width.js";
import { cardLines } from "./card.js";
import {
	MoveSession,
	dispatchMove,
	lanes,
	movePayload,
	placementOf,
	shiftAcross,
	shiftWithin,
	type Placement,
} from "./move.js";
import {
	CollectionState,
	dispatchActivate,
	dispatchCheck,
	isQuiet,
	type CollectionItem,
	type ItemGroup,
} from "./shared.js";

/** One addressable row within a lane: an item or the quiet fold. */
interface LaneRow {
	kind: "item" | "quiet";
	group: string;
	itemId?: string;
	quietCount?: number;
}

/** The lanes display. */
export class LanesComponent implements Component {
	readonly #block: CollectionBlock;
	readonly #ctx: BlockCtx;
	readonly #state = new CollectionState();
	readonly #moves = new MoveSession();
	#tick = 0;
	/** The compact lane selection (survives width-class changes — the
	 *  same rule as U1's Review Focus 3). */
	#lane = 0;
	/** The cursor: a lane id plus a row within it. */
	#cursor: { group: string; row: number } = { group: "", row: 0 };
	/** The item the "Move to…" menu was opened for. */
	#menuItem: string | undefined;

	constructor(block: CollectionBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
	}

	#lanes(): { groups: ItemGroup[]; visible: Map<string, CollectionItem[]> } {
		return lanes(this.#block, this.#ctx);
	}

	/** The cursor lane (defaulting to the first group / compact lane). */
	#cursorLane(groups: readonly ItemGroup[]): ItemGroup | undefined {
		if (this.#cursor.group === "") {
			const first = groups[Math.min(this.#lane, groups.length - 1)];
			if (first !== undefined) this.#cursor = { group: first.id, row: 0 };
		}
		return (
			groups.find((group) => group.id === this.#cursor.group) ?? groups[0]
		);
	}

	/** The addressable rows of a lane: visible items, then quiet items
	 *  (folded behind "N more" while the lane's fold is closed). */
	#laneRows(group: ItemGroup, items: readonly CollectionItem[]): LaneRow[] {
		const rows: LaneRow[] = [];
		const visibleIds = new Set(items.map((row) => row.id));
		const quiet = group.items.filter((row) => !visibleIds.has(row.id));
		if (this.#state.quietShownFor(group.id)) {
			for (const item of [...items, ...quiet]) {
				rows.push({ kind: "item", group: group.id, itemId: item.id });
			}
			if (quiet.length > 0) {
				rows.push({ kind: "quiet", group: group.id, quietCount: 0 });
			}
			return rows;
		}
		for (const item of items) rows.push({ kind: "item", group: group.id, itemId: item.id });
		if (quiet.length > 0) {
			rows.push({ kind: "quiet", group: group.id, quietCount: quiet.length });
		}
		return rows;
	}

	render(width: number): string[] {
		this.#tick += 1;
		const { groups, visible } = this.#lanes();
		const compact = widthClassOf(width) === "compact";
		if (this.#lane >= groups.length) this.#lane = 0;
		const shownGroups = compact
			? groups.filter((group) => group.id === (groups[this.#lane]?.id ?? ""))
			: groups;

		if (this.#state.menu?.kind === "moveTo") {
			const lines: string[] = [truncate("Move to…", width)];
			this.#moveTargets().forEach((group, index) => {
				const cursor = index === this.#state.menuCursor ? "> " : "  ";
				lines.push(truncate(cursor + (group.title || group.id), width));
			});
			return lines;
		}

		const lines: string[] = [];
		if (compact && groups.length > 1) {
			const names = groups
				.map((group, index) => {
					const label = group.title || group.id;
					return index === this.#lane ? this.#ctx.theme.bold(label) : label;
				})
				.join("  ");
			lines.push(truncate(names, width));
		}

		const gutter = 2;
		const laneWidth =
			shownGroups.length === 0
				? width
				: Math.max(
						8,
						Math.floor((width - gutter * (shownGroups.length - 1)) / shownGroups.length),
					);
		const perLane = shownGroups.map((group) =>
			this.#laneLines(group, visible.get(group.id) ?? [], laneWidth),
		);
		const height = Math.max(0, ...perLane.map((column) => column.length));
		for (let row = 0; row < height; row++) {
			const parts = perLane.map((column) => (column[row] ?? "").padEnd(laneWidth));
			lines.push(truncate(parts.join(" ".repeat(gutter)), width));
		}
		return lines;
	}

	/** One lane's lines: heading, item cards (with a cursor column and
	 *  the pick-up marker), the quiet fold, and the drop marker. */
	#laneLines(group: ItemGroup, items: readonly CollectionItem[], width: number): string[] {
		const lines: string[] = [];
		lines.push(this.#ctx.theme.bold(truncate(`## ${group.title || group.id}`, width)));
		const rows = this.#laneRows(group, items);
		rows.forEach((row, rowIndex) => {
			const atCursor = this.#cursor.group === group.id && this.#cursor.row === rowIndex;
			const cursor = atCursor ? "> " : "  ";
			if (row.kind === "quiet") {
				const label =
					row.quietCount === 0 ? "Show less" : `${row.quietCount ?? 0} more`;
				lines.push(truncate(cursor + this.#ctx.theme.dim(label), width));
				return;
			}
			const item =
				items.find((candidate) => candidate.id === row.itemId) ??
				group.items.find((candidate) => candidate.id === row.itemId);
			if (item === undefined) return;
			const held = this.#moves.held?.itemId === item.id;
			let prefix = "";
			if (this.#block.checkable !== undefined) {
				prefix += this.#state.checkedValue(this.#block, item) ? "[x] " : "[ ] ";
			}
			if (this.#block.select !== undefined) {
				prefix += this.#state.selected.has(item.id)
					? this.#ctx.unicode
						? "(•) "
						: "(*) "
					: "( ) ";
			}
			if (held) prefix += this.#ctx.unicode ? "✋ " : "* ";
			const card = cardLines(
				this.#block.item,
				item.item,
				this.#ctx,
				width - cursor.length - prefix.length,
				0,
				this.#tick,
			);
			const [first, ...rest] = card;
			lines.push(truncate(`${cursor}${prefix}${first ?? ""}`, width));
			for (const line of rest) {
				lines.push(truncate(`${cursor}${" ".repeat(prefix.length)}${line}`, width));
			}
		});
		const held = this.#moves.held;
		if (held !== undefined && held.at.group === group.id) {
			const marker = this.#ctx.unicode ? "⌄ drop here" : "v drop here";
			lines.push(this.#ctx.theme.dim(truncate(`  ${marker} (${held.at.index})`, width)));
		}
		return lines;
	}

	/** The other groups (the compact "Move to…" menu entries). */
	#moveTargets(): ItemGroup[] {
		const { groups } = this.#lanes();
		return groups.filter((group) => group.id !== this.#cursor.group);
	}

	#item(id: string | undefined): CollectionItem | undefined {
		if (id === undefined) return undefined;
		const { groups } = this.#lanes();
		for (const group of groups) {
			const found = group.items.find((row) => row.id === id);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	handleInput(data: string): void {
		const { groups, visible } = this.#lanes();
		const lane = this.#cursorLane(groups);

		// The "Move to…" menu owns the keys while open.
		if (this.#state.menu?.kind === "moveTo") {
			const targets = this.#moveTargets();
			if (data === "\x1b") {
				this.#state.menu = null;
				return;
			}
			if (data === "\x1b[B") {
				this.#state.menuCursor = Math.min(targets.length - 1, this.#state.menuCursor + 1);
				return;
			}
			if (data === "\x1b[A") {
				this.#state.menuCursor = Math.max(0, this.#state.menuCursor - 1);
				return;
			}
			if (data !== "\r") return;
			const target = targets[this.#state.menuCursor];
			const itemId = this.#menuItem;
			this.#state.menu = null;
			if (target === undefined || itemId === undefined) return;
			const from = placementOf(groups, visible, itemId);
			if (from === undefined || this.#block.onMove === undefined) return;
			// The compact move target is the END of the chosen lane (U1's
			// MoveToMenu rule, spec §12.3).
			const to: Placement = { group: target.id, index: (visible.get(target.id) ?? []).length };
			this.#ctx.dispatch(
				{ type: "move", name: this.#block.onMove },
				movePayload({ itemId, from, to }),
			);
			return;
		}

		// A pick-up in flight owns the arrows (spec §12.4).
		const held = this.#moves.held;
		if (held !== undefined) {
			if (data === "\x1b") {
				this.#moves.cancel();
				return;
			}
			if (data === "\x1b[D") {
				this.#moves.held = shiftAcross(held, groups, visible, -1);
				return;
			}
			if (data === "\x1b[C") {
				this.#moves.held = shiftAcross(held, groups, visible, 1);
				return;
			}
			if (data === "\x1b[A") {
				this.#moves.held = shiftWithin(held, visible, -1);
				return;
			}
			if (data === "\x1b[B") {
				this.#moves.held = shiftWithin(held, visible, 1);
				return;
			}
			if (data === "\r") {
				this.#moves.held = undefined;
				dispatchMove(this.#block, this.#ctx, held);
			}
			return;
		}

		// Compact lane switcher: Tab / Shift+Tab cycle lanes.
		if (data === "\t") {
			if (groups.length > 1) {
				this.#lane = (this.#lane + 1) % groups.length;
				this.#cursor = { group: groups[this.#lane]?.id ?? "", row: 0 };
			}
			return;
		}
		if (data === "\x1b[Z") {
			if (groups.length > 1) {
				this.#lane = this.#lane - 1 < 0 ? groups.length - 1 : this.#lane - 1;
				this.#cursor = { group: groups[this.#lane]?.id ?? "", row: 0 };
			}
			return;
		}

		if (lane === undefined) return;
		const rows = this.#laneRows(lane, visible.get(lane.id) ?? []);
		if (this.#cursor.row >= rows.length) this.#cursor.row = Math.max(0, rows.length - 1);
		const current = rows[this.#cursor.row];

		if (data === "m" && current?.kind === "item" && current.itemId !== undefined) {
			if (this.#block.onMove === undefined) return;
			const from = placementOf(groups, visible, current.itemId);
			if (from === undefined) return;
			this.#moves.pickUp(current.itemId, from);
			return;
		}
		if (data === ".") {
			if (
				current?.kind === "item" &&
				this.#block.onMove !== undefined &&
				this.#moveTargets().length > 0
			) {
				this.#state.menu = { kind: "moveTo" };
				this.#state.menuCursor = 0;
				this.#menuItem = current.itemId;
			}
			return;
		}
		if (data === "\x1b[B") {
			this.#cursor = { group: lane.id, row: Math.min(rows.length - 1, this.#cursor.row + 1) };
			return;
		}
		if (data === "\x1b[A") {
			this.#cursor = { group: lane.id, row: Math.max(0, this.#cursor.row - 1) };
			return;
		}
		if (data === "x" && current?.kind === "item") {
			const item = this.#item(current.itemId);
			if (item !== undefined) dispatchCheck(this.#block, this.#ctx, this.#state, item);
			return;
		}
		if (data === " " && this.#block.select !== undefined && current?.kind === "item") {
			const id = current.itemId ?? "";
			if (this.#state.selected.has(id)) this.#state.selected.delete(id);
			else this.#state.selected.add(id);
			return;
		}
		if (data !== "\r") return;
		if (current?.kind === "quiet") {
			this.#state.toggleQuiet(current.group);
			return;
		}
		if (current?.kind === "item") {
			const item = this.#item(current.itemId);
			if (item !== undefined) dispatchActivate(this.#block, this.#ctx, item);
		}
	}

	invalidate(): void {
		// State (cursor, selection, folds, the pick-up) survives re-renders.
	}
}

/** Re-exported so tests can assert the compact switcher boundary. */
export { isQuiet };
