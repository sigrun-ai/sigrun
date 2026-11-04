/**
 * NoticesPane (notices Task 6): the header (Notices + Clear all), the
 * stacked cards, the "No notices" empty state, and the overlay chrome
 * (outside click / Escape close) for the non-Chats tabs. The document
 * is a fake (the react-test-renderer suite has none): the listeners are
 * captured from addEventListener and fired by hand.
 */

import { act, createElement as h, type ReactElement } from "react";
import TestRenderer from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { UserNotice } from "@sigrun/shared/notices";
import { render } from "../test-utils";
import { NoticesPane } from "./NoticesPane";

function notice(fields: Partial<UserNotice> & Pick<UserNotice, "id">): UserNotice {
	return {
		user: "acme-user",
		title: `notice ${fields.id}`,
		owner: "acme-ext",
		at: "2026-11-04T10:00:00.000Z",
		...fields,
	};
}

const noopRun = async () => undefined;
const noop = () => {};

function baseProps(notices: readonly UserNotice[]) {
	return {
		notices,
		run: noopRun,
		dismiss: noop,
		dismissAll: noop,
		onNavigate: noop,
	};
}

type Listener = (event: unknown) => void;

/** A document fake that records + fires listeners per event type. */
function makeDocument() {
	const listeners = new Map<string, Set<Listener>>();
	return {
		addEventListener(type: string, listener: Listener) {
			const set = listeners.get(type) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type: string, listener: Listener) {
			listeners.get(type)?.delete(listener);
		},
		fire(type: string, event: unknown): void {
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
	};
}

/** Render with host nodes faked (the overlay's outside-click test needs
 *  the pane root's `contains`). Every fake node reports the click target
 *  OUTSIDE the pane (the fired target is a foreign object). */
function renderWithNodes(element: ReactElement): TestRenderer.ReactTestRenderer {
	let renderer: TestRenderer.ReactTestRenderer | undefined;
	act(() => {
		renderer = TestRenderer.create(element, {
			createNodeMock: () => ({ contains: () => false }),
		});
	});
	if (renderer === undefined) throw new Error("test renderer not created");
	return renderer;
}

describe("NoticesPane", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("empty state: 'No notices'", () => {
		const root = render(h(NoticesPane, { ...baseProps([]), variant: "docked" }));
		expect(root.root.findByProps({ className: "notices-pane-empty" })).toBeTruthy();
	});

	test("header Clear all dismisses the pile", () => {
		let cleared = 0;
		const root = render(
			h(NoticesPane, {
				...baseProps([notice({ id: "n-1" }), notice({ id: "n-2" })]),
				variant: "docked",
				dismissAll: () => (cleared += 1),
			}),
		);
		act(() => {
			root.root.findByProps({ className: "notices-pane-clear" }).props.onClick();
		});
		expect(cleared).toBe(1);
	});

	test("docked on Chats closes outline (renders as the panel's mode content, no overlay chrome)", () => {
		const root = render(
			h(NoticesPane, { ...baseProps([notice({ id: "n-1" })]), variant: "docked" }),
		);
		expect(
			root.root.findAllByProps({ className: "notices-pane notices-pane-overlay" }),
		).toEqual([]);
		expect(root.root.findByProps({ "data-notice-id": "n-1" })).toBeTruthy();
	});

	test("overlay on Skills closes on outside click", () => {
		const doc = makeDocument();
		vi.stubGlobal("document", doc);
		let closed = 0;
		renderWithNodes(
			h(NoticesPane, {
				...baseProps([notice({ id: "n-1" })]),
				variant: "overlay",
				onClose: () => (closed += 1),
			}),
		);
		act(() => {
			doc.fire("mousedown", { target: {} });
		});
		expect(closed).toBe(1);
	});

	test("overlay closes on Escape", () => {
		const doc = makeDocument();
		vi.stubGlobal("document", doc);
		let closed = 0;
		renderWithNodes(
			h(NoticesPane, {
				...baseProps([notice({ id: "n-1" })]),
				variant: "overlay",
				onClose: () => (closed += 1),
			}),
		);
		act(() => {
			doc.fire("keydown", { key: "Escape" });
		});
		expect(closed).toBe(1);
	});

	test("a mousedown inside the bell does NOT close the overlay (the bell toggles it)", () => {
		const doc = makeDocument();
		vi.stubGlobal("document", doc);
		let closed = 0;
		renderWithNodes(
			h(NoticesPane, {
				...baseProps([notice({ id: "n-1" })]),
				variant: "overlay",
				onClose: () => (closed += 1),
			}),
		);
		// The bell subtree's target: closest() finds the bell's
		// data-rail-section="notices" wrapper.
		const bellTarget = {
			closest: (selector: string) =>
				selector === '[data-rail-section="notices"]' ? {} : null,
		};
		act(() => {
			doc.fire("mousedown", { target: bellTarget });
		});
		expect(closed).toBe(0);
		// An outside target still closes (the selector finds nothing).
		act(() => {
			doc.fire("mousedown", { target: { closest: () => null } });
		});
		expect(closed).toBe(1);
	});

	test("phone: the sheet keeps the overlay's close semantics (Escape closes)", () => {
		// The ≤900px full-height sheet is CSS over the SAME overlay
		// variant — its chrome (outside click / Escape) is unchanged; this
		// pins that nothing phone-shaped adds a second close path.
		const doc = makeDocument();
		vi.stubGlobal("document", doc);
		let closed = 0;
		renderWithNodes(
			h(NoticesPane, {
				...baseProps([notice({ id: "n-1" })]),
				variant: "overlay",
				onClose: () => (closed += 1),
			}),
		);
		act(() => {
			doc.fire("keydown", { key: "Escape" });
		});
		expect(closed).toBe(1);
	});
});
