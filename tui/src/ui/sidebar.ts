/**
 * The sidebar (Task 6; restyled in C2, UI refresh): the conversation
 * TREE — rows come from B1's `buildConversationTree` (fork children
 * indent two spaces + `↳ `), names are single-line via B1's
 * `displayName` + pi-tui's `truncateToWidth`, ages right-align via B1's
 * `formatAge`, and the active row highlights accent-fg + bold. Archived
 * conversations stay hidden (the tree's `includeArchived: false`; the
 * server has no delete, archive is the hide). `+ New conversation` is
 * always the last row.
 *
 * The listing itself carries every field the rows need (`name`,
 * `archived`, `pinned`, `parent`, `lastActivityAt` ride
 * `ConversationSummary` — A1), so {@link refresh} makes ONE request: no
 * per-row meta fetch. The app re-refreshes on a 10 s poll (an unref'd
 * `setInterval` the launcher clears on dispose).
 *
 * Keyboard-first (mouse is additive): `cursor` / `moveCursor` /
 * `confirm()` are the C3 action layer's seam; a click on a row selects
 * it (`MouseRegion` per row). Selection reports to {@link onSelect}: a
 * conversation id, or `"new"` for the `+ New conversation` row
 * (creation is the app's job — the sidebar never calls
 * createConversation itself).
 */

import {
	MouseRegion,
	Text,
	truncateToWidth,
	visibleWidth,
	VStack,
	type Component,
} from "@earendil-works/pi-tui";
import {
	buildConversationTree,
	displayName,
	formatAge,
	type TreeNode,
} from "../../../src/shared/conversations.js";
import { plainTuiTheme, type TuiTheme } from "../theme.js";
import type { ConversationSummary, SigrunClient } from "../api.js";

/** The sidebar selection: a conversation id, or the `+ new` action. */
export type SidebarSelection = number | "new";

/** One display row: a conversation, or the trailing `+ New` action. */
interface SidebarRow {
	/** The conversation id; -1 for the `+ New conversation` action row. */
	readonly id: number;
	/** The display name (displayName — unnamed → "New conversation"). */
	readonly name: string;
	/** The tree depth (fork children render indented). */
	readonly depth: number;
	/** The right-aligned age column ("" when never used). */
	readonly age: string;
	/** Whether this row is the active conversation. */
	readonly active: boolean;
}

/** The `+ New conversation` row's id (never a conversation id). */
const NEW_ROW_ID = -1;

export interface SidebarOptions {
	/** The token theme; defaults to the plain (identity) fallback. */
	readonly theme?: TuiTheme;
	/** The clock seam for age rendering (tests pin it). */
	readonly now?: () => Date;
}

export class Sidebar implements Component {
	readonly #client: SigrunClient;
	readonly #theme: TuiTheme;
	readonly #now: () => Date;
	readonly #stack = new VStack();
	#header: Text | undefined;
	#rowComponents: Component[] = [];
	/** Conversation rows only (the action row is {@link #newRow}). */
	#rows: SidebarRow[] = [];
	/** The trailing `+ New conversation` action row (always present). */
	readonly #newRow: SidebarRow = {
		id: NEW_ROW_ID,
		name: "+ New conversation",
		depth: 0,
		age: "",
		active: false,
	};
	#activeId: number | undefined;
	#cursor = 0;

	/** Selection callback: the conversation id, or `"new"` for `+ new`. */
	onSelect?: (selection: SidebarSelection) => void;

	constructor(client: SigrunClient, options?: SidebarOptions) {
		this.#client = client;
		this.#theme = options?.theme ?? plainTuiTheme();
		this.#now = options?.now ?? (() => new Date());
		this.#mount();
	}

	/** The conversation rows, in display order (the app's boot default
	 * reads `rows[0]`); the trailing `+ New conversation` action row is
	 * NOT part of this list — it renders last via {@link #newRow}. */
	get rows(): readonly SidebarRow[] {
		return this.#rows;
	}

	/** The display list: the conversation rows plus the action row. */
	get #display(): readonly SidebarRow[] {
		return [...this.#rows, this.#newRow];
	}

	/** The cursor's row index (0-based over {@link rows}). */
	get cursor(): number {
		return this.#cursor;
	}

	/**
	 * Re-fetch the listing and rebuild the rows from the tree (summary
	 * fields only — no per-row meta fetch). The cursor follows its
	 * conversation when it still exists.
	 */
	async refresh(): Promise<void> {
		const list = await this.#client.listConversations();
		const previousId = this.#display[this.#cursor]?.id;
		const tree = buildConversationTree(list.conversations, {
			includeArchived: false,
		});
		const rows: SidebarRow[] = [];
		const walk = (nodes: readonly TreeNode<ConversationSummary>[], depth: number): void => {
			for (const node of nodes) {
				rows.push(this.#row(node.row, depth));
				walk(node.children, depth + 1);
			}
		};
		walk(tree, 0);
		this.#rows = rows;
		if (previousId !== undefined) {
			const index = rows.findIndex((row) => row.id === previousId);
			if (index >= 0) this.#cursor = index;
		}
		this.#clampCursor();
		this.#mount();
	}

	/** Mark the active conversation (accent fg + bold); pass `undefined` to clear. */
	setActive(id: number | undefined): void {
		if (id === this.#activeId) return;
		this.#activeId = id;
		this.#rows = this.#rows.map((row) =>
			row.id === NEW_ROW_ID ? row : { ...row, active: row.id === id },
		);
		this.#mount();
	}

	/** Move the cursor by `delta` rows, clamped to the list. */
	moveCursor(delta: number): void {
		this.#cursor += delta;
		this.#clampCursor();
		this.#stack.invalidate();
	}

	/** Select the cursor's row (Enter — the action layer's seam). */
	confirm(): void {
		const row = this.#display[this.#cursor];
		if (row === undefined) return;
		this.onSelect?.(row.id === NEW_ROW_ID ? "new" : row.id);
	}

	/** The keyboard seam: arrows move, Enter confirms (pre-C3 minimal). */
	handleInput(data: string): void {
		if (data.endsWith("[A")) {
			this.moveCursor(-1);
		} else if (data.endsWith("[B")) {
			this.moveCursor(1);
		} else if (data === "\r") {
			this.confirm();
		}
	}

	#clampCursor(): void {
		// The display list always has the action row, so it is never empty.
		this.#cursor = Math.max(0, Math.min(this.#cursor, this.#display.length - 1));
	}

	#row(summary: ConversationSummary, depth: number): SidebarRow {
		return {
			id: summary.id,
			name: displayName(summary),
			depth,
			age: formatAge(summary.lastActivityAt, this.#now()),
			active: summary.id === this.#activeId,
		};
	}

	/** One-line placeholder (pi-tui's `Text` drops whitespace-only text). */
	#rowLine(): Component {
		return {
			render: () => [""],
			invalidate: () => {},
		};
	}

	/** Rebuild the row components (header + one MouseRegion per row). */
	#mount(): void {
		this.#stack.clear();
		this.#rowComponents = [];
		this.#header = new Text(this.#theme.dim("CONVERSATIONS"), 1, 0);
		this.#stack.addChild(this.#header);
		for (const [index, row] of this.#display.entries()) {
			const line = this.#rowLine();
			const component = new MouseRegion(line, (event) => {
				if (event.type === "click" && event.button === "left") {
					this.#cursor = index;
					this.confirm();
					return { handled: true };
				}
				return undefined;
			});
			this.#rowComponents.push(component);
			this.#stack.addChild(component);
		}
		this.#stack.invalidate();
	}

	/** One row's styled text at the render width. */
	#rowText(row: SidebarRow, index: number, width: number): string {
		const indent = "  ".repeat(row.depth);
		const marker = row.depth > 0 ? "↳ " : "";
		const cursor = index === this.#cursor ? "› " : "  ";
		const age = row.age;
		const nameWidth = Math.max(
			1,
			width - visibleWidth(cursor + indent + marker) - (age === "" ? 0 : age.length + 1),
		);
		const name = truncateToWidth(`${indent}${marker}${row.name}`, nameWidth);
		const gap = age === "" ? "" : " ".repeat(Math.max(1, width - visibleWidth(cursor + name) - age.length));
		let text = `${cursor}${name}${gap}${age}`;
		text = truncateToWidth(text, width, "…", true);
		if (row.active) {
			return this.#theme.bold(this.#theme.fg("accent")(text));
		}
		if (row.id === NEW_ROW_ID) {
			return this.#theme.fg("accent")(text);
		}
		return text;
	}

	render(width: number): string[] {
		// The row components render empty; the rows are drawn here so the
		// width is known (right-aligned ages need it).
		const lines = this.#stack.render(width);
		// Header is line 0; one line per row follows (rows never wrap —
		// truncateToWidth pins them to one line).
		for (const [index, row] of this.#display.entries()) {
			lines[index + 1] = this.#rowText(row, index, width);
		}
		return lines;
	}

	invalidate(): void {
		this.#stack.invalidate();
	}
}
