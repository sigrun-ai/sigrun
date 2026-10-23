/**
 * The `tree` block (UI-blocks spec §5.3): a `nodes` binding of
 * `{id, label, icon?, hasChildren?, children?}[]` with a cursor row,
 * arrow-key movement, and Enter to expand/collapse or activate.
 *
 * A node with inline `children` toggles locally and never dispatches;
 * a node with `hasChildren` and no inline children dispatches
 * `onExpand` (an `edit`-shaped action carrying the handler NAME — the
 * handler returns `DataOps` inserting the children). A leaf runs
 * `onActivate` with `{id}`. Markers: `▸`/`▾` (ASCII `>`/`v`).
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Action, TreeBlock, TreeNode } from "@sigrun/shared/blocks";
import { bindRaw, type BlockCtx } from "./context.js";
import { iconGlyph } from "./icons.js";
import { truncate } from "./width.js";

/** The markers for expandable nodes. */
const MARKERS = { collapsed: "▸", expanded: "▾", collapsedAscii: ">", expandedAscii: "v" };

/** Read the bound nodes, dropping malformed entries. */
function treeNodes(block: TreeBlock, ctx: BlockCtx): TreeNode[] {
	const raw = bindRaw(block.nodes, ctx);
	if (!Array.isArray(raw)) return [];
	const out: TreeNode[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record: Record<string, unknown> = entry;
		if (typeof record.id !== "string" || typeof record.label !== "string") continue;
		out.push({
			id: record.id,
			label: record.label,
			icon: typeof record.icon === "string" ? (record.icon as TreeNode["icon"]) : undefined,
			hasChildren: record.hasChildren === true,
			children: Array.isArray(record.children)
				? (record.children as readonly TreeNode[])
				: undefined,
		});
	}
	return out;
}

/** One visible row: its node and indent depth. */
interface Row {
	node: TreeNode;
	depth: number;
}

/** `tree`: cursor + expand/collapse + activate. */
export class TreeComponent implements Component {
	readonly #block: TreeBlock;
	readonly #ctx: BlockCtx;
	#cursor = 0;
	readonly #expanded = new Set<string>();

	constructor(block: TreeBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
	}

	/** The visible rows (children of expanded nodes interleave). */
	#rows(): Row[] {
		const out: Row[] = [];
		const walk = (nodes: readonly TreeNode[], depth: number): void => {
			for (const node of nodes) {
				out.push({ node, depth });
				if (this.#expanded.has(node.id) && node.children !== undefined) {
					walk(node.children, depth + 1);
				}
			}
		};
		walk(treeNodes(this.#block, this.#ctx), 0);
		return out;
	}

	render(width: number): string[] {
		const unicode = this.#ctx.unicode;
		return this.#rows().map((row, index) => {
			const cursor = index === this.#cursor ? "> " : "  ";
			// Every row carries a state marker; leaves show the collapsed
			// glyph as their bullet so icon rows align with parent rows.
			const marker =
				(this.#expanded.has(row.node.id)
					? unicode
						? MARKERS.expanded
						: MARKERS.expandedAscii
					: unicode
						? MARKERS.collapsed
						: MARKERS.collapsedAscii) + " ";
			const icon =
				row.node.icon === undefined
					? ""
					: `${iconGlyph(row.node.icon, !unicode)} `;
			const indent = "  ".repeat(row.depth);
			return truncate(`${cursor}${indent}${marker}${icon}${row.node.label}`, width);
		});
	}

	handleInput(data: string): void {
		const rows = this.#rows();
		if (data === "\x1b[B") {
			this.#cursor = Math.min(rows.length - 1, this.#cursor + 1);
			return;
		}
		if (data === "\x1b[A") {
			this.#cursor = Math.max(0, this.#cursor - 1);
			return;
		}
		if (data !== "\r") return;
		const row = rows[this.#cursor];
		if (row === undefined) return;
		const node = row.node;
		if (node.children !== undefined) {
			// Inline children toggle locally; nothing dispatches.
			if (this.#expanded.has(node.id)) this.#expanded.delete(node.id);
			else this.#expanded.add(node.id);
			return;
		}
		if (node.hasChildren === true && this.#block.onExpand !== undefined) {
			const action: Action = { type: "edit", name: this.#block.onExpand };
			this.#ctx.dispatch(action, { id: node.id });
			return;
		}
		if (this.#block.onActivate !== undefined) {
			this.#ctx.dispatch(this.#block.onActivate, { id: node.id });
		}
	}

	invalidate(): void {
		// Cursor and expansion survive re-renders.
	}
}
