/**
 * The composer behaviors (Task 7) against a stub client: submit is
 * fire-and-forget (idle → no `whenBusy`; a live run → `whenBusy: "steer"`),
 * Esc during a live run aborts, a `/`-prefixed input routes through the
 * slash-command catalog (fetched once, cached), unknown commands show a
 * clear error, and the immediate error path (a 400 on the POST, an abort
 * racing settlement) renders visibly in the conversation pane instead of
 * wedging or crashing.
 */

import { describe, expect, test } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { StatusBar } from "../src/ui/status-bar.js";
import { plainTuiTheme } from "../src/theme.js";
import { TuiApp } from "../src/ui/app.js";
import {
	SigrunApiError,
	type ConversationList,
	type ConversationSummary,
	type ConversationViewWire,
	type SigrunClient,
	type WhenBusyMode,
} from "../src/api.js";
import type { Unwatch, WatchHandlers, WatchOptions } from "../src/sse.js";

// ─── Stub client (the app.test.ts idiom, extended for Task 4's surface) ──

function summary(id: number): ConversationSummary {
	// C2's sidebar tree orders by recency; a distinct stamp per id keeps
	// the boot listing deterministic with the LOWEST id newest (row 0,
	// the app's boot selection) — the pre-C2 insertion-order behavior.
	return {
		id,
		root: false,
		archived: false,
		pinned: false,
		access: "write",
		lastActivityAt: new Date(2026, 0, 1, 0, 0, -id).toISOString(),
	};
}

function view(id: number, entries: unknown[], busy = false): ConversationViewWire {
	return {
		conversation: { id },
		entries,
		docs: {},
		steer: { busy, queued: 0 },
	} as unknown as ConversationViewWire;
}

/** The catalog the stub serves (a subset of the server's `SLASH_COMMANDS`,
 *  plus ONE extension-contributed entry — W5 Task 3). */
const STUB_COMMANDS = [
	{ name: "new", description: "Start a new conversation", endpoint: { method: "POST", path: "/v1/conversations" } },
	{ name: "fork", description: "Fork this conversation", argsHint: "[at]", endpoint: { method: "POST", path: "/v1/conversations/:id/fork" } },
	{ name: "compact", description: "Compact this conversation", argsHint: "[instructions]", endpoint: { method: "POST", path: "/v1/conversations/:id/compact" } },
	// In the catalog but with no client method the composer can drive.
	{ name: "export", description: "Download this conversation as JSONL", endpoint: { method: "GET", path: "/v1/conversations/:id/export" } },
	// An extension-contributed command (the invoke endpoint drives it).
	{ name: "hello", description: "Say hello", argsHint: "<name>", extension: "fixture-ext", endpoint: { method: "POST", path: "/v1/conversations/:id/commands/hello" } },
] as const;

function stubClient(init?: {
	/** The abort stub's behavior per call (default: resolves "aborted"). */
	abortResult?: () => Promise<unknown>;
	/** The submit stub's failure (default: resolves settled). */
	submitResult?: () => Promise<unknown>;
	/** Start with no conversations (the no-active-conversation cases). */
	empty?: boolean;
}) {
	const submitCalls: { id: number; text: string; whenBusy: WhenBusyMode | undefined }[] = [];
	const abortCalls: number[] = [];
	const compactCalls: { id: number; instructions: string | undefined }[] = [];
	const forkCalls: number[] = [];
	const invokeCalls: { id: number; name: string; args: string | undefined }[] = [];
	let getCommandsCalls = 0;
	let forkSerial = 100;
	const watchCalls: number[] = [];
	const watchRegistry = new Map<number, WatchHandlers>();
	const listed: ConversationSummary[] = init?.empty === true ? [] : [summary(1), summary(2), summary(3)];
	const client = {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({ conversations: [...listed] });
		},
		getMeta(_id: number) {
			return Promise.resolve({
				pinned: false,
				access: "write",
				tagged: [],
				archived: false,
				draft: { text: "", attachments: [] },
				source: "user",
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
		submit(id: number, text: string, whenBusy?: WhenBusyMode) {
			submitCalls.push({ id, text, whenBusy });
			return init?.submitResult !== undefined
				? init.submitResult()
				: Promise.resolve({ id: 1, conversationId: id, type: "user", status: "answered" });
		},
		abort(id: number) {
			abortCalls.push(id);
			return init?.abortResult !== undefined
				? (init.abortResult() as Promise<{ result: string; submissionId: number }>)
				: Promise.resolve({ result: "aborted", submissionId: 1 });
		},
		compact(id: number, instructions?: string) {
			compactCalls.push({ id, instructions });
			return Promise.resolve({ taskId: 7 });
		},
		runCommand(id: number, name: string, args?: string) {
			invokeCalls.push({ id, name, args });
			return Promise.resolve({ notice: `hi ${args ?? ""}` });
		},
		getCommands() {
			getCommandsCalls += 1;
			return Promise.resolve({ commands: [...STUB_COMMANDS] });
		},
		getConversation(id: number) {
			return Promise.resolve(view(id, []));
		},
	};
	return {
		client: client as unknown as SigrunClient,
		submitCalls,
		abortCalls,
		compactCalls,
		forkCalls,
		invokeCalls,
		watchCalls,
		watchRegistry,
		getCommandsCalls: () => getCommandsCalls,
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

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

/** Flush the microtask queue (one macrotask drains every chained promise). */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function boot(init?: Parameters<typeof stubClient>[0]) {
	const stub = stubClient(init);
	const app = new TuiApp(stub.client, {
		tui: fakeTui,
		watch: stubWatch(stub.watchRegistry, stub.watchCalls),
	});
	await app.refresh();
	return { app, ...stub };
}

// ─── Submit: fire-and-forget + steer ────────────────────────────────────

describe("composer submit", () => {
	test("idle submit POSTs without whenBusy", async () => {
		const { app, submitCalls } = await boot();
		app.editor.setText("hello");
		app.editor.onSubmit?.("hello");
		await flush();
		expect(submitCalls).toEqual([{ id: 1, text: "hello", whenBusy: undefined }]);
	});

	test("submit while a run is live queues a steer (whenBusy: steer)", async () => {
		const { app, submitCalls, watchRegistry } = await boot();
		// A stream frame marks the conversation busy.
		watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		app.editor.setText("steer it");
		app.editor.onSubmit?.("steer it");
		await flush();
		expect(submitCalls).toEqual([{ id: 1, text: "steer it", whenBusy: "steer" }]);
	});

	test("busy state tracks the LATEST frame (a settled frame clears the steer)", async () => {
		const { app, submitCalls, watchRegistry } = await boot();
		watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		watchRegistry.get(1)?.onView?.(view(1, [], false));
		app.editor.setText("after settle");
		app.editor.onSubmit?.("after settle");
		await flush();
		expect(submitCalls).toEqual([{ id: 1, text: "after settle", whenBusy: undefined }]);
	});

	test("a 400 response renders the server's error in the pane (Review Focus 2)", async () => {
		const { app } = await boot({
			submitResult: () =>
				Promise.reject(
					new SigrunApiError("POST", "/v1/conversations/1/submissions", 400, {
						error: "unserved_model",
						model: "acme/widget-1",
					}),
				),
		});
		app.editor.setText("ship it");
		app.editor.onSubmit?.("ship it");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).toContain("[error]");
		expect(lines).toContain("400");
		expect(lines).toContain("unserved_model");
	});

	test("a failed submit never wedges the composer (the next submit flows)", async () => {
		let fail = true;
		const { app, submitCalls } = await boot({
			submitResult: () =>
				fail
					? Promise.reject(new SigrunApiError("POST", "/v1/conversations/1/submissions", 400, { error: "invalid_input" }))
					: Promise.resolve({ id: 2, conversationId: 1, type: "user", status: "answered" }),
		});
		app.editor.onSubmit?.("first");
		await flush();
		expect(app.editor.disableSubmit).toBe(false);
		fail = false;
		app.editor.onSubmit?.("second");
		await flush();
		expect(submitCalls.map((call) => call.text)).toEqual(["first", "second"]);
	});

	test("pane error lines survive a stream replacement (notices are not stream state)", async () => {
		const { app, watchRegistry } = await boot({
			submitResult: () =>
				Promise.reject(new SigrunApiError("POST", "/v1/conversations/1/submissions", 400, { error: "invalid_input" })),
		});
		app.editor.onSubmit?.("bad");
		await flush();
		expect(app.pane.render(60).join("\n")).toContain("invalid_input");
		// The next full revision must not erase the error line.
		watchRegistry.get(1)?.onSnapshot?.(
			view(1, [{ id: 1, kind: "pi.user", model: [{ role: "user", content: "fresh frame" }] }]),
		);
		const lines = app.pane.render(60).join("\n");
		expect(lines).toContain("fresh frame");
		expect(lines).toContain("invalid_input");
	});
});

// ─── Esc → abort ─────────────────────────────────────────────────────────

describe("composer abort (Esc)", () => {
	test("Esc during a live run calls abort(id) and is consumed", async () => {
		const { app, abortCalls, watchRegistry } = await boot();
		watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		expect(app.handleKeybinding("\x1b")).toBe(true);
		expect(abortCalls).toEqual([1]);
		await flush();
	});

	test("Esc while idle neither aborts nor is consumed (the editor may want it)", async () => {
		const { app, abortCalls } = await boot();
		expect(app.handleKeybinding("\x1b")).toBe(false);
		expect(abortCalls).toEqual([]);
	});

	test("an abort that landed (result: aborted) stays silent — the stream carries it", async () => {
		const { app, watchRegistry } = await boot({
			abortResult: () => Promise.resolve({ result: "aborted", submissionId: 3 }),
		});
		watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		app.handleKeybinding("\x1b");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).not.toContain("[error]");
		expect(lines).not.toContain("settled");
	});

	test("an abort racing settlement (200 settled) surfaces cleanly, no crash (Review Focus 3)", async () => {
		const { app, watchRegistry } = await boot({
			abortResult: () => Promise.resolve({ result: "settled", submissionId: 3 }),
		});
		watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		app.handleKeybinding("\x1b");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).not.toContain("[error]");
		expect(lines).toContain("already settled");
		expect(app.editor.disableSubmit).toBe(false);
	});

	test("an abort racing settlement (404 no_active_submission) surfaces cleanly", async () => {
		const { app, watchRegistry } = await boot({
			abortResult: () =>
				Promise.reject(
					new SigrunApiError("POST", "/v1/conversations/1/abort", 404, { error: "no_active_submission" }),
				),
		});
		watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		app.handleKeybinding("\x1b");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).not.toContain("[error]");
		expect(lines).toContain("no active run");
	});

	test("an abort failure other than the settled race renders an error line", async () => {
		const { app, watchRegistry } = await boot({
			abortResult: () =>
				Promise.reject(new SigrunApiError("POST", "/v1/conversations/1/abort", 500, { error: "internal" })),
		});
		watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		app.handleKeybinding("\x1b");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).toContain("[error]");
		expect(lines).toContain("abort");
		expect(lines).toContain("500");
	});
});

// ─── Slash commands ─────────────────────────────────────────────────────

describe("composer slash commands", () => {
	test("/fork routes to the fork path (catalog name → endpoint mapping)", async () => {
		const { app, forkCalls, getCommandsCalls } = await boot();
		app.editor.onSubmit?.("/fork");
		await flush();
		expect(getCommandsCalls()).toBe(1);
		expect(forkCalls).toEqual([1]);
		expect(app.activeConversationId).toBe(101);
	});

	test("/fork <at> notices that at-entry selection is unsupported, then forks at latest (fix wave A1)", async () => {
		const { app, forkCalls } = await boot();
		app.editor.onSubmit?.("/fork 3");
		await flush();
		// The argument is NOT silently dropped: a notice names the limit
		// (rendered lines wrap, so assert the unwrapped halves)…
		const lines = app.pane.render(80).join("\n");
		expect(lines).toContain("fork at-entry selection is not supported by the TUI composer");
		expect(lines).toContain("at latest");
		// …and the fork still happens at the latest entry.
		expect(forkCalls).toEqual([1]);
		expect(app.activeConversationId).toBe(101);
	});

	test("/new creates a conversation and selects it (C3: the create dispatch)", async () => {
		const { app, watchCalls } = await boot();
		app.editor.onSubmit?.("/new");
		await flush();
		expect(app.activeConversationId).toBe(4);
		expect(watchCalls).toEqual([1, 4]);
	});

	test("a bare `/` is the empty slash command — a clear error, nothing dispatched (C3)", async () => {
		const { app, submitCalls, forkCalls, compactCalls, getCommandsCalls } = await boot();
		app.editor.onSubmit?.("/");
		await flush();
		expect(app.pane.render(60).join("\n")).toContain("empty slash command");
		expect(getCommandsCalls()).toBe(0);
		expect(submitCalls).toEqual([]);
		expect(forkCalls).toEqual([]);
		expect(compactCalls).toEqual([]);
	});

	test("/compact hits compact (with the argument as instructions)", async () => {
		const { app, compactCalls } = await boot();
		app.editor.onSubmit?.("/compact keep the acme thread");
		await flush();
		expect(compactCalls).toEqual([{ id: 1, instructions: "keep the acme thread" }]);
	});

	test("/compact without an argument sends no instructions", async () => {
		const { app, compactCalls } = await boot();
		app.editor.onSubmit?.("/compact");
		await flush();
		expect(compactCalls).toEqual([{ id: 1, instructions: undefined }]);
	});

	test("the catalog is fetched once and cached across commands", async () => {
		const { app, getCommandsCalls } = await boot();
		app.editor.onSubmit?.("/compact");
		await flush();
		app.editor.onSubmit?.("/fork");
		await flush();
		expect(getCommandsCalls()).toBe(1);
	});

	test("an unknown command shows a clear error and calls nothing", async () => {
		const { app, submitCalls, forkCalls, compactCalls } = await boot();
		app.editor.onSubmit?.("/nosuch");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).toContain("unknown command: /nosuch");
		expect(submitCalls).toEqual([]);
		expect(forkCalls).toEqual([]);
		expect(compactCalls).toEqual([]);
	});

	test("a catalog command the composer cannot drive shows a clear error", async () => {
		const { app } = await boot();
		app.editor.onSubmit?.("/export");
		await flush();
		expect(app.pane.render(60).join("\n")).toContain("/export is not supported by the TUI composer");
	});

	test("an extension command POSTs the invoke route and flashes the returned notice in the status bar (W5 Task 3)", async () => {
		const stub = stubClient();
		const registry = new Map<number, WatchHandlers>();
		const app = new TuiApp(stub.client, { tui: fakeTui, watch: stubWatch(registry, stub.watchCalls) });
		// The notice lands in the STATUS BAR (the Task 3 client surface), so
		// the boot attaches one (the actions.test.ts pattern) — without it
		// #flashStatus no-ops and the notice would be unobservable.
		const statusBar = new StatusBar({ theme: plainTuiTheme(), messageMs: 60_000 });
		app.setStatusBar(statusBar);
		await app.refresh();
		app.editor.onSubmit?.("/hello bob");
		await flush();
		expect(stub.invokeCalls).toEqual([{ id: 1, name: "hello", args: "bob" }]);
		expect(stripAnsi(statusBar.render(120)[0] ?? "")).toContain("hi bob");
	});

	test("an extension command failing on the invoke route shows the server's error", async () => {
		const stub = stubClient();
		(stub.client as unknown as { runCommand: unknown }).runCommand = () =>
			Promise.reject(
				new SigrunApiError("POST", "/v1/conversations/1/commands/hello", 500, {
					error: "command_failed",
				extension: "fixture-ext",
			}),
		);
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		app.editor.onSubmit?.("/hello bob");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).toContain("command_failed");
		expect(lines).toContain("fixture-ext");
	});

	test("a command needing a conversation fails clearly when none is active", async () => {
		const { app, compactCalls } = await boot({ empty: true });
		app.editor.onSubmit?.("/compact");
		await flush();
		expect(compactCalls).toEqual([]);
		expect(app.pane.render(60).join("\n")).toContain("/compact needs an active conversation");
	});

	test("slash routing is case-insensitive and consumes the input line", async () => {
		const { app, forkCalls } = await boot();
		app.editor.setText("/FORK");
		app.editor.onSubmit?.("/FORK");
		await flush();
		expect(forkCalls).toEqual([1]);
		expect(app.editor.getText()).toBe("");
	});

	test("plain text starting mid-line with a slash is NOT a command", async () => {
		const { app, submitCalls, getCommandsCalls } = await boot();
		app.editor.onSubmit?.("look at /etc/hosts");
		await flush();
		expect(getCommandsCalls()).toBe(0);
		expect(submitCalls.map((call) => call.text)).toEqual(["look at /etc/hosts"]);
	});

	test("a catalog fetch failure surfaces an error and retries next time", async () => {
		const stub = stubClient();
		let fail = true;
		const flaky = {
			...stub.client,
			getCommands() {
				return fail
					? Promise.reject(new SigrunApiError("GET", "/v1/commands", 500, { error: "internal" }))
					: Promise.resolve({ commands: [...STUB_COMMANDS] });
			},
		} as unknown as SigrunClient;
		const app = new TuiApp(flaky, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		app.editor.onSubmit?.("/fork");
		await flush();
		expect(app.pane.render(60).join("\n")).toContain("[error]");
		expect(stub.forkCalls).toEqual([]);
		// The rejection is not cached: the next command retries and succeeds.
		fail = false;
		app.editor.onSubmit?.("/fork");
		await flush();
		expect(stub.forkCalls).toEqual([1]);
	});
});
