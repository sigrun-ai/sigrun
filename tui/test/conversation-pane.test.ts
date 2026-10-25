/**
 * The restyled conversation pane (task C2): turns from B1's `groupTurns`
 * — user turns carry the accent `▎` bar on every line, assistant prose is
 * plain markdown, activity collapses to one dim `▸ Thinking · N tools`
 * line that unfolds into thinking + `✓ tool  preview` rows. Turns are
 * focusable (`›` gutter marker on the focused turn's first line),
 * foldable (`toggleFold`), and carry the copy/id accessors the C3 action
 * layer drives (`textOf`, `entryIdOf`, `lineRangeOf`). `[tool]` /
 * `[thinking]` tags are gone. Structure assertions: rendered-line
 * content, not pixels.
 */

import { describe, expect, test } from "vitest";
import type { SurfaceTransport, Tree } from "@sigrun/shared/blocks";
import { ConversationPane } from "../src/ui/conversation-pane.js";
import type { ConversationViewWire } from "../src/api.js";

function view(id: number, entries: unknown[]): ConversationViewWire {
	return {
		conversation: { id },
		entries,
		docs: {},
		steer: { busy: false, queued: 0 },
	} as unknown as ConversationViewWire;
}

/**
 * The fixture: a user prompt, an assistant turn with thinking + one
 * successful `bash ls /` call, then a second user prompt. Mirrors a
 * root-filesystem inspection run.
 */
function rootFilesystemEntries(): unknown[] {
	return [
		{
			id: 1,
			kind: "pi.user",
			model: [{ role: "user", content: "what is in the root filesystem?" }],
		},
		{
			id: 2,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I should list the directory" },
						{
							type: "toolCall",
							id: "call-1",
							name: "bash",
							arguments: { command: "ls /" },
						},
					],
				},
			],
		},
		{
			id: 3,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "bin  etc  usr" }],
				},
			],
		},
		{
			id: 4,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "The root holds bin, etc and usr." }],
				},
			],
		},
		{
			id: 5,
			kind: "pi.user",
			model: [{ role: "user", content: "thanks" }],
		},
	];
}

describe("ConversationPane (C2 turn rendering)", () => {
	test("turns() groups entries into user + assistant turns", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		const turns = pane.turns();
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"user",
		]);
	});

	test("renders the collapsed activity line; no [tool]/[thinking] tags", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("▸ Thinking · 1 tool");
		expect(lines).not.toContain("[tool]");
		expect(lines).not.toContain("[thinking]");
		// The user prompt renders with the accent bar on every line.
		expect(lines).toContain("▎ what is in the root filesystem?");
		// Assistant prose renders plainly (no bar).
		expect(lines).toContain("The root holds bin, etc and usr.");
	});

	test("toggleFold opens the activity: thinking + ✓ tool rows", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		pane.toggleFold(1);
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("▾ Thinking · 1 tool");
		expect(lines).toContain("I should list the directory");
		expect(lines).toContain("✓ bash  ls /");
		// Folding again collapses back.
		pane.toggleFold(1);
		const closed = pane.render(80).join("\n");
		expect(closed).toContain("▸ Thinking · 1 tool");
		expect(closed).not.toContain("✓ bash");
	});

	test("a tool-only aborted turn collapses to ▸ 1 tool with a · no-result row", () => {
		const pane = new ConversationPane();
		pane.showView(
			view(1, [
				{
					id: 1,
					kind: "pi.user",
					model: [{ role: "user", content: "run it" }],
				},
				{
					id: 2,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "call-x",
									name: "bash",
									arguments: { command: "make test" },
								},
							],
						},
					],
				},
				// Aborted mid-run: no pi.tool-result ever lands.
			]),
		);
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("▸ 1 tool");
		pane.toggleFold(1);
		const open = pane.render(80).join("\n");
		expect(open).toContain("· bash  make test");
	});

	test("a tool with an error result renders ✗", () => {
		const pane = new ConversationPane();
		pane.showView(
			view(1, [
				{
					id: 1,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "call-e",
									name: "bash",
									arguments: { command: "false" },
								},
							],
						},
					],
				},
				{
					id: 2,
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "call-e",
							toolName: "bash",
							isError: true,
							content: [{ type: "text", text: "exit 1" }],
						},
					],
				},
			]),
		);
		pane.toggleFold(0);
		expect(pane.render(80).join("\n")).toContain("✗ bash  false");
	});

	test("setFocus(0) composes › and the ▎ bar on a focused user turn's first line", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		expect(pane.focusIndex).toBeUndefined();
		pane.setFocus(0);
		expect(pane.focusIndex).toBe(0);
		const lines = pane.render(80);
		const first = lines.find((line) => line.includes("what is in the root"));
		expect(first).toBeDefined();
		// The focus gutter and the user bar are independent chrome: the
		// focused user turn's first line carries BOTH (the bar must not be
		// lost to the focus branch).
		expect(first?.startsWith("›")).toBe(true);
		expect(first).toContain("▎");
		// Clearing focus removes the marker.
		pane.setFocus(undefined);
		const after = pane.render(80).join("\n");
		expect(after).not.toContain("›");
	});

	test("lineRangeOf orders turns (1 after 0) and covers rendered lines", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		pane.render(80);
		const first = pane.lineRangeOf(0);
		const second = pane.lineRangeOf(1);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second!.start).toBeGreaterThanOrEqual(first!.end);
		expect(pane.lineRangeOf(99)).toBeUndefined();
	});

	test("textOf returns the markdown source; entryIdOf the wire id", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		expect(pane.textOf(0)).toBe("what is in the root filesystem?");
		expect(pane.textOf(1)).toBe("The root holds bin, etc and usr.");
		expect(pane.entryIdOf(0)).toBe(1);
		expect(pane.entryIdOf(1)).toBe(4); // assistant lastEntryId
	});

	// ── Task 2c: the expanded-user chip ──────────────────────────────
	// An expanded submission is ONE entry (kind `sigrun.user.expanded`,
	// `data {typed, command}`, the EXPANDED text on `model`): the pane
	// renders the TYPED text as the user turn with a dim chip line that
	// folds the full expanded text open/closed.

	/** An expanded turn: typed `/review concurrency`, admitted text
	 *  "Review with focus: concurrency". */
	function expandedEntries(): unknown[] {
		return [
			{
				id: 1,
				kind: "sigrun.user.expanded",
				data: { typed: "/review concurrency", command: "review" },
				model: [
					{
						role: "user",
						content: [{ type: "text", text: "Review with focus: concurrency" }],
					},
				],
			},
			{
				id: 2,
				kind: "pi.assistant",
				model: [
					{ role: "assistant", content: [{ type: "text", text: "Reviewed." }] },
				],
			},
		];
	}

	test("an expanded entry renders as a USER turn: the typed text, the accent bar, and the chip", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, expandedEntries()));
		expect(pane.turns().map((turn) => turn.kind)).toEqual(["user", "assistant"]);
		const lines = pane.render(80).join("\n");
		// The TYPED text is the bubble (with the user-turn accent bar)…
		expect(lines).toContain("▎ /review concurrency");
		// …the chip names the command…
		expect(lines).toContain("expanded from /review");
		// …and the expanded text is NOT shown by default.
		expect(lines).not.toContain("Review with focus: concurrency");
	});

	test("toggleFold on an expanded user turn reveals and re-hides the full text; textOf copies the typed line", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, expandedEntries()));
		pane.toggleFold(0);
		const open = pane.render(80).join("\n");
		expect(open).toContain("Review with focus: concurrency");
		pane.toggleFold(0);
		const closed = pane.render(80).join("\n");
		expect(closed).not.toContain("Review with focus: concurrency");
		// The copy payload is the typed command (what the user wrote).
		expect(pane.textOf(0)).toBe("/review concurrency");
		expect(pane.entryIdOf(0)).toBe(1);
	});

	test("pi.compaction renders the centred divider", () => {
		const pane = new ConversationPane();
		pane.showView(
			view(1, [{ id: 1, kind: "pi.compaction", data: { reason: "threshold" } }]),
		);
		expect(pane.render(80).join("\n")).toContain("── context compacted ──");
	});

	test("the focused turn's first line carries the surface2 background", () => {
		// Non-plain theme: the surface2 bg span wraps the first line only.
		const pane = new ConversationPane({
			theme: {
				fg: () => (s) => s,
				bg: (token) => (s) => (token === "surface2" ? `<bg>${s}</bg>` : s),
				bold: (s) => s,
				dim: (s) => s,
				italic: (s) => s,
			},
		});
		pane.showView(view(1, rootFilesystemEntries()));
		pane.setFocus(0);
		const lines = pane.render(80);
		expect(lines[0]).toContain("<bg>");
		expect(lines[1] ?? "").not.toContain("<bg>");
	});
});

/**
 * U5 Task 4 fixtures: the entry order a real `show_blocks` run produces
 * (pi.user → pi.assistant(toolCall show_blocks) → sigrun.blocks →
 * pi.tool-result → sigrun.blocks.note → pi.assistant(text)) plus the
 * answer entry (a user turn with the "from <title>" chip).
 */
function chatBlocksEntries(): unknown[] {
	return [
		{
			id: 1,
			kind: "pi.user",
			model: [{ role: "user", content: "show the ranking" }],
		},
		{
			id: 2,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-blocks",
							name: "show_blocks",
							arguments: { title: "Ranking" },
						},
					],
				},
			],
		},
		{
			id: 3,
			kind: "sigrun.blocks",
			data: {
				title: "Ranking",
				tree: {
					v: 1,
					root: {
						type: "collection",
						id: "ranking",
						items: { $: "/cards" },
						display: "list",
						numbered: true,
						reorder: { within: true },
						onMove: "reorderCards",
						item: { title: { $: "./title" } },
					},
				},
				data: { cards: [{ id: "c1", title: "Clair de Lune" }] },
			},
		},
		{
			id: 4,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "call-blocks",
					toolName: "show_blocks",
					content: [{ type: "text", text: "1. Clair de Lune\nentryId: 3" }],
				},
			],
		},
		{
			id: 5,
			kind: "sigrun.blocks.note",
			model: [
				{
					role: "user",
					content: [
						{ type: "text", text: "UI changes: Ranking (alice): moved c1" },
					],
				},
			],
			data: { advance: [{ entryId: "3", through: 1 }] },
		},
		{
			id: 6,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Here is the ranking." }],
				},
			],
		},
		{
			id: 7,
			kind: "sigrun.blocks.answer",
			model: [
				{
					role: "user",
					content: [{ type: "text", text: "Submitted 'Ranking': 1. Clair de Lune" }],
				},
			],
			data: { entryId: "3", action: "submitRanking", payload: null, state: {} },
		},
	];
}

/** A stub chat transport serving the ranking block (write access). */
function stubChatTransport(): SurfaceTransport {
	const tree = {
		v: 1,
		root: {
			type: "collection",
			id: "ranking",
			items: { $: "/cards" },
			display: "list",
			numbered: true,
			reorder: { within: true },
			onMove: "reorderCards",
			item: { title: { $: "./title" } },
		},
	} as unknown as Tree;
	return {
		load: async () => ({
			tree,
			data: { cards: [{ id: "c1", title: "Clair de Lune" }] },
			rev: 1,
			treeRev: 0,
			access: "write",
		}),
		fetchData: async () => ({ rev: 1, treeRev: 0, data: {} }),
		act: async () => ({ ok: true as const, rev: 1 }),
		upload: async () => {
			throw new Error("no uploads in chat");
		},
		image: async () => {
			throw new Error("no images yet");
		},
		onChanged: () => () => {},
	};
}

describe("ConversationPane: chat blocks (U5 Task 4)", () => {
	test("one assistant turn carries the blocks + note events; the show_blocks tool is absent", async () => {
		const pane = new ConversationPane({
			attachChatTransport: () => stubChatTransport(),
		});
		pane.showView(view(1, chatBlocksEntries()));
		const turns = pane.turns();
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		const assistant = turns[1]!;
		if (assistant.kind !== "assistant") throw new Error("expected assistant");
		// The show_blocks call is left out of tools (the activity line
		// never counts the surface's own rendering machinery).
		expect(assistant.tools).toEqual([]);
		// The timeline interleaves blocks, note, text.
		expect(
			assistant.timeline.map((event) =>
				event.kind === "blocks" || event.kind === "note"
					? `${event.kind}:${event.entryId}`
					: event.kind,
			),
		).toEqual(["blocks:3", "note:5", "text"]);
		// The render shows the note's collapsed summary row; the note text
		// waits behind the fold.
		const closed = pane.render(80).join("\n");
		expect(closed).toContain("UI changes sent to the agent");
		expect(closed).not.toContain("moved c1");
		// Opening the fold reveals the note text.
		pane.toggleFold(1);
		const open = pane.render(80).join("\n");
		expect(open).toContain("moved c1");
		// The answer turn renders the user's message with the title chip.
		const answerText = pane.textOf(2);
		expect(answerText).toContain("Submitted 'Ranking'");
		expect(pane.render(80).join("\n")).toContain("from Ranking");
	});

	test("the block surface loads inline through the attach seam", async () => {
		const pane = new ConversationPane({
			attachChatTransport: () => stubChatTransport(),
		});
		pane.showView(view(1, chatBlocksEntries()));
		// The surface loads asynchronously; flush the microtask queue.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("Clair de Lune");
	});

	test("without an attach seam the block renders the fail-visible placeholder", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, chatBlocksEntries()));
		expect(pane.render(80).join("\n")).toContain(
			"blocks entry 3 — no chat transport",
		);
	});

	test("repeated showView frames reuse ONE surface state: one attach, one load, one subscription", async () => {
		let loads = 0;
		let subscriptions = 0;
		const transport = {
			...stubChatTransport(),
			load: async () => {
				loads += 1;
				return stubChatTransport().load();
			},
			onChanged: () => {
				subscriptions += 1;
				return () => {};
			},
		};
		let attaches = 0;
		const pane = new ConversationPane({
			attachChatTransport: () => {
				attaches += 1;
				return transport;
			},
		});
		// Two frames (a snapshot then a delta — each triggers a rebuild).
		pane.showView(view(1, chatBlocksEntries()));
		pane.showView(view(1, chatBlocksEntries()));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(attaches).toBe(1);
		expect(loads).toBe(1);
		expect(subscriptions).toBe(1);
		pane.dispose();
	});

	test("a conversation swap disposes the old surface state (its unsubscribe fires)", async () => {
		let unsubscribed = 0;
		const transport = {
			...stubChatTransport(),
			onChanged: () => () => {
				unsubscribed += 1;
			},
		};
		const pane = new ConversationPane({
			attachChatTransport: () => transport,
		});
		pane.showView(view(1, chatBlocksEntries()));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(unsubscribed).toBe(0);
		pane.showView(view(2, chatBlocksEntries()));
		expect(unsubscribed).toBe(1);
		// The swap's own state unsubscribes once its async load lands.
		await new Promise((resolve) => setTimeout(resolve, 0));
		pane.dispose();
		expect(unsubscribed).toBe(2); // the swap's own state, now torn down
	});

	test("a same-conversation rewind prunes the orphaned surface state", async () => {
		// A fork rewinding past the blocks entry leaves the state for the
		// rewound-away entry orphaned: the rebuild prune must dispose it
		// (its unsubscribe fires) and drop it from the cache.
		let unsubscribed = 0;
		const transport = {
			...stubChatTransport(),
			onChanged: () => () => {
				unsubscribed += 1;
			},
		};
		const pane = new ConversationPane({
			attachChatTransport: () => transport,
		});
		pane.showView(view(1, chatBlocksEntries()));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pane.surfaceStateFor(3)).toBeDefined();
		// The fork's rewind: the view replaces with entries 1-2 only (the
		// blocks entry 3 is gone) — the SAME conversation, so the swap
		// clear never runs; the rebuild prune owns this teardown.
		pane.showView(view(1, chatBlocksEntries().slice(0, 2)));
		expect(unsubscribed).toBe(1);
		expect(pane.surfaceStateFor(3)).toBeUndefined();
		pane.dispose();
	});

	test("a note entry written after a compaction renders as a note, never unsupported", async () => {
		// Auto-compaction lands at run end and flushes the pending turn;
		// the next turn's note entry lands after the pi.compaction entry —
		// it must open a fresh assistant turn (the note row renders), not
		// fall through to the other-kind unsupported line.
		const pane = new ConversationPane({
			attachChatTransport: () => stubChatTransport(),
		});
		pane.showView(
			view(1, [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
				{
					id: 2,
					kind: "pi.assistant",
					model: [
						{ role: "assistant", content: [{ type: "text", text: "hello" }] },
					],
				},
				{ id: 3, kind: "pi.compaction" },
				{
					id: 4,
					kind: "sigrun.blocks.note",
					model: [
						{
							role: "user",
							content: [
								{ type: "text", text: "UI changes: Ranking (alice): moved c1" },
							],
						},
					],
					data: { advance: [{ entryId: "2", through: 1 }] },
				},
			]),
		);
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("UI changes sent to the agent");
		expect(lines).not.toContain("unsupported entry kind");
		pane.dispose();
	});

	test("a rejected action's notice drains into a pane [error] line", async () => {
		const pane = new ConversationPane({
			attachChatTransport: () => ({
				...stubChatTransport(),
				act: async () => ({
					ok: false as const,
					error: { message: "nope from acme" },
				}),
			}),
		});
		pane.showView(view(1, chatBlocksEntries()));
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Dispatch an action through the cached state (a form button's
		// path). The rejection's message must land as a pane notice.
		const state = pane.surfaceStateFor(3);
		expect(state).toBeDefined();
		state!.dispatch(
			{ type: "action", name: "submit" } as never,
			{},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pane.render(80).join("\n")).toContain("[error] nope from acme");
		pane.dispose();
	});
});
