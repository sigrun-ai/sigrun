/**
 * The key reference overlay (Task C5, UI refresh): `showHelp` mounts a
 * centred overlay listing the active keymap's `describe()` table in two
 * columns. Esc, `q`, or the keymap's own help key (`?` standard, `C-h`
 * emacs — the vim keymap binds no help key, so its overlay closes on
 * Esc/`q`) closes it. Built on the same `showOverlay` mechanism as C3's
 * picker.
 */

import { Key, matchesKey, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { Keymap } from "../keymaps/types.js";

export interface HelpOptions {
	/** Fires on close so the app can clear its overlayOpen flag. */
	readonly onClose?: () => void;
}

/** The keymap's own help key doubles as a close key (undefined = none). */
function helpKey(keymap: Keymap): string | undefined {
	if (keymap.name === "standard") return "?";
	if (keymap.name === "emacs") return "\x08"; // C-h
	return undefined;
}

class HelpOverlay implements Component {
	readonly #rows: readonly { keys: string; action: string }[];
	readonly #helpKey: string | undefined;
	readonly #options: HelpOptions;
	#overlay: OverlayHandle | undefined;

	constructor(keymap: Keymap, options: HelpOptions) {
		this.#rows = keymap.describe();
		this.#helpKey = helpKey(keymap);
		this.#options = options;
	}

	/** The overlay handle is installed by {@link showHelp} after show. */
	setOverlay(overlay: OverlayHandle): void {
		this.#overlay = overlay;
	}

	#close(): void {
		this.#overlay?.hide();
		this.#options.onClose?.();
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			data === "q" ||
			(this.#helpKey !== undefined && data === this.#helpKey)
		) {
			this.#close();
		}
		// Every other key is consumed: the overlay is modal.
	}

	render(width: number): string[] {
		const half = Math.ceil(this.#rows.length / 2);
		// The left column's field width: its longest "keys  action" pair.
		const leftWidth = Math.min(
			Math.max(
				...this.#rows
					.slice(0, half)
					.map((row) => row.keys.length + 2 + row.action.length),
			) + 4,
			Math.floor(width / 2),
		);
		const lines: string[] = ["key reference (esc or q closes)"];
		for (let i = 0; i < half; i++) {
			const left = this.#rows[i]!;
			const right = this.#rows[i + half];
			const leftText = `${left.keys}  ${left.action}`;
			if (right === undefined) {
				lines.push(leftText);
			} else {
				lines.push(`${leftText.padEnd(leftWidth)}${right.keys}  ${right.action}`);
			}
		}
		return lines;
	}

	invalidate(): void {}
}

/** Open the key reference overlay for `keymap`; Esc/q/help-key closes. */
export function showHelp(tui: TUI, keymap: Keymap, options: HelpOptions = {}): void {
	const help = new HelpOverlay(keymap, options);
	const overlay = tui.showOverlay(help, {
		anchor: "center",
		width: "70%",
		maxHeight: "70%",
	});
	help.setOverlay(overlay);
}
