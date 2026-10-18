/**
 * The picker overlay (Task C3, UI refresh): a centred `showOverlay` box —
 * a title line, a one-line fuzzy filter, and a `SelectList`. Typing
 * re-filters (pi-tui's `fuzzyFilter` over label + detail), Enter picks,
 * Esc closes, and a mouse click picks (SelectList's own mouse handling).
 *
 * Conversation/model/command pickers are built by the app from the
 * sidebar tree, `listModels()`, and the slash catalog respectively.
 */

import {
	fuzzyFilter,
	Key,
	matchesKey,
	SelectList,
	type Component,
	type OverlayHandle,
	type SelectListTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { TuiTheme } from "../theme.js";

export interface PickerItem<T> {
	readonly label: string;
	readonly detail?: string;
	readonly value: T;
}

export interface PickerOptions<T> {
	readonly title: string;
	readonly onPick: (value: T) => void;
	/** Fires on close (pick OR cancel) so the app can clear overlayOpen. */
	readonly onClose?: () => void;
	/** The token theme; defaults to plain identity styling. */
	readonly theme?: TuiTheme;
}

const MAX_VISIBLE = 10;

function plainSelectListTheme(): SelectListTheme {
	const identity = (text: string): string => text;
	return {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	};
}

class Picker<T> implements Component {
	readonly #items: readonly PickerItem<T>[];
	readonly #options: PickerOptions<T>;
	readonly #selectTheme: SelectListTheme;
	readonly #muted: (text: string) => string;
	#query = "";
	#filtered: readonly PickerItem<T>[];
	#list: SelectList;
	#overlay: OverlayHandle | undefined;

	constructor(items: readonly PickerItem<T>[], options: PickerOptions<T>) {
		this.#items = items;
		this.#options = options;
		const theme = options.theme;
		this.#selectTheme =
			theme === undefined
				? plainSelectListTheme()
				: {
						selectedPrefix: (text) => theme.fg("accent")(text),
						selectedText: (text) => theme.bold(text),
						description: (text) => theme.fg("muted")(text),
						scrollInfo: (text) => theme.fg("muted")(text),
						noMatch: (text) => theme.fg("muted")(text),
					};
		this.#muted =
			theme === undefined ? (text) => text : (text) => theme.fg("muted")(text);
		this.#filtered = items;
		this.#list = this.#buildList();
	}

	/** The overlay handle is installed by {@link openPicker} after show. */
	setOverlay(overlay: OverlayHandle): void {
		this.#overlay = overlay;
	}

	#buildList(): SelectList {
		const list = new SelectList(
			this.#filtered.map((item, index) => ({
				value: String(index),
				label: item.label,
				...(item.detail === undefined ? {} : { description: item.detail }),
			})),
			MAX_VISIBLE,
			this.#selectTheme,
		);
		list.onSelect = (item) => {
			const picked = this.#filtered[Number(item.value)];
			if (picked === undefined) return;
			this.#close();
			this.#options.onPick(picked.value);
		};
		list.onCancel = () => this.#close();
		return list;
	}

	#close(): void {
		this.#overlay?.hide();
		this.#options.onClose?.();
	}

	#refilter(): void {
		const filtered: readonly PickerItem<T>[] =
			this.#query === ""
				? this.#items
				: fuzzyFilter([...this.#items], this.#query, (item) =>
						item.detail === undefined ? item.label : `${item.label} ${item.detail}`,
					);
		this.#filtered = filtered;
		this.#list = this.#buildList();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.backspace) || matchesKey(data, "backspace")) {
			if (this.#query !== "") {
				this.#query = this.#query.slice(0, -1);
				this.#refilter();
			}
			return;
		}
		// One printable character extends the filter; everything else
		// (arrows, Enter, Esc, mouse) is the list's own input.
		if (data.length === 1 && data >= " ") {
			this.#query += data;
			this.#refilter();
			return;
		}
		this.#list.handleInput(data);
	}

	render(width: number): string[] {
		return [
			this.#muted(this.#options.title),
			this.#muted(`filter: ${this.#query}`),
			...this.#list.render(width),
		];
	}

	/** The click is additive: delegate to the list under the filter rows. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y < 2) return { handled: true };
		return this.#list.handleMouse({ ...event, y: event.y - 2 });
	}

	invalidate(): void {
		this.#list.invalidate();
	}
}

/** Open a centred picker overlay; Enter/click picks, Esc closes. */
export function openPicker<T>(
	tui: TUI,
	items: readonly PickerItem<T>[],
	options: PickerOptions<T>,
): void {
	const picker = new Picker(items, options);
	const overlay = tui.showOverlay(picker, {
		anchor: "center",
		width: "60%",
		maxHeight: "60%",
	});
	picker.setOverlay(overlay);
}
