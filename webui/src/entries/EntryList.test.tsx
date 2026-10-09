/**
 * EntryList (Task 22): renders `view.entries` dispatching on the `kind`
 * discriminant, in array order; unknown kinds render a fail-visible fallback
 * naming the kind; a `pi.tool-result` entry joins its LiveDoc tool slot by
 * callId so the card can show the running state.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h } from "react";
import { describe, expect, test } from "vitest";
import {
	makeEntry,
	makeView,
	render,
	textContent,
	textMessage,
} from "../test-utils";
import { EntryList } from "./EntryList";

describe("EntryList", () => {
	test("renders each entry kind in array order", () => {
		const view = makeView({
			entries: [
				makeEntry("pi.system", [textMessage("system", "sys note")], {
					id: 1,
				}),
				makeEntry("pi.user", [textMessage("user", "hello there")], {
					id: 2,
				}),
				makeEntry("pi.assistant", [textMessage("assistant", "hi **you**")], {
					id: 3,
				}),
				makeEntry(
					"pi.tool-result",
					[
						{
							role: "toolResult",
							content: [{ type: "text", text: "file contents" }],
							toolName: "read",
							toolCallId: "call-1",
						},
					],
					{ id: 4 },
				),
			],
		});
		const renderer = render(h(EntryList, { view }));
		const tree = renderer.toJSON();
		expect(tree).toMatchObject({ props: { className: "entry-list" } });
		const children = !Array.isArray(tree) && tree !== null ? (tree.children ?? []) : [];
		const classes = children.map((child) =>
			typeof child === "string" ? "" : String(child.props.className),
		);
		expect(classes).toEqual([
			expect.stringContaining("entry-system"),
			expect.stringContaining("entry-user"),
			expect.stringContaining("entry-assistant"),
			expect.stringContaining("entry-tool"),
		]);
		const text = textContent(tree);
		expect(text).toContain("sys note");
		expect(text).toContain("hello there");
		expect(text).toContain("hi you"); // markdown bold flattens to text
		renderer.unmount();
	});

	test("an unknown kind renders a fail-visible fallback naming the kind", () => {
		const view = makeView({
			entries: [
				makeEntry("pi.future-thing", [textMessage("system", "payload")], {
					id: 1,
				}),
			],
		});
		const renderer = render(h(EntryList, { view }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("pi.future-thing");
		expect(text).toContain("payload");
		renderer.unmount();
	});

	test("a pi.tool-result entry joins its live tool slot by callId for the running state", () => {
		const view = makeView({
			entries: [
				makeEntry(
					"pi.tool-result",
					[
						{
							role: "toolResult",
							content: [{ type: "text", text: "partial output" }],
							toolName: "bash",
							toolCallId: "call-1",
						},
					],
					{ id: 1 },
				),
				makeEntry(
					"pi.tool-result",
					[
						{
							role: "toolResult",
							content: [{ type: "text", text: "done output" }],
							toolName: "read",
							toolCallId: "call-2",
						},
					],
					{ id: 2 },
				),
			],
			docs: {
				"pi.live": {
					tools: [
						{
							callId: "call-1",
							name: "bash",
							status: "running",
							output: "partial output",
						},
					],
				},
			},
		});
		const renderer = render(h(EntryList, { view }));
		const running = renderer.root.findAll(
			(node) =>
				typeof node.props.className === "string" &&
				node.props.className.includes("entry-tool-running"),
		);
		expect(running).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("running");
		renderer.unmount();
	});
});
