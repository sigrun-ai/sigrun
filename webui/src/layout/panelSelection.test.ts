/**
 * panelSelection tests (todo Task 2): the one right-panel selection
 * model — toggle/close, parse (garbage → closed; "notices" never
 * restorable), resolve (a removed extension panel → closed), and the
 * load/save round-trip through the localStorage seam ("notices" never
 * persisted; null stores as "none").
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memoryStorage } from "./extViews";
import {
	extPanelKey,
	loadPanelKey,
	parsePanelKey,
	PANEL_STORAGE_KEY,
	resolvePanel,
	savePanelKey,
	togglePanel,
} from "./panelSelection";

describe("togglePanel", () => {
	test("clicking the active key closes the panel", () => {
		expect(togglePanel("outline", "outline")).toBe(null);
	});

	test("clicking a different key switches to it", () => {
		expect(togglePanel("outline", "ext:todo/todos")).toBe("ext:todo/todos");
	});

	test("clicking while closed opens", () => {
		expect(togglePanel(null, "workspace")).toBe("workspace");
	});
});

describe("parsePanelKey", () => {
	test('"none" (the stored closed sentinel) parses to null', () => {
		expect(parsePanelKey("none")).toBe(null);
	});

	test("a well-formed ext key parses to itself", () => {
		expect(parsePanelKey("ext:todo/todos")).toBe("ext:todo/todos");
	});

	test("garbage parses to null", () => {
		expect(parsePanelKey("bogus")).toBe(null);
	});

	test("core panes parse to themselves", () => {
		expect(parsePanelKey("outline")).toBe("outline");
		expect(parsePanelKey("workspace")).toBe("workspace");
	});

	test('"notices" is never restorable (chrome, not state)', () => {
		expect(parsePanelKey("notices")).toBe(null);
	});

	test("null parses to null", () => {
		expect(parsePanelKey(null)).toBe(null);
	});
});

describe("resolvePanel", () => {
	test("an ext key whose panel is not available resolves to closed", () => {
		expect(resolvePanel("ext:gone/x", [])).toBe(null);
	});

	test("core keys pass through regardless of availability", () => {
		expect(resolvePanel("workspace", [])).toBe("workspace");
		expect(resolvePanel("notices", [])).toBe("notices");
	});

	test("an ext key whose panel IS available passes through", () => {
		const entry = { slug: "todo", id: "todos", title: "Todos", icon: "list" };
		expect(resolvePanel(extPanelKey("todo", "todos"), [entry])).toBe(
			"ext:todo/todos",
		);
	});

	test("null passes through", () => {
		expect(resolvePanel(null, [])).toBe(null);
	});
});

describe("load/save round-trip", () => {
	let stub: Storage;
	const globalWithStorage = globalThis as { localStorage?: Storage };

	beforeEach(() => {
		stub = memoryStorage();
		globalWithStorage.localStorage = stub;
	});

	afterEach(() => {
		delete globalWithStorage.localStorage;
	});

	test('saving "outline" and loading restores "outline"', () => {
		savePanelKey("outline");
		expect(loadPanelKey()).toBe("outline");
	});

	test("an ext key round-trips", () => {
		savePanelKey("ext:todo/todos");
		expect(loadPanelKey()).toBe("ext:todo/todos");
	});

	test('null stores as the "none" sentinel and loads as null', () => {
		savePanelKey(null);
		expect(stub.getItem(PANEL_STORAGE_KEY)).toBe("none");
		expect(loadPanelKey()).toBe(null);
	});

	test('saving "notices" leaves the stored value untouched', () => {
		savePanelKey("outline");
		savePanelKey("notices");
		expect(stub.getItem(PANEL_STORAGE_KEY)).toBe("outline");
	});
});
