/**
 * UserEntry (Task 22): renders a `pi.user` entry's text parts; non-text
 * parts (image/file uploads) render as path markers; string content renders
 * as-is.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h } from "react";
import { describe, expect, test } from "vitest";
import { makeEntry, render, textContent, textMessage } from "../test-utils";
import { UserEntry } from "./UserEntry";

describe("UserEntry", () => {
	test("renders the user's text parts", () => {
		const entry = makeEntry("pi.user", [
			textMessage("user", "first part"),
			textMessage("user", "second message"),
		]);
		const renderer = render(h(UserEntry, { entry }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("first part");
		expect(text).toContain("second message");
		renderer.unmount();
	});

	test("non-text parts render as path markers alongside the text", () => {
		const entry = makeEntry("pi.user", [
			{
				role: "user",
				content: [
					{ type: "image", path: "uploads/cat.png" },
					{ type: "text", text: "what is this" },
					{ type: "file", path: "uploads/notes.txt" },
				],
			},
		]);
		const renderer = render(h(UserEntry, { entry }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("uploads/cat.png");
		expect(text).toContain("uploads/notes.txt");
		expect(text).toContain("what is this");
		renderer.unmount();
	});

	test("string content renders as-is", () => {
		const entry = makeEntry("pi.user", [
			{ role: "user", content: "plain string" },
		]);
		const renderer = render(h(UserEntry, { entry }));
		expect(textContent(renderer.toJSON())).toContain("plain string");
		renderer.unmount();
	});
});
