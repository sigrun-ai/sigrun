/**
 * NoticeCard (notices Task 6): the card's behaviors — the extension
 * action's confirm dialog, the busy state while an action POST is in
 * flight, and the 4 s result line (fake timers drive the window).
 */

import { act, createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { UserNotice, UserNoticeAction } from "@sigrun/shared/notices";
import { render, instanceText } from "../test-utils";
import { NoticeCard } from "./NoticeCard";

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
		vi.restoreAllMocks();
	});
	afterEach(() => {
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

	test("the result prop renders the message line (the lifted map's text)", () => {
		// Notices Task 7: the result text is LIFTED (useNotices' map) —
		// the card renders the prop; the 4 s window is the hook's timer,
		// covered in useNotices.test.tsx.
		const root = render(
			h(NoticeCard, {
				...baseProps(notice({ id: "n-1" })),
				run: async () => undefined,
				result: "learn undone",
			}),
		);
		expect(
			instanceText(root.root.findByProps({ className: "notice-card-result" })),
		).toBe("learn undone");
		// Absent/null renders no line.
		const bare = render(
			h(NoticeCard, {
				...baseProps(notice({ id: "n-2" })),
				run: async () => undefined,
				result: null,
			}),
		);
		expect(bare.root.findAllByProps({ className: "notice-card-result" })).toHaveLength(0);
	});
});
