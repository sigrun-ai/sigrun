/**
 * ToolResultEntry → ToolRow (B4, UI refresh): one tool row inside the
 * expanded ActivityLine — glyph (✓ settled / ✗ error / spinner running /
 * · no result yet), tool name, preview in mono; expandable to the call
 * arguments (JSON) and the result output (first 20 lines + "Show more"),
 * with the edit diff view kept from Task 1d and Copy command / Copy
 * output on the row.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolCall } from "@sigrun/shared/turns";
import {
	findButton,
	render,
	stubClipboard,
	textContent,
	toolResultTurnEntry,
} from "../test-utils";
import { ToolRow } from "./ToolResultEntry";

afterEach(() => {
	vi.unstubAllGlobals();
});

const SETTLED: ToolCall = {
	callId: "call-1",
	name: "bash",
	preview: "ls /",
	resultEntryId: 3,
	isError: false,
};

const ERROR: ToolCall = { ...SETTLED, callId: "call-2", isError: true };

const PENDING: ToolCall = {
	callId: "call-3",
	name: "read",
	preview: "notes/todo.txt",
	isError: false,
};

const ARGS = { command: "ls /" };

describe("ToolRow", () => {
	test("collapsed shows glyph, name, and preview — not the output", () => {
		const renderer = render(
			h(ToolRow, {
				tool: SETTLED,
				args: ARGS,
				result: toolResultTurnEntry(3, "call-1", { text: "bin\netc" }),
			}),
		);
		const glyph = renderer.root.findByProps({ "data-glyph": "ok" });
		expect(glyph.children).toEqual(["✓"]);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("bash");
		expect(text).toContain("ls /");
		expect(text).not.toContain("bin\netc");
		expect(text).not.toContain('"command"');
		renderer.unmount();
	});

	test("an error result renders ✗ and the row carries data-error even collapsed", () => {
		const renderer = render(
			h(ToolRow, {
				tool: ERROR,
				args: ARGS,
				result: toolResultTurnEntry(3, "call-2", {
					text: "boom",
					isError: true,
				}),
			}),
		);
		expect(renderer.root.findByProps({ "data-glyph": "error" }).children).toEqual([
			"✗",
		]);
		expect(
			renderer.root.findAllByProps({
				className: "tool-row",
				"data-error": true,
			}),
		).toHaveLength(1);
		renderer.unmount();
	});

	test("no result and no live slot renders the · glyph", () => {
		const renderer = render(h(ToolRow, { tool: PENDING, args: ARGS }));
		expect(renderer.root.findByProps({ "data-glyph": "pending" }).children).toEqual([
			"·",
		]);
		renderer.unmount();
	});

	test("a running live slot renders the spinner and its output wins", () => {
		const renderer = render(
			h(ToolRow, {
				tool: SETTLED,
				args: ARGS,
				result: toolResultTurnEntry(3, "call-1", { text: "settled output" }),
				slot: {
					callId: "call-1",
					name: "bash",
					status: "running",
					output: "streamed so far",
				},
			}),
		);
		const row = renderer.root.findByProps({ className: "tool-row" });
		expect(row.props["data-running"]).toBe(true);
		expect(renderer.root.findAllByProps({ "data-glyph": expect.anything() })).toHaveLength(0);
		const spinner = renderer.root.findByProps({ "aria-label": "running" });
		expect(spinner).toBeDefined();
		act(() => {
			renderer.root.findByProps({ className: "tool-row-toggle" }).props.onClick();
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("streamed so far");
		expect(text).not.toContain("settled output");
		renderer.unmount();
	});

	test("expanding reveals the arguments JSON and the output; collapsing hides them", () => {
		const renderer = render(
			h(ToolRow, {
				tool: SETTLED,
				args: ARGS,
				result: toolResultTurnEntry(3, "call-1", { text: "secret output" }),
			}),
		);
		const toggle = renderer.root.findByProps({ className: "tool-row-toggle" });
		expect(toggle.props["aria-expanded"]).toBe(false);
		act(() => {
			toggle.props.onClick();
		});
		expect(toggle.props["aria-expanded"]).toBe(true);
		const text = textContent(renderer.toJSON());
		expect(text).toContain('"command": "ls /"');
		expect(text).toContain("secret output");
		act(() => {
			toggle.props.onClick();
		});
		const collapsed = textContent(renderer.toJSON());
		expect(collapsed).not.toContain('"command"');
		expect(collapsed).not.toContain("secret output");
		renderer.unmount();
	});

	test("output longer than 20 lines shows the first 20 then Show more", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`);
		const renderer = render(
			h(ToolRow, {
				tool: SETTLED,
				args: ARGS,
				result: toolResultTurnEntry(3, "call-1", { text: lines.join("\n") }),
			}),
		);
		act(() => {
			renderer.root.findByProps({ className: "tool-row-toggle" }).props.onClick();
		});
		const capped = textContent(renderer.toJSON());
		expect(capped).toContain("line-20");
		expect(capped).not.toContain("line-21");
		act(() => {
			findButton(renderer, "Show more").props.onClick();
		});
		const all = textContent(renderer.toJSON());
		expect(all).toContain("line-30");
		renderer.unmount();
	});

	test("an edit result renders the line-coloured diff view when expanded", () => {
		const renderer = render(
			h(ToolRow, {
				tool: { ...SETTLED, name: "edit", preview: "a.ts" },
				args: { path: "a.ts" },
				result: toolResultTurnEntry(3, "call-1", {
					toolName: "edit",
					text: "Successfully replaced 1 block(s) in a.ts.",
					details: {
						diff: "-1 old line\n+1 new line\n 2 context line",
						patch: "irrelevant here",
						firstChangedLine: 1,
					},
				}),
			}),
		);
		act(() => {
			renderer.root.findByProps({ className: "tool-row-toggle" }).props.onClick();
		});
		const diff = renderer.root.findByProps({ className: "tool-row-diff" });
		expect(diff).toBeDefined();
		const byClass = (className: string) =>
			diff.children.filter(
				(child) =>
					typeof child === "object" &&
					(child as { props?: { className?: string } }).props?.className ===
						className,
			);
		expect(byClass("diff-line-del")).toHaveLength(1);
		expect(byClass("diff-line-add")).toHaveLength(1);
		expect(byClass("diff-line-ctx")).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("Successfully replaced");
		renderer.unmount();
	});

	test("Copy command writes the preview's FULL argument; Copy output writes the output", () => {
		const writeText = stubClipboard();
		const fullCommand = "echo one\necho two";
		const renderer = render(
			h(ToolRow, {
				tool: { ...SETTLED, preview: "echo one" },
				args: { command: fullCommand },
				result: toolResultTurnEntry(3, "call-1", { text: "one\ntwo" }),
			}),
		);
		act(() => {
			findButton(renderer, "Copy command").props.onClick();
		});
		expect(writeText).toHaveBeenCalledWith(fullCommand);
		act(() => {
			findButton(renderer, "Copy output").props.onClick();
		});
		expect(writeText).toHaveBeenCalledWith("one\ntwo");
		renderer.unmount();
	});

	test("a tool with no derivable command hides Copy command; no output hides Copy output", () => {
		const renderer = render(h(ToolRow, { tool: PENDING, args: { count: 3 } }));
		const labels = renderer.root
			.findAllByType("button")
			.flatMap((button) =>
				(button.children ?? []).filter(
					(child) => typeof child === "string",
				),
			);
		expect(labels).not.toContain("Copy command");
		expect(labels).not.toContain("Copy output");
		renderer.unmount();
	});
});
