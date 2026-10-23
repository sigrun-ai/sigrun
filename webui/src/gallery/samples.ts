/**
 * The Blocks gallery samples (UI-blocks U1 Task 6): the U0 fixture corpus
 * (`test/fixtures/blocks/*.json`) imported into the BUNDLE through Vite's
 * `import.meta.glob` with eager loading (the cross-package path works from
 * `webui/src` — the vitest suites import the same files via relative path).
 * Each sample carries literal sample data for its bindings so the gallery
 * pages render real content.
 *
 * The `form-view` sample pairs with a sibling markdown block bound to
 * `/view/...` (the Task-5 setView sibling-render seam, now visible in a
 * browser): the pair is composed here into one page tree.
 */

import type { JsonObject, JsonValue, Tree } from "@sigrun/shared/blocks";

/** Every fixture file, parsed, keyed by file name (eager glob). */
const FIXTURES = import.meta.glob("../../../test/fixtures/blocks/*.json", {
	eager: true,
	import: "default",
}) as Record<string, Tree>;

export interface GallerySample {
	/** The fixture name (path segment, no extension). */
	readonly name: string;
	readonly tree: Tree;
	/** The data the tree's bindings resolve against. */
	readonly data: JsonObject;
}

/** Sample cards for the collection displays (tests own their literals:
 *  acme/ names, example.invalid hosts). */
const CARDS: JsonObject[] = [
	{
		id: "card-1",
		title: "acme provision",
		state: "todo",
		done: false,
		eyebrow: "acme/queue",
		subtitle: "spin the example.invalid runner",
		body: "clone the repo, mount the volume",
		badge: "queue",
		when: "today",
		user: "u1",
		userName: "acme ops",
		at: "2026-10-19T09:00:00Z",
		score: 3,
		quiet: false,
		busy: false,
		deps: [],
		tone: "info",
		subtasks: [],
	},
	{
		id: "card-2",
		title: "acme build",
		done: true,
		eyebrow: "acme/ci",
		subtitle: "build the release",
		body: "vite build && vitest",
		badge: "ci",
		when: "yesterday",
		user: "acme-ops",
		userName: "acme ops",
		at: "2026-10-18T17:00:00Z",
		score: 9,
		state: "doing",
		quiet: true,
		busy: false,
		deps: ["card-1"],
		tone: "good",
		subtasks: [],
	},
	{
		id: "card-3",
		title: "acme deploy",
		done: false,
		eyebrow: "acme/cd",
		subtitle: "ship to example.invalid",
		body: "helm upgrade",
		badge: "cd",
		when: "tomorrow",
		user: "acme-cd",
		userName: "acme deploy",
		at: "2026-10-20T12:00:00Z",
		score: 5,
		state: "doing",
		quiet: false,
		busy: true,
		deps: ["card-2"],
		tone: "warn",
		subtasks: [
			{
				id: "card-3a",
				title: "acme smoke",
				done: false,
				state: "todo",
				subtasks: [],
			},
		],
	},
];

/** Per-fixture binding data; fixtures not listed render against the
 *  defaults (cards, title, nav, plus an empty object). */
function dataFor(name: string): JsonObject {
	const base: JsonObject = {
		// The gallery's sample cards carry loose keys per fixture (each
		// collection display reads its own subset).
		cards: CARDS,
		title: "acme board",
		nav: [
			{
				id: "n1",
				label: "Board",
				icon: "folder",
				children: [{ id: "n1a", label: "Active" }],
			},
			{ id: "n2", label: "Archive", hasChildren: false },
		],
		filter: { state: "open" },
	};
	if (name === "collection-calendar") {
		return {
			...base,
			cards: [
				{
					id: "ev-1",
					title: "acme sync",
					start: "2026-10-19T10:00:00Z",
					end: "2026-10-19T11:00:00Z",
				},
				{
					id: "ev-2",
					title: "acme review",
					start: "2026-10-21T14:00:00Z",
					end: "2026-10-21T15:30:00Z",
				},
			],
		};
	}
	return base;
}

/** The gallery's sample list (every fixture; `form-view` gains its
 *  sibling markdown bound to `/view/filter/state`). */
export const GALLERY_SAMPLES: readonly GallerySample[] = Object.keys(FIXTURES)
	.filter((path) => path.endsWith(".json"))
	.map((path) => {
		const name = path.slice(
			path.lastIndexOf("/") + 1,
			path.length - ".json".length,
		);
		const tree = FIXTURES[path] as Tree;
		if (name === "form-view") {
			// The Task-5 setView seam, visible: the live form publishes to
			// the view branch; the sibling markdown reads it back.
			const paired: Tree = {
				v: 1,
				root: {
					type: "stack",
					children: [
						tree.root,
						{
							type: "markdown",
							text: "filter.state = `{$}` bound to `/view/filter/state`:" as never,
						},
						{ type: "markdown", text: { $: "/view/filter/state" } },
					],
				},
			};
			return { name, tree: paired, data: dataFor(name) };
		}
		return { name, tree, data: dataFor(name) };
	})
	.sort((a, b) => a.name.localeCompare(b.name));
