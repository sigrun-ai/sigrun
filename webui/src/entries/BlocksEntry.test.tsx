/**
 * BlocksEntry (U5 Task 4): the inline chat-block surface + the note row.
 *
 * The surface renders pinned to the COMPACT width class (the chat column
 * keeps its compact fallbacks even in a 60-rem window) — a lanes
 * collection in a wide container must render its single-lane compact
 * fallback, never the side-by-side layout. A `read` viewer sees no drag
 * handles (the collection gates its affordances on the load's access).
 * The note row is a collapsed disclosure that expands to the note text.
 *
 * Transports are stubs (the component's seam is the context's attach);
 * the wire itself is chatTransport.ts's subject.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { describe, expect, test, vi } from "vitest";
import type { SurfaceLoad, SurfaceTransport } from "@sigrun/shared/blocks";
import { renderAsync, textContent } from "../test-utils";
import { BlocksEntry, NoteEntry, blocksEntryData } from "./BlocksEntry";
import { ChatTransportContext } from "./chatTransportContext";

/** A grid board (the rem-derived compact fallback's proving tree — a
 *  minItemWidth "s" grid must collapse to ONE column under the chat
 *  pin, never auto-fill into two columns inside the 720px column). */
const GRID_TREE = {
	v: 1,
	root: {
		type: "collection",
		id: "gallery",
		items: { $: "/cards" },
		display: "grid",
		item: { title: { $: "./title" } },
	},
};

/** A two-lane ranking board (the compact fallback's proving tree). */
const LANES_TREE = {
	v: 1,
	root: {
		type: "collection",
		id: "board",
		items: { $: "/cards" },
		display: "lanes",
		groupBy: "status",
		onMove: "moveCard",
		item: { title: { $: "./title" } },
	},
};

const LANES_DATA = {
	cards: [
		{ id: "c1", title: "Clair de Lune", status: "todo" },
		{ id: "c2", title: "Gymnopédie", status: "doing" },
	],
};

function stubLoad(access: SurfaceLoad["access"]): SurfaceLoad {
	return {
		tree: LANES_TREE as unknown as SurfaceLoad["tree"],
		data: LANES_DATA,
		rev: 1,
		treeRev: 0,
		access,
	};
}

/** A stub transport serving the lanes board; `changed` fires onChanged. */
function stubTransport(access: SurfaceLoad["access"]): {
	readonly transport: SurfaceTransport;
	readonly changed: () => void;
} {
	let listener: (() => void) | undefined;
	const transport = {
		load: vi.fn(async () => stubLoad(access)),
		fetchData: vi.fn(async () => ({
			rev: 1,
			treeRev: 0,
			data: LANES_DATA,
		})),
		act: vi.fn(async () => ({ ok: true as const, rev: 1 })),
		upload: vi.fn(),
		image: vi.fn(),
		onChanged: vi.fn((next: () => void) => {
			listener = next;
			return () => {};
		}),
	} as unknown as SurfaceTransport;
	return {
		transport,
		changed: () => {
			listener?.();
		},
	};
}

/** Render a BlocksEntry under a stub-attach provider. */
async function renderBlocksEntry(
	access: SurfaceLoad["access"],
): Promise<Awaited<ReturnType<typeof renderAsync>>> {
	const { transport } = stubTransport(access);
	const attach = vi.fn(() => transport);
	return await renderAsync(
		h(
			ChatTransportContext.Provider,
			{ value: attach },
			h(BlocksEntry, {
				conversationId: 1,
				entryId: 7,
				data: { title: "Ranking", tree: LANES_TREE, data: LANES_DATA },
			}),
		),
	);
}

describe("BlocksEntry", () => {
	test("renders the block's title and the surface inline", async () => {
		const renderer = await renderBlocksEntry("write");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Ranking");
		// The compact lanes fallback shows ONE lane plus a switcher (the
		// selected lane's items); the todo lane's card is not visible until
		// the switcher selects it — assert the shown lane's card.
		expect(text).toContain("Gymnopédie");
		renderer.unmount();
	});

	test("renders pinned to the compact width class even when the container is wide", async () => {
		// The compact fallback's marker: a lanes collection in a compact
		// container renders data-layout="single" (the lane switcher),
		// never the side-by-side layout a regular/wide container draws.
		const renderer = await renderBlocksEntry("write");
		const lanes = renderer.root.findAll(
			(node) =>
				typeof node.props["data-layout"] === "string" &&
				node.props["data-layout"] !== "",
		);
		expect(lanes.length).toBeGreaterThan(0);
		for (const lane of lanes) {
			expect(lane.props["data-layout"]).toBe("single");
		}
		renderer.unmount();
	});

	test("a read viewer sees the surface with no drag handles", async () => {
		const renderer = await renderBlocksEntry("read");
		// The collection's move affordance keys the item rows'
		// `data-drag-item` attribute (drag.ts's hit-test hook); a read
		// viewer never gets one (spec §6.5: read sees, never drags).
		expect(
			renderer.root.findAll(
				(node) => typeof node.props["data-drag-item"] === "string",
			),
		).toEqual([]);
		renderer.unmount();
	});

	test("a write viewer gets the drag affordance", async () => {
		const renderer = await renderBlocksEntry("write");
		expect(
			renderer.root.findAll(
				(node) => typeof node.props["data-drag-item"] === "string",
			).length,
		).toBeGreaterThan(0);
		renderer.unmount();
	});

	test("the compact pin forces a grid to one column (rem-derived fallback)", async () => {
		// §12.3: at compact a wrap grid renders ONE column. The pin must
		// carry a compact REM (not null) — null falls back to auto-fill
		// and a minItemWidth "s" grid would render two columns inside the
		// 720px chat column.
		const { transport } = stubTransport("read");
		transport.load = async () => ({
			tree: GRID_TREE as unknown as SurfaceLoad["tree"],
			data: LANES_DATA,
			rev: 1,
			treeRev: 0,
			access: "read",
		});
		const renderer = await renderAsync(
			h(
				ChatTransportContext.Provider,
				{ value: () => transport },
				h(BlocksEntry, {
					conversationId: 1,
					entryId: 7,
					data: { title: "Gallery", tree: GRID_TREE, data: LANES_DATA },
				}),
			),
		);
		const grid = renderer.root.findByProps({ className: "blk-grid-items" });
		expect(
			(grid.props.style as { gridTemplateColumns?: string })
				.gridTemplateColumns,
		).toBe("1fr");
		renderer.unmount();
	});

	test("a rejected action surfaces its message as a toast row", async () => {
		// useSurface collects a rejection into toasts; the chat BlocksEntry
		// renders them inline (the chat column has no other notice surface).
		// The dispatch rides a card's action button (the tree's own
		// affordance — content.tsx dispatches its click).
		const CALLOUT_TREE = {
			v: 1,
			root: {
				type: "callout",
				id: "c",
				title: "Card",
				actions: [
					{
						id: "submit",
						label: "Submit",
						action: { type: "submit", name: "submitRanking" },
					},
				],
			},
		};
		const { transport } = stubTransport("write");
		transport.load = async () => ({
			tree: CALLOUT_TREE as unknown as SurfaceLoad["tree"],
			data: {},
			rev: 1,
			treeRev: 0,
			access: "write",
		});
		transport.act = async () => ({
			ok: false as const,
			error: { message: "nope from acme" },
		});
		const renderer = await renderAsync(
			h(
				ChatTransportContext.Provider,
				{ value: () => transport },
				h(BlocksEntry, {
					conversationId: 1,
					entryId: 7,
					data: { title: "Ranking", tree: CALLOUT_TREE, data: {} },
				}),
			),
		);
		const button = renderer.root.findByProps({ type: "button" });
		await act(async () => {
			button.props.onClick();
		});
		// The rejection's message renders as the toast row SurfaceView
		// would have shown (chat has no other notice surface).
		const toasts = renderer.root.findAllByProps({
			className: "blk-surface-toast",
		});
		expect(toasts.length).toBeGreaterThan(0);
		expect(textContent(renderer.toJSON())).toContain("nope from acme");
		renderer.unmount();
	});
});

describe("blocksEntryData", () => {
	test("narrows only a blocks-shaped payload", () => {
		expect(blocksEntryData(undefined)).toBeUndefined();
		expect(blocksEntryData({})).toBeUndefined();
		expect(blocksEntryData({ title: 7, tree: {}, data: {} })).toBeUndefined();
		expect(
			blocksEntryData({ title: "T", tree: { v: 1 }, data: {} }),
		).toEqual({ title: "T", tree: { v: 1 }, data: {} });
	});
});

describe("NoteEntry", () => {
	test("renders collapsed with the disclosure summary; the text rides the details body", async () => {
		const renderer = await renderAsync(
			h(NoteEntry, { entryId: 9, text: "• Ranking (alice): moved c2" }),
		);
		const root = renderer.root.findByProps({ className: "entry-note" });
		// A native <details> starts CLOSED (no `open` prop): the summary is
		// the row; the text sits in the body the disclosure reveals.
		expect(root.props.open === undefined || root.props.open === false).toBe(
			true,
		);
		expect(root.findByProps({ className: "entry-note-summary" })).toBeDefined();
		expect(textContent(renderer.toJSON())).toContain(
			"UI changes sent to the agent",
		);
		expect(textContent(renderer.toJSON())).toContain(
			"• Ranking (alice): moved c2",
		);
		renderer.unmount();
	});
});
