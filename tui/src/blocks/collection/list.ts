/**
 * The `list` display (UI-blocks spec §5.5): rows with group headings in
 * `groups` order, 2-cell-per-level nesting on `children`, `numbered`,
 * checkboxes, quiet items folded behind "N more", and the multi-select
 * bulk action menu (`.`).
 *
 * Keys (spec §12.4): Up/Down move the cursor; `x` toggles the checkable
 * field and dispatches `onCheck` (`edit`, `{itemId, value}`); `Space`
 * selects; `.` opens the bulk menu; Enter activates a row (`onActivate`
 * with `{itemId}`), unfolds the "N more" fold, or picks a menu entry.
 * Selection, folds and menus are view-only — they never dispatch.
 *
 * The bulk menu is the seam Task 5's form renderer plugs into: an
 * action with a `form` opens a minimal seam form here (labeled line
 * per top-level field name, values keyed by name) and its submit rides
 * the bulk payload as `{ids, values}` — mirroring U1 Task 3's note.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CollectionBlock, JsonObject, Tree } from "@sigrun/shared/blocks";
import { bindText, type BlockCtx } from "../context.js";
import { truncate, widthClassOf } from "../width.js";
import { cardLines } from "./card.js";
import {
	CollectionState,
	childItems,
	collectionItems,
	dispatchActivate,
	dispatchBulk,
	dispatchCheck,
	groupItems,
	isQuiet,
	sortItems,
	type CollectionItem,
	type ItemGroup,
} from "./shared.js";

/** One addressable row of the rendered list. */
interface ListRow {
	kind: "item" | "group" | "quiet";
	/** The item rows: which item, at what nesting depth. */
	row?: CollectionItem;
	depth?: number;
	/** Group rows: the group's id (heading folds honor `collapsed`).
	 *  Quiet rows carry it too (the fold is per-group). */
	groupId?: string;
	/** The folded quiet items a "quiet" row stands for. */
	quietRows?: CollectionItem[];
}

/** The seam form's field descriptors (Task 5 owns the real renderer). */
interface SeamField {
	name: string;
	label: string;
}

/** Top-level `form` block fields of a bulk action's form tree. */
function seamFields(form: Tree, ctx: BlockCtx): SeamField[] {
	const root = form.root;
	if (root.type !== "form") return [];
	const fields: SeamField[] = [];
	for (const child of root.children) {
		if (child.type === "section") continue;
		fields.push({ name: child.name, label: bindText(child.label, ctx) || child.name });
	}
	return fields;
}

/** `list`: groups, nesting, numbering, checkboxes, quiet fold, bulk menu. */
export class ListComponent implements Component {
	readonly #block: CollectionBlock;
	readonly #ctx: BlockCtx;
	readonly #state = new CollectionState();
	#tick = 0;

	constructor(block: CollectionBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
	}

	/** The items in render order (block's initial `sort`). */
	#items(): CollectionItem[] {
		return sortItems(collectionItems(this.#block, this.#ctx), this.#block.sort);
	}

	/** Flatten the render into addressable rows. */
	#rows(): ListRow[] {
		const rows: ListRow[] = [];
	const push = (row: CollectionItem, depth: number): void => {
		rows.push({ kind: "item", row, depth });
		for (const child of childItems(this.#block, row.item)) push(child, depth + 1);
	};
		for (const group of this.#groups()) {
			if (group.id !== "" && group.title !== "") {
				rows.push({ kind: "group", groupId: group.id });
			}
			if (group.collapsed && !this.#state.unfoldedGroups.has(group.id)) continue;
			const quiet = group.items.filter((row) => isQuiet(this.#block, this.#ctx, row.item));
			const loud = group.items.filter((row) => !isQuiet(this.#block, this.#ctx, row.item));
			for (const row of loud) push(row, 0);
			if (quiet.length > 0) {
				if (this.#state.quietShownFor(group.id)) {
					for (const row of quiet) push(row, 0);
					rows.push({ kind: "quiet", groupId: group.id, quietRows: [] }); // the "Show less" row
				} else {
					rows.push({ kind: "quiet", groupId: group.id, quietRows: quiet });
				}
			}
		}
		return rows;
	}

	#groups(): ItemGroup[] {
		return groupItems(this.#block, this.#items(), this.#ctx);
	}

	render(width: number): string[] {
		this.#tick += 1;
		const rows = this.#rows();
		if (this.#state.cursor >= rows.length) this.#state.cursor = Math.max(0, rows.length - 1);
		const lines: string[] = [];
		const unicode = this.#ctx.unicode;

		if (this.#state.menu?.kind === "bulk") {
			lines.push(
				truncate(`Bulk actions (${this.#state.selected.size} selected)`, width),
			);
			const actions = this.#block.bulkActions ?? [];
			actions.forEach((action, index) => {
				const cursor = index === this.#state.menuCursor ? "> " : "  ";
				lines.push(truncate(`${cursor}${bindText(action.label, this.#ctx) || action.id}`, width));
			});
			return lines;
		}
		if (this.#state.menu?.kind === "form") {
			const menu = this.#state.menu;
			const value = this.#state.formBuffer === "" ? "…" : this.#state.formBuffer;
			for (const field of seamFields(menu.form, this.#ctx)) {
				lines.push(truncate(`${field.label}: ${value}`, width));
			}
			lines.push(truncate("Enter to submit · Esc to cancel", width));
			return lines;
		}

		rows.forEach((row, index) => {
			const cursor = index === this.#state.cursor ? "> " : "  ";
			if (row.kind === "group") {
				lines.push(truncate(cursor + this.#ctx.theme.bold(`## ${this.#groupTitle(row.groupId ?? "")}`), width));
				return;
			}
			if (row.kind === "quiet") {
				const count = row.quietRows?.length ?? 0;
				const label = this.#state.quietShownFor(row.groupId ?? "") ? "Show less" : `${count} more`;
				lines.push(truncate(cursor + this.#ctx.theme.dim(label), width));
				return;
			}
			const item = row.row;
			if (item === undefined) return;
			let prefix = "";
			const indentStr = "  ".repeat(row.depth ?? 0);
			if (this.#block.numbered === true && (row.depth ?? 0) === 0) {
				prefix += `${this.#numberOf(rows, index)}. `;
			}
			if (this.#block.checkable !== undefined) {
				prefix += this.#state.checkedValue(this.#block, item) ? "[x] " : "[ ] ";
			}
			if (this.#block.select !== undefined) {
				const box = this.#state.selected.has(item.id)
					? unicode
						? "(•) "
						: "(*) "
					: "( ) ";
				prefix += box;
			}
			const card = cardLines(
				this.#block.item,
				item.item,
				this.#ctx,
				width - cursor.length - indentStr.length - prefix.length,
				0,
				this.#tick,
			);
			// The first card line carries the prefixes (title line by slot
			// order — an eyebrow hoists the prefixes onto the eyebrow line,
			// keeping one fixed line layout).
			const [first, ...rest] = card;
			lines.push(truncate(`${cursor}${indentStr}${prefix}${first ?? ""}`, width));
			for (const line of rest) {
				lines.push(truncate(`${cursor}${indentStr}${" ".repeat(prefix.length)}${line}`, width));
			}
		});
		return lines;
	}

	#groupTitle(id: string): string {
		return this.#groups().find((group) => group.id === id)?.title ?? id;
	}

	/** The running number of a depth-0 item row (numbered lists). */
	#numberOf(rows: readonly ListRow[], at: number): number {
		let number = 0;
		for (let i = 0; i <= at; i++) {
			const row = rows[i];
			if (row?.kind === "item" && row.depth === 0) number += 1;
		}
		return number;
	}

	handleInput(data: string): void {
		if (this.#state.menu !== null) {
			this.#menuInput(data);
			return;
		}
		const rows = this.#rows();
		if (data === "\x1b[B") {
			this.#state.cursor = Math.min(rows.length - 1, this.#state.cursor + 1);
			return;
		}
		if (data === "\x1b[A") {
			this.#state.cursor = Math.max(0, this.#state.cursor - 1);
			return;
		}
		const row = rows[this.#state.cursor];
		if (row === undefined) return;
		if (data === "x" && row.kind === "item" && row.row !== undefined) {
			dispatchCheck(this.#block, this.#ctx, this.#state, row.row);
			return;
		}
		if (data === " " && this.#block.select !== undefined && row.kind === "item" && row.row !== undefined) {
			const id = row.row.id;
			if (this.#state.selected.has(id)) this.#state.selected.delete(id);
			else this.#state.selected.add(id);
			return;
		}
		if (data === "." && this.#block.select === "multi" && this.#state.selected.size > 0) {
			if ((this.#block.bulkActions ?? []).length > 0) {
				this.#state.menu = { kind: "bulk" };
				this.#state.menuCursor = 0;
			}
			return;
		}
		if (data !== "\r") return;
		if (row.kind === "quiet") {
			this.#state.toggleQuiet(row.groupId ?? "");
			return;
		}
		if (row.kind === "group" && row.groupId !== undefined) {
			if (this.#state.unfoldedGroups.has(row.groupId)) {
				this.#state.unfoldedGroups.delete(row.groupId);
			} else {
				this.#state.unfoldedGroups.add(row.groupId);
			}
			return;
		}
		if (row.row !== undefined) dispatchActivate(this.#block, this.#ctx, row.row);
	}

	#menuInput(data: string): void {
		const menu = this.#state.menu;
		if (menu === null) return;
		if (data === "\x1b") {
			this.#state.menu = null;
			return;
		}
		if (menu.kind === "form") {
			if (data === "\r") {
				const values: JsonObject = {};
				for (const field of seamFields(menu.form, this.#ctx)) {
					values[field.name] = this.#state.formBuffer;
				}
				this.#state.formBuffer = "";
				dispatchBulk(this.#ctx, this.#state, menu.onSubmit, values);
				return;
			}
						if (data === "\x7f") {
						this.#state.formBuffer = this.#state.formBuffer.slice(0, -1);
						return;
						}
						if (!data.startsWith("\x1b") && data.length >= 1) {
				this.#state.formBuffer += data;
			}
			return;
		}
		const actions = this.#block.bulkActions ?? [];
		if (data === "\x1b[B") {
			this.#state.menuCursor = Math.min(actions.length - 1, this.#state.menuCursor + 1);
			return;
		}
		if (data === "\x1b[A") {
			this.#state.menuCursor = Math.max(0, this.#state.menuCursor - 1);
			return;
		}
		if (data !== "\r") return;
		const action = actions[this.#state.menuCursor];
		if (action === undefined) return;
		if (action.form !== undefined) {
			// The Task-5 seam: the form's full rendering lands with the
			// form block; this menu opens the seam form and its values
			// ride the payload (mirroring U1 Task 3's note in rows.tsx).
			this.#state.menu = { kind: "form", form: action.form, onSubmit: action.onSubmit };
			this.#state.formBuffer = "";
			return;
		}
		dispatchBulk(this.#ctx, this.#state, action.onSubmit);
	}

	invalidate(): void {
		// State survives re-renders (view-only by design).
	}
}

export { widthClassOf };
