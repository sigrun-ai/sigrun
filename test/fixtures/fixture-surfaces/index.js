/**
 * Test-fixture extension package (UI-blocks U3 Task 1): declares the
 * surfaces the runtime tasks consume — a view `board` (lanes + move
 * handler) and a panel `stats` (a refreshMs dashboard with `data()`).
 *
 * Trees are built with the host's own builders through
 * `@sigrun/sigrun/blocks` (spec §14.1) — this fixture has NO package.json
 * of its own, so the bare specifier resolves through the repo root's
 * self-reference into `dist/blocks` (the running server's copy; the
 * packages-dir host-link shape is covered by fixture-blocks-ext).
 */

import {
	bind,
	card,
	collection,
	markdown,
	page,
	stack,
	stat,
	tree,
} from "@sigrun/sigrun/blocks";

/** The lanes board: three groups, reorderable across lanes (§5.5). */
const boardTree = tree(
	page({
		id: "board",
		title: "Acme board",
		main: [
			collection({
				id: "cards",
				items: bind("/cards"),
				display: "lanes",
				groupBy: "status",
				groups: [
					{ id: "todo", title: "To do" },
					{ id: "doing", title: "In progress" },
					{ id: "done", title: "Done" },
				],
				reorder: { within: true, across: true },
				onMove: "move",
				item: card({ title: bind("./title") }),
			}),
		],
	}),
);

/** The stats panel: a refreshMs dashboard (data() refetches while visible). */
const statsTree = tree(
	page({
		id: "stats",
		title: "Acme stats",
		main: [
			stack({
				id: "stats-stack",
				children: [
					stat({ id: "open", label: "Open", value: bind("/open") }),
					stat({ id: "done", label: "Done", value: bind("/done") }),
					markdown({ id: "note", text: "acme panel body" }),
				],
			}),
		],
	}),
);

/** The board's shared data (acme literals only — tests own their values). */
const boardData = {
	cards: [
		{ id: "c1", title: "First", status: "todo" },
		{ id: "c2", title: "Second", status: "doing" },
	],
};

export default function createFixtureSurfaces() {
	return {
		extension: {
			name: "fixture-surfaces",
			hooks: [],
			tools: [],
			sections: [],
		},
		surfaces: {
			views: [
				{
					id: "board",
					title: "Acme board",
					icon: "board",
					placement: "view",
					sharedData: true,
					render: async () => ({
						tree: boardTree,
						data: boardData,
						access: "write",
					}),
					data: async () => ({ data: boardData, access: "write" }),
					actions: {
						move: async () => ({ ok: true, update: { ops: [] } }),
					},
				},
			],
			panels: [
				{
					id: "stats",
					title: "Acme stats",
					icon: "chart",
					placement: "panel",
					refreshMs: 60000,
					render: async () => ({
						tree: statsTree,
						data: { open: 1, done: 1 },
						access: "read",
					}),
					data: async () => ({ data: { open: 1, done: 1 }, access: "read" }),
				},
			],
		},
	};
}
