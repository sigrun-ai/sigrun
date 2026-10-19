/**
 * The action layer (Task C3): TuiApp implements ActionHost — fork-here
 * forks at the focused turn's entry and selects the fork, edit-here
 * follows the web B4 rule (previous-entry fork, else create; draft
 * prefill + composer text), cycle-thinking walks the level order via
 * configure, and `/model <id>` / `/thinking <level>` reach configure.
 */

import { describe, expect, test } from "vitest";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { TuiApp } from "../src/ui/app.js";
import { StatusBar } from "../src/ui/status-bar.js";
import { createStandardKeymap } from "../src/keymaps/standard.js";
import { createTuiTheme } from "../src/theme.js";
import type {
	CommandsResponse,
	ConversationList,
	ConversationSummary,
	ConversationViewWire,
	SessionMetaPatch,
	SigrunClient,
} from "../src/api.js";
import type { Unwatch, WatchHandlers, WatchOptions } from "../src/sse.js";

// ─── Stub client ────────────────────────────────────────────────────────

function summary(id: number): ConversationSummary {
	return {
		id,
		root: false,
		entryCount: 0,
		archived: false,
		pinned: false,
		access: "write",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
	};
}

function userEntry(id: number, text: string): unknown {
	return { id, kind: "pi.user", model: [{ role: "user", content: text }] };
}

function view(
	id: number,
	entries: unknown[],
	docs: Record<string, unknown> = {},
): ConversationViewWire {
	return {
		conversation: { id },
		entries,
		docs,
		steer: { busy: false, queued: 0 },
	} as unknown as ConversationViewWire;
}

function stubClient() {
	const listed: ConversationSummary[] = [summary(1), summary(2)];
	const forkCalls: { id: number; at?: number }[] = [];
	const patchCalls: { id: number; patch: SessionMetaPatch }[] = [];
	const configureCalls: { id: number; body: unknown }[] = [];
	let nextId = 100;
	const client = {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({ conversations: [...listed] });
		},
		getConversation(id: number) {
			return Promise.resolve(view(id, []));
		},
		createConversation() {
			nextId += 1;
			listed.push(summary(nextId));
			return Promise.resolve({ id: nextId, view: view(nextId, []) });
		},
		forkConversation(id: number, at?: number) {
			forkCalls.push({ id, at });
			nextId += 1;
			listed.push(summary(nextId));
			return Promise.resolve({ id: nextId, view: view(nextId, []) });
		},
		patchMeta(id: number, patch: SessionMetaPatch) {
			patchCalls.push({ id, patch });
			return Promise.resolve({});
		},
		configure(id: number, body: unknown) {
			configureCalls.push({ id, body });
			const thinking =
				typeof body === "object" && body !== null && "thinking" in body
					? String((body as { thinking: unknown }).thinking)
					: "off";
			return Promise.resolve({ thinkingLevel: thinking });
		},
		listModels() {
			return Promise.resolve({ models: [] });
		},
		getCommands(): Promise<CommandsResponse> {
			return Promise.resolve({
				commands: [
					{
						name: "model",
						description: "Switch this conversation's model",
						argsHint: "<provider/model>",
						endpoint: { method: "POST", path: "/v1/conversations/:id/configure" },
					},
					{
						name: "thinking",
						description: "Set this conversation's thinking level",
						argsHint: "<level>",
						endpoint: { method: "POST", path: "/v1/conversations/:id/configure" },
					},
				],
			});
		},
		submit() {
			return Promise.resolve({ id: 1, conversationId: 1, type: "user", status: "answered" });
		},
	};
	return {
		client: client as unknown as SigrunClient,
		forkCalls,
		patchCalls,
		configureCalls,
	};
}

function stubWatch(
	registry?: Map<number, WatchHandlers>,
): (
	conversationId: number,
	handlers: WatchHandlers,
	options: WatchOptions,
) => Unwatch {
	return (conversationId, handlers) => {
		registry?.set(conversationId, handlers);
		return () => {
			registry?.delete(conversationId);
		};
	};
}

const fakeTui = {
	requestRender: () => {},
	setFocus: () => {},
	terminal: { write: () => {} },
	showOverlay: () => ({ hide: () => {} }),
} as unknown as TUI;

/** Yield microtasks so an `async` dispatch's awaits settle. */
async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/** Boot an app against the stub with `entries` already in the pane. */
async function bootWith(entries: unknown[]): Promise<{
	app: TuiApp;
	stub: ReturnType<typeof stubClient>;
}> {
	const stub = stubClient();
	const app = new TuiApp(stub.client, { tui: fakeTui, watch: stubWatch() });
	await app.refresh();
	// Recency order boots the newest id (2); the pane content is id 2's.
	app.pane.showView(view(2, entries));
	return { app, stub };
}

// ─── fork-here ──────────────────────────────────────────────────────────

describe("dispatch: fork-here", () => {
	test("forks at the focused turn's entry and selects the fork", async () => {
		const { app, stub } = await bootWith([
			userEntry(1, "first question"),
			userEntry(2, "second question"),
		]);
		await app.dispatch({ type: "focus", target: "transcript" });
		app.pane.setFocus(1); // the second user turn (entry 2)
		await app.dispatch({ type: "fork-here" });
		expect(stub.forkCalls).toEqual([{ id: 2, at: 2 }]);
		expect(app.activeConversationId).toBe(101);
	});
});

// ─── edit-here ──────────────────────────────────────────────────────────

// The fork point comes from the TURNS list, never entry-id arithmetic:
// pi-durable mints ids from one global counter, so these fixtures use
// non-dense ids — an `entryId - 1` implementation cannot pass them.
describe("dispatch: edit-here", () => {
	test("first user turn: creates (no fork point), prefills the draft + composer", async () => {
		const { app, stub } = await bootWith([userEntry(41, "original prompt")]);
		await app.dispatch({ type: "focus", target: "transcript" });
		app.pane.setFocus(0);
		await app.dispatch({ type: "edit-here" });
		expect(stub.forkCalls).toEqual([]);
		expect(stub.patchCalls).toEqual([
			{ id: 101, patch: { draft: { text: "original prompt" } } },
		]);
		expect(app.activeConversationId).toBe(101);
		expect(app.editor.getText()).toBe("original prompt");
	});

	test("a later user turn: forks at the PREVIOUS turn's entry, prefills the draft", async () => {
		const { app, stub } = await bootWith([
			userEntry(41, "first"),
			userEntry(57, "reword me"),
			userEntry(90, "third"),
		]);
		await app.dispatch({ type: "focus", target: "transcript" });
		app.pane.setFocus(1); // the second user turn (entry 57)
		await app.dispatch({ type: "edit-here" });
		expect(stub.forkCalls).toEqual([{ id: 2, at: 41 }]);
		expect(stub.patchCalls).toEqual([
			{ id: 101, patch: { draft: { text: "reword me" } } },
		]);
		expect(app.editor.getText()).toBe("reword me");
	});

	test("the last user turn forks at its predecessor's entry, not its own minus one", async () => {
		const { app, stub } = await bootWith([
			userEntry(41, "first"),
			userEntry(57, "middle"),
			userEntry(90, "reword me"),
		]);
		await app.dispatch({ type: "focus", target: "transcript" });
		app.pane.setFocus(2); // the third user turn (entry 90)
		await app.dispatch({ type: "edit-here" });
		expect(stub.forkCalls).toEqual([{ id: 2, at: 57 }]);
	});
});

// ─── cycle-thinking ─────────────────────────────────────────────────────

describe("dispatch: cycle-thinking", () => {
	test("from off it configures minimal, then walks the order", async () => {
		const { app, stub } = await bootWith([]);
		await app.dispatch({ type: "cycle-thinking" });
		expect(stub.configureCalls).toEqual([{ id: 2, body: { thinking: "minimal" } }]);
		await app.dispatch({ type: "cycle-thinking" });
		expect(stub.configureCalls[1]).toEqual({ id: 2, body: { thinking: "low" } });
	});

	test("after xhigh it wraps to off", async () => {
		const { app, stub } = await bootWith([]);
		for (let i = 0; i < 6; i += 1) await app.dispatch({ type: "cycle-thinking" });
		expect(stub.configureCalls.at(-1)).toEqual({ id: 2, body: { thinking: "off" } });
	});

	test("the pi.agent doc seeds the cycle's start level (no dead off default)", async () => {
		const registry = new Map<number, WatchHandlers>();
		const stub = stubClient();
		const app = new TuiApp(stub.client, { tui: fakeTui, watch: stubWatch(registry) });
		await app.refresh();
		registry.get(2)?.onView?.(
			view(2, [], {
				"pi.agent": {
					model: { provider: "faux", modelId: "m" },
					thinkingLevel: "high",
				},
			}),
		);
		await app.dispatch({ type: "cycle-thinking" });
		expect(stub.configureCalls).toEqual([{ id: 2, body: { thinking: "xhigh" } }]);
	});
});

// ─── /model and /thinking ───────────────────────────────────────────────

describe("slash commands: /model and /thinking", () => {
	test("/model faux/m2 calls configure with the model", async () => {
		const { app, stub } = await bootWith([]);
		await app.dispatch({ type: "run-command", line: "/model faux/m2" });
		expect(stub.configureCalls).toEqual([{ id: 2, body: { model: "faux/m2" } }]);
	});

	test("/thinking high calls configure with the level", async () => {
		const { app, stub } = await bootWith([]);
		await app.dispatch({ type: "run-command", line: "/thinking high" });
		expect(stub.configureCalls).toEqual([{ id: 2, body: { thinking: "high" } }]);
	});
});

// ─── move / open / prompt-jump ──────────────────────────────────────────

describe("dispatch: navigation", () => {
	test("move drives the sidebar cursor in list focus", async () => {
		const { app } = await bootWith([]);
		await app.dispatch({ type: "focus", target: "list" });
		expect(app.sidebar.cursor).toBe(0);
		await app.dispatch({ type: "move", delta: 1 });
		expect(app.sidebar.cursor).toBe(1);
	});

	test("move drives the pane focus index in transcript focus", async () => {
		const { app } = await bootWith([userEntry(1, "a"), userEntry(2, "b")]);
		await app.dispatch({ type: "focus", target: "transcript" });
		await app.dispatch({ type: "move", delta: -1 });
		expect(app.pane.focusIndex).toBe(1);
		await app.dispatch({ type: "move", delta: -1 });
		expect(app.pane.focusIndex).toBe(0);
		await app.dispatch({ type: "move", delta: -1 });
		expect(app.pane.focusIndex).toBe(0); // clamped
	});

	test("open on the list selects the cursor row", async () => {
		const { app } = await bootWith([]);
		// The stub lists ids 1 and 2 (recency order boots id 2 active).
		expect(app.activeConversationId).toBe(2);
		await app.dispatch({ type: "focus", target: "list" });
		await app.dispatch({ type: "move", delta: 1 }); // cursor onto id 1
		await app.dispatch({ type: "open" });
		expect(app.activeConversationId).toBe(1);
	});

	test("prompt-jump lands on the previous user turn", async () => {
		const { app } = await bootWith([
			userEntry(1, "first"),
			{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }] },
			userEntry(3, "second"),
		]);
		await app.dispatch({ type: "focus", target: "transcript" });
		await app.dispatch({ type: "prompt-jump", delta: -1 });
		expect(app.pane.focusIndex).toBe(2); // the latest user turn
		await app.dispatch({ type: "prompt-jump", delta: -1 });
		expect(app.pane.focusIndex).toBe(0);
	});
});

// ─── status bar: config segments + the mouse surface ────────────────────

const theme = createTuiTheme({
	palette: "polar-night",
	accent: "baltic-amber",
	mode: "dark",
	colorMode: "truecolor",
});

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

function click(x: number, width: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y: 0,
		screenX: x,
		screenY: 0,
		width,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

/** Boot with a StatusBar attached and one pi.agent frame delivered. */
async function bootWithStatusBar(): Promise<{
	app: TuiApp;
	stub: ReturnType<typeof stubClient>;
	statusBar: StatusBar;
}> {
	const registry = new Map<number, WatchHandlers>();
	const stub = stubClient();
	const app = new TuiApp(stub.client, { tui: fakeTui, watch: stubWatch(registry) });
	const statusBar = new StatusBar({ theme });
	statusBar.set({ conversation: "", hints: [] });
	app.setStatusBar(statusBar);
	await app.refresh();
	registry.get(2)?.onView?.(
		view(2, [], {
			"pi.agent": {
				model: { provider: "faux", modelId: "m" },
				thinkingLevel: "high",
			},
		}),
	);
	return { app, stub, statusBar };
}

describe("status bar: config segments + mouse surface", () => {
	test("a frame's pi.agent doc populates the model/thinking segments", async () => {
		const { statusBar } = await bootWithStatusBar();
		const line = stripAnsi(statusBar.render(120)[0] ?? "");
		expect(line).toContain("faux/m");
		expect(line).toContain("high");
	});

	test("the thinking segment cycles; the model segment opens the model picker", async () => {
		const { app, stub, statusBar } = await bootWithStatusBar();
		// Layout: empty conversation name → the cluster starts at column 2:
		// "faux/m" [2,8), separator, "high" [11,15).
		expect(statusBar.handleMouse(click(12, 120))).toEqual({ handled: true });
		await tick();
		expect(stub.configureCalls).toEqual([{ id: 2, body: { thinking: "xhigh" } }]);
		expect(statusBar.handleMouse(click(3, 120))).toEqual({ handled: true });
		expect(app.overlayOpen).toBe(true); // the model picker opened
	});

	test("a focus change repaints the keymap's hints (C5)", async () => {
		const { app, statusBar } = await bootWithStatusBar();
		const keymap = createStandardKeymap();
		app.hintsProvider = () => keymap.hints(app.keyContext());
		app.refreshHints();
		expect(statusBar.getState().hints).toEqual(["Tab focus", "^P chats", "? keys"]);
		await app.dispatch({ type: "focus", target: "transcript" });
		expect(statusBar.getState().hints).toEqual([
			"enter open",
			"y copy",
			"f fork",
			"e edit",
			"/ search",
			"? help",
		]);
	});
});

// ─── the overlay guard (the pre-keymap seams) ───────────────────────────

describe("handleKeybinding: the overlay guard", () => {
	test("an open picker fences busy Esc and ctrl+o", async () => {
		const { app } = await bootWith([]);
		await app.dispatch({ type: "picker", kind: "conversation" });
		expect(app.overlayOpen).toBe(true);
		// Esc must NOT abort behind the picker; ctrl+o must NOT arm answer mode.
		expect(app.handleKeybinding("\x1b")).toBe(false);
		expect(app.handleKeybinding("\x0f")).toBe(false);
	});

	test("the search overlay still owns every key (it precedes the guard)", async () => {
		const { app } = await bootWith([]);
		await app.dispatch({ type: "search", direction: "forward" });
		expect(app.overlayOpen).toBe(true);
		expect(app.handleKeybinding("a")).toBe(true); // extends the query
		expect(app.handleKeybinding("\x1b")).toBe(true); // Esc closes the search
		expect(app.overlayOpen).toBe(false);
	});

	test("C-g closes the search overlay (the emacs cancel)", async () => {
		const { app } = await bootWith([]);
		await app.dispatch({ type: "search", direction: "forward" });
		expect(app.overlayOpen).toBe(true);
		expect(app.handleKeybinding("\x07")).toBe(true);
		expect(app.overlayOpen).toBe(false);
	});

	test("C-s / C-r walk the matches while the search overlay stays open", async () => {
		const { app } = await bootWith([
			userEntry(41, "needle one"),
			userEntry(57, "needle two"),
		]);
		await app.dispatch({ type: "search", direction: "forward" });
		for (const char of "needle") app.handleKeybinding(char);
		// C-s walks forward to the first match; again to the second.
		expect(app.handleKeybinding("\x13")).toBe(true);
		expect(app.pane.focusIndex).toBe(0);
		expect(app.handleKeybinding("\x13")).toBe(true);
		expect(app.pane.focusIndex).toBe(1);
		// C-r walks back; the overlay stays open throughout.
		expect(app.handleKeybinding("\x12")).toBe(true);
		expect(app.pane.focusIndex).toBe(0);
		expect(app.overlayOpen).toBe(true);
	});
});
