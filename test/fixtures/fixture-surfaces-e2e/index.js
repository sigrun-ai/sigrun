/**
 * The two-browser e2e fixture extension (UI-blocks U3 Task 5): a SHARED
 * board (`sharedData: true`, a mutable lane map the move handler edits)
 * and a stats panel. Alice's drag (the `move` action) mutates the shared
 * data and calls `host.surfaces.changed` — Bob's context must see the
 * card in the new lane within the e2e's 2 s budget (the surface.changed
 * → since-fetch round trip).
 *
 * `readOnly` users (the access override below) load with access "read" —
 * the e2e asserts their render carries no drag affordance.
 */

import { bind, card, collection, page, stack, stat, tree } from "@sigrun/sigrun/blocks";

/** The mutable shared board (the e2e drives the `move` action). */
const board = {
	cards: [
		{ id: "c1", title: "First card", status: "todo" },
		{ id: "c2", title: "Second card", status: "doing" },
	],
};

/** Users who load READ-ONLY (no drag handles) — the e2e's bob context. */
export const readOnlyUsers = new Set();

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

const statsTree = tree(
	page({
		id: "stats",
		title: "Acme stats",
		main: [
			stack({
				id: "stats-stack",
				children: [stat({ id: "open", label: "Open", value: bind("/open") })],
			}),
		],
	}),
);

function accessOf(principal, fallback) {
	const user = principal === undefined ? undefined : principal.user;
	return readOnlyUsers.has(user) ? "read" : fallback;
}

export default function createFixtureSurfacesE2E(host) {
	return {
		extension: {
			name: "fixture-surfaces-e2e",
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
					render: async (ctx) => ({
						tree: boardTree,
						data: { cards: board.cards.map((card_) => ({ ...card_ })) },
						access: accessOf(ctx.principal, "write"),
					}),
					data: async (ctx) => ({
						data: { cards: board.cards.map((card_) => ({ ...card_ })) },
						access: accessOf(ctx.principal, "write"),
					}),
					actions: {
						move: async (ctx, payload) => {
							const item = board.cards.find(
								(card_) => card_.id === payload.itemId,
							);
							if (item !== undefined && typeof payload.to?.group === "string") {
								item.status = payload.to.group ?? item.status;
							}
							host.surfaces.changed("board", ctx.key);
							return { ok: true };
						},
					},
				},
			],
			panels: [
				{
					id: "stats",
					title: "Acme stats",
					icon: "chart",
					placement: "panel",
					render: async () => ({
						tree: statsTree,
						data: { open: board.cards.length },
						access: "read",
					}),
					data: async () => ({ data: { open: board.cards.length }, access: "read" }),
				},
			],
		},
	};
}

/** Reset the board (tests call in beforeEach). */
export function resetBoard() {
	board.cards = [
		{ id: "c1", title: "First card", status: "todo" },
		{ id: "c2", title: "Second card", status: "doing" },
	];
	readOnlyUsers.clear();
}
