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

function summary(
	id: number,
	init?: { owner?: string; archived?: boolean; name?: string },
): ConversationSummary {
	return {
		id,
		root: false,
		entryCount: 0,
		archived: init?.archived ?? false,
		pinned: false,
		...(init?.owner === undefined ? {} : { owner: init.owner }),
		...(init?.name === undefined ? {} : { name: init.name }),
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
	/** Per-id sidebar metadata the summaries carry (A1: one request). */
	rows?: Record<number, { archived?: boolean; name?: string }>;
	watch?: (handlers: WatchHandlers) => void;
	/** Fix-wave seam: make createConversation/forkConversation reject. */
	createError?: Error;
	forkError?: Error;
	/** Park createConversation until released (sampling mid-swap, A1: the
	 * shorter refresh chain no longer spans tick() on its own). */
	holdCreate?: { readonly promise: Promise<void> };
}) {
	const submitCalls: { id: number; text: string }[] = [];
	const forkCalls: number[] = [];
	let forkSerial = 100;
	const watchCalls: number[] = [];
	const watchRegistry = new Map<number, WatchHandlers>();
	// The stub's listing is stateful: created/forked conversations join it,
	// the way a real server's listing would reflect them on the next poll.
	const listed: ConversationSummary[] = [
		summary(1, init.rows?.[1]),
		summary(2, init.rows?.[2]),
		summary(3, init.rows?.[3]),
	];
	const client = {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({ conversations: [...listed] });
		},
		createConversation() {
			if (init.createError !== undefined)
				return Promise.reject(init.createError);
			const create = (): { id: number; view: ConversationViewWire } => {
				listed.push(summary(4));
				return { id: 4, view: view(4, []) };
			};
			return init.holdCreate === undefined
				? Promise.resolve(create())
				: init.holdCreate.promise.then(create);
		},
		forkConversation(id: number) {
			if (init.forkError !== undefined)
				return Promise.reject(init.forkError);
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

/** Yield microtasks so an `async` swap's awaits interleave. */
async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/** A manual gate: `promise` parks until `release()` (the sse-view idiom). */
function makeGate(): { readonly promise: Promise<void>; release(): void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

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

	test("hides archived conversations (summary.archived)", async () => {
		const { client } = stubClient({ rows: { 2: { archived: true } } });
		const sidebar = new Sidebar(client, { maxVisible: 20 });
		await sidebar.refresh();
		const lines = sidebar.render(30).join("\n");
		expect(lines).toContain("#1");
		expect(lines).not.toContain("#2");
		expect(lines).toContain("#3");
	});

	test("shows the session name when meta carries one", async () => {
		const { client } = stubClient({ rows: { 1: { name: "acme-research" } } });
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
	test("clearNotices drops pending notice rows (fix wave F4)", () => {
		const pane = new ConversationPane();
		pane.showError("boom");
		pane.showView(view(1, []));
		expect(pane.render(60).join("\n")).toContain("[error] boom");
		pane.clearNotices();
		pane.showView(view(1, []));
		expect(pane.render(60).join("\n")).not.toContain("[error] boom");
	});

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

	test("notices cap at the 10 most recent (fix wave A5 — oldest drop silently)", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, []));
		const notes = [
			"first dropped", "second dropped", "kept three", "kept four",
			"kept five", "kept six", "kept seven", "kept eight", "kept nine",
			"kept ten", "kept eleven", "kept twelve",
		];
		for (const text of notes) pane.showNotice(text);
		const lines = pane.render(60).join("\n");
		// Exactly the last 10 render; the oldest two dropped silently.
		for (const text of notes.slice(2)) expect(lines).toContain(text);
		expect(lines).not.toContain("first dropped");
		expect(lines).not.toContain("second dropped");
		const rendered = lines.split("\n").filter((line) => line.startsWith("[notice]"));
		expect(rendered).toHaveLength(10);
		// The cap survives a stream replacement (notices re-render capped).
		pane.showView(view(1, []));
		const after = pane.render(60).join("\n");
		expect(after).not.toContain("second dropped");
		expect(after).toContain("kept twelve");
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

// ─── Fix wave: guarded actions, sidebar focus, notices, stream health ──

describe("TuiApp fix wave", () => {
	test("F1: a rejecting createConversation renders a pane error and never throws", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({
			createError: new Error("boom: server gone"),
		});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		// The sidebar's `+ new` selection is the void-ed path the finding
		// named; createAndSelect catching it is the fix (no rejection escapes).
		app.sidebar.onSelect?.("new");
		await tick();
		const lines = app.render(80).join("\n");
		expect(lines).toContain("[error]");
		expect(lines).toContain("boom: server gone");
		// The app survived and stayed on the boot conversation.
		expect(app.activeConversationId).toBe(1);
		expect(app.editor.disableSubmit).toBe(false);
	});

	test("F1: a rejecting forkConversation renders a pane error and never throws", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({
			forkError: new Error("boom: fork refused"),
		});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		// `/fork` dispatches to the same void-ed internal path the finding
		// named (ctrl+f was its keybinding; task C1b removed it — C3's
		// action layer reintroduces navigation).
		void app.forkActive();
		await tick();
		const lines = app.render(80).join("\n");
		expect(lines).toContain("boom: fork refused");
		expect(app.activeConversationId).toBe(1);
		expect(app.editor.disableSubmit).toBe(false);
	});

	test("F2 (C1b): the mouse-era sidebar — a direct selection switches the pane", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		// No ctrl+b toggle: the key is unbound and arms no routing state.
		expect(app.handleKeybinding("\u0002")).toBe(false);
		expect(app.handleKeybinding("\x1b[B")).toBe(false); // arrows fall through
		// The launcher enables mouse mode, so the switcher is driven by
		// clicks — SelectList's onSelect fires identically for click and
		// key selection; the app reacts the same either way.
		app.sidebar.handleInput("\x1b[B"); // → #2 (the list's own input seam)
		app.sidebar.handleInput("\r"); // select #2
		await tick();
		expect(app.activeConversationId).toBe(2);
		expect(watchCalls).toEqual([1, 2]);
		// No focus state to return: arrows keep falling through.
		expect(app.handleKeybinding("\x1b[B")).toBe(false);
	});

	test("F2 (C1b): a selection lands immediately — no toggle round-trip", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		app.sidebar.handleInput("\x1b[B"); // cursor moves, no selection yet
		await tick();
		expect(app.activeConversationId).toBe(1);
		expect(app.handleKeybinding("\x1b[B")).toBe(false);
	});

	test("F4: an error notice never bleeds across a conversation swap", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		// An error in conversation 1 renders…
		app.pane.showError("submit failed (400): conv-1 error");
		expect(app.render(80).join("\n")).toContain("conv-1 error");
		// …and switching conversations discards it: conversation 2's first
		// frame renders WITHOUT the stale notice.
		await app.selectConversation(2);
		watchRegistry.get(2)?.onSnapshot?.(
			view(2, [
				{ id: 2, kind: "pi.user", model: [{ role: "user", content: "conv 2 body" }] },
			]),
		);
		const lines = app.render(80).join("\n");
		expect(lines).toContain("conv 2 body");
		expect(lines).not.toContain("conv-1 error");
	});

	test("A6: the swap clears notice rows IMMEDIATELY (before any new frame arrives)", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		// Conversation 1 has entries AND a notice.
		watchRegistry.get(1)?.onSnapshot?.(
			view(1, [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: "conv 1 body" }] },
			]),
		);
		app.pane.showError("conv-1 error");
		const before = app.render(80).join("\n");
		expect(before).toContain("conv 1 body");
		expect(before).toContain("conv-1 error");
		// Switch: the clear must repaint — the notice rows are gone right
		// away, NOT only after conversation 2's first frame rebuilds.
		await app.selectConversation(2);
		const midSwap = app.render(80).join("\n");
		expect(midSwap).not.toContain("conv-1 error");
		expect(midSwap).not.toContain("conv 1 body");
		// The fresh frame still lands normally afterwards.
		watchRegistry.get(2)?.onSnapshot?.(
			view(2, [
				{ id: 2, kind: "pi.user", model: [{ role: "user", content: "conv 2 body" }] },
			]),
		);
		expect(app.render(80).join("\n")).toContain("conv 2 body");
	});

	test("F5: the current watch's onOpen reaches onWatchOpen; a stale watch's does not", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		const opens: number[] = [];
		app.onWatchOpen = () => opens.push(1);
		watchRegistry.get(1)?.onOpen?.();
		expect(opens).toEqual([1]);
		// Stale watches are generation-fenced like onError.
		const staleHandlers = watchRegistry.get(1);
		await app.selectConversation(2);
		staleHandlers?.onOpen?.();
		expect(opens).toEqual([1]);
		watchRegistry.get(2)?.onOpen?.();
		expect(opens).toEqual([1, 1]);
	});
});

describe("TuiApp C1b keybinding removals", () => {
	test("ctrl+b is unbound (C3 reintroduces navigation via the action layer)", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		// Not consumed — the key falls through to the editor.
		expect(app.handleKeybinding("\u0002")).toBe(false);
		// And it arms nothing: arrows still fall through afterwards.
		expect(app.handleKeybinding("\x1b[B")).toBe(false);
	});

	test("ctrl+f no longer forks (the action layer owns fork now)", async () => {
		const { client, forkCalls, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		expect(app.handleKeybinding("\u0006")).toBe(false); // ctrl+f
		await tick();
		expect(forkCalls).toEqual([]);
		expect(app.activeConversationId).toBe(1);
	});
});

describe("TuiApp race guards", () => {
	test("a stale frame in flight from the old watch never lands after a switch", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		// Simulate a frame in flight from the OLD watch: capture its
		// handlers before the switch (the stub's unwatch removes the
		// registry entry, but a real in-flight delivery already holds them).
		const staleHandlers = watchRegistry.get(1);
		expect(staleHandlers).toBeDefined();
		await app.selectConversation(2);
		// The new conversation's own snapshot renders first; the stale
		// delivery arrives AFTER it (the async-delivery race).
		watchRegistry.get(2)?.onSnapshot?.(
			view(2, [
				{ id: 2, kind: "pi.user", model: [{ role: "user", content: "fresh frame" }] },
			]),
		);
		staleHandlers?.onSnapshot?.(
			view(1, [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: "stale frame" }] },
			]),
		);
		// A stale ERROR must not surface either (errors carry no id).
		const staleErrors: string[] = [];
		app.onWatchError = (message) => staleErrors.push(message);
		staleHandlers?.onError?.("stale connection dropped");
		const lines = app.render(80).join("\n");
		expect(lines).not.toContain("stale frame");
		expect(lines).toContain("fresh frame");
		expect(staleErrors).toEqual([]);
	});

	test("a stale onView after a switch never renders (C2: the guarded onView path)", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		const staleHandlers = watchRegistry.get(1);
		expect(staleHandlers).toBeDefined();
		await app.selectConversation(2);
		watchRegistry.get(2)?.onView?.(
			view(2, [
				{ id: 2, kind: "pi.user", model: [{ role: "user", content: "fresh view" }] },
			]),
		);
		// The OLD watch's in-flight onView must be generation-fenced too
		// (the race-guards scenario covered only onSnapshot).
		staleHandlers?.onView?.(
			view(1, [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: "stale view" }] },
			]),
		);
		const lines = app.render(80).join("\n");
		expect(lines).toContain("fresh view");
		expect(lines).not.toContain("stale view");
	});

	test("dispose() fences stale watch handlers (A9: the watch generation bumps)", async () => {
		const { client, watchCalls, watchRegistry } = stubClient({});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		watchRegistry.get(1)?.onSnapshot?.(
			view(1, [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: "before dispose" }] },
			]),
		);
		expect(app.render(80).join("\n")).toContain("before dispose");
		// Capture the handlers, dispose, then fire the stale delivery — the
		// generation bump must fence it exactly as a switch does.
		const staleHandlers = watchRegistry.get(1);
		app.dispose();
		staleHandlers?.onSnapshot?.(
			view(1, [
				{ id: 2, kind: "pi.user", model: [{ role: "user", content: "after dispose" }] },
			]),
		);
		expect(app.render(80).join("\n")).not.toContain("after dispose");
	});
	test("the composer cannot submit during a swap (createAndSelect's async window)", async () => {
		const gate = makeGate();
		const { client, submitCalls, watchCalls, watchRegistry } = stubClient({
			holdCreate: gate,
		});
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(watchRegistry, watchCalls),
		});
		await app.refresh();
		const swap = app.createAndSelect();
		await tick(); // the swap reached (and is parked in) createConversation
		expect(app.editor.disableSubmit).toBe(true);
		// Even a PROGRAMMATIC onSubmit (bypassing the editor's own gate)
		// must no-op — and must not destroy the draft.
		app.editor.setText("mid-swap draft");
		app.editor.onSubmit?.("mid-swap draft");
		expect(submitCalls).toEqual([]);
		expect(app.editor.getText()).toBe("mid-swap draft");
		gate.release();
		await swap;
		expect(app.editor.disableSubmit).toBe(false);
		// After the swap completes, submits flow to the NEW conversation.
		app.editor.setText("after swap");
		app.editor.onSubmit?.("after swap");
		await tick();
		expect(submitCalls).toEqual([{ id: 4, text: "after swap" }]);
	});
	test("the composer cannot submit during selectConversation's window", async () => {
		const { client, submitCalls, watchCalls, watchRegistry } = stubClient({});
		// selectConversation's try block has no awaits with the stub, so it
		// completes synchronously — sample disableSubmit DURING the swap by
		// firing a submit from inside the watch factory (invoked mid-swap).
		let app: TuiApp | undefined;
		const samplingWatch = (
			conversationId: number,
			handlers: WatchHandlers,
		): Unwatch => {
			if (conversationId === 2) {
				expect(app?.editor.disableSubmit).toBe(true);
				app?.editor.setText("during select");
				app?.editor.onSubmit?.("during select");
			}
			watchCalls.push(conversationId);
			watchRegistry.set(conversationId, handlers);
			return () => {
				watchRegistry.delete(conversationId);
			};
		};
		app = new TuiApp(client, { tui: fakeTui, watch: samplingWatch });
		await app.refresh();
		await app.selectConversation(2);
		expect(submitCalls).toEqual([]);
		// The draft survived the no-op submit; the editor is re-enabled.
		expect(app.editor.getText()).toBe("during select");
		expect(app.editor.disableSubmit).toBe(false);
		app.editor.onSubmit?.("settled");
		await tick();
		expect(submitCalls).toEqual([{ id: 2, text: "settled" }]);
	});
});
