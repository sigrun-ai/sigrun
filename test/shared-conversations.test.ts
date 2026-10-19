/**
 * Task B1 (UI refresh): the conversation list tree and age shaping.
 *
 * `@sigrun/shared/conversations` builds the sidebar's forest: forks
 * nest under their parent when the parent is in the (filtered) set,
 * each node carries the newest activity of its whole subtree, roots
 * sort pinned-first then newest-first, and `formatAge` renders the
 * relative-time column. Fixtures are synthetic (tests own their
 * literals) and `NOW` is local noon so day-boundary cases survive any
 * runner timezone (DST shifts move the instants by at most an hour,
 * never across the noon-anchored day edges under test).
 */

import { describe, expect, it } from "vitest";
import {
	ageGroup,
	buildConversationTree,
	displayName,
	formatAge,
	type ListRow,
	type TreeNode,
} from "@sigrun/shared/conversations";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = new Date(2026, 9, 17, 12, 0, 0); // local noon, Oct 17 2026
const ago = (span: number): string =>
	new Date(NOW.getTime() - span).toISOString();

const row = (fields: Partial<ListRow> & Pick<ListRow, "id">): ListRow => ({
	archived: false,
	pinned: false,
	...fields,
});

const leaf = (fields: Partial<ListRow> & Pick<ListRow, "id">): TreeNode<ListRow> => {
	const activity = fields.lastActivityAt ? Date.parse(fields.lastActivityAt) : 0;
	return { row: row(fields), children: [], newestActivity: activity };
};

describe("buildConversationTree", () => {
	it("nests a fork used today under a parent used last week", () => {
		const parent = row({
			id: 1,
			name: "Release checklist",
			lastActivityAt: ago(8 * DAY),
		});
		const fork = row({
			id: 2,
			name: "Release checklist — retry",
			parent: { id: 1 },
			lastActivityAt: ago(30 * MINUTE),
		});
		const tree = buildConversationTree([parent, fork], {
			includeArchived: false,
		});
		expect(tree).toHaveLength(1);
		expect(tree[0]!.row.id).toBe(1);
		expect(tree[0]!.children.map((child) => child.row.id)).toEqual([2]);
		// The root carries the newest activity of its whole subtree…
		expect(tree[0]!.newestActivity).toBe(Date.parse(fork.lastActivityAt!));
		// …so the stale parent still groups under Today.
		expect(ageGroup(tree[0]!, NOW)).toBe("Today");
	});

	it("excludes an archived parent, promoting the fork to a root", () => {
		const archivedParent = row({
			id: 1,
			name: "Old work",
			archived: true,
			lastActivityAt: ago(8 * DAY),
		});
		const fork = row({
			id: 2,
			name: "Forked from old work",
			parent: { id: 1 },
			lastActivityAt: ago(HOUR),
		});
		const active = buildConversationTree([archivedParent, fork], {
			includeArchived: false,
		});
		expect(active.map((node) => node.row.id)).toEqual([2]);
		expect(active[0]!.children).toEqual([]);
		// With archives included the parent is back and the fork re-nests.
		const full = buildConversationTree([archivedParent, fork], {
			includeArchived: true,
		});
		expect(full.map((node) => node.row.id)).toEqual([1]);
		expect(full[0]!.children.map((child) => child.row.id)).toEqual([2]);
	});

	it("sorts roots pinned-first, then newest-first, ties by id desc, never-used last", () => {
		const tree = buildConversationTree(
			[
				row({ id: 1, name: "Pinned ancient", pinned: true, lastActivityAt: ago(30 * DAY) }),
				row({ id: 2, name: "Fresh", lastActivityAt: ago(HOUR) }),
				row({ id: 3, name: "Also fresh", lastActivityAt: ago(HOUR) }),
				row({ id: 4, name: "Never used" }),
			],
			{ includeArchived: false },
		);
		expect(tree.map((node) => node.row.id)).toEqual([1, 3, 2, 4]);
	});

	it("sorts siblings newest-first with id-desc ties", () => {
		const tree = buildConversationTree(
			[
				row({ id: 1, name: "Parent", lastActivityAt: ago(10 * DAY) }),
				row({ id: 2, name: "Older fork", parent: { id: 1 }, lastActivityAt: ago(3 * DAY) }),
				row({ id: 3, name: "Newer fork", parent: { id: 1 }, lastActivityAt: ago(2 * DAY) }),
				row({ id: 5, name: "Tied fork", parent: { id: 1 }, lastActivityAt: ago(2 * DAY) }),
			],
			{ includeArchived: false },
		);
		expect(tree[0]!.children.map((child) => child.row.id)).toEqual([5, 3, 2]);
	});
});

describe("ageGroup", () => {
	it("uses local calendar days (Pinned beats everything)", () => {
		expect(ageGroup(leaf({ id: 1, name: "Pinned old", pinned: true, lastActivityAt: ago(30 * DAY) }), NOW)).toBe("Pinned");
		expect(ageGroup(leaf({ id: 2, name: "Today", lastActivityAt: ago(30 * MINUTE) }), NOW)).toBe("Today");
		expect(ageGroup(leaf({ id: 3, name: "Yesterday", lastActivityAt: ago(18 * HOUR) }), NOW)).toBe("Yesterday");
		expect(ageGroup(leaf({ id: 4, name: "Earlier", lastActivityAt: ago(30 * DAY) }), NOW)).toBe("Earlier");
		expect(ageGroup(leaf({ id: 5, name: "Never used" }), NOW)).toBe("Earlier");
	});
});

describe("formatAge", () => {
	it("renders the relative-time table against a fixed now", () => {
		expect(formatAge(undefined, NOW)).toBe("");
		expect(formatAge(ago(30 * SECOND), NOW)).toBe("now");
		expect(formatAge(ago(5 * MINUTE), NOW)).toBe("5m");
		expect(formatAge(ago(3 * HOUR), NOW)).toBe("3h");
		expect(formatAge(ago(2 * DAY), NOW)).toBe("2d");
		expect(formatAge(ago(8 * DAY), NOW)).toBe("Oct 9");
	});
});

describe("displayName", () => {
	it("flattens a long multi-line name to a single line", () => {
		const long = "release-notes".repeat(16); // 208 chars
		const shown = displayName(
			row({ id: 9, name: `${long}\r\nsecond line\r` }),
		);
		expect(shown).not.toMatch(/[\r\n]/);
		expect(shown.startsWith("release-notes")).toBe(true);
		expect(shown.endsWith("second line")).toBe(true);
	});

	it("falls back to New conversation", () => {
		expect(displayName(row({ id: 10 }))).toBe("New conversation");
		expect(displayName(row({ id: 11, name: "  \n " }))).toBe(
			"New conversation",
		);
	});
});
