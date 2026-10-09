/**
 * ToolResultEntry (Task 22): an expandable tool card for a `pi.tool-result`
 * entry. Collapsed shows the tool name + status; expanded shows the output.
 * A matching LiveDoc tool slot (status "running") renders the card
 * in-progress with the slot's streaming output.
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
