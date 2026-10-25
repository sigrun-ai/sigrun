/**
 * TurnList (B4, UI refresh): the turn-grouped transcript. groupTurns folds
 * the flat entries into turns; a user turn is a bubble with
 * Copy/Edit/Fork actions; an assistant turn is prose + the collapsed
 * ActivityLine + Copy/Fork with the `model · tokens` meta; a compaction
 * entry renders the centred divider; the fork lineage row names the
 * parent. Turn roots carry data-turn-kind (and data-entry-id on user
 * turns) for the outline (B5).
 *
 * Action seams (fork / edit / draft-prefill) go through a stub client
 * recording the §5 calls; the streaming partial merges into the trailing
 * assistant turn.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationViewWire, SigrunClient } from "../api";
import type { SurfaceLoad, SurfaceTransport } from "@sigrun/shared/blocks";
import {
	assistantTurnEntry,
	findButton,
	makeEntry,
	makeView,
	render,
	renderAsync,
	stubClipboard,
	stubSessionStorage,
	textBlock,
	textContent,
	textMessage,
	thinkingBlock,
	toolCallBlock,
	toolResultTurnEntry,
	userTurnEntry,
} from "../test-utils";
import { TurnList } from "./TurnList";
import { ChatTransportContext } from "./chatTransportContext";

afterEach(() => {
	vi.unstubAllGlobals();
});

// Node ≥26 ships a real global sessionStorage; each test gets a fresh Map so
// the persisted open state never bleeds across tests sharing a key.
beforeEach(() => {
	stubSessionStorage();
});

/** A client stub recording fork/create/patch — the B4 action seams. */
function makeTurnClient(init?: { readonly forkId?: number }): {
	client: SigrunClient;
	fork: ReturnType<typeof vi.fn>;
	createConversation: ReturnType<typeof vi.fn>;
	patchConversationMeta: ReturnType<typeof vi.fn>;
} {
	const fork = vi.fn(() => Promise.resolve({ id: init?.forkId ?? 9 }));
	const createConversation = vi.fn(() =>
		Promise.resolve({
			id: 11,
			root: true,
			archived: false,
			pinned: false,
		}),
	);
	const patchConversationMeta = vi.fn(() => Promise.resolve());
	return {
		client: {
			fork,
			createConversation,
			patchConversationMeta,
		} as unknown as SigrunClient,
		fork,
		createConversation,
		patchConversationMeta,
	};
}

/** The root-filesystem run: user asks, assistant thinks, runs `ls /`, answers. */
function rootView() {
	return makeView({
		id: 1,
		entries: [
			userTurnEntry(1, "What is at the filesystem root?"),
			assistantTurnEntry(2, [
				thinkingBlock("List the root directory first."),
				toolCallBlock("call-root", "bash", { command: "ls /" }),
			]),
			toolResultTurnEntry(3, "call-root", { text: "bin\netc" }),
			assistantTurnEntry(4, [textBlock("The root has `bin` and `etc`.")], {
				model: "faux/m1",
				input: 84,
				cacheRead: 0,
				cacheWrite: 0,
				output: 36,
				totalTokens: 120,
			}),
		],
	});
}

/** The assistant turn's actions row (kind "assistant" is the last one). */
function assistantActions(renderer: ReturnType<typeof render>) {
	const rows = renderer.root.findAllByProps({ className: "message-actions" });
	const assistantRow = rows.find(
		(row) => row.props["data-kind"] === "assistant",
	);
	if (assistantRow === undefined) throw new Error("no assistant actions row");
	return assistantRow;
}

describe("TurnList: grouping and rendering", () => {
	test("root-filesystem fixture: one user bubble, one assistant turn, collapsed activity line", () => {
		const renderer = render(
			h(TurnList, {
				view: rootView(),
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("What is at the filesystem root?");
		// Markdown renders the backticks as real inline code elements (B5);
		// the plain-text tree reads the words only.
		expect(text).toContain("The root has bin and etc.");
		expect(text).toContain("Thinking · 1 tool");
		// Collapsed: no thinking text, no tool preview.
		expect(text).not.toContain("List the root directory first.");
		expect(text).not.toContain("ls /");
		renderer.unmount();
	});

	test("expanding the activity line shows the thinking text and the `ls /` row", () => {
		const renderer = render(
			h(TurnList, {
				view: rootView(),
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		act(() => {
			renderer.root.findByProps({ className: "activity-toggle" }).props.onClick();
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("List the root directory first.");
		expect(text).toContain("ls /");
		renderer.unmount();
	});

	test("turn roots carry data-turn-kind and, on user turns, data-entry-id", () => {
		const renderer = render(
			h(TurnList, {
				view: rootView(),
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		const user = renderer.root.findAllByProps({ "data-turn-kind": "user" });
		expect(user).toHaveLength(1);
		expect(user[0]?.props["data-entry-id"]).toBe(1);
		const assistant = renderer.root.findAllByProps({
			"data-turn-kind": "assistant",
		});
		expect(assistant).toHaveLength(1);
		expect(assistant[0]?.props["data-entry-id"]).toBeUndefined();
		renderer.unmount();
	});

	test("assistant prose renders Markdown: **bold** becomes <strong>", () => {
		const view = makeView({
			id: 1,
			entries: [
				userTurnEntry(1, "which files?"),
				assistantTurnEntry(2, [textBlock("The root has **bin** and `etc`.")]),
			],
		});
		const renderer = render(
			h(TurnList, {
				view,
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		const prose = renderer.root.findByProps({ className: "turn-prose" });
		const strongs = prose.findAllByType("strong");
		expect(strongs).toHaveLength(1);
		expect(strongs[0]?.children).toEqual(["bin"]);
		renderer.unmount();
	});

	test("a tool-only aborted turn renders `1 tool` with the · glyph and no empty prose node", () => {
		const view = makeView({
			id: 1,
			entries: [
				userTurnEntry(1, "Read my notes"),
				assistantTurnEntry(2, [
					toolCallBlock("call-read", "read", { path: "notes/todo.txt" }),
				]),
			],
		});
		const renderer = render(
			h(TurnList, {
				view,
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		const collapsed = textContent(renderer.toJSON());
		expect(collapsed).toContain("1 tool");
		expect(collapsed).not.toContain("Thinking");
		act(() => {
			renderer.root.findByProps({ className: "activity-toggle" }).props.onClick();
		});
		expect(
			renderer.root.findByProps({ "data-glyph": "pending" }).children,
		).toEqual(["·"]);
		// No empty prose node under the assistant turn.
		const assistant = renderer.root.findAllByProps({
			"data-turn-kind": "assistant",
		})[0];
		expect(assistant.findAllByProps({ className: "turn-prose" })).toHaveLength(0);
		renderer.unmount();
	});

	test("showThinking=false hides thinking text but keeps the tool row", () => {
		const renderer = render(
			h(TurnList, {
				view: rootView(),
				showThinking: false,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		const collapsed = textContent(renderer.toJSON());
		expect(collapsed).toContain("Thinking · 1 tool");
		act(() => {
			renderer.root.findByProps({ className: "activity-toggle" }).props.onClick();
		});
		const expanded = textContent(renderer.toJSON());
		expect(expanded).not.toContain("List the root directory first.");
		expect(expanded).toContain("ls /");
		renderer.unmount();
	});

	test("compaction renders the centred divider text with no button", () => {
		const view = makeView({
			id: 1,
			entries: [
				{
					...makeEntry("pi.compaction", [
						textMessage("user", "summary text…"),
					], { id: 3 }),
					data: { reason: "manual" },
				},
			],
		});
		const renderer = render(
			h(TurnList, {
				view,
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		expect(textContent(renderer.toJSON())).toContain("Context compacted");
		const compaction = renderer.root.findAllByProps({
			"data-turn-kind": "compaction",
		});
		expect(compaction).toHaveLength(1);
		expect(compaction[0]?.findAllByType("button")).toHaveLength(0);
		renderer.unmount();
	});

	test("the fork lineage row renders when parent is set and navigates to it", () => {
		const onNavigate = vi.fn();
		const renderer = render(
			h(TurnList, {
				view: rootView(),
				showThinking: true,
				parent: { id: 7, name: "Tide table rewrite" },
				onNavigate,
				client: makeTurnClient().client,
			}),
		);
		const lineage = renderer.root.findByProps({ className: "turn-lineage" });
		expect(
			(lineage.children ?? []).join(""),
		).toContain("Forked from Tide table rewrite");
		act(() => {
			lineage.props.onClick();
		});
		expect(onNavigate).toHaveBeenCalledWith(7);
		renderer.unmount();
	});

	test("an unknown kind stays fail-visible, naming the kind", () => {
		const view = makeView({
			id: 1,
			entries: [
				makeEntry("pi.future-thing", [textMessage("system", "payload")], {
					id: 1,
				}),
			],
		});
		const renderer = render(
			h(TurnList, {
				view,
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("pi.future-thing");
		expect(text).toContain("payload");
		renderer.unmount();
	});

	test("the assistant meta label reads the last assistant message's model and usage", () => {
		const renderer = render(
			h(TurnList, {
				view: rootView(),
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		const metas = renderer.root.findAllByProps({ className: "message-meta" });
		expect(metas).toHaveLength(1);
		expect(metas[0]?.children).toEqual(["faux/m1 · in 84 · out 36"]);
		renderer.unmount();
	});
});

describe("TurnList: the streaming partial and live slots", () => {
	test("the partial's streaming text merges into the trailing assistant turn", () => {
		const view = makeView({
			id: 1,
			entries: [
				userTurnEntry(1, "hello"),
				assistantTurnEntry(2, [toolCallBlock("call-1", "bash", { command: "ls /" })]),
			],
			docs: {
				"pi.live": {
					generation: {
						message: {
							role: "assistant",
							content: [{ type: "text", text: "streaming answer" }],
						},
					},
				},
			},
		});
		const renderer = render(
			h(TurnList, {
				view,
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		// ONE assistant turn (the partial joined it), carrying the live text.
		const assistant = renderer.root.findAllByProps({
			"data-turn-kind": "assistant",
		});
		expect(assistant).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("streaming answer");
		// The live turn renders IN PLACE (timeline-style): the settled tool
		// call renders as its chronological row — not the grouped activity
		// line — and the live flag marks the turn root.
		expect(assistant[0]?.props["data-live"]).toBe("true");
		expect(textContent(renderer.toJSON())).toContain("ls /");
		renderer.unmount();
	});

	test("a partial with no trailing assistant turn renders as its own live turn", () => {
		const view = makeView({
			id: 1,
			entries: [userTurnEntry(1, "hello")],
			docs: {
				"pi.live": {
					generation: {
						message: {
							role: "assistant",
							content: [{ type: "text", text: "first words" }],
						},
					},
				},
			},
		});
		const renderer = render(
			h(TurnList, {
				view,
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		expect(textContent(renderer.toJSON())).toContain("first words");
		const assistant = renderer.root.findAllByProps({
			"data-turn-kind": "assistant",
		});
		expect(assistant).toHaveLength(1);
		renderer.unmount();
	});

	test("a running live slot joins its tool row (spinner, slot output wins)", () => {
		const view = makeView({
			id: 1,
			entries: [
				userTurnEntry(1, "look"),
				assistantTurnEntry(2, [toolCallBlock("call-1", "bash", { command: "ls /" })]),
			],
			docs: {
				"pi.live": {
					tools: [
						{ callId: "call-1", name: "bash", status: "running", output: "so far" },
					],
				},
			},
		});
		const renderer = render(
			h(TurnList, {
				view,
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		act(() => {
			renderer.root.findByProps({ className: "activity-toggle" }).props.onClick();
		});
		const row = renderer.root.findByProps({ className: "tool-row" });
		expect(row.props["data-running"]).toBe(true);
		expect(
			renderer.root.findAllByProps({ "aria-label": "running" }),
		).toHaveLength(1);
		act(() => {
			renderer.root.findByProps({ className: "tool-row-toggle" }).props.onClick();
		});
		expect(textContent(renderer.toJSON())).toContain("so far");
		renderer.unmount();
	});
});

describe("TurnList actions", () => {
	test("Fork from here (assistant) calls client.fork(1, lastEntryId) then onNavigate", async () => {
		const { client, fork } = makeTurnClient({ forkId: 9 });
		const onNavigate = vi.fn();
		const renderer = render(
			h(TurnList, { view: rootView(), showThinking: true, onNavigate, client }),
		);
		await act(async () => {
			findButton(assistantActions(renderer), "Fork from here").props.onClick();
		});
		expect(fork).toHaveBeenCalledWith(1, 4);
		expect(onNavigate).toHaveBeenCalledWith(9);
		renderer.unmount();
	});

	test("Fork from here (user turn) forks at the user entry id", async () => {
		const { client, fork } = makeTurnClient();
		const onNavigate = vi.fn();
		const renderer = render(
			h(TurnList, { view: rootView(), showThinking: true, onNavigate, client }),
		);
		const userTurn = renderer.root.findByProps({ "data-turn-kind": "user" });
		await act(async () => {
			findButton(userTurn, "Fork from here").props.onClick();
		});
		expect(fork).toHaveBeenCalledWith(1, 1);
		expect(onNavigate).toHaveBeenCalledWith(9);
		renderer.unmount();
	});

	test("Edit on the FIRST user message: createConversation, draft patch, navigate (no fork)", async () => {
		const { client, fork, createConversation, patchConversationMeta } =
			makeTurnClient();
		const onNavigate = vi.fn();
		const renderer = render(
			h(TurnList, { view: rootView(), showThinking: true, onNavigate, client }),
		);
		await act(async () => {
			findButton(renderer, "Edit").props.onClick();
		});
		expect(fork).not.toHaveBeenCalled();
		expect(createConversation).toHaveBeenCalledTimes(1);
		expect(patchConversationMeta).toHaveBeenCalledWith(11, {
			draft: { text: "What is at the filesystem root?" },
		});
		expect(onNavigate).toHaveBeenCalledWith(11);
		renderer.unmount();
	});

	test("Edit on a LATER user message forks at the immediately previous entry id", async () => {
		const { client, fork, createConversation, patchConversationMeta } =
			makeTurnClient();
		const onNavigate = vi.fn();
		const view = makeView({
			id: 1,
			entries: [
				userTurnEntry(1, "first question"),
				assistantTurnEntry(2, [textBlock("first answer")]),
				userTurnEntry(3, "second question"),
				assistantTurnEntry(4, [textBlock("second answer")]),
			],
		});
		const renderer = render(
			h(TurnList, { view, showThinking: true, onNavigate, client }),
		);
		// Two user turns → two Edit buttons; the LAST user turn's Edit forks at entry 2.
		const edits = renderer.root.findAllByType("button").filter((button) =>
			(button.children ?? []).some((child) => child === "Edit"),
		);
		expect(edits).toHaveLength(2);
		await act(async () => {
			edits[1]?.props.onClick();
		});
		expect(createConversation).not.toHaveBeenCalled();
		expect(fork).toHaveBeenCalledWith(1, 2);
		expect(patchConversationMeta).toHaveBeenCalledWith(9, {
			draft: { text: "second question" },
		});
		expect(onNavigate).toHaveBeenCalledWith(9);
		renderer.unmount();
	});

	test("Copy writes the assistant markdown source (raw text, not rendered)", async () => {
		vi.useFakeTimers();
		const writeText = stubClipboard();
		const renderer = render(
			h(TurnList, {
				view: rootView(),
				showThinking: true,
				onNavigate: () => {},
				client: makeTurnClient().client,
			}),
		);
		await act(async () => {
			findButton(assistantActions(renderer), "Copy").props.onClick();
		});
		expect(writeText).toHaveBeenCalledWith("The root has `bin` and `etc`.");
		vi.useRealTimers();
		renderer.unmount();
	});
});

/** U5 Task 4: the chat-blocks fixtures — the entry order a real
 *  `show_blocks` run produces (pi.user → pi.assistant(toolCall
 *  show_blocks) → sigrun.blocks → pi.tool-result → sigrun.blocks.note →
 *  pi.assistant(text)), plus an answer entry. */
function blocksView(): ConversationViewWire {
	return makeView({
		entries: [
			userTurnEntry(1, "show the ranking"),
			assistantTurnEntry(2, [toolCallBlock("call-blocks", "show_blocks", { title: "Ranking" })]),
			makeEntry("sigrun.blocks", [], {
				id: 3,
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
			}),
			toolResultTurnEntry(4, "call-blocks"),
			makeEntry("sigrun.blocks.note", [textMessage("user", "UI changes: Ranking (alice): moved c1")], {
				id: 5,
				data: { advance: [{ entryId: "3", through: 1 }] },
			}),
			assistantTurnEntry(6, [textBlock("Here is the ranking.")]),
			makeEntry("sigrun.blocks.answer", [textMessage("user", "Submitted 'Ranking': 1. Clair de Lune")], {
				id: 7,
				data: { entryId: "3", action: "submitRanking", payload: null, state: {} },
			}),
		],
	});
}


	/** A stub chat-transport attach serving the blocksView surface (access write). */
function stubAttach() {
	const data = blocksView().entries[2]!.data as {
		readonly tree: Parameters<typeof JSON.stringify>[0];
		readonly data: Parameters<typeof JSON.stringify>[0];
	};
	const transport: SurfaceTransport = {
		load: vi.fn(async () => ({
			tree: data.tree as SurfaceLoad["tree"],
			data: data.data as SurfaceLoad["data"],
			rev: 1,
			treeRev: 0,
			access: "write" as const,
		})),
		fetchData: vi.fn(async () => ({ rev: 1, treeRev: 0, data: data.data as SurfaceLoad["data"] })),
		act: vi.fn(),
		upload: vi.fn(),
		image: vi.fn(),
		onChanged: vi.fn(() => () => {}),
	};
	return vi.fn(() => transport);
}

describe("TurnList: chat blocks (U5 Task 4)", () => {
	test("the show_blocks tool row never renders; the block renders inline in the timeline view", async () => {
		const attach = stubAttach();
		const renderer = await renderAsync(
			h(
				ChatTransportContext.Provider,
				{ value: attach },
				h(TurnList, {
					view: blocksView(),
					showThinking: true,
					timeline: true,
					onNavigate: () => {},
					client: makeTurnClient().client,
				}),
			),
		);
		const text = textContent(renderer.toJSON());
		// The tool row is NOT shown (groupTurns leaves show_blocks out of
		// tools and the timeline; the activity line never counts it).
		expect(text).not.toContain("show_blocks");
		// The block renders inline: its title + the loaded surface.
		expect(text).toContain("Ranking");
		expect(text).toContain("Clair de Lune");
		// The note row is the collapsed disclosure.
		expect(text).toContain("UI changes sent to the agent");
		// The answer turn is a user bubble with the "from <title>" chip.
		expect(text).toContain("Submitted 'Ranking'");
		expect(text).toContain("from Ranking");
		renderer.unmount();
	});

	test("the grouped view keeps the surface OUTSIDE the folded activity line", async () => {
		const attach = stubAttach();
		const renderer = await renderAsync(
			h(
				ChatTransportContext.Provider,
				{ value: attach },
				h(TurnList, {
					view: blocksView(),
					showThinking: true,
					onNavigate: () => {},
					client: makeTurnClient().client,
				}),
			),
		);
		// The activity line folds the turn's thinking/tools; the block
		// surface must NOT live inside it (an ActivityLine's expanded
		// content renders ToolRows and thinking — the surface's root is
		// the proof the block sits outside).
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Clair de Lune");
		// The grouped view shows NO tool row for show_blocks either.
		expect(text).not.toContain("show_blocks");
		renderer.unmount();
	});
});
