/**
 * The `page` shell (UI-blocks U2 Task 5, spec §5.1/§12.3 — the TUI port
 * of U1's `Page.tsx`): a header line (title, subtitle), sidebar, main
 * and detail regions — the channel draws them, the extension never
 * positions them.
 *
 * - `empty` replaces MAIN ONLY when main's first collection binds to a
 *   missing path, `null` or `[]`; the sidebar and detail keep rendering.
 * - At ≥ 100 columns the sidebar is a focusable pane beside main
 *   (Tab cycles sidebar → main); below 100 it is a toggled overlay
 *   (Tab toggles it; Esc closes it).
 * - `ctrl+s` opens the header switcher (a `choice` field): Up/Down
 *   pick, Enter dispatches a `navigate` action with `{<name>: id}`.
 * - `.` opens the actions menu: Up/Down pick, Enter dispatches the
 *   action, Esc closes. (Access `read` hides edit/answer actions.)
 * - The detail region is a pushed view: Enter on main pushes it, Esc
 *   pops back. At ≥ 100 columns it renders beside main once pushed.
 * - Esc with nothing open resolves at THIS layer (Task 4's host note:
 *   the app-level Esc handling for a surface with no pick-up and no
 *   open menu is the page's "unfocus" — the host routes it; the page
 *   reports `hasOverlay` so the host knows when Esc is already spoken
 *   for).
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
	ActionButton,
	Bindable,
	Block,
	ChoiceField,
	CollectionBlock,
	Field,
	JsonObject,
	PageBlock,
} from "@sigrun/shared/blocks";
import { resolvePointer } from "@sigrun/shared/blocks";
import { bindText, type BlockCtx } from "./context.js";
import { iconGlyph } from "./icons.js";
import { renderBlock, type RenderOptions } from "./render.js";
import { pad, truncate, wrapPlain } from "./width.js";

/** The sidebar-pane minimum (spec §5.1/brief: ≥ 100 columns). */
export const SIDEBAR_PANE_MIN = 100;

/** The sidebar's pane width at the side-by-side layout. */
export const SIDEBAR_CELLS = 30;

/** The first `collection` block in a slot list, depth-first (mirrors
 *  U1's `firstCollection`). */
export function firstCollection(blocks: readonly Block[]): CollectionBlock | undefined {
	for (const block of blocks) {
		if (block.type === "collection") return block;
		if (block.type === "stack") {
			const found = firstCollection(block.children);
			if (found !== undefined) return found;
		}
		if (block.type === "section") {
			const found = firstCollection(
				block.children.filter(
					(child: Block | Field): child is Block =>
						child.type === "collection" ||
						child.type === "stack" ||
						child.type === "columns" ||
						child.type === "grid" ||
						child.type === "section",
				),
			);
			if (found !== undefined) return found;
		}
		if (block.type === "columns" || block.type === "grid") {
			for (const child of block.children) {
				const found = firstCollection([child.block]);
				if (found !== undefined) return found;
			}
		}
	}
	return undefined;
}

/** Whether `empty` replaces main (spec §5.1): the first collection's
 *  `items` binding resolves missing, null or an empty array. */
export function isMainEmpty(block: PageBlock, data: JsonObject): boolean {
	if (block.empty === undefined) return false;
	const collection = firstCollection(block.main);
	if (collection === undefined) return false;
	const itemsProp = collection.items;
	// Literal rows (the ambient shape, U6 Task 3) resolve directly; the
	// "$" check discriminates the binding (Array.isArray cannot narrow
	// a readonly-array union).
	if (typeof itemsProp !== "object" || !("$" in itemsProp)) {
		return itemsProp.length === 0;
	}
	const items = resolvePointer(data, itemsProp.$);
	return !Array.isArray(items) || items.length === 0;
}

/** Which region has keyboard focus (Tab cycles sidebar → main). */
type Region = "sidebar" | "main";

export class PageComponent implements Component {
	readonly #block: PageBlock;
	readonly #ctx: BlockCtx;
	/** The open overlay: the switcher or the actions menu. */
	#menu: { kind: "switcher" | "actions"; cursor: number } | null = null;
	/** The pushed detail view (spec §12.3: detail → pushed page, Esc back). */
	#detailPushed = false;
	/** The sidebar overlay (compact) / focused pane (side-by-side). */
	#sidebarOpen = false;
	#region: Region = "main";
	/** The rendered region components (input forwards to the focused one). */
	readonly #main: readonly Component[];
	readonly #sidebar: readonly Component[];
	readonly #detail: readonly Component[];

	constructor(block: PageBlock, ctx: BlockCtx, options: RenderOptions = {}) {
		this.#block = block;
		this.#ctx = ctx;
		this.#main = block.main.map((child) => renderBlock(child, ctx, options));
		this.#sidebar = (block.sidebar ?? []).map((child) => renderBlock(child, ctx, options));
		this.#detail = (block.detail ?? []).map((child) => renderBlock(child, ctx, options));
	}

	get #hasSidebar(): boolean {
		return this.#sidebar.length > 0;
	}

	get #hasDetail(): boolean {
		return this.#detail.length > 0;
	}

	/** True while an overlay (menu, sidebar drawer, pushed detail) owns Esc. */
	get hasOverlay(): boolean {
		return this.#menu !== null || this.#detailPushed || this.#sidebarOpen;
	}

	/** The header line: title (+ subtitle), switcher/actions hints. */
	#headerLines(width: number): string[] {
		const title = bindText(this.#block.title as Bindable<string> | undefined, this.#ctx);
		const subtitle = bindText(this.#block.subtitle, this.#ctx);
		const hints: string[] = [];
		if (this.#block.switcher !== undefined) hints.push("ctrl+s switch");
		if ((this.#block.actions ?? []).length > 0) hints.push(". actions");
		const hint = hints.length > 0 ? this.#ctx.theme.dim(`  (${hints.join(" · ")})`) : "";
		const lines = [truncate(`${this.#ctx.theme.bold(title)}${hint}`, width)];
		if (subtitle !== "") lines.push(truncate(this.#ctx.theme.dim(subtitle), width));
		return lines;
	}

	#emptyLines(width: number): string[] {
		const empty = this.#block.empty;
		if (empty === undefined) return [];
		const icon = iconGlyph(empty.icon, !this.#ctx.unicode);
		const lines = [`${icon} ${empty.title}`];
		if (empty.hint !== undefined && empty.hint !== "") {
			for (const line of wrapPlain(empty.hint, width)) lines.push(this.#ctx.theme.dim(line));
		}
		return lines.map((line) => truncate(line, width));
	}

	#menuLines(width: number): string[] {
		const menu = this.#menu;
		if (menu === null) return [];
		if (menu.kind === "switcher") {
			const field = this.#block.switcher;
			if (field === undefined) return [];
			const options = this.#switcherOptions(field);
			return [
				truncate(this.#ctx.theme.bold("Switch"), width),
				...options.map((option, index) => {
					const cursor = index === menu.cursor ? "> " : "  ";
					return truncate(`${cursor}${bindText(option.label, this.#ctx) || option.id}`, width);
				}),
				truncate(this.#ctx.theme.dim("Enter selects · Esc closes"), width),
			];
		}
		const actions = this.#visibleActions();
		return [
			truncate(this.#ctx.theme.bold("Actions"), width),
			...actions.map((button, index) => {
				const cursor = index === menu.cursor ? "> " : "  ";
				const icon =
					button.icon === undefined ? "" : `${iconGlyph(button.icon, !this.#ctx.unicode)} `;
				return truncate(`${cursor}${icon}${bindText(button.label, this.#ctx) || button.id}`, width);
			}),
			truncate(this.#ctx.theme.dim("Enter runs · Esc closes"), width),
		];
	}

	#switcherOptions(field: ChoiceField): readonly { id: string; label: Bindable<string> }[] {
		const raw: unknown = field.options;
		if (Array.isArray(raw)) return raw;
		if (typeof raw === "object" && raw !== null && typeof (raw as { $?: unknown }).$ === "string") {
			const resolved: unknown = resolvePointer(this.#ctx.data, (raw as { $: string }).$);
			if (Array.isArray(resolved)) return resolved as readonly { id: string; label: Bindable<string> }[];
		}
		return [];
	}

	/** The header actions the principal may run (access read hides
	 *  edit/answer actions; navigate/open/copy stay — §6.5's read rule). */
	#visibleActions(): readonly ActionButton[] {
		if (this.#ctx.access === "write") return this.#block.actions ?? [];
		return (this.#block.actions ?? []).filter(
			(button) =>
				button.action.type === "navigate" ||
				button.action.type === "open" ||
				button.action.type === "copy",
		);
	}

	render(width: number): string[] {
		const lines = this.#headerLines(width);
		if (this.#menu !== null) {
			return [...lines, ...this.#menuLines(width)];
		}
		if (this.#detailPushed && this.#hasDetail) {
			lines.push(truncate(this.#ctx.theme.dim("Esc back"), width));
			for (const component of this.#detail) {
				lines.push(...component.render(width));
			}
			return lines;
		}
		const empty = isMainEmpty(this.#block, this.#ctx.data);
		const mainLines: string[] = empty
			? this.#emptyLines(width)
			: this.#main.flatMap((component) => component.render(this.#mainWidth(width)));
		const sideBySide = width >= SIDEBAR_PANE_MIN && this.#hasSidebar;
		if (!sideBySide) {
			// Compact/regular below the pane minimum: the sidebar is a
			// toggled overlay (rendered above main while open).
			if (this.#sidebarOpen && this.#hasSidebar) {
				lines.push(truncate(this.#ctx.theme.dim("Esc closes the sidebar"), width));
				for (const component of this.#sidebar) {
					lines.push(...component.render(width));
				}
				return lines;
			}
			return [...lines, ...mainLines];
		}
		// The side-by-side layout: sidebar pane, gutter, main.
		const sidebarLines = this.#sidebar.flatMap((component) =>
			component.render(SIDEBAR_CELLS),
		);
		const height = Math.max(sidebarLines.length, mainLines.length);
		for (let row = 0; row < height; row++) {
			const left = pad(sidebarLines[row] ?? "", SIDEBAR_CELLS);
			const right = mainLines[row] ?? "";
			lines.push(truncate(`${left} ${right}`, width));
		}
		return lines;
	}

	#mainWidth(width: number): number {
		return width >= SIDEBAR_PANE_MIN && this.#hasSidebar
			? Math.max(1, width - SIDEBAR_CELLS - 1)
			: width;
	}

	handleInput(data: string): void {
		// An open menu owns the keys.
		if (this.#menu !== null) {
			if (data === "\x1b") {
				this.#menu = null;
				return;
			}
			if (this.#menu.kind === "switcher") {
				const field = this.#block.switcher;
				if (field === undefined) return;
				const options = this.#switcherOptions(field);
				if (data === "\x1b[A") {
					this.#menu.cursor = Math.max(0, this.#menu.cursor - 1);
					return;
				}
				if (data === "\x1b[B") {
					this.#menu.cursor = Math.min(options.length - 1, this.#menu.cursor + 1);
					return;
				}
				if (data === "\r") {
					const option = options[this.#menu.cursor];
					if (option !== undefined) {
						// The switcher navigates (spec §5.1): params carry the id.
						this.#ctx.dispatch(
							{ type: "navigate", params: { [field.name]: option.id } },
							{ [field.name]: option.id },
						);
					}
					this.#menu = null;
					return;
				}
				return;
			}
			const actions = this.#visibleActions();
			if (data === "\x1b[A") {
				this.#menu.cursor = Math.max(0, this.#menu.cursor - 1);
				return;
			}
			if (data === "\x1b[B") {
				this.#menu.cursor = Math.min(actions.length - 1, this.#menu.cursor + 1);
				return;
			}
			if (data === "\r") {
				const button = actions[this.#menu.cursor];
				if (button !== undefined) this.#ctx.dispatch(button.action, {});
				this.#menu = null;
				return;
			}
			return;
		}
		// The pushed detail owns Esc (back).
		if (this.#detailPushed) {
			if (data === "\x1b") {
				this.#detailPushed = false;
				return;
			}
			for (const component of this.#detail) component.handleInput?.(data);
			return;
		}
		// The compact sidebar overlay owns Esc (close).
		if (this.#sidebarOpen) {
			if (data === "\x1b") {
				this.#sidebarOpen = false;
				return;
			}
			for (const component of this.#sidebar) component.handleInput?.(data);
			return;
		}
		if (data === "\x13") {
			// ctrl+s opens the switcher.
			if (this.#block.switcher !== undefined) {
				this.#menu = { kind: "switcher", cursor: 0 };
			}
			return;
		}
		if (data === ".") {
			if (this.#visibleActions().length > 0) this.#menu = { kind: "actions", cursor: 0 };
			return;
		}
		if (data === "\t") {
			// Tab cycles the sidebar (a focused pane at ≥ 100 columns, a
			// toggled overlay below).
			if (this.#hasSidebar) {
				if (this.#sideBySideKnown === true) {
					this.#region = this.#region === "sidebar" ? "main" : "sidebar";
				} else {
					this.#sidebarOpen = !this.#sidebarOpen;
				}
			}
			return;
		}
		if (data === "\r" && this.#hasDetail && !this.#detailPushed) {
			this.#detailPushed = true;
			return;
		}
		// Forward to the focused region.
		const target = this.#region === "sidebar" && this.#hasSidebar ? this.#sidebar : this.#main;
		for (const component of target) component.handleInput?.(data);
	}

	/** Whether the last render was the side-by-side layout (Tab's
	 *  pane-vs-overlay decision — set by the host when it knows; the
	 *  render path computes it from the width). */
	#sideBySideKnown: boolean | undefined;

	/** The host tells the page the current pane width's layout class
	 *  (render computes it too; this setter keeps Tab consistent when
	 *  input arrives between renders). */
	setSideBySide(sideBySide: boolean): void {
		this.#sideBySideKnown = sideBySide;
	}

	invalidate(): void {
		for (const component of [...this.#main, ...this.#sidebar, ...this.#detail]) {
			component.invalidate();
		}
	}

	/** Test introspection: the pushed detail / overlay state. */
	get detailPushed(): boolean {
		return this.#detailPushed;
	}

	get sidebarOpen(): boolean {
		return this.#sidebarOpen;
	}

	get menuKind(): "switcher" | "actions" | null {
		return this.#menu?.kind ?? null;
	}
}
