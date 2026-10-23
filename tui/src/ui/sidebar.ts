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
} from "@sigrun/shared/conversations";
import { plainTuiTheme, type TuiTheme } from "../theme.js";
import type { ConversationSummary, SigrunClient } from "../api.js";

/** The sidebar selection: a conversation id, the `+ new` action, or an
 *  extension VIEW (UI-blocks U3 Task 5 — the app opens it in the main
 *  pane). */
export type SidebarSelection =
	| number
	| "new"
	| { readonly view: { readonly slug: string; readonly id: string } };

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
	/** The extension VIEW rows (U3 Task 5): one per declared view surface,
	 *  rendered under the VIEWS group header. */
	#views: { readonly slug: string; readonly id: string; readonly title: string }[] = [];
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

	/**
	 * The extension views (U3 Task 5): refetch `GET /v1/extensions` and
	 * rebuild the VIEWS group (one row per declared view surface, in
	 * declaration order, status "ok" only). Panels live in the side pane,
	 * not here. Failures keep the last good list (a flaky server must
	 * never blank the sidebar).
	 */
	async refreshViews(): Promise<void> {
		try {
			const list = await this.#client.listExtensions();
			const views: { slug: string; id: string; title: string }[] = [];
			for (const extension of list.extensions) {
				if (extension.status !== "ok") continue;
				for (const surface of extension.surfaces ?? []) {
					if (surface.placement !== "view") continue;
					views.push({ slug: extension.name, id: surface.id, title: surface.title });
				}
			}
			this.#views = views;
			this.#mount();
		} catch {
			// fail quiet — the last good list stands
		}
	}

	/** The extension view rows (the app's openExtView reads them). */
	get views(): readonly { slug: string; id: string; title: string }[] {
		return this.#views;
	}

	/** Select the Nth extension view (the action layer's seam). */
	confirmView(index: number): void {
		const view = this.#views[index];
		if (view === undefined) return;
		this.onSelect?.({ view: { slug: view.slug, id: view.id } });
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
		// The VIEWS group (U3 Task 5): one row per declared extension view.
		if (this.#views.length > 0) {
			this.#stack.addChild(new Text(this.#theme.dim("VIEWS"), 1, 0));
			for (const view of this.#views) {
				const line = this.#rowLine();
				const component = new MouseRegion(line, (event) => {
					if (event.type === "click" && event.button === "left") {
						this.onSelect?.({ view: { slug: view.slug, id: view.id } });
						return { handled: true };
					}
					return undefined;
				});
				this.#rowComponents.push(component);
				this.#stack.addChild(component);
			}
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
		// The VIEWS group rows (after the conversations + the VIEWS header).
		if (this.#views.length > 0) {
			const base = this.#display.length + 2; // header + rows + VIEWS header
			for (const [index, view] of this.#views.entries()) {
				lines[base + index] = truncateToWidth(`  ${view.title}`, width);
			}
		}
		return lines;
	}

	invalidate(): void {
		this.#stack.invalidate();
	}
}
