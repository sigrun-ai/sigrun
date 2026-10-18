/**
 * The vim keymap (Task C4): insert/normal/command modes, the 500 ms
 * two-key chords, the unbound-printable consume rule, and the
 * RESERVED_KEYS pass-through invariant in INSERT.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createVimKeymap } from "../src/keymaps/vim.js";
import { RESERVED_KEYS, type KeyContext } from "../src/keymaps/types.js";

function ctx(init?: Partial<KeyContext>): KeyContext {
	return {
		focus: "composer",
		busy: false,
		autocompleteOpen: false,
		overlayOpen: false,
		...init,
	};
}

describe("vim keymap — insert mode", () => {
	test("starts in insert; j passes (types into the composer)", () => {
		const keymap = createVimKeymap();
		expect(keymap.mode).toBe("insert");
		expect(keymap.modeLabel()).toBe("-- INSERT --");
		expect(keymap.handle("j", ctx())).toBe("pass");
	});

	test("every RESERVED_KEYS chord passes in insert", () => {
		const keymap = createVimKeymap();
		for (const id of RESERVED_KEYS) {
			const letter = id.replace("ctrl+", "");
			const data = String.fromCharCode(letter.charCodeAt(0) - 96);
			expect(keymap.handle(data, ctx())).toBe("pass");
		}
	});

	test("ctrl+c aborts a live run, consumed otherwise (never quit)", () => {
		const keymap = createVimKeymap();
		expect(keymap.handle("\x03", ctx({ busy: true }))).toEqual({
			type: "cancel-run",
		});
		expect(keymap.handle("\x03", ctx())).toBe("consume");
	});

	test("esc with autocomplete open passes to the dropdown", () => {
		const keymap = createVimKeymap();
		expect(keymap.handle("\x1b", ctx({ autocompleteOpen: true }))).toBe("pass");
		expect(keymap.mode).toBe("insert");
	});
});

describe("vim keymap — normal mode", () => {
	function normalKeymap() {
		const keymap = createVimKeymap();
		const escResult = keymap.handle("\x1b", ctx());
		expect(escResult).toEqual({ type: "focus", target: "transcript" });
		expect(keymap.mode).toBe("normal");
		expect(keymap.modeLabel()).toBe("-- NORMAL --");
		return keymap;
	}

	test("j moves down; unbound printable x is consumed (not passed)", () => {
		const keymap = normalKeymap();
		const normal = ctx({ focus: "transcript" });
		expect(keymap.handle("j", normal)).toEqual({ type: "move", delta: 1 });
		expect(keymap.handle("k", normal)).toEqual({ type: "move", delta: -1 });
		expect(keymap.handle("x", normal)).toBe("consume");
	});

	test("ctrl+b and ctrl+f are NOT bound in normal (they pass)", () => {
		const keymap = normalKeymap();
		const normal = ctx({ focus: "transcript" });
		expect(keymap.handle("\x02", normal)).toBe("pass");
		expect(keymap.handle("\x06", normal)).toBe("pass");
	});

	test("gg within 500 ms edges to top; a 600 ms gap does not", () => {
		vi.useFakeTimers();
		try {
			const keymap = normalKeymap();
			const normal = ctx({ focus: "transcript" });
			expect(keymap.handle("g", normal)).toBe("consume");
			vi.setSystemTime(Date.now() + 400);
			expect(keymap.handle("g", normal)).toEqual({ type: "edge", to: "top" });
			expect(keymap.handle("g", normal)).toBe("consume");
			vi.setSystemTime(Date.now() + 600);
			expect(keymap.handle("g", normal)).toBe("consume"); // stale prefix, not edge
		} finally {
			vi.useRealTimers();
		}
	});

	test("g? within 500 ms opens help; bare ? stays search-backward", () => {
		const keymap = normalKeymap();
		const normal = ctx({ focus: "transcript" });
		expect(keymap.handle("?", normal)).toEqual({ type: "search", direction: "backward" });
		expect(keymap.handle("g", normal)).toBe("consume");
		expect(keymap.handle("?", normal)).toEqual({ type: "help" });
	});

	test("yy copies; ZZ quits; za toggles the fold; v edits in vim", () => {
		vi.useFakeTimers();
		try {
			const keymap = normalKeymap();
			const normal = ctx({ focus: "transcript" });
			expect(keymap.handle("y", normal)).toEqual({ type: "copy" });
			expect(keymap.handle("y", normal)).toEqual({ type: "copy" });
			expect(keymap.handle("Z", normal)).toBe("consume");
			expect(keymap.handle("Z", normal)).toEqual({ type: "quit" });
			expect(keymap.handle("z", normal)).toBe("consume");
			expect(keymap.handle("a", normal)).toEqual({ type: "toggle-fold" });
			expect(keymap.handle("v", normal)).toEqual({ type: "edit-in-vim" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("i returns to insert focused on the composer", () => {
		const keymap = normalKeymap();
		expect(keymap.handle("i", ctx({ focus: "transcript" }))).toEqual({
			type: "focus",
			target: "composer",
		});
		expect(keymap.mode).toBe("insert");
	});
});

describe("vim keymap — command mode", () => {
	test(":b hugo<enter> dispatches run-command with the line", () => {
		const keymap = createVimKeymap();
		keymap.handle("\x1b", ctx());
		expect(keymap.handle(":", ctx())).toBe("consume");
		expect(keymap.mode).toBe("command");
		expect(keymap.modeLabel()).toBeUndefined();
		for (const ch of "b hugo") keymap.handle(ch, ctx());
		expect(keymap.getCommandLine()).toBe(":b hugo");
		expect(keymap.handle("\r", ctx())).toEqual({ type: "run-command", line: "b hugo" });
		expect(keymap.mode).toBe("normal");
		expect(keymap.getCommandLine()).toBeUndefined();
	});

	test("esc cancels; backspace edits; tab completes the command name", () => {
		const keymap = createVimKeymap();
		keymap.handle("\x1b", ctx());
		keymap.handle(":", ctx());
		keymap.handle("m", ctx());
		expect(keymap.getCommandLine()).toBe(":m");
		keymap.handle("\t", ctx());
		expect(keymap.getCommandLine()).toBe(":model");
		keymap.handle("\x7f", ctx());
		expect(keymap.getCommandLine()).toBe(":mode");
		expect(keymap.handle("\x1b", ctx())).toBe("consume");
		expect(keymap.mode).toBe("normal");
	});
	test("tab completes a slash-catalog name (the options-injected table)", () => {
		const keymap = createVimKeymap({ catalogNames: ["thinking", "model"] });
		keymap.handle("\x1b", ctx());
		keymap.handle(":", ctx());
		for (const ch of "/th") keymap.handle(ch, ctx());
		keymap.handle("\t", ctx());
		expect(keymap.getCommandLine()).toBe(":/thinking");
	});

	test("enterInsertMode drops the keymap to insert", () => {
		const keymap = createVimKeymap();
		keymap.handle("\x1b", ctx());
		expect(keymap.mode).toBe("normal");
		keymap.enterInsertMode();
		expect(keymap.mode).toBe("insert");
	});
});

describe("vim keymap — overlays", () => {
	test("an open overlay passes everything except esc", () => {
		const keymap = createVimKeymap();
		keymap.handle("\x1b", ctx()); // normal
		expect(keymap.handle("j", ctx({ overlayOpen: true }))).toBe("pass");
		expect(keymap.handle("\x1b", ctx({ overlayOpen: true }))).toBe("consume");
	});
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── App wiring (Task C4: edit-in-vim + the command table) ──────────────

import type { TUI } from "@earendil-works/pi-tui";
import type { SigrunClient } from "../src/api.js";
import { TuiApp } from "../src/ui/app.js";
import { StatusBar } from "../src/ui/status-bar.js";
import { plainTuiTheme } from "../src/theme.js";

const fakeTui = { requestRender: () => {} } as unknown as TUI;

function vimStubClient() {
	const configureCalls: { id: number; patch: unknown }[] = [];
	const watchCalls: number[] = [];
	const client = {
		listConversations: () =>
			Promise.resolve({
				conversations: [
					{
						id: 7,
						root: false,
						entryCount: 1,
						archived: false,
						pinned: false,
						lastActivityAt: "2026-01-02T00:00:00.000Z",
						name: "faux-notes",
					},
					{
						id: 3,
						root: false,
						entryCount: 1,
						archived: false,
						pinned: false,
						lastActivityAt: "2026-01-01T00:00:00.000Z",
						name: "hugo-drafts",
					},
				],
			}),
		getCommands: () =>
			Promise.resolve({
				commands: [
					{ name: "model", description: "set the model", argsHint: "<provider/id>" },
					{ name: "thinking", description: "set thinking", argsHint: "<level>" },
				],
			}),
		configure(id: number, patch: unknown) {
			configureCalls.push({ id, patch });
			return Promise.resolve({ thinkingLevel: "low", model: { provider: "faux", modelId: "m2" } });
		},
	} as unknown as SigrunClient;
	return { client, configureCalls, watchCalls };
}

function makeApp(client: SigrunClient, init?: { resolveVim?: () => string | undefined }) {
	const watchCalls: number[] = [];
	const app = new TuiApp(client, {
		tui: fakeTui,
		watch: (id) => {
			watchCalls.push(id);
			return () => {};
		},
		...(init?.resolveVim === undefined ? {} : { resolveVim: init.resolveVim }),
	});
	const statusBar = new StatusBar({ theme: plainTuiTheme(), messageMs: 60_000 });
	statusBar.set({ mode: "attach", conversation: "", hints: [] });
	app.setStatusBar(statusBar);
	return { app, statusBar, watchCalls };
}

describe("vim app wiring", () => {
	test("edit-in-vim with no vim found: status message, draft untouched", async () => {
		const { client } = vimStubClient();
		const { app, statusBar } = makeApp(client, { resolveVim: () => undefined });
		app.editor.setText("draft stays");
		await app.dispatch({ type: "edit-in-vim" });
		expect(statusBar.getState().message).toBe("no vim found");
		expect(app.editor.getText()).toBe("draft stays");
	});

	test("runCommand `b <substring>` selects the matching conversation", async () => {
		const { client } = vimStubClient();
		const { app, watchCalls } = makeApp(client);
		await app.refresh();
		await app.runCommand("b hugo");
		expect(app.activeConversationId).toBe(3);
		expect(watchCalls[watchCalls.length - 1]).toBe(3);
	});

	test("runCommand `b zzz` flashes no match", async () => {
		const { client } = vimStubClient();
		const { app, statusBar } = makeApp(client);
		await app.refresh();
		await app.runCommand("b zzz");
		expect(statusBar.getState().message).toBe("no match");
	});

	test("runCommand `b` with no arg: usage error, no selection", async () => {
		const { client } = vimStubClient();
		const { app } = makeApp(client);
		await app.refresh();
		const showError = vi.spyOn(app.pane, "showError");
		await app.runCommand("b");
		expect(showError).toHaveBeenCalledWith("usage: b <id|name>");
	});

	test("edit-in-vim success: the keymap returns to insert mode (C4)", async () => {
		const { client } = vimStubClient();
		const stopStartTui = {
			requestRender: () => {},
			stop: () => {},
			start: () => {},
			setFocus: () => {},
		} as unknown as TUI;
		const watch = () => () => {};
		const app = new TuiApp(client, {
			tui: stopStartTui,
			watch,
			// `true` exits 0 without touching the temp file (ok: true).
			resolveVim: () => "true",
		});
		const keymap = createVimKeymap();
		keymap.handle("\x1b", ctx());
		expect(keymap.mode).toBe("normal");
		app.enterInsertMode = () => keymap.enterInsertMode();
		await app.dispatch({ type: "edit-in-vim" });
		expect(keymap.mode).toBe("insert");
	});

	test("runCommand `model faux/m2` configures the model", async () => {
		const { client, configureCalls } = vimStubClient();
		const { app } = makeApp(client);
		await app.refresh();
		await app.runCommand("model faux/m2");
		expect(configureCalls).toEqual([{ id: 7, patch: { model: "faux/m2" } }]);
	});
});
