/**
 * useDismiss (B7 polish): outside-click + Escape dismissal. Driven through a
 * fake document (the react-test-renderer suite has none): the hook's
 * listeners are captured from addEventListener and fired by hand.
 */

import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { render } from "./test-utils";
import { useDismiss } from "./useDismiss";

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
		count(type: string): number {
			return listeners.get(type)?.size ?? 0;
		},
	};
}

/** An element fake: `contains` answers by identity against a fixed set. */
function makeElement(...inside: unknown[]) {
	return { contains: (node: unknown) => inside.includes(node) };
}

describe("useDismiss", () => {
	test("a pointerdown outside the region dismisses; inside it does not", () => {
		const doc = makeDocument();
		vi.stubGlobal("document", doc);
		const insideTarget = {};
		const region = { current: makeElement(insideTarget) };
		const onDismiss = vi.fn();
		function Probe() {
			useDismiss(true, onDismiss, region);
			return null;
		}
		render(<Probe />);
		expect(doc.count("pointerdown")).toBe(1);
		act(() => {
			doc.fire("pointerdown", { target: insideTarget });
		});
		expect(onDismiss).not.toHaveBeenCalled();
		act(() => {
			doc.fire("pointerdown", { target: {} });
		});
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	test("an Escape keydown anywhere dismisses", () => {
		const doc = makeDocument();
		vi.stubGlobal("document", doc);
		const region = { current: makeElement() };
		const onDismiss = vi.fn();
		function Probe() {
			useDismiss(true, onDismiss, region);
			return null;
		}
		render(<Probe />);
		act(() => {
			doc.fire("keydown", { key: "Escape" });
		});
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	test("closed attaches nothing; a null region ref is simply not inside", () => {
		const doc = makeDocument();
		vi.stubGlobal("document", doc);
		const onDismiss = vi.fn();
		function Closed() {
			useDismiss(false, onDismiss, { current: null });
			return null;
		}
		render(<Closed />);
		expect(doc.count("pointerdown")).toBe(0);
		expect(doc.count("keydown")).toBe(0);
		// The open variant with a NULL ref: every target is outside → dismiss.
		function OpenNullRegion() {
			useDismiss(true, onDismiss, { current: null });
			return null;
		}
		render(<OpenNullRegion />);
		act(() => {
			doc.fire("pointerdown", { target: {} });
		});
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
