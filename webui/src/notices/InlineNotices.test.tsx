/**
 * InlineNotices (notices Task 6): the active conversation's notices
 * above the composer — the 3 newest show, the rest fold behind an
 * "N more" button that opens the pane.
 */

import { act, createElement as h } from "react";
import { describe, expect, test, vi } from "vitest";
import type { UserNotice } from "@sigrun/shared/notices";
import { render } from "../test-utils";
import { instanceText } from "../test-utils";
import { InlineNotices } from "./InlineNotices";

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

describe("InlineNotices", () => {
	test("no notices renders nothing", () => {
		const root = render(
			h(InlineNotices, {
				notices: [],
				run: noopRun,
				dismiss: noop,
				onNavigate: noop,
				onOpenPane: noop,
			}),
		);
		expect(root.toJSON()).toBeNull();
	});

	test("max 3 then N more opens the pane", () => {
		const notices = [
			notice({ id: "n-1" }),
			notice({ id: "n-2" }),
			notice({ id: "n-3" }),
			notice({ id: "n-4" }),
			notice({ id: "n-5" }),
		];
		let opened = 0;
		const root = render(
			h(InlineNotices, {
				notices,
				run: noopRun,
				dismiss: noop,
				onNavigate: noop,
				onOpenPane: () => (opened += 1),
			}),
		);
		// The 3 newest show as cards.
		expect(root.root.findAllByProps({ className: "notice-card notice-tone-neutral" }).length).toBe(3);
		const more = root.root.findByProps({ className: "inline-notices-more" });
		expect(instanceText(more)).toBe("2 more");
		act(() => {
			more.props.onClick();
		});
		expect(opened).toBe(1);
	});
});
