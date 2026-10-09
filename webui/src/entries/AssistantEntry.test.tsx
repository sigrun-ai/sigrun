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
