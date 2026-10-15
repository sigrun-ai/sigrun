/**
 * AssistantEntry (Task 22): a `pi.assistant` entry rendered as markdown via
 * react-markdown + remark-gfm — bold/code/links, GFM strikethrough/tables,
 * and multiple text blocks joined into one markdown source.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h } from "react";
import { describe, expect, test } from "vitest";
import { makeEntry, render, textContent, textMessage } from "../test-utils";
import { AssistantEntry } from "./AssistantEntry";

describe("AssistantEntry", () => {
	test("renders markdown: bold, inline code, and links", () => {
		const entry = makeEntry("pi.assistant", [
			textMessage(
				"assistant",
				"some **bold** and `code` and [a link](https://example.com)",
			),
		]);
		const renderer = render(h(AssistantEntry, { entry }));
		expect(renderer.root.findAllByType("strong")).toHaveLength(1);
		expect(renderer.root.findAllByType("code")).toHaveLength(1);
		const links = renderer.root.findAllByType("a");
		expect(links).toHaveLength(1);
		expect(links[0]?.props.href).toBe("https://example.com");
		renderer.unmount();
	});

	test("renders gfm: strikethrough and tables", () => {
		const entry = makeEntry("pi.assistant", [
			textMessage(
				"assistant",
				"~~gone~~\n\n| a | b |\n|---|---|\n| 1 | 2 |",
			),
		]);
		const renderer = render(h(AssistantEntry, { entry }));
		expect(renderer.root.findAllByType("del")).toHaveLength(1);
		expect(renderer.root.findAllByType("table")).toHaveLength(1);
		renderer.unmount();
	});

	test("multiple text blocks join into one markdown source", () => {
		const entry = makeEntry("pi.assistant", [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "para one" },
					{ type: "text", text: "para two" },
				],
			},
		]);
		const renderer = render(h(AssistantEntry, { entry }));
		expect(renderer.root.findAllByType("p").length).toBeGreaterThanOrEqual(2);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("para one");
		expect(text).toContain("para two");
		renderer.unmount();
	});
});

describe("AssistantEntry thinking blocks", () => {
	const thinkingMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "weighing the options" },
			{ type: "text", text: "the answer" },
		],
	};

	test("renders thinking as a collapsible block before the text", () => {
		const entry = makeEntry("pi.assistant", [thinkingMessage]);
		const renderer = render(h(AssistantEntry, { entry }));
		const details = renderer.root.findAllByType("details");
		expect(details).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain(
			"weighing the options",
		);
		expect(textContent(renderer.toJSON())).toContain("the answer");
		renderer.unmount();
	});

	test("thinking blocks render collapsed at rest", () => {
		const entry = makeEntry("pi.assistant", [thinkingMessage]);
		const renderer = render(h(AssistantEntry, { entry }));
		const details = renderer.root.findByType("details");
		expect(details.props.open).toBeUndefined();
		renderer.unmount();
	});

	test("live thinking renders expanded (open)", () => {
		const entry = makeEntry("pi.assistant", [thinkingMessage]);
		const renderer = render(h(AssistantEntry, { entry, live: true }));
		const details = renderer.root.findByType("details");
		expect(details.props.open).toBe(true);
		renderer.unmount();
	});

	test("showThinking=false hides thinking completely", () => {
		const entry = makeEntry("pi.assistant", [thinkingMessage]);
		const renderer = render(
			h(AssistantEntry, { entry, showThinking: false }),
		);
		expect(renderer.root.findAllByType("details")).toHaveLength(0);
		expect(textContent(renderer.toJSON())).not.toContain(
			"weighing the options",
		);
		expect(textContent(renderer.toJSON())).toContain("the answer");
		renderer.unmount();
	});

	test("a tool-call-only message renders nothing (no empty bubble)", () => {
		const entry = makeEntry("pi.assistant", [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: {},
					} as unknown as import("../api").ContentBlockWire,
				],
			},
		]);
		const renderer = render(h(AssistantEntry, { entry }));
		expect(renderer.toJSON()).toBeNull();
		renderer.unmount();
	});

	test("a thinking-only message renders its thinking (no empty text)", () => {
		const entry = makeEntry("pi.assistant", [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "still deciding" }],
			},
		]);
		const renderer = render(h(AssistantEntry, { entry }));
		const details = renderer.root.findAllByType("details");
		expect(details).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("still deciding");
		renderer.unmount();
	});
});
