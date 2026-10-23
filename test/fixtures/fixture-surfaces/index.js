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
 *
 * Task 2 test seam: the fixture models an extension that keeps its own
 * per-user grant table (spec §6.5 — the extension does its own
 * accessOf) in a module-level map. The loader imports THIS module by
 * the same file URL the test imports, so mutations are visible to the
 * loaded extension — that is the whole seam. `calls`/`contexts` record
 * every render/data invocation the way a real extension's own logging
 * would; tests read them to pin the server's call discipline (every
 * data fetch calls data(), params order does not change the key).
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

/** The stats panel's data. */
const statsData = { open: 1, done: 1 };

/**
 * The per-user grant table (the test seam): username → access level for
 * BOTH surfaces. Absent user falls back to the surface's default below.
 */
export const accessOverrides = new Map();

/**
 * Per-surface invocation counters: `calls.render[id]` / `calls.data[id]`.
 */
export const calls = { render: {}, data: {} };

/**
 * One record per render/data invocation: which surface, which principal,
 * which params, and the instance KEY the server computed (spec §7.3).
 */
export const contexts = [];

/** Reset the seam state (tests call this in beforeEach). */
export function resetSurfaceFixture() {
	accessOverrides.clear();
	calls.render = {};
	calls.data = {};
	contexts.length = 0;
}

/** The fixture's own access resolution (its "accessOf"): table, else default. */
function accessOf(principal, fallback) {
	const user = principal === undefined ? undefined : principal.user;
	return accessOverrides.get(user) ?? fallback;
}

/** Record one invocation on the seam. */
function record(kind, id, ctx) {
	calls[kind][id] = (calls[kind][id] ?? 0) + 1;
	contexts.push({
		kind,
		id,
		user: ctx.principal === undefined ? undefined : ctx.principal.user,
		params: ctx.params,
		key: ctx.key,
	});
}

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
					render: async (ctx) => {
						record("render", "board", ctx);
						return {
							tree: boardTree,
							data: boardData,
							access: accessOf(ctx.principal, "write"),
						};
					},
					data: async (ctx) => {
						record("data", "board", ctx);
						return { data: boardData, access: accessOf(ctx.principal, "write") };
					},
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
					render: async (ctx) => {
						record("render", "stats", ctx);
						return {
							tree: statsTree,
							data: statsData,
							access: accessOf(ctx.principal, "read"),
						};
					},
					data: async (ctx) => {
						record("data", "stats", ctx);
						return { data: statsData, access: accessOf(ctx.principal, "read") };
					},
				},
			],
		},
	};
}
