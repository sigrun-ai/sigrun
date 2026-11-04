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

import { bind, card, collection, markdown, page, stack, stat, tree } from "@sigrun/sigrun/blocks";

/** The mutable shared board (the e2e drives the `move` action). */
const board = {
	cards: [
		{ id: "c1", title: "First card", status: "todo" },
		{ id: "c2", title: "Second card", status: "doing" },
	],
};

/** Users who load READ-ONLY (no drag handles) — the e2e's bob context. */
export const readOnlyUsers = new Set();

/** Per-conversation bump counters for the `convo` panel (todo Task 3). */
const convoBumps = new Map();

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

/** The convo panel's line: `conversation <id> bump <n>` (params-bound),
 *  or `no conversation` when the params carry no id. */
function convoLine(params) {
	const id =
		params !== null &&
		typeof params === "object" &&
		typeof params.conversationId === "number"
			? params.conversationId
			: undefined;
	if (id === undefined) return "no conversation";
	return `conversation ${id} bump ${convoBumps.get(id) ?? 0}`;
}

/** The convo tree: a `page` whose `main` is one markdown block bound to
 *  the data document's `/line` (todo Task 3; no `instanceKey` — the
 *  webui routes live updates by canonicalJson(params)). */
function convoTreeFor(params) {
	return tree(
		page({
			id: "convo",
			title: "Convo",
			main: [markdown({ text: bind("/line") })],
		}),
	);
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
				{
					// todo Task 3: a per-conversation panel. NO `instanceKey`
					// (the default canonicalJson(params) keys each conversation's
					// instance, and the webui routes live updates by the same
					// canonical params).
					id: "convo",
					title: "Convo",
					icon: "list",
					placement: "panel",
					perConversation: true,
					render: async (ctx) => ({
						tree: convoTreeFor(ctx.params),
						data: { line: convoLine(ctx.params) },
						access: accessOf(ctx.principal, "read"),
					}),
					data: async (ctx) => ({
						data: { line: convoLine(ctx.params) },
						access: accessOf(ctx.principal, "read"),
					}),
				},
			],
		},
		routes: [
			{
				// Bump one conversation's counter and publish that instance's
				// change (the params-keyed routing delivers it to the open
				// panel watching that conversation).
				method: "POST",
				path: "bump",
				auth: "user",
				handler: async (request) => {
					const body = await request.json();
					const conversationId = body?.conversationId;
					if (typeof conversationId !== "number") {
						return Response.json(
							{ error: "conversationId must be a number" },
							{ status: 400 },
						);
					}
					const next = (convoBumps.get(conversationId) ?? 0) + 1;
					convoBumps.set(conversationId, next);
					host.surfaces.changed(
						"convo",
						JSON.stringify({ conversationId }),
					);
					return Response.json({ conversationId, bump: next });
				},
			},
		],
	};
}

/** Reset the board (tests call in beforeEach). */
export function resetBoard() {
	board.cards = [
		{ id: "c1", title: "First card", status: "todo" },
		{ id: "c2", title: "Second card", status: "doing" },
	];
	readOnlyUsers.clear();
	convoBumps.clear();
}
