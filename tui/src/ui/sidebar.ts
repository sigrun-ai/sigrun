/**
 * The sidebar (Task 6): the conversation list — header, one row per
 * conversation, a trailing `+ new` action row, the active conversation
 * marked `*`. Archived conversations (`meta.archived`) are hidden from the
 * default listing (spec §3.2; the server has no delete, archive is the
 * hide). Named conversations list by name, unnamed by `#id` (spec: "named
 * ones by name, unnamed by id/first-prompt" — first-prompt previews are a
 * Task-7+ nicety; v1 is id).
 *
 * The list body is a pi-tui `SelectList` (arrow keys + enter; its own
 * scroll window caps the rows). `SelectList.setFilter` is a prefix MATCH,
 * so items can't be swapped through it: refresh rebuilds the inner list
 * instead — 1.3.0's idiom.
 *
 * Selection reports to {@link onSelect}: a conversation id, or `"new"`
 * when the `+ new` row is chosen (creation is the app's job — the sidebar
 * never calls createConversation itself).
 */

import {
	SelectList,
	Text,
	VStack,
	type Component,
	type SelectItem,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import type { SigrunClient } from "../api.js";

/** The sidebar selection: a conversation id, or the `+ new` action. */
export type SidebarSelection = number | "new";

interface SidebarRow {
	readonly id: number;
	readonly label: string;
}

/** The `+ new` row's select value (never a conversation id). */
const NEW_VALUE = "__new__";

/** No-color theme: the shell pins structure; styling is a later task. */
function plainSelectTheme(): SelectListTheme {
	const identity = (text: string): string => text;
	return {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	};
}

export interface SidebarOptions {
	/** Caps the rendered rows (the SelectList scroll window). */
	readonly maxVisible?: number;
}

export class Sidebar implements Component {
	readonly #client: SigrunClient;
	readonly #maxVisible: number;
	readonly #stack = new VStack();
	#list: SelectList;
	#rows: readonly SidebarRow[] = [];
	#activeId: number | undefined;

	/** Selection callback: the conversation id, or `"new"` for `+ new`. */
	onSelect?: (selection: SidebarSelection) => void;

	constructor(client: SigrunClient, options?: SidebarOptions) {
		this.#client = client;
		this.#maxVisible = options?.maxVisible ?? 10;
		this.#list = this.#buildList([]);
		this.#stack.addChild(new Text("CONVERSATIONS", 1, 0));
		this.#stack.addChild(this.#list);
	}

	/** The resolved rows, in display order (the app picks the boot default). */
	get rows(): readonly SidebarRow[] {
		return this.#rows;
	}

	/**
	 * Re-fetch the listing and resolve labels: `getMeta` per conversation
	 * supplies the name and the archive filter.
	 */
	async refresh(): Promise<void> {
		const list = await this.#client.listConversations();
		const rows: SidebarRow[] = [];
		for (const summary of list.conversations) {
			const meta = await this.#client.getMeta(summary.id);
			if (meta.archived) continue;
			const name = meta.name?.trim();
			rows.push({
				id: summary.id,
				label: name !== undefined && name !== "" ? name : `#${summary.id}`,
			});
		}
		this.#rows = rows;
		// Preserve the cursor's conversation across the rebuild when it
		// still exists (the cursor is SelectList-internal state).
		const selected = this.#list.getSelectedItem();
		const previousId =
			selected === null || selected.value === NEW_VALUE
				? undefined
				: Number(selected.value);
		this.#rebuildList();
		if (previousId !== undefined) {
			const index = rows.findIndex((row) => row.id === previousId);
			if (index >= 0) this.#list.setSelectedIndex(index);
		}
	}

	/** Mark the active conversation with `*`; pass `undefined` to clear. */
	setActive(id: number | undefined): void {
		this.#activeId = id;
		this.#rebuildList();
	}

	#rebuildList(): void {
		this.#stack.removeChild(this.#list);
		this.#list = this.#buildList(this.#items());
		this.#stack.addChild(this.#list);
		this.#stack.invalidate();
	}

	#items(): SelectItem[] {
		const items: SelectItem[] = this.#rows.map((row) => ({
			value: String(row.id),
			label: row.id === this.#activeId ? `* ${row.label}` : row.label,
		}));
		items.push({ value: NEW_VALUE, label: "+ new" });
		return items;
	}

	#buildList(items: SelectItem[]): SelectList {
		const list = new SelectList(items, this.#maxVisible, plainSelectTheme());
		list.onSelect = (item) => {
			if (item.value === NEW_VALUE) {
				this.onSelect?.("new");
			} else {
				this.onSelect?.(Number(item.value));
			}
		};
		return list;
	}

	handleInput(data: string): void {
		this.#list.handleInput(data);
	}

	render(width: number): string[] {
		return this.#stack.render(width);
	}

	invalidate(): void {
		this.#stack.invalidate();
	}
}
