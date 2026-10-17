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
import type { SigrunClient } from "../api";
import {
	assistantTurnEntry,
	findButton,
	makeEntry,
	makeView,
	render,
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
			entryCount: 0,
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
		expect(text).toContain("The root has `bin` and `etc`.");
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
		expect(metas[0]?.children).toEqual(["faux/m1 · 120 tokens"]);
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
		expect(textContent(renderer.toJSON())).toContain("1 tool");
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
