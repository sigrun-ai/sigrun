/**
 * The picker overlay (Task C3): opens centred via showOverlay, fuzzy
 * filters as you type, Enter picks, Esc closes, a mouse click picks.
 */

import { describe, expect, test } from "vitest";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { openPicker } from "../src/ui/picker.js";

interface Shown {
	component: Component;
	options?: OverlayOptions;
	hidden: boolean;
}

function stubTui(): { tui: TUI; shown: Shown[] } {
	const shown: Shown[] = [];
	const tui = {
		showOverlay(component: Component, options?: OverlayOptions) {
			const record: Shown = { component, options, hidden: false };
			shown.push(record);
			return {
				hide: () => {
					record.hidden = true;
				},
				setHidden: () => {},
				isHidden: () => record.hidden,
				focus: () => {},
				unfocus: () => {},
				isFocused: () => true,
				getBounds: () => undefined,
			};
		},
	} as unknown as TUI;
	return { tui, shown };
}

const ITEMS = [
	{ label: "alpha project", detail: "2m", value: 1 },
	{ label: "beta fork", detail: "1h", value: 2 },
	{ label: "gamma release", detail: "1d", value: 3 },
] as const;

describe("openPicker", () => {
	test("opens a centred overlay titled with the list rendered", () => {
		const { tui, shown } = stubTui();
		openPicker(tui, ITEMS, { title: "Conversations", onPick: () => {} });
		expect(shown).toHaveLength(1);
		expect(shown[0]!.options?.anchor).toBe("center");
		const lines = shown[0]!.component.render(60).join("\n");
		expect(lines).toContain("Conversations");
		expect(lines).toContain("alpha project");
	});

	test("typing filters fuzzy (label substring-ish, in order)", () => {
		const { tui, shown } = stubTui();
		openPicker(tui, ITEMS, { title: "Conversations", onPick: () => {} });
		const picker = shown[0]!.component;
		picker.handleInput!("b");
		picker.handleInput!("t");
		const lines = picker.render(60).join("\n");
		expect(lines).toContain("filter: bt");
		expect(lines).toContain("beta fork");
		expect(lines).not.toContain("alpha project");
	});

	test("enter picks the (filtered) selection and closes", () => {
		const { tui, shown } = stubTui();
		const picked: number[] = [];
		openPicker(tui, ITEMS, { title: "Conversations", onPick: (value) => picked.push(value) });
		const picker = shown[0]!.component;
		picker.handleInput!("g"); // only "gamma release" matches
		picker.handleInput!("\r");
		expect(picked).toEqual([3]);
		expect(shown[0]!.hidden).toBe(true);
	});

	test("esc closes without picking and fires onClose", () => {
		const { tui, shown } = stubTui();
		const picked: number[] = [];
		let closed = 0;
		openPicker(tui, ITEMS, {
			title: "Conversations",
			onPick: (value) => picked.push(value),
			onClose: () => {
				closed += 1;
			},
		});
		shown[0]!.component.handleInput!("\x1b");
		expect(picked).toEqual([]);
		expect(shown[0]!.hidden).toBe(true);
		expect(closed).toBe(1);
	});

	test("a mouse click picks the clicked row (additive, not required)", () => {
		const { tui, shown } = stubTui();
		const picked: number[] = [];
		openPicker(tui, ITEMS, { title: "Conversations", onPick: (value) => picked.push(value) });
		const picker = shown[0]!.component;
		picker.render(60); // layout before the click (row 0 = first item line)
		const handled = picker.handleMouse!({
			type: "click",
			button: "left",
			x: 2,
			y: 2, // the picker's title + filter rows precede the list
			screenX: 2,
			screenY: 2,
			width: 60,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(handled?.handled).toBe(true);
		expect(picked).toEqual([1]);
	});
});
