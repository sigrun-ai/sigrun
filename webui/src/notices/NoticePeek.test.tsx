/**
 * NoticePeek (notices Task 6): the transient arrival card — 6 s then
 * folds, hover pauses, arrivals merge into "N new notices", never for
 * the on-screen conversation, never while the document is hidden,
 * role="status" aria-live="polite", click opens the pane, ✕ dismisses.
 * Fake timers drive the countdown.
 */

import { act, createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { UserNotice } from "@sigrun/shared/notices";
import type TestRenderer from "react-test-renderer";
import { render, instanceText } from "../test-utils";
import { NoticePeek, PEEK_MS, type PeekClock } from "./NoticePeek";

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

/** The fake-timers clock (vitest fake timers drive BOTH setTimeout and
 *  the Date this reads — the peek's countdown runs on virtual time). */
const FAKE_CLOCK: PeekClock = {
	now: () => Date.now(),
	sleep: (ms, fn) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle),
};

function baseProps(arrivals: readonly UserNotice[]) {
	return {
		arrivals,
		run: noopRun,
		dismiss: noop,
		onNavigate: noop,
		onOpenPane: noop,
		clock: FAKE_CLOCK,
	};
}

function peekOf(root: TestRenderer.ReactTestRenderer) {
	return root.root.findAllByProps({ className: "notice-peek" });
}

describe("NoticePeek", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.restoreAllMocks();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test("shows for 6 s then folds", () => {
		const root = render(h(NoticePeek, baseProps([notice({ id: "n-1" })])));
		expect(peekOf(root).length).toBe(1);
		expect(root.root.findByProps({ role: "status" }).props["aria-live"]).toBe("polite");
		act(() => {
			vi.advanceTimersByTime(PEEK_MS + 10);
		});
		expect(peekOf(root)).toEqual([]);
	});

	test("hover pauses the countdown", () => {
		const root = render(h(NoticePeek, baseProps([notice({ id: "n-1" })])));
		const peek = peekOf(root)[0];
		act(() => {
			peek.props.onMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(PEEK_MS + 5000);
		});
		expect(peekOf(root).length).toBe(1);
		// Leaving resumes: the remaining time runs out.
		act(() => {
			peek.props.onMouseLeave();
		});
		act(() => {
			vi.advanceTimersByTime(PEEK_MS + 10);
		});
		expect(peekOf(root)).toEqual([]);
	});

	test("three arrivals merge into '3 new notices'", () => {
		const root = render(h(NoticePeek, baseProps([notice({ id: "n-1" })])));
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		act(() => {
			root.update(h(NoticePeek, baseProps([notice({ id: "n-1" }), notice({ id: "n-2" })])));
		});
		act(() => {
			root.update(
				h(
					NoticePeek,
					baseProps([notice({ id: "n-1" }), notice({ id: "n-2" }), notice({ id: "n-3" })]),
				),
			);
		});
		const body = root.root.findByProps({ className: "notice-peek-body" });
		expect(instanceText(body)).toContain("3 new notices");
	});

	test("no peek for the on-screen conversation's notice", () => {
		const root = render(
			h(NoticePeek, {
				...baseProps([notice({ id: "n-1", conversationId: 7 })]),
				visibleConversationId: 7,
			}),
		);
		expect(peekOf(root)).toEqual([]);
		act(() => {
			vi.advanceTimersByTime(PEEK_MS + 10);
		});
		expect(peekOf(root)).toEqual([]);
	});

	test("no peek while the document is hidden", () => {
		vi.stubGlobal("document", { visibilityState: "hidden" });
		const root = render(h(NoticePeek, baseProps([notice({ id: "n-1" })])));
		expect(peekOf(root)).toEqual([]);
	});

	test("a click opens the pane scrolled to the notice; ✕ dismisses", () => {
		const opened: (string | undefined)[] = [];
		const dismissed: string[] = [];
		const root = render(
			h(NoticePeek, {
				...baseProps([notice({ id: "n-1" })]),
				onOpenPane: (id?: string) => opened.push(id),
				dismiss: (id: string) => dismissed.push(id),
			}),
		);
		act(() => {
			root.root.findByProps({ className: "notice-peek-body" }).props.onClick();
		});
		expect(opened).toEqual(["n-1"]);
		// The peek folds after the click-through; a new arrival re-peeks,
		// and its ✕ dismisses that notice.
		act(() => {
			root.update(
				h(NoticePeek, {
					...baseProps([notice({ id: "n-1" }), notice({ id: "n-2" })]),
					onOpenPane: (id?: string) => opened.push(id),
					dismiss: (id: string) => dismissed.push(id),
				}),
			);
		});
		act(() => {
			root.root.findByProps({ className: "notice-peek-close" }).props.onClick();
		});
		expect(dismissed).toEqual(["n-2"]);
	});
});
