/**
 * The TUI shell (Task 6) against a stub client: the sidebar lists
 * `listConversations()` (active marked, archived hidden, `+ new` action
 * present), selecting a conversation swaps the pane, the pane renders a
 * `ConversationViewWire`'s entries in order (user / assistant / thinking /
 * tool rows), the composer submits via `submit(id, text)`, and the fork
 * action calls `forkConversation` then selects the fork. Render-to-string
 * and component-state assertions — structure, not pixels.
 */

import { describe, expect, test } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { TuiApp } from "../src/ui/app.js";
import { ConversationPane } from "../src/ui/conversation-pane.js";
import { Sidebar } from "../src/ui/sidebar.js";
import type {
	ConversationList,
	ConversationSummary,
	ConversationViewWire,
	SigrunClient,
} from "../src/api.js";
import type { Unwatch, WatchHandlers, WatchOptions } from "../src/sse.js";

// ─── Stub client (the brief's "against a stub client") ──────────────────

function summary(id: number, init?: { owner?: string }): ConversationSummary {
	return {
		id,
		root: false,
		entryCount: 0,
		...(init?.owner === undefined ? {} : { owner: init.owner }),
	};
}

function view(id: number, entries: unknown[]): ConversationViewWire {
	return {
		conversation: { id },
		entries,
		docs: {},
		steer: { busy: false, queued: 0 },
	} as unknown as ConversationViewWire;
}

function stubClient(init: {
	metas?: Record<number, { archived?: boolean; name?: string }>;
	watch?: (handlers: WatchHandlers) => void;
}) {
	const submitCalls: { id: number; text: string }[] = [];
	const forkCalls: number[] = [];
	let forkSerial = 100;
	const watchCalls: number[] = [];
	const watchRegistry = new Map<number, WatchHandlers>();
	// The stub's listing is stateful: created/forked conversations join it,
	// the way a real server's listing would reflect them on the next poll.
	const listed: ConversationSummary[] = [summary(1), summary(2), summary(3)];
	const client = {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({ conversations: [...listed] });
		},
		getMeta(id: number) {
			const meta = init.metas?.[id] ?? {};
			return Promise.resolve({
				pinned: false,
				tagged: [],
				archived: meta.archived ?? false,
				draft: { text: "", attachments: [] },
				source: "user",
				...(meta.name === undefined ? {} : { name: meta.name }),
			});
		},
		createConversation() {
			listed.push(summary(4));
			return Promise.resolve({ id: 4, view: view(4, []) });
		},
		forkConversation(id: number) {
			forkCalls.push(id);
			forkSerial += 1;
			listed.push(summary(forkSerial));
			return Promise.resolve({ id: forkSerial, view: view(forkSerial, []) });
		},
		submit(id: number, text: string) {
			submitCalls.push({ id, text });
			return Promise.resolve({ id: 1, conversationId: id, type: "user", status: "answered" });
		},
		getConversation(id: number) {
			return Promise.resolve(view(id, []));
		},
	};
	return {
		client: client as unknown as SigrunClient,
		submitCalls,
		forkCalls,
		watchCalls,
		watchRegistry,
	};
}

function stubWatch(
	registry: Map<number, WatchHandlers>,
	calls: number[],
): (conversationId: number, handlers: WatchHandlers, options: WatchOptions) => Unwatch {
	return (conversationId, handlers) => {
		calls.push(conversationId);
		registry.set(conversationId, handlers);
		return () => {
			registry.delete(conversationId);
		};
	};
}

/** A render target stand-in: Editor needs one; the shell is tested headless. */
const fakeTui = { requestRender: () => {} } as unknown as TUI;

// ─── Sidebar ────────────────────────────────────────────────────────────

describe("Sidebar", () => {
	test("lists conversations with the header, + new action, and the active marked", async () => {
		const { client } = stubClient({});
		const sidebar = new Sidebar(client, { maxVisible: 20 });
		await sidebar.refresh();
		sidebar.setActive(2);
		const lines = sidebar.render(30).join("\n");
		expect(lines).toContain("CONVERSATIONS");
		expect(lines).toContain("+ new");
		expect(lines).toContain("#1");
		expect(lines).toContain("* #2");
		expect(lines).toContain("#3");
	});

	test("hides archived conversations (meta.archived)", async () => {
		const { client } = stubClient({ metas: { 2: { archived: true } } });
		const sidebar = new Sidebar(client, { maxVisible: 20 });
		await sidebar.refresh();
		const lines = sidebar.render(30).join("\n");
		expect(lines).toContain("#1");
		expect(lines).not.toContain("#2");
		expect(lines).toContain("#3");
	});

	test("shows the session name when meta carries one", async () => {
		const { client } = stubClient({ metas: { 1: { name: "acme-research" } } });
		const sidebar = new Sidebar(client, { maxVisible: 20 });
		await sidebar.refresh();
		const lines = sidebar.render(40).join("\n");
		expect(lines).toContain("acme-research");
	});

	test("selection reports the chosen conversation; the + new row reports create", async () => {
		const { client } = stubClient({});
		const sidebar = new Sidebar(client, { maxVisible: 20 });
		await sidebar.refresh();
		const selections: (number | "new")[] = [];
		sidebar.onSelect = (selection) => selections.push(selection);
		// Cursor starts on the first conversation; enter selects it.
		sidebar.handleInput("\r");
		expect(selections).toEqual([1]);
		// Down past the list lands on the "+ new" action row.
		sidebar.handleInput("[B"); // → #2
		sidebar.handleInput("[B"); // → #3
		sidebar.handleInput("[B"); // → + new
		sidebar.handleInput("\r");
		expect(selections).toEqual([1, "new"]);
	});
});

// ─── Conversation pane ─────────────────────────────────────────────────

describe("ConversationPane", () => {
	test("renders user, assistant, thinking, and tool rows in entry order", () => {
		const pane = new ConversationPane();
		pane.showView(
			view(1, [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: "hello there" }] },
				{
					id: 2,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "let me consider" },
								{ type: "text", text: "the answer" },
							],
						},
					],
				},
				{
					id: 3,
					kind: "pi.tool-result",
					model: [{ role: "toolResult", toolName: "read", content: "file contents" }],
				},
				{ id: 4, kind: "pi.user", model: [{ role: "user", content: "follow up" }] },
			]),
		);
		const lines = pane.render(60).join("\n");
		const userIndex = lines.indexOf("hello there");
		const thinkingIndex = lines.indexOf("[thinking] let me consider");
		const answerIndex = lines.indexOf("the answer");
		const toolIndex = lines.indexOf("[tool] read");
		const followUpIndex = lines.indexOf("follow up");
		expect(userIndex).toBeGreaterThanOrEqual(0);
		expect(thinkingIndex).toBeGreaterThan(userIndex);
		expect(answerIndex).toBeGreaterThan(thinkingIndex);
		expect(toolIndex).toBeGreaterThan(answerIndex);
		expect(followUpIndex).toBeGreaterThan(toolIndex);
	});

	test("the next snapshot REPLACES the pane (the SSE contract — no accumulation)", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, [{ id: 1, kind: "pi.user", model: [{ role: "user", content: "first" }] }]));
		expect(pane.render(60).join("\n")).toContain("first");
		pane.showView(view(1, [{ id: 2, kind: "pi.user", model: [{ role: "user", content: "second" }] }]));
		const lines = pane.render(60).join("\n");
		expect(lines).not.toContain("first");
		expect(lines).toContain("second");
	});

	test("unknown entry kinds render a fail-visible fallback naming the kind", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, [{ id: 1, kind: "acme.custom", model: [{ role: "user", content: "payload" }] }]));
		const lines = pane.render(60).join("\n");
		expect(lines).toContain("unsupported entry kind: acme.custom");
	});

	test("pi.compaction entries render as compact rows", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, [{ id: 1, kind: "pi.compaction", data: { reason: "threshold" } }]));
		expect(pane.render(60).join("\n")).toContain("[compaction]");
	});
});

// ─── App shell ──────────────────────────────────────────────────────────

describe("TuiApp", () => {
	test("renders sidebar left and conversation pane right", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		const lines = app.render(80).join("\n");
		expect(lines).toContain("CONVERSATIONS");
	});

	test("boot selects the first conversation and starts watching it", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		expect(app.activeConversationId).toBe(1);
		expect(watchCalls).toEqual([1]);
		// A snapshot on the stream renders into the pane.
		watchRegistry.get(1)?.onSnapshot?.(
			view(1, [{ id: 1, kind: "pi.user", model: [{ role: "user", content: "streamed prompt" }] }]),
		);
		expect(app.render(80).join("\n")).toContain("streamed prompt");
	});

	test("selecting a sidebar conversation swaps the pane's watch", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		await app.selectConversation(2);
		expect(app.activeConversationId).toBe(2);
		// The old watch is closed, the new one opened.
		expect(watchCalls).toEqual([1, 2]);
		expect(watchRegistry.has(1)).toBe(false);
		expect(watchRegistry.has(2)).toBe(true);
	});

	test("the composer submits via submit(id, text) with the active id", async () => {
		const { client, submitCalls, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		app.editor.setText("ship it");
		app.editor.onSubmit?.("ship it");
		await Promise.resolve();
		expect(submitCalls).toEqual([{ id: 1, text: "ship it" }]);
		expect(app.editor.getText()).toBe("");
	});

	test("the fork action forks the active conversation, refreshes, and switches to the fork", async () => {
		const { client, forkCalls, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		await app.forkActive();
		expect(forkCalls).toEqual([1]);
		expect(app.activeConversationId).toBe(101);
		expect(watchCalls).toEqual([1, 101]);
		// The fork appears in the sidebar listing.
		expect(app.render(80).join("\n")).toContain("#101");
	});

	test("the + new action creates a conversation and selects it", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		await app.createAndSelect();
		expect(app.activeConversationId).toBe(4);
		expect(watchCalls).toEqual([1, 4]);
	});
});
