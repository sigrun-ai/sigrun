/**
 * ToolResultEntry (Task 22): an expandable tool card for a `pi.tool-result`
 * entry. Collapsed shows the tool name + status; expanded shows the output.
 * A matching LiveDoc tool slot (status "running") renders the card
 * in-progress with the slot's streaming output.
 *
 * Task 1d: an edit result with `details.diff` renders a line-colored diff
 * view when expanded.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { describe, expect, test } from "vitest";
import { makeEntry, render, textContent } from "../test-utils";
import { ToolResultEntry } from "./ToolResultEntry";

const ENTRY = makeEntry("pi.tool-result", [
	{
		role: "toolResult",
		content: [{ type: "text", text: "secret output" }],
		toolName: "bash",
		toolCallId: "call-1",
	},
]);

/** An edit result carrying the applied diff in `details` (pi-durable shape). */
const EDIT_ENTRY = makeEntry("pi.tool-result", [
	{
		role: "toolResult",
		content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
		toolName: "edit",
		toolCallId: "call-2",
		details: {
			diff: "-1 old line\n+1 new line\n 2 context line",
			patch: "irrelevant here",
			firstChangedLine: 1,
		},
	},
]);

describe("ToolResultEntry", () => {
	test("collapsed shows the tool name + status, not the output", () => {
		const renderer = render(h(ToolResultEntry, { entry: ENTRY }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("bash");
		expect(text).toContain("done");
		expect(text).not.toContain("secret output");
		renderer.unmount();
	});

	test("expanding reveals the output; collapsing hides it again", () => {
		const renderer = render(h(ToolResultEntry, { entry: ENTRY }));
		const header = () =>
			renderer.root.findByProps({ className: "tool-card-header" });
		expect(header().props["aria-expanded"]).toBe(false);
		act(() => {
			header().props.onClick();
		});
		expect(header().props["aria-expanded"]).toBe(true);
		expect(textContent(renderer.toJSON())).toContain("secret output");
		act(() => {
			header().props.onClick();
		});
		expect(textContent(renderer.toJSON())).not.toContain("secret output");
		renderer.unmount();
	});

	test("a running live slot renders the card in-progress", () => {
		const renderer = render(
			h(ToolResultEntry, {
				entry: ENTRY,
				slot: {
					callId: "call-1",
					name: "bash",
					status: "running",
					output: "so far",
				},
			}),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toMatch(/running/i);
		expect(text).not.toContain("done");
		const running = renderer.root.findAll(
			(node) =>
				typeof node.props.className === "string" &&
				node.props.className.includes("entry-tool-running"),
		);
		expect(running).toHaveLength(1);
		renderer.unmount();
	});

	test("the running slot's streaming output wins over the entry body when expanded", () => {
		const renderer = render(
			h(ToolResultEntry, {
				entry: ENTRY,
				slot: {
					callId: "call-1",
					name: "bash",
					status: "running",
					output: "streamed so far",
				},
			}),
		);
		const header = renderer.root.findByProps({
			className: "tool-card-header",
		});
		act(() => {
			header.props.onClick();
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("streamed so far");
		expect(text).not.toContain("secret output");
		renderer.unmount();
	});
});

describe("ToolResultEntry diff view (Task 1d)", () => {
	test("collapsed hides the diff; expanding renders its lines colored", () => {
		const renderer = render(h(ToolResultEntry, { entry: EDIT_ENTRY }));
		expect(textContent(renderer.toJSON())).not.toContain("new line");
		const header = renderer.root.findByProps({
			className: "tool-card-header",
		});
		act(() => {
			header.props.onClick();
		});
		// The diff renders in the diff view, each line in its class.
		const diff = renderer.root.findByProps({ className: "tool-card-diff" });
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
		expect(textContent(renderer.toJSON())).toContain("new line");
		// The plain text body still renders alongside the diff.
		expect(textContent(renderer.toJSON())).toContain(
			"Successfully replaced",
		);
		renderer.unmount();
	});

	test("entries without a details diff render the plain output only", () => {
		const renderer = render(h(ToolResultEntry, { entry: ENTRY }));
		const header = renderer.root.findByProps({
			className: "tool-card-header",
		});
		act(() => {
			header.props.onClick();
		});
		const diffNodes = renderer.root.findAll(
			(node) => node.props.className === "tool-card-diff",
		);
		expect(diffNodes).toHaveLength(0);
		expect(textContent(renderer.toJSON())).toContain("secret output");
		renderer.unmount();
	});

	test("a find result renders its output in the card (Task 1b)", () => {
		const entry = makeEntry("pi.tool-result", [
			{
				role: "toolResult",
				content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
				toolName: "find",
				toolCallId: "call-3",
			},
		]);
		const renderer = render(h(ToolResultEntry, { entry }));
		const header = renderer.root.findByProps({
			className: "tool-card-header",
		});
		act(() => {
			header.props.onClick();
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("find");
		expect(text).toContain("src/a.ts");
		renderer.unmount();
	});
});
