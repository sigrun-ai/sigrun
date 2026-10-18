/**
 * ActivityLine (B4, UI refresh): the collapsed activity summary under an
 * assistant turn — "Thinking · 1 tool" (+ "· N failed"), collapsed by
 * default also during live runs, open state persisted in sessionStorage
 * keyed `sigrun.activity.<conversationId>.<lastEntryId>`; expanded shows
 * the thinking text (unless showThinking false) and one row per tool.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolSlotWire } from "../api";
import {
	assistantTurnEntry,
	makeEntry,
	render,
	stubSessionStorage,
	textContent,
	thinkingBlock,
	toolCallBlock,
	toolResultTurnEntry,
} from "../test-utils";
import { ActivityLine } from "./ActivityLine";

afterEach(() => {
	vi.unstubAllGlobals();
});

// Node ≥26 ships a real global sessionStorage; each test gets a fresh Map
// so the persisted open state never bleeds across tests sharing a key.
beforeEach(() => {
	stubSessionStorage();
});

/** The root-filesystem run's assistant turn pieces (synthetic literals). */
const THINKING = "List the root directory first.";
const CALL = toolCallBlock("call-root", "bash", { command: "ls /" });
const ASSISTANT = assistantTurnEntry(2, [thinkingBlock(THINKING), CALL]);
const RESULT = toolResultTurnEntry(3, "call-root", { text: "bin\netc" });

function line(init?: {
	readonly thinking?: readonly string[];
	readonly tools?: Parameters<typeof ActivityLine>[0]["tools"];
	readonly entries?: Parameters<typeof ActivityLine>[0]["entries"];
	readonly slots?: readonly ToolSlotWire[];
	readonly showThinking?: boolean;
	readonly lastEntryId?: number;
	readonly live?: boolean;
}) {
	return h(ActivityLine, {
		conversationId: 1,
		lastEntryId: init?.lastEntryId ?? 4,
		thinking: init?.thinking ?? [THINKING],
		tools:
			init?.tools ?? [
				{
					callId: "call-root",
					name: "bash",
					preview: "ls /",
					resultEntryId: 3,
					isError: false,
				},
			],
		entries: init?.entries ?? [ASSISTANT, RESULT],
		slots: init?.slots ?? [],
		showThinking: init?.showThinking ?? true,
		live: init?.live,
	});
}

const toggleOf = (renderer: ReturnType<typeof render>) =>
	renderer.root.findByProps({ className: "activity-toggle" });

describe("ActivityLine", () => {
	test("collapsed by default: label only, no thinking text or tool rows", () => {
		const renderer = render(line());
		const toggle = toggleOf(renderer);
		expect(toggle.props["aria-expanded"]).toBe(false);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Thinking · 1 tool");
		expect(text).not.toContain(THINKING);
		expect(text).not.toContain("ls /");
		expect(toggle.props["data-live"]).toBeUndefined();
		renderer.unmount();
	});

	test("live runs stay collapsed too; the toggle carries data-live", () => {
		const renderer = render(line({ live: true }));
		expect(toggleOf(renderer).props["aria-expanded"]).toBe(false);
		expect(toggleOf(renderer).props["data-live"]).toBe(true);
		renderer.unmount();
	});

	test("expanding shows the thinking text and the tool row; open state persists in sessionStorage", () => {
		const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
		const renderer = render(line());
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		expect(toggleOf(renderer).props["aria-expanded"]).toBe(true);
		expect(storage.getItem("sigrun.activity.1.4")).toBe("1");
		const text = textContent(renderer.toJSON());
		expect(text).toContain(THINKING);
		expect(text).toContain("ls /");
		renderer.unmount();
	});

	test("a remount re-reads the stored open state for its key", () => {
		const first = render(line());
		act(() => {
			toggleOf(first).props.onClick();
		});
		first.unmount();
		const second = render(line());
		expect(toggleOf(second).props["aria-expanded"]).toBe(true);
		second.unmount();
	});

	test("a different lastEntryId is a different key: the line re-collapses", () => {
		const renderer = render(line());
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		act(() => {
			renderer.update(line({ lastEntryId: 5 }));
		});
		expect(toggleOf(renderer).props["aria-expanded"]).toBe(false);
		renderer.unmount();
	});

	test("showThinking=false hides the thinking text but keeps the tool row", () => {
		const renderer = render(line({ showThinking: false }));
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		const text = textContent(renderer.toJSON());
		expect(text).not.toContain(THINKING);
		expect(text).toContain("ls /");
		renderer.unmount();
	});

	test("a failed tool appends `· 1 failed` to the summary", () => {
		const renderer = render(
			line({
				tools: [
					{
						callId: "call-root",
						name: "bash",
						preview: "make check",
						resultEntryId: 3,
						isError: true,
					},
				],
				entries: [
					ASSISTANT,
					toolResultTurnEntry(3, "call-root", {
						text: "boom",
						isError: true,
					}),
				],
			}),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("Thinking · 1 tool · 1 failed");
		renderer.unmount();
	});

	test("a tool with no result and no live slot shows the · glyph", () => {
		const renderer = render(
			line({
				thinking: [],
				tools: [
					{
						callId: "call-read",
						name: "read",
						preview: "notes/todo.txt",
						isError: false,
					},
				],
				entries: [
					assistantTurnEntry(2, [
						toolCallBlock("call-read", "read", { path: "notes/todo.txt" }),
					]),
				],
			}),
		);
		expect(textContent(renderer.toJSON())).toContain("1 tool");
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		expect(
			renderer.root.findByProps({ "data-glyph": "pending" }).children,
		).toEqual(["·"]);
		renderer.unmount();
	});

	test("a running live slot renders the spinner row", () => {
		const renderer = render(
			line({
				thinking: [],
				tools: [
					{ callId: "call-1", name: "bash", preview: "ls /", isError: false },
				],
				entries: [assistantTurnEntry(2, [CALL])],
				slots: [
					{ callId: "call-1", name: "bash", status: "running", output: "…" },
				],
			}),
		);
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		const row = renderer.root.findByProps({ className: "tool-row" });
		expect(row.props["data-running"]).toBe(true);
		expect(renderer.root.findByProps({ "aria-label": "running" })).toBeDefined();
		renderer.unmount();
	});

	test("each tool renders its own row, in call order", () => {
		const renderer = render(
			line({
				thinking: [],
				tools: [
					{
						callId: "call-a",
						name: "bash",
						preview: "ls /",
						resultEntryId: 3,
						isError: false,
					},
					{
						callId: "call-b",
						name: "read",
						preview: "notes/todo.txt",
						resultEntryId: 4,
						isError: false,
					},
				],
				entries: [
					assistantTurnEntry(2, [
						toolCallBlock("call-a", "bash", { command: "ls /" }),
						toolCallBlock("call-b", "read", { path: "notes/todo.txt" }),
					]),
					toolResultTurnEntry(3, "call-a", { text: "bin" }),
					toolResultTurnEntry(4, "call-b", {
						toolName: "read",
						text: "- buy milk",
					}),
				],
			}),
		);
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		const rows = renderer.root.findAllByProps({ className: "tool-row" });
		expect(rows).toHaveLength(2);
		const text = textContent(renderer.toJSON());
		expect(text.indexOf("ls /")).toBeLessThan(text.indexOf("notes/todo.txt"));
		renderer.unmount();
	});

	test("an empty turn (no thinking, no tools) renders nothing", () => {
		const renderer = render(
			line({ thinking: [], tools: [], entries: [makeEntry("pi.assistant", [], { id: 2 })] }),
		);
		expect(renderer.toJSON()).toBeNull();
		renderer.unmount();
	});
});
