/**
 * The TUI notices surface (notices Task 8): the inline line shows the
 * current conversation's newest notice, the dismiss key clears it, the
 * status-bar count follows the list, and the overlay runs the actions
 * (Enter on an extension action POSTs the action route; `open` prints
 * the URL). Plus the ambient chrome's navigate/open action routing.
 */

import { describe, expect, test } from "vitest";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { UserNotice } from "@sigrun/shared/notices";
import type {
	ConversationList,
	ConversationSummary,
	ConversationViewWire,
	SigrunClient,
} from "../src/api.js";
import type { Unwatch, WatchHandlers } from "../src/sse.js";
import { TuiApp } from "../src/ui/app.js";
import { AmbientChrome } from "../src/ui/ambient.js";
import { NoticeChrome } from "../src/ui/notices.js";
import { StatusBar } from "../src/ui/status-bar.js";
import { plainTuiTheme } from "../src/theme.js";

// ─── Fixtures ───────────────────────────────────────────────────────────

function notice(id: string, init?: Partial<UserNotice>): UserNotice {
	return {
		id,
		user: "alice",
		owner: "acme-notices",
		title: `notice ${id}`,
		at: "2026-01-01T00:00:00.000Z",
		...init,
	};
}

function summary(id: number): ConversationSummary {
	return {
		id,
		root: false,
		archived: false,
		pinned: false,
		access: "write",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
	};
}

function view(id: number): ConversationViewWire {
	return {
		conversation: { id },
		entries: [],
		docs: {},
		steer: { busy: false, queued: 0 },
	} as unknown as ConversationViewWire;
}

function stubClient(served: { notices: UserNotice[] }) {
	const dismissCalls: string[] = [];
	const actionCalls: { id: string; actionId: string }[] = [];
	const client = {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({ conversations: [summary(1), summary(2)] });
		},
		getConversation(id: number) {
			return Promise.resolve(view(id));
		},
		listNotices() {
			return Promise.resolve({ notices: [...served.notices] });
		},
		dismissNotice(id: string) {
			dismissCalls.push(id);
			served.notices = served.notices.filter((one) => one.id !== id);
			return Promise.resolve(undefined);
		},
		dismissAllNotices() {
			served.notices = [];
			return Promise.resolve(undefined);
		},
		runNoticeAction(id: string, actionId: string) {
			actionCalls.push({ id, actionId });
			return Promise.resolve({ ok: true as const, message: "action done" });
		},
	};
	return {
		client: client as unknown as SigrunClient,
		dismissCalls,
		actionCalls,
	};
}

function stubWatch(): (
	conversationId: number,
	handlers: WatchHandlers,
) => Unwatch {
	return () => () => {};
}

function stubTui(): {
	tui: TUI;
	shown: { component: Component | undefined };
} {
	const shown: { component: Component | undefined } = { component: undefined };
	const tui = {
		requestRender: () => {},
		setFocus: () => {},
		terminal: { write: () => {} },
		showOverlay(component: Component): OverlayHandle {
			shown.component = component;
			return {
				hide: () => {
					shown.component = undefined;
				},
			} as unknown as OverlayHandle;
		},
	} as unknown as TUI;
	return { tui, shown };
}

/** Strip ANSI SGR so assertions read the visible text. */
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── the inline line ────────────────────────────────────────────────────

describe("NoticeChrome: the inline line", () => {
	test("the inline line shows the current conversation's newest notice", async () => {
		const served = {
			notices: [
				notice("n-app", { title: "app-wide note" }),
				notice("n-conv", { title: "CI failed", conversationId: 2 }),
				notice("n-other", { title: "other conversation", conversationId: 1 }),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		chrome.setConversation(2);
		await chrome.refresh();
		const line = stripAnsi(chrome.render(120).join("\n"));
		expect(line).toContain("CI failed");
		expect(line).not.toContain("other conversation");
		// A conversation notice wins over the app-wide one.
		expect(line).not.toContain("app-wide note");
	});

	test("the inline line falls back to the newest app-wide notice", async () => {
		const served = { notices: [notice("n-app", { title: "app-wide note" })] };
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		chrome.setConversation(2);
		await chrome.refresh();
		expect(stripAnsi(chrome.render(120).join("\n"))).toContain("app-wide note");
	});

	test("the dismiss key clears it", async () => {
		const served = {
			notices: [notice("n-conv", { title: "CI failed", conversationId: 2 })],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		chrome.setConversation(2);
		await chrome.refresh();
		expect(chrome.render(120)).toHaveLength(1);
		await chrome.dismissNewest();
		expect(stub.dismissCalls).toEqual(["n-conv"]);
		expect(chrome.render(120)).toEqual([]);
	});
});

// ─── the status-bar count ───────────────────────────────────────────────

describe("the status bar count follows the list", () => {
	test("boot paints notices:N; a refetch to fewer updates it", async () => {
		const served = { notices: [notice("n-1"), notice("n-2")] };
		const stub = stubClient(served);
		const { tui } = stubTui();
		const app = new TuiApp(stub.client, { tui, watch: stubWatch() });
		const statusBar = new StatusBar({ theme: plainTuiTheme() });
		statusBar.set({ conversation: "", hints: [] });
		app.setStatusBar(statusBar);
		await app.refresh();
		expect(statusBar.getState().notices).toBe(2);
		expect(stripAnsi(statusBar.render(120)[0] ?? "")).toContain("notices:2");
		served.notices = [notice("n-2")];
		await app.notices.refresh();
		expect(statusBar.getState().notices).toBe(1);
	});
});

// ─── the overlay ────────────────────────────────────────────────────────

describe("NoticeChrome: the overlay", () => {
	test("the overlay lists all notices with tone, title, body, buttons, age", async () => {
		const served = {
			notices: [
				notice("n-1", {
					title: "Deploy finished",
					body: "all green",
					tone: "good",
					actions: [
						{ id: "ack", label: "Ack", kind: "extension", name: "ack" },
					],
				}),
				notice("n-2", {
					title: "Quota warning",
					tone: "warn",
					actions: [
						{ id: "see", label: "See usage", kind: "open", url: "https://acme.example/usage" },
					],
				}),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		await chrome.refresh();
		const { tui, shown } = stubTui();
		chrome.openOverlay(tui, {});
		expect(shown.component).toBeDefined();
		const text = stripAnsi(shown.component!.render(100).join("\n"));
		expect(text).toContain("Deploy finished");
		expect(text).toContain("all green");
		expect(text).toContain("Quota warning");
		expect(text).toContain("Ack");
		expect(text).toContain("See usage");
	});

	test("Enter on an extension action calls runNoticeAction", async () => {
		const served = {
			notices: [
				notice("n-1", {
					actions: [{ id: "ack", label: "Ack", kind: "extension", name: "ack" }],
				}),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		const results: string[] = [];
		chrome.onResult = (text) => results.push(text);
		await chrome.refresh();
		const { tui, shown } = stubTui();
		chrome.openOverlay(tui, {});
		shown.component!.handleInput!("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(stub.actionCalls).toEqual([{ id: "n-1", actionId: "ack" }]);
		expect(results).toEqual(["action done"]);
	});

	test("Enter on a confirm-carrying action asks first", async () => {
		const served = {
			notices: [
				notice("n-1", {
					actions: [
						{
							id: "undo",
							label: "Undo",
							kind: "extension",
							name: "undo",
							confirm: "Undo every change this review made?",
						},
					],
				}),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		await chrome.refresh();
		const { tui, shown } = stubTui();
		chrome.openOverlay(tui, {});
		shown.component!.handleInput!("\r");
		expect(stub.actionCalls).toEqual([]);
		expect(shown.component!.render(120)).toEqual(
			expect.arrayContaining([expect.stringContaining("Undo every change this review made? (y/n)")]),
		);
		shown.component!.handleInput!("y");
		expect(stub.actionCalls).toEqual([{ id: "n-1", actionId: "undo" }]);
	});

	test("n or Esc cancels the confirm", async () => {
		const served = {
			notices: [
				notice("n-1", {
					actions: [
						{
							id: "undo",
							label: "Undo",
							kind: "extension",
							name: "undo",
							confirm: "Undo every change this review made?",
						},
					],
				}),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		await chrome.refresh();
		const { tui, shown } = stubTui();
		chrome.openOverlay(tui, {});
		shown.component!.handleInput!("\r");
		shown.component!.handleInput!("n");
		expect(stub.actionCalls).toEqual([]);
		expect(shown.component).toBeDefined();
		expect(shown.component!.render(120).join("\n")).not.toContain("Undo every change this review made? (y/n)");
		shown.component!.handleInput!("\r");
		shown.component!.handleInput!("\x1b");
		expect(stub.actionCalls).toEqual([]);
		expect(shown.component).toBeDefined();
	});

	test("an `open` action prints the URL and dismisses the notice", async () => {
		const served = {
			notices: [
				notice("n-1", {
					actions: [
						{ id: "see", label: "See usage", kind: "open", url: "https://acme.example/usage" },
					],
				}),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		const printed: string[] = [];
		chrome.onOpenUrl = (url) => printed.push(url);
		await chrome.refresh();
		const { tui, shown } = stubTui();
		chrome.openOverlay(tui, {});
		shown.component!.handleInput!("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(printed).toEqual(["https://acme.example/usage"]);
		expect(stub.dismissCalls).toEqual(["n-1"]);
	});

	test("a navigate action routes and dismisses", async () => {
		const served = {
			notices: [
				notice("n-1", {
					actions: [
						{ id: "go", label: "Open chat", kind: "navigate", target: { conversation: 7 } },
					],
				}),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		const routed: unknown[] = [];
		chrome.onNavigate = (target) => routed.push(target);
		await chrome.refresh();
		const { tui, shown } = stubTui();
		chrome.openOverlay(tui, {});
		shown.component!.handleInput!("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(routed).toEqual([{ conversation: 7 }]);
		expect(stub.dismissCalls).toEqual(["n-1"]);
	});

	test("down moves to the next action row; Esc closes", async () => {
		const served = {
			notices: [
				notice("n-1", {
					actions: [
						{ id: "a1", label: "First", kind: "extension", name: "a1" },
						{ id: "a2", label: "Second", kind: "extension", name: "a2" },
					],
				}),
			],
		};
		const stub = stubClient(served);
		const chrome = new NoticeChrome(stub.client, { theme: plainTuiTheme() });
		await chrome.refresh();
		const { tui, shown } = stubTui();
		chrome.openOverlay(tui, {});
		shown.component!.handleInput!("\x1b[B"); // down
		shown.component!.handleInput!("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(stub.actionCalls).toEqual([{ id: "n-1", actionId: "a2" }]);
		shown.component!.handleInput!("\x1b");
		expect(shown.component).toBeUndefined();
	});
});

// ─── ambient navigate/open routing ──────────────────────────────────────

describe("ambient navigate action routes", () => {
	test("a navigate action routes to onNavigate; open prints the URL", () => {
		const stub = stubClient({ notices: [] });
		const chrome = new AmbientChrome(stub.client, { theme: plainTuiTheme() });
		const routed: unknown[] = [];
		const printed: string[] = [];
		chrome.onNavigate = (target) => routed.push(target);
		chrome.onOpenUrl = (url) => printed.push(url);
		chrome.dispatchAmbientAction({ type: "navigate", target: { conversation: 3 } });
		expect(routed).toEqual([{ conversation: 3 }]);
		chrome.dispatchAmbientAction({ type: "open", url: "https://acme.example/x" });
		expect(printed).toEqual(["https://acme.example/x"]);
	});
});

// ─── the app's action dispatch ──────────────────────────────────────────

describe("the app dispatches the notice actions", () => {
	test("notices.open opens the overlay; notices.dismissNewest dismisses the inline notice", async () => {
		const served = {
			notices: [notice("n-conv", { title: "CI failed", conversationId: 2 })],
		};
		const stub = stubClient(served);
		const { tui, shown } = stubTui();
		const app = new TuiApp(stub.client, { tui, watch: stubWatch() });
		await app.refresh();
		await app.dispatch({ type: "notices.open" });
		expect(shown.component).toBeDefined();
		expect(stripAnsi(shown.component!.render(100).join("\n"))).toContain("CI failed");
		shown.component!.handleInput!("\x1b");
		await app.dispatch({ type: "notices.dismissNewest" });
		expect(stub.dismissCalls).toEqual(["n-conv"]);
	});

	test("a navigate action reaches the conversation selection", async () => {
		const served = {
			notices: [
				notice("n-1", {
					actions: [
						{ id: "go", label: "Open chat", kind: "navigate", target: { conversation: 1 } },
					],
				}),
			],
		};
		const stub = stubClient(served);
		const { tui, shown } = stubTui();
		const app = new TuiApp(stub.client, { tui, watch: stubWatch() });
		await app.refresh();
		expect(app.activeConversationId).toBe(2); // boot selects the newest
		await app.dispatch({ type: "notices.open" });
		shown.component!.handleInput!("\r");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(app.activeConversationId).toBe(1);
	});
});
