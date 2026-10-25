/**
 * U5 Task 2 — change-record summaries (spec §8.3): core writes each
 * record's `summary` from the TREE, "using labels the user saw" — the
 * item's `title` slot value, 1-based positions, the group's (or the
 * enclosing section's) title, and the form field's `label`.
 *
 * Pure unit tests over `summarizeAction` (the pinned interface): the
 * exact strings the spec and the worked example name —
 * "moved 'Clair de Lune' from 4th to 1st in 'Ranking'",
 * "checked 'milk' in 'Shopping'", "set 'Notes' to '…'" — plus the
 * ordinal forms (1st/2nd/3rd, 11th/12th/13th, 21st) and the 80-char
 * value truncation.
 */

import { describe, expect, test } from "vitest";
import type { Action, JsonObject, Tree } from "@sigrun/shared/blocks";
import {
	SUMMARY_VALUE_MAX,
	summarizeAction,
} from "../src/server/blocks/summaries.js";

// ---------------------------------------------------------------------------
// Fixtures (the §8.5 shapes; synthetic literals only)
// ---------------------------------------------------------------------------

/** A reorderable ranking list inside a section titled "Ranking". */
const RANKING_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Ranking",
		children: [
			{
				type: "collection",
				id: "ranking",
				items: { $: "/cards" },
				display: "list",
				numbered: true,
				reorder: { within: true },
				onMove: "reorderCards",
				item: { title: { $: "./title" } },
			},
		],
	},
};

/** Four cards; Clair de Lune sits 4th. */
const RANKING_DATA: JsonObject = {
	cards: [
		{ id: "c1", title: "Arabesque" },
		{ id: "c2", title: "Gymnopédie" },
		{ id: "c3", title: "Reflets" },
		{ id: "c4", title: "Clair de Lune" },
	],
};

/** A checkable shopping list inside a section titled "Shopping". */
const SHOPPING_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Shopping",
		children: [
			{
				type: "collection",
				id: "shopping",
				items: { $: "/items" },
				display: "list",
				checkable: "bought",
				onCheck: "toggleBought",
				item: { title: { $: "./name" } },
			},
		],
	},
};

const SHOPPING_DATA: JsonObject = {
	items: [
		{ id: "m1", name: "milk", bought: false },
		{ id: "m2", name: "bread", bought: true },
	],
};

/** A grouped (lanes) task board with `groupBy` + declared groups. */
const LANES_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Chores",
		children: [
			{
				type: "collection",
				id: "tasks",
				items: { $: "/tasks" },
				display: "lanes",
				groupBy: "status",
				groups: [
					{ id: "todo", title: "To do" },
					{ id: "done", title: "Done" },
				],
				reorder: { within: true, across: true },
				onMove: "moveTask",
				item: { title: { $: "./title" } },
			},
		],
	},
};

const LANES_DATA: JsonObject = {
	tasks: [
		{ id: "t1", title: "Write spec", status: "todo" },
		{ id: "t2", title: "Ship it", status: "todo" },
		{ id: "d1", title: "Review", status: "done" },
	],
};

/**
 * NON-CONTIGUOUS lanes (the grouped-position test's stricter twin):
 * the todo lane's rows do NOT sit at the array head, so an absolute
 * `findIndex` position differs from the within-lane one ("3rd" vs the
 * "2nd" the user saw).
 */
const LANES_DATA_NONCONTIGUOUS: JsonObject = {
	tasks: [
		{ id: "d1", title: "Review", status: "done" },
		{ id: "t1", title: "Write spec", status: "todo" },
		{ id: "t2", title: "Ship it", status: "todo" },
	],
};

/** A submit-mode form with a longtext Notes field. */
const FORM_TREE: Tree = {
	v: 1,
	root: {
		type: "form",
		id: "notes-form",
		bind: "/notes",
		mode: "submit",
		onSubmit: "saveNotes",
		turn: false,
		children: [
			{ type: "longtext", name: "Notes", label: "Notes" },
			{ type: "number", name: "Count", label: "Count" },
		],
	},
};

// ---------------------------------------------------------------------------
// The pinned spec strings
// ---------------------------------------------------------------------------

describe("summarizeAction (spec §8.3)", () => {
	test("move: the worked example's exact string — item title, 1-based positions, the section's title", () => {
		const summary = summarizeAction(
			RANKING_TREE,
			RANKING_DATA,
			{ type: "move", name: "reorderCards" },
			{
				itemId: "c4",
				from: { group: "", index: 3 },
				to: { group: "", index: 0 },
			},
		);
		expect(summary).toBe("moved 'Clair de Lune' from 4th to 1st in 'Ranking'");
	});

	test("move: a literal item title (not a binding) is used verbatim", () => {
		const tree: Tree = {
			v: 1,
			root: {
				type: "section",
				title: "Ranking",
				children: [
					{
						type: "collection",
						id: "fixed",
						items: { $: "/cards" },
						display: "list",
						reorder: { within: true },
						onMove: "reorderCards",
						item: { title: "Pinned" },
					},
				],
			},
		};
		const summary = summarizeAction(
			tree,
			RANKING_DATA,
			{ type: "move", name: "reorderCards" },
			{
				itemId: "c1",
				from: { group: "", index: 0 },
				to: { group: "", index: 1 },
			},
		);
		expect(summary).toBe("moved 'Pinned' from 1st to 2nd in 'Ranking'");
	});

	test("move: grouped positions are within the group, and the label is the group's title", () => {
		// Within one group: Ship it is 2nd in 'To do', dropped at the top.
		const within = summarizeAction(
			LANES_TREE,
			LANES_DATA,
			{ type: "move", name: "moveTask" },
			{
				itemId: "t2",
				from: { group: "todo", index: 1 },
				to: { group: "todo", index: 0 },
			},
		);
		expect(within).toBe("moved 'Ship it' from 2nd to 1st in 'To do'");
		// Cross-group: Write spec leaves 'To do' for the top of 'Done'.
		const across = summarizeAction(
			LANES_TREE,
			LANES_DATA,
			{ type: "move", name: "moveTask" },
			{
				itemId: "t1",
				from: { group: "todo", index: 0 },
				to: { group: "done", index: 0 },
			},
		);
		expect(across).toBe("moved 'Write spec' from 1st to 1st in 'Done'");
	});

	test("move: grouped positions are within the group even when the lane's rows are not at the array head", () => {
		// The done row leads the bound array, so Ship it's ABSOLUTE index
		// is 2 ("3rd") while its within-'To do' position — what the user
		// saw in the lane — is 2nd. The summary must name the lane one.
		const summary = summarizeAction(
			LANES_TREE,
			LANES_DATA_NONCONTIGUOUS,
			{ type: "move", name: "moveTask" },
			{
				itemId: "t2",
				from: { group: "todo", index: 1 },
				to: { group: "todo", index: 0 },
			},
		);
		expect(summary).toBe("moved 'Ship it' from 2nd to 1st in 'To do'");
	});

	test("check: checked/unchecked with the item title and the section's title", () => {
		const checked = summarizeAction(
			SHOPPING_TREE,
			SHOPPING_DATA,
			{ type: "edit", name: "toggleBought" },
			{ itemId: "m1", value: true },
		);
		expect(checked).toBe("checked 'milk' in 'Shopping'");
		const unchecked = summarizeAction(
			SHOPPING_TREE,
			SHOPPING_DATA,
			{ type: "edit", name: "toggleBought" },
			{ itemId: "m2", value: false },
		);
		expect(unchecked).toBe("unchecked 'bread' in 'Shopping'");
	});

	test("check: an omitted value is a toggle-on — 'checked', matching the written true", () => {
		// planAction defaults an omitted `value` to true; the summary
		// verb must agree with the written value (review minor 2).
		const summary = summarizeAction(
			SHOPPING_TREE,
			SHOPPING_DATA,
			{ type: "edit", name: "toggleBought" },
			{ itemId: "m1" },
		);
		expect(summary).toBe("checked 'milk' in 'Shopping'");
	});

	test("move: a bound group title resolves against the surface data (the label the user saw)", () => {
		// The declared group's title is a BINDING: the summary must
		// resolve it against the surface data, not emit the raw group id
		// (review minor 7).
		const tree: Tree = {
			v: 1,
			root: {
				type: "section",
				title: "Board",
				children: [
					{
						type: "collection",
						id: "tasks",
						items: { $: "/tasks" },
						display: "lanes",
						groupBy: "status",
						groups: [
							{ id: "todo", title: { $: "/groupLabels/todo" } },
							{ id: "done", title: { $: "/groupLabels/done" } },
						],
						reorder: { within: true, across: true },
						onMove: "moveTask",
						item: { title: { $: "./title" } },
					},
				],
			},
		};
		const data: JsonObject = {
			tasks: LANES_DATA.tasks,
			groupLabels: { todo: "Not started", done: "Finished" },
		};
		const summary = summarizeAction(
			tree,
			data,
			{ type: "move", name: "moveTask" },
			{
				itemId: "t1",
				from: { group: "todo", index: 0 },
				to: { group: "done", index: 0 },
			},
		);
		expect(summary).toBe("moved 'Write spec' from 1st to 1st in 'Finished'");
	});

	test("check: a bound section title resolves against the surface data", () => {
		// Same fix, on the section scope: a section whose title is a
		// binding resolves to the label the user saw.
		const tree: Tree = {
			v: 1,
			root: {
				type: "section",
				title: { $: "/listName" },
				children: [
					{
						type: "collection",
						id: "shopping",
						items: { $: "/items" },
						display: "list",
						checkable: "bought",
						onCheck: "toggleBought",
						item: { title: { $: "./name" } },
					},
				],
			},
		};
		const data: JsonObject = {
			listName: "Groceries",
			items: SHOPPING_DATA.items,
		};
		const summary = summarizeAction(
			tree,
			data,
			{ type: "edit", name: "toggleBought" },
			{ itemId: "m1", value: true },
		);
		expect(summary).toBe("checked 'milk' in 'Groceries'");
	});

	test("submit: one 'set' per field, in the form's declared order, labels from the field's label", () => {
		const summary = summarizeAction(
			FORM_TREE,
			{},
			{ type: "submit", name: "saveNotes" },
			{ values: { Count: 2, Notes: "first pass" } },
		);
		// Field order (Notes, then Count) — the labels the user saw — not
		// the payload's key order.
		expect(summary).toBe("set 'Notes' to 'first pass'; set 'Count' to '2'");
	});

	test("submit: values over 80 characters are truncated with an ellipsis", () => {
		const long = "y".repeat(SUMMARY_VALUE_MAX + 1);
		const summary = summarizeAction(
			FORM_TREE,
			{},
			{ type: "submit", name: "saveNotes" },
			{ values: { Notes: long } },
		);
		expect(summary).toBe(
			`set 'Notes' to '${"y".repeat(SUMMARY_VALUE_MAX)}…'`,
		);
		// Exactly 80 characters stays whole.
		const exact = "z".repeat(SUMMARY_VALUE_MAX);
		const whole = summarizeAction(
			FORM_TREE,
			{},
			{ type: "submit", name: "saveNotes" },
			{ values: { Notes: exact } },
		);
		expect(whole).toBe(`set 'Notes' to '${exact}'`);
	});

	test("submit: non-string values render as their plain JSON form", () => {
		const summary = summarizeAction(
			FORM_TREE,
			{},
			{ type: "submit", name: "saveNotes" },
			{ values: { Count: 2 } },
		);
		expect(summary).toBe("set 'Count' to '2'");
	});

	test("ordinals: 11th/12th/13th and 21st/22nd/23rd, not 11st/12nd/13rd", () => {
		// A 23-item ungrouped list; move the 11th, 12th, 13th and 21st items.
		const cards: JsonObject[] = [];
		for (let index = 0; index < 23; index++) {
			cards.push({ id: `i${index}`, title: `song ${index}` });
		}
		const data: JsonObject = { cards };
		// Move each item from its actual slot to the front; `from` is the
		// pre-move position the user saw (the payload §6.3 sends).
		const move = (itemId: string, fromIndex: number, toIndex: number): string =>
			summarizeAction(
				RANKING_TREE,
				data,
				{ type: "move", name: "reorderCards" },
				{ itemId, from: { group: "", index: fromIndex }, to: { group: "", index: toIndex } },
			);
		// Item i10 is the 11th; moving it to the front reads from 11th.
		expect(move("i10", 10, 0)).toBe("moved 'song 10' from 11th to 1st in 'Ranking'");
		expect(move("i11", 11, 0)).toBe("moved 'song 11' from 12th to 1st in 'Ranking'");
		expect(move("i12", 12, 0)).toBe("moved 'song 12' from 13th to 1st in 'Ranking'");
		expect(move("i20", 20, 0)).toBe("moved 'song 20' from 21st to 1st in 'Ranking'");
		expect(move("i21", 21, 0)).toBe("moved 'song 21' from 22nd to 1st in 'Ranking'");
		expect(move("i22", 22, 0)).toBe("moved 'song 22' from 23rd to 1st in 'Ranking'");
	});

	test("an action whose name matches nothing in the tree still answers a string", () => {
		const summary = summarizeAction(
			RANKING_TREE,
			RANKING_DATA,
			{ type: "move", name: "nope" },
			{},
		);
		expect(typeof summary).toBe("string");
		expect(summary.length).toBeGreaterThan(0);
	});
});
