/**
 * NoticeCard (notices Task 6): the card's behaviors — the extension
 * action's confirm dialog, the busy state while an action POST is in
 * flight, and the 4 s result line (fake timers drive the window).
 */

import { act, createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { UserNotice, UserNoticeAction } from "@sigrun/shared/notices";
import { render, instanceText } from "../test-utils";
import { NoticeCard, RESULT_MESSAGE_MS } from "./NoticeCard";

function notice(fields: Partial<UserNotice> & Pick<UserNotice, "id">): UserNotice {
	return {
		user: "acme-user",
		title: `notice ${fields.id}`,
		owner: "acme-ext",
		at: "2026-11-04T10:00:00.000Z",
		...fields,
	};
}

const noop = () => {};

function baseProps(noticeArg: UserNotice) {
	return {
		notice: noticeArg,
		dismiss: noop,
		onNavigate: noop,
	};
}

describe("NoticeCard", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.restoreAllMocks();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test("a confirm dialog returning false runs NOTHING", () => {
		vi.stubGlobal("confirm", () => false);
		const runs: string[] = [];
		const action: UserNoticeAction = {
			id: "undo",
			label: "Undo",
			kind: "extension",
			name: "undo-learn",
			confirm: "Undo the learned skill?",
		};
		const root = render(
			h(NoticeCard, {
				...baseProps(notice({ id: "n-1", actions: [action] })),
				run: async () => {
					runs.push("run");
					return undefined;
				},
			}),
		);
		act(() => {
			root.root.findByProps({ className: "notice-card-action" }).props.onClick();
		});
		expect(runs).toEqual([]);
	});

	test("a pending extension action disables the buttons until it settles", async () => {
		let resolveRun: (value: unknown) => void = () => {};
		const action: UserNoticeAction = {
			id: "undo",
			label: "Undo",
			kind: "extension",
			name: "undo-learn",
		};
		const root = render(
			h(NoticeCard, {
				...baseProps(notice({ id: "n-1", actions: [action] })),
				run: () =>
					new Promise((resolve) => {
						resolveRun = resolve;
					}),
			}),
		);
		const button = () =>
			root.root.findByProps({ className: "notice-card-action" });
		expect(button().props.disabled).toBe(false);
		act(() => {
			button().props.onClick();
		});
		expect(button().props.disabled).toBe(true);
		await act(async () => {
			resolveRun({ ok: true });
		});
		expect(button().props.disabled).toBe(false);
	});

	test("the result message renders, then clears after the 4 s window", async () => {
		const action: UserNoticeAction = {
			id: "undo",
			label: "Undo",
			kind: "extension",
			name: "undo-learn",
		};
		const root = render(
			h(NoticeCard, {
				...baseProps(notice({ id: "n-1", actions: [action] })),
				run: async () => ({ ok: true, message: "learn undone" }),
			}),
		);
		await act(async () => {
			await root.root.findByProps({ className: "notice-card-action" }).props.onClick();
		});
		const result = () => root.root.findAllByProps({ className: "notice-card-result" });
		expect(result()).toHaveLength(1);
		expect(instanceText(result()[0]!)).toBe("learn undone");
		act(() => {
			vi.advanceTimersByTime(RESULT_MESSAGE_MS + 10);
		});
		expect(result()).toHaveLength(0);
	});

	test("an action error renders, then clears", async () => {
		const action: UserNoticeAction = {
			id: "retry",
			label: "Retry",
			kind: "extension",
			name: "retry",
		};
		const root = render(
			h(NoticeCard, {
				...baseProps(notice({ id: "n-1", actions: [action] })),
				run: async () => ({ ok: false, error: { message: "handler exploded" } }),
			}),
		);
		await act(async () => {
			await root.root.findByProps({ className: "notice-card-action" }).props.onClick();
		});
		expect(instanceText(root.root.findByProps({ className: "notice-card-result" }))).toBe(
			"handler exploded",
		);
		act(() => {
			vi.advanceTimersByTime(RESULT_MESSAGE_MS + 10);
		});
		expect(root.root.findAllByProps({ className: "notice-card-result" })).toHaveLength(0);
	});
});
