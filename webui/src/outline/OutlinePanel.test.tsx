/**
 * OutlinePanel (B5, UI refresh): one button per user turn — click scrolls
 * the matching `[data-entry-id]` turn into view (block start, smooth), an
 * IntersectionObserver over the user turns marks the topmost visible one
 * aria-current. Items are buttons (keyboard-reachable; Enter activates).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, textContent } from "../test-utils";
import { OutlinePanel } from "./OutlinePanel";

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The panel's item for a user turn's entry id. */
function itemByEntryId(
	renderer: ReturnType<typeof render>,
	entryId: number,
): { props: Record<string, unknown> } {
	const matches = renderer.root
		.findAllByProps({ className: "outline-item" })
		.filter((item) => item.props["data-entry-id"] === entryId);
	if (matches.length !== 1) {
		throw new Error(`expected one outline item ${entryId}, found ${matches.length}`);
	}
	return matches[0] as unknown as { props: Record<string, unknown> };
}

/** A fake turn element: scrollIntoView spy, a rect `top`, and the
 *  data-entry-id attribute read back by the panel. */
function fakeTurn(id: number, top: number): FakeTurnElement {
	return {
		getAttribute: (name: string) =>
			name === "data-entry-id" ? String(id) : null,
		getBoundingClientRect: () => ({ top }),
		scrollIntoView: vi.fn(),
	};
}

/** A scroll-root stub answering `[data-entry-id="<id>"]` queries. */
function fakeScrollRoot(
	turns: Record<number, FakeTurnElement>,
): HTMLElement {
	return {
		querySelector: (selector: string) => {
			const match = /^\[data-entry-id="(\d+)"\]$/.exec(selector);
			return match === null ? null : (turns[Number(match[1])] ?? null);
		},
	} as unknown as HTMLElement;
}

/** The fake element a stubbed scrollRoot resolves `[data-entry-id]` to. */
interface FakeTurnElement {
	readonly getAttribute: (name: string) => string | null;
	readonly getBoundingClientRect: () => { readonly top: number };
	readonly scrollIntoView: ReturnType<typeof vi.fn>;
}

describe("OutlinePanel", () => {
	test("lists one button per user turn with the turn's text", () => {
		const renderer = render(
			h(OutlinePanel, {
				scrollRoot: null,
				turns: [
					{ entryId: 1, text: "Which generators support i18n?" },
					{ entryId: 5, text: "Yes — Hugo, English + French" },
				],
			}),
		);
		const items = renderer.root.findAllByProps({ className: "outline-item" });
		expect(items).toHaveLength(2);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Which generators support i18n?");
		expect(text).toContain("Yes — Hugo, English + French");
		// Keyboard-reachable: the items are buttons, not inert rows.
		expect(items.every((item) => item.type === "button")).toBe(true);
		renderer.unmount();
	});

	test("clicking the second item scrolls [data-entry-id=\"5\"] into view (block start, smooth)", () => {
		const turn5 = fakeTurn(5, 0);
		const renderer = render(
			h(OutlinePanel, {
				scrollRoot: fakeScrollRoot({ 5: turn5 }),
				turns: [
					{ entryId: 1, text: "first question" },
					{ entryId: 5, text: "second question" },
				],
			}),
		);
		act(() => {
			(itemByEntryId(renderer, 5).props as { onClick: () => void }).onClick();
		});
		expect(turn5.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(turn5.scrollIntoView).toHaveBeenCalledWith({
			behavior: "smooth",
			block: "start",
		});
		renderer.unmount();
	});

	test("the topmost visible user turn carries aria-current", () => {
		const observers: {
			callback: (
				entries: readonly { isIntersecting: boolean; target: unknown }[],
			) => void;
			observe: ReturnType<typeof vi.fn>;
			disconnect: ReturnType<typeof vi.fn>;
		}[] = [];
		class FakeObserver {
			callback: (entries: readonly unknown[]) => void;
			observe = vi.fn();
			disconnect = vi.fn();
			constructor(
				callback: (entries: readonly unknown[]) => void,
			) {
				this.callback = callback;
				observers.push(this as unknown as (typeof observers)[number]);
			}
		}
		vi.stubGlobal("IntersectionObserver", FakeObserver);
		const turn1 = fakeTurn(1, 120);
		const turn5 = fakeTurn(5, 40);
		const renderer = render(
			h(OutlinePanel, {
				scrollRoot: fakeScrollRoot({ 1: turn1, 5: turn5 }),
				turns: [
					{ entryId: 1, text: "first question" },
					{ entryId: 5, text: "second question" },
				],
			}),
		);
		// The observer watched every user turn element.
		expect(observers).toHaveLength(1);
		expect(observers[0]?.observe).toHaveBeenCalledTimes(2);
		expect(
			itemByEntryId(renderer, 1).props["aria-current"],
		).toBeUndefined();
		// Both visible: the topmost rect (turn 5 at top 40) is current.
		act(() => {
			observers[0]?.callback([
				{ isIntersecting: true, target: turn1 },
				{ isIntersecting: true, target: turn5 },
			]);
		});
		expect(itemByEntryId(renderer, 5).props["aria-current"]).toBe("true");
		expect(itemByEntryId(renderer, 1).props["aria-current"]).toBeUndefined();
		// Scrolling on: only turn 1 remains visible → it becomes current.
		act(() => {
			observers[0]?.callback([{ isIntersecting: false, target: turn5 }]);
		});
		expect(itemByEntryId(renderer, 1).props["aria-current"]).toBe("true");
		act(() => {
			renderer.unmount();
		});
		expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
	});

	test("empty transcript state: no turns, no items", () => {
		const renderer = render(
			h(OutlinePanel, { scrollRoot: null, turns: [] }),
		);
		expect(
			renderer.root.findAllByProps({ className: "outline-item" }),
		).toHaveLength(0);
		renderer.unmount();
	});
});
