/**
 * The restyled sidebar (task C2): rows come from B1's
 * `buildConversationTree` (fork children indent two spaces + `↳ `),
 * names render single-line via `displayName` + `truncateToWidth`, ages
 * right-align via `formatAge`, the active row highlights accent+bold, and
 * `+ New conversation` stays the last row. Keyboard drives it without a
 * mouse: `cursor` / `moveCursor` / `confirm()` (the C3 action layer's
 * seam); a row click selects it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Sidebar } from "../src/ui/sidebar.js";
import type {
	ConversationList,
	ConversationSummary,
	SigrunClient,
} from "../src/api.js";

function summary(
	id: number,
	init?: {
		name?: string;
		archived?: boolean;
		parent?: number;
		lastActivityAt?: string;
	},
): ConversationSummary {
	return {
		id,
		root: false,
		archived: init?.archived ?? false,
		pinned: false,
		access: "write",
		...(init?.name === undefined ? {} : { name: init.name }),
		...(init?.parent === undefined
			? {}
			: { parent: { id: init.parent, at: 1 } }),
		// Default activity stamp: distinct per id so tree ordering is
		// deterministic (recency first, id tie-break never reached).
		...(init?.lastActivityAt === undefined
			? { lastActivityAt: new Date(2026, 0, 1, 0, 0, id).toISOString() }
			: { lastActivityAt: init.lastActivityAt }),
	};
}

function stubClient(rows: ConversationSummary[]): SigrunClient {
	return {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({ conversations: rows });
		},
	} as unknown as SigrunClient;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Sidebar (C2 tree rows)", () => {
	test("a fork renders ↳ indented under its parent", async () => {
		const sidebar = new Sidebar(
			stubClient([
				summary(1, { name: "main line" }),
				summary(2, { name: "experiment", parent: 1 }),
			]),
		);
		await sidebar.refresh();
		const lines = sidebar.render(40);
		const parent = lines.findIndex((line) => line.includes("main line"));
		const child = lines.findIndex((line) => line.includes("↳ "));
		expect(parent).toBeGreaterThanOrEqual(0);
		expect(child).toBe(parent + 1);
		expect(lines[child]).toContain("  ↳ experiment");
	});

	test("a 200-char name renders on one line within the sidebar width", async () => {
		const long = "acme-".repeat(40); // 200 chars
		const sidebar = new Sidebar(stubClient([summary(1, { name: long })]));
		await sidebar.refresh();
		const lines = sidebar.render(28);
		const row = lines.find((line) => line.includes("acme-"));
		expect(row).toBeDefined();
		expect(visibleWidth(row!)).toBeLessThanOrEqual(28);
		// One line only: no second line carries the name's tail.
		expect(lines.filter((line) => line.includes("acme-"))).toHaveLength(1);
	});

	test("moveCursor + confirm selects the next row via onSelect", async () => {
		const sidebar = new Sidebar(
			stubClient([
				summary(1, { name: "one", lastActivityAt: "2026-10-17T11:00:00Z" }),
				summary(2, { name: "two", lastActivityAt: "2026-10-17T10:00:00Z" }),
			]),
		);
		await sidebar.refresh();
		const selections: (number | "new")[] = [];
		sidebar.onSelect = (selection) => selections.push(selection);
		expect(sidebar.cursor).toBe(0);
		sidebar.moveCursor(1);
		expect(sidebar.cursor).toBe(1);
		sidebar.confirm();
		expect(selections).toEqual([2]);
	});

	test("the + New conversation row is last and selects 'new'", async () => {
		const sidebar = new Sidebar(stubClient([summary(1, { name: "one" })]));
		await sidebar.refresh();
		const lines = sidebar.render(40);
		expect(lines[lines.length - 1]).toContain("+ New conversation");
		const selections: (number | "new")[] = [];
		sidebar.onSelect = (selection) => selections.push(selection);
		sidebar.moveCursor(1); // past the single conversation row
		sidebar.confirm();
		expect(selections).toEqual(["new"]);
	});

	test("ages render right-aligned from lastActivityAt", async () => {
		const sidebar = new Sidebar(
			stubClient([
				summary(1, {
					name: "old chat",
					lastActivityAt: "2026-10-17T09:00:00Z",
				}),
			]),
		);
		await sidebar.refresh();
		const row = sidebar.render(40).find((line) => line.includes("old chat"));
		expect(row?.trimEnd().endsWith("3h")).toBe(true);
	});

	test("setActive highlights the active row (accent fg + bold)", async () => {
		const sidebar = new Sidebar(
			stubClient([summary(1, { name: "one" }), summary(2, { name: "two" })]),
		);
		await sidebar.refresh();
		sidebar.setActive(2);
		const row = sidebar.render(40).find((line) => line.includes("two"));
		// Plain theme is the identity, so assert the marker structure: the
		// active row is the one flagged in the public rows.
		expect(sidebar.rows.find((r) => r.id === 2)?.active).toBe(true);
		expect(row).toBeDefined();
	});

	test("archived rows stay hidden; refresh preserves the cursor's conversation", async () => {
		const sidebar = new Sidebar(
			stubClient([
				summary(1, { name: "one", lastActivityAt: "2026-10-17T11:00:00Z" }),
				summary(2, { name: "two", archived: true }),
				summary(3, { name: "three", lastActivityAt: "2026-10-17T10:00:00Z" }),
			]),
		);
		await sidebar.refresh();
		expect(sidebar.rows.map((row) => row.id)).toEqual([1, 3]);
		sidebar.moveCursor(1); // → id 3
		await sidebar.refresh();
		expect(sidebar.cursor).toBe(1);
		expect(sidebar.rows[sidebar.cursor]?.id).toBe(3);
	});
});
